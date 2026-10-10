#!/usr/bin/env node
/**
 * scratch-sandbox-darwin-probe — validate the macOS symlink-farm + clonefile
 * scratch sandbox ON A MAC. Linux cannot run this (sandbox-exec / clonefile).
 *
 *   node scripts/scratch-sandbox-darwin-probe.mjs
 *
 * Checks: prepare (bounded, no TCC traversal), dotfile clone isolation,
 * project clone isolation, symlink-to-OUTSIDE write denial (target outside
 * every host-writable area), system write denial, host cache area semantics,
 * outbox passthrough, cleanup (try/finally so a failed assert never leaves a
 * multi-GB residual).
 */
// @ts-nocheck
import { prepareMacScratchSandbox } from '../dist/adapters/backend/scratch-sandbox-darwin.js';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir as osTmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') {
  console.error('macOS-only probe. On Linux run scripts/scratch-sandbox-probe.mjs.');
  process.exit(2);
}

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(name);
};

const dataDir = mkdtempSync(join(osTmpdir(), 'botmux-scratch-mac-data-'));
const workDir = mkdtempSync(join(osTmpdir(), 'botmux-scratch-mac-cwd-'));
const sid = `probe-mac-${Date.now()}`;

const t0 = Date.now();
const sbx = prepareMacScratchSandbox({
  sessionId: sid,
  dataDir,
  chdir: workDir,
  home: homedir(),
  cliBin: '/bin/sh',
  cliArgs: ['-c', 'true'],
  net: true,
});
const prepMs = Date.now() - t0;
check('prepare ok (symlink farm, bounded)', !!sbx);
if (!sbx) {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}
console.log(`   prepare took ${prepMs}ms`);

// sandbox-exec argv is ['-f', <profile>, <bin>, ...args]; slice(0,2) keeps
// BOTH '-f' and the profile path (slice(0,1) drops the profile → illegal opt).
const run = (script) => spawnSync(sbx.bin, [...sbx.args.slice(0, 2), '/bin/sh', '-c', script],
  { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: sbx.chdirInSandbox, env: sbx.env, timeout: 30_000 });

try {
  // 1. dotfile write in cloned HOME → clone only
  const probeDotfile = '.botmux-scratch-probe-dotfile';
  const rDot = run(`echo x > "$HOME/${probeDotfile}" && echo OK`);
  check('write a new dotfile in cloned HOME succeeds', rDot.stdout.includes('OK'), rDot.stderr?.slice(0, 150));
  check('host HOME has no probe dotfile', !existsSync(join(homedir(), probeDotfile)));
  check('cloned HOME carries probe dotfile', existsSync(join(sbx.clonedHome, probeDotfile)));

  // 2. project cwd write → clone, host untouched
  const rCwd = run('echo p > PROBE_PROJ && echo OK');
  check('write in cloned project succeeds', rCwd.stdout.includes('OK'), rCwd.stderr?.slice(0, 150));
  check('host project untouched', !existsSync(join(workDir, 'PROBE_PROJ')));

  // 3. symlink escape. Target MUST be outside every host-writable area:
  //    /private/var/folders IS writable (Foundation), so use /Users/Shared
  //    (real path, no symlink in the path, not under TMPDIR or ~/Library).
  const targetFile = '/Users/Shared/.botmux-scratch-escape-target';
  try { writeFileSync(targetFile, 'orig'); } catch { /* may need perms */ }
  if (existsSync(targetFile)) {
    const rLink = run(`ln -s "${targetFile}" "$TMPDIR/esc"; echo overwrite >> "$TMPDIR/esc" 2>/dev/null && echo LEAKED || echo DENIED`);
    check('write through symlink to a non-writable host path is DENIED', rLink.stdout.includes('DENIED'), rLink.stderr?.slice(0, 150));
    check('symlink target unchanged', readFileSync(targetFile, 'utf8') === 'orig');
    rmSync(targetFile, { force: true });
  } else {
    console.log('   (skip symlink-escape: cannot create /Users/Shared target)');
  }

  // 4. system path write denied
  const rSys = run('touch /etc/.botmux-probe-sys 2>/dev/null && echo LEAKED || echo DENIED');
  check('system-path write DENIED', rSys.stdout.includes('DENIED'));
  check('host /etc untouched', !existsSync('/etc/.botmux-probe-sys'));

  // 5. outbox passthrough
  const rOut = run('echo relay > "$BOTMUX_SEND_RELAY/req" && echo OK');
  check('outbox write succeeds from inside', rOut.stdout.includes('OK'));
  check('outbox host-readable', readFileSync(join(sbx.outbox, 'req'), 'utf8').trim() === 'relay');

  // 6. reads work through the farm
  const rRead = run('ls "$HOME" >/dev/null && echo READ_OK');
  check('reads work through the farm', rRead.stdout.includes('READ_OK'));

  // 7. macOS lark-cli keystores are sealed (N1). Non-vacuous assertion:
  //    existence is checked on the HOST (outside the sandbox) because
  //    Seatbelt file-read* denial also blocks stat/metadata — an in-sandbox
  //    `[ -f ]` on a sealed path ALWAYS fails and can't distinguish "sealed"
  //    from "absent". Only when the host confirms a real secret exists do we
  //    require the in-sandbox read to fail (= SEALED). The primary target is
  //    an appsecret_*.enc CIPHERTEXT file (always a file on macOS; the master
  //    key itself usually lives in the system Keychain and master.key.file is
  //    only a fallback). A machine with no keystore SKIPs (never silently green).
  const larkAppSupportDir = join(homedir(), 'Library', 'Application Support', 'lark-cli');
  const encFiles = existsSync(larkAppSupportDir)
    ? readdirSync(larkAppSupportDir).filter(n => /^appsecret_.*\.enc$/.test(n))
    : [];
  const targets = [
    ...encFiles.slice(0, 1).map(n => ({ rel: join('Library', 'Application Support', 'lark-cli', n), kind: 'appsecret ciphertext', required: true })),
    { rel: 'Library/Application Support/lark-cli/master.key.file', kind: 'macOS master-key file fallback', required: false },
    { rel: '.lark-cli/config.json', kind: 'per-bot lark-cli config', required: false },
  ];
  let sealedAny = false;
  for (const t of targets) {
    const hostPath = join(homedir(), t.rel);
    if (!existsSync(hostPath)) {
      console.log(`   SKIP ${t.kind} (not present on host): ${t.rel}`);
      continue;
    }
    // In-sandbox read of a host-confirmed secret path must fail. cat returns
    // non-zero / no output when file-read* is denied; success = LEAK.
    const out = run(`cat "$HOME/${t.rel}" 2>/dev/null | wc -c | tr -d ' '`);
    const bytes = parseInt(out.stdout.trim(), 10);
    const ok = Number.isFinite(bytes) && bytes === 0;
    if (ok) sealedAny = true;
    check(`mac lark keystore sealed: ${t.kind} (${basename(t.rel)})`, ok, `readable bytes=${out.stdout.trim()}`);
  }
  if (encFiles.length === 0) {
    // No ciphertext on this machine → the N1 content guarantee can't be proven
    // here. Report loudly (probe exit non-zero) so it must be re-run on a mac
    // with a real provisioned lark-cli rather than passing vacuously.
    check('host has at least one real appsecret_*.enc to prove sealing', false, 're-run this probe on a Mac provisioned with lark-cli');
  } else {
    check('at least one real ciphertext was proven sealed', sealedAny);
  }
} finally {
  // Guarantee cleanup even if an assert/read throws — otherwise a failed probe
  // leaves the whole clone subtree (potentially GB) on disk.
  sbx.cleanup();
  check('cleanup removed session tree', !existsSync(join(dataDir, 'sandboxes', sid)));
  rmSync(workDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILURE(S): ${failures.join('; ')}` : '\nALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
