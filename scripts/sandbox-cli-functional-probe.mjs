// FUNCTIONAL probe: actually RUN the real CLIs (codex, claude-code, seed) inside
// the overlay bwrap sandbox built by the compiled prepareSandbox.
//
// For each CLI it does TWO bwrap runs sharing one sandbox plan:
//   (1) RECON via /bin/sh: verify config/auth readability, project edit lands in
//       proj-upper, the `botmux` relay shim loads (node <cli.js> prints help, no
//       "Cannot find module"), and the proxy env is present in the sandbox env.
//   (2) REAL CLI start: run the actual CLI binary non-interactively (`--version`)
//       to confirm the process STARTS and does not crash / Cannot-find-module.
//
// Mirrors worker.ts wiring: resolved binary + real adapter args + adapter spawnEnv
// (seed's CLAUDE_CONFIG_DIR) + sbx.env merged into the child env.
//
// Run: node scripts/sandbox-cli-functional-probe.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { prepareSandbox } from '../dist/adapters/backend/sandbox.js';
import { createCliAdapterSync } from '../dist/adapters/cli/registry.js';

const SRC = '/root/sandbox-demo';
const HOME = homedir();
const CLAUDE_CRED = join(HOME, '.claude', '.credentials.json');
const CLAUDE_SETTINGS = join(HOME, '.claude', 'settings.json');
const CODEX_AUTH = join(HOME, '.codex', 'auth.json');

function line() { console.log('─'.repeat(72)); }

// Build the per-CLI sandbox using the SAME inputs worker.ts feeds prepareSandbox.
function buildSbx(cliId, sessionId, dataDir, cliBin, cliArgs) {
  return prepareSandbox({
    enabled: true,
    cliId,
    sessionId,
    sourceWorkingDir: SRC,
    dataDir,
    cliBin,
    cliArgs,
    hidePaths: [],
  });
}

// Mirror worker.ts childEnv assembly: process.env + adapter.spawnEnv + sbx.env.
function childEnv(adapter, sbx) {
  const e = { ...process.env };
  if (adapter.spawnEnv) Object.assign(e, adapter.spawnEnv);
  Object.assign(e, sbx.env);
  return e;
}

const reconScript = (authCheck, configCheck) => `
  set +e
  echo "RECON: whoami=$(id -un) uid=$(id -u)"
  echo "RECON: cwd=$(pwd)"
  echo "RECON: project README line1=$(head -1 README.md 2>&1)"
  echo "RECON: ${authCheck}"
  echo "RECON: ${configCheck}"
  echo "RECON: proxy_in_env https_proxy=\${https_proxy:-MISSING} HTTPS_PROXY=\${HTTPS_PROXY:-MISSING}"
  echo "RECON: PATH_head=$(echo \$PATH | cut -d: -f1)"
  echo "RECON: HOME=\$HOME"
  echo "RECON: BOTMUX_SEND_RELAY=\${BOTMUX_SEND_RELAY:-MISSING}"
  # EDIT a project file (must land in proj-upper, NOT in real /root/sandbox-demo)
  echo "edit-by-$(id -un)-$$" > sandbox_edit_marker.txt
  echo "# appended in sandbox" >> app.py
  echo "RECON: wrote project files"
  # relay shim: 'botmux' on PATH must exec node <cli.js>; help must print w/o module error
  BOUT=$(botmux --help 2>&1)
  if echo "\$BOUT" | grep -qi "Cannot find module"; then
    echo "RECON: relay_shim=CANNOT_FIND_MODULE"
  elif echo "\$BOUT" | grep -qiE "botmux|usage|command|send|daemon|schedule"; then
    echo "RECON: relay_shim=OK (botmux help loaded)"
  else
    echo "RECON: relay_shim=UNKNOWN_OUTPUT"
  fi
  echo "RECON: relay_shim_first_line=$(echo \"\$BOUT\" | head -1)"
`;

const cases = [
  {
    cliId: 'codex',
    binPath: '/root/.local/share/fnm/node-versions/v22.21.1/installation/bin/codex',
    label: 'codex (codex-cli)',
    authCheck: 'codex_auth_readable=$( [ -r "$HOME/.codex/auth.json" ] && echo YES || echo NO )',
    configCheck: 'codex_config_readable=$( [ -r "$HOME/.codex/config.toml" ] && echo YES || echo NO )',
    versionArgs: ['--version'],
  },
  {
    cliId: 'claude-code',
    binPath: '/root/.local/bin/claude',
    label: 'claude-code (claude)',
    authCheck: 'claude_creds_readable=$( [ -r "$HOME/.claude/.credentials.json" ] && echo YES || echo NO )',
    configCheck: 'claude_settings_readable=$( [ -r "$HOME/.claude/settings.json" ] && echo YES || echo NO )',
    versionArgs: ['--version'],
  },
  {
    cliId: 'seed',
    binPath: '/root/.local/share/fnm/node-versions/v22.21.1/installation/bin/seed',
    label: 'seed (Seed fork; CLAUDE_CONFIG_DIR=.claude-runtime)',
    // Seed reads CLAUDE_CONFIG_DIR (set via adapter.spawnEnv) — assert that dir's settings.
    authCheck: 'seed_config_dir=${CLAUDE_CONFIG_DIR:-UNSET}',
    configCheck: 'seed_settings_readable=$( [ -r "$CLAUDE_CONFIG_DIR/settings.json" ] && echo YES || echo NO )',
    versionArgs: ['--version'],
  },
];

const results = [];

for (const c of cases) {
  line();
  console.log(`### ${c.label}`);
  const adapter = createCliAdapterSync(c.cliId, c.binPath);
  const bin = adapter.resolvedBin;
  console.log(`resolvedBin = ${bin}`);
  console.log(`spawnEnv    = ${JSON.stringify(adapter.spawnEnv ?? {})}`);

  const res = { cliId: c.cliId, started: false, auth: '?', config: '?', edit: false, relay: '?', proxy: false, versionExit: null, notes: [] };

  // ── (1) RECON run (sh inside the sandbox) ──────────────────────────────────
  const reconData = mkdtempSync(join(tmpdir(), `sbx-recon-${c.cliId}-`));
  const reconSid = `recon-${c.cliId}-${Date.now()}`;
  const sbxRecon = buildSbx(c.cliId, reconSid, reconData, '/bin/sh', ['-c', reconScript(c.authCheck, c.configCheck)]);
  if (!sbxRecon) {
    console.log('RECON: prepareSandbox returned null — FAIL (mount failed/unsupported)');
    res.notes.push('prepareSandbox null on recon');
    results.push(res);
    try { rmSync(reconData, { recursive: true, force: true }); } catch {}
    continue;
  }
  const reconEnv = childEnv(adapter, sbxRecon);
  const rr = spawnSync(sbxRecon.bin, sbxRecon.args, { env: reconEnv, encoding: 'utf8' });
  console.log('--- recon stdout ---');
  console.log((rr.stdout || '(none)').trimEnd());
  if (rr.stderr && rr.stderr.trim()) { console.log('--- recon stderr ---'); console.log(rr.stderr.trimEnd()); }

  const out = rr.stdout || '';
  res.auth = (out.match(/(?:credentials_readable|auth_readable|config_dir)=(\S+)/) || [])[1] ?? '?';
  res.config = (out.match(/settings_readable=(\S+)/) || [])[1] ?? '?';
  res.relay = /relay_shim=OK/.test(out) ? 'OK' : /CANNOT_FIND_MODULE/.test(out) ? 'CANNOT_FIND_MODULE' : 'UNKNOWN';
  res.proxy = /HTTPS_PROXY=http/.test(out);

  // EDIT landed in proj-upper, real project untouched
  const upperMarker = join(sbxRecon.workDir, 'sandbox_edit_marker.txt');
  const upperApp = join(sbxRecon.workDir, 'app.py');
  const realMarker = join(SRC, 'sandbox_edit_marker.txt');
  const editLanded = existsSync(upperMarker) && existsSync(upperApp);
  const realUntouched = !existsSync(realMarker) && !readFileSync(join(SRC, 'app.py'), 'utf8').includes('# appended in sandbox');
  res.edit = editLanded && realUntouched;
  console.log(`VERIFY: edit landed in proj-upper=${editLanded} realUntouched=${realUntouched}`);
  if (editLanded) console.log(`VERIFY: upper marker content=${JSON.stringify(readFileSync(upperMarker, 'utf8').trim())}`);

  sbxRecon.cleanup();
  try { rmSync(reconData, { recursive: true, force: true }); } catch {}

  // ── (2) REAL CLI start (run the actual binary, non-interactive) ────────────
  const verData = mkdtempSync(join(tmpdir(), `sbx-ver-${c.cliId}-`));
  const verSid = `ver-${c.cliId}-${Date.now()}`;
  const sbxVer = buildSbx(c.cliId, verSid, verData, bin, c.versionArgs);
  if (!sbxVer) {
    console.log('VERSION: prepareSandbox returned null — FAIL');
    res.notes.push('prepareSandbox null on version run');
  } else {
    const verEnv = childEnv(adapter, sbxVer);
    const vr = spawnSync(sbxVer.bin, sbxVer.args, { env: verEnv, encoding: 'utf8', timeout: 60000 });
    res.versionExit = vr.status;
    const vout = (vr.stdout || '').trim();
    const verr = (vr.stderr || '').trim();
    console.log(`--- real \`${c.cliId} ${c.versionArgs.join(' ')}\` inside sandbox ---`);
    console.log(`exit=${vr.status} signal=${vr.signal ?? ''}`);
    if (vout) console.log(`stdout: ${vout.split('\n')[0]}`);
    if (verr) console.log(`stderr: ${verr.split('\n').slice(0, 5).join(' | ')}`);
    const moduleErr = /Cannot find module/i.test(vout + verr);
    res.started = vr.status === 0 && !moduleErr;
    if (moduleErr) res.notes.push('Cannot find module');
    sbxVer.cleanup();
  }
  try { rmSync(verData, { recursive: true, force: true }); } catch {}

  results.push(res);
}

line();
console.log('=== SUMMARY ===');
for (const r of results) {
  console.log(
    `${r.cliId.padEnd(12)} | started=${r.started} | versionExit=${r.versionExit} | ` +
    `auth/configDir=${r.auth} | settings=${r.config} | editLands=${r.edit} | ` +
    `relayShim=${r.relay} | proxyEnv=${r.proxy}` +
    (r.notes.length ? ` | notes=${r.notes.join(',')}` : '')
  );
}
const allGood = results.every(r => r.started && r.edit && r.relay === 'OK' && r.proxy);
console.log('RESULT:', allGood ? 'ALL PASS' : 'SEE SUMMARY (some checks failed)');
process.exit(allGood ? 0 : 1);
