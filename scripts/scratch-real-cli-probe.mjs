#!/usr/bin/env node
/**
 * scratch real-CLI probe: run the REAL claude (and codex with --codex)
 * non-interactively inside a scratch sandbox, verify the reply arrives and the
 * transcript was written ONLY into the merged tree (host ~/.claude untouched),
 * and that the transcript resolver finds it via the merged root.
 *
 *   node scripts/scratch-real-cli-probe.mjs           # claude
 *   node scripts/scratch-real-cli-probe.mjs --codex   # codex
 */
import { prepareScratchSandbox } from '../dist/adapters/backend/scratch-sandbox.js';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const useCodex = process.argv.includes('--codex');
const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(name);
};

const dataDir = mkdtempSync(join(tmpdir(), 'botmux-scratch-real-data-'));
const workDir = mkdtempSync(join(tmpdir(), 'botmux-scratch-real-cwd-'));
const sid = `probe-real-${useCodex ? 'codex' : 'claude'}-${Date.now()}`;

const cliBin = useCodex ? '/root/.local/bin/codex' : '/root/.local/bin/claude';
const cliArgs = useCodex
  ? ['exec', '--skip-git-repo-check', 'Reply with exactly the text: SCRATCH_CODEX_OK']
  : ['-p', '--dangerously-skip-permissions', 'Reply with exactly the text: SCRATCH_CLAUDE_OK'];

const marker = useCodex ? 'SCRATCH_CODEX_OK' : 'SCRATCH_CLAUDE_OK';
const sbx = prepareScratchSandbox({
  sessionId: sid,
  dataDir,
  storage: 'disk',
  chdir: workDir,
  home: homedir(),
  cliBin,
  cliArgs,
  denyPaths: [join(homedir(), '.botmux-probe-deny-real')],
});
check('prepare ok', !!sbx);
if (!sbx) process.exit(1);

const t0 = Date.now();
const r = spawnSync(sbx.bin, sbx.args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 180_000 });
console.log(`exit=${r.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('--- stdout (first 800) ---');
console.log((r.stdout ?? '').slice(0, 800));
if (r.stderr) { console.log('--- stderr (first 400) ---'); console.log(r.stderr.slice(0, 400)); }

check('CLI replied inside sandbox', (r.stdout ?? '').includes(marker));

// Find the newest transcript the CLI wrote, compare host-real vs merged views.
const merged = sbx.mergedHostPath;
function newestJsonl(root) {
  const out = [];
  // `root` is the host-side path of the MERGED tree (or '/' for the host
  // view): the in-container $HOME=/root maps to `${root}/root`. Restrict to
  // THIS probe's project dir so the live fleet's transcripts can't race in.
  const projectKey = workDir.replace(/[^A-Za-z0-9-]/g, '-');
  const base = useCodex
    ? join(root, homedir(), '.codex', 'sessions')
    : join(root, homedir(), '.claude', 'projects', projectKey);
  const walk = (d, depth) => {
    if (depth > 6) return;
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try { out.push({ f, mtime: statSync(f).mtimeMs }); } catch { /* */ }
      }
    }
  };
  walk(base, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  // Prefer a file actually carrying this probe's marker (live fleet sessions
  // can race in a shared codex sessions dir); fall back to newest.
  return out.find(x => {
    try { return readFileSync(x.f, 'utf8').includes(marker); } catch { return false; }
  })?.f ?? out[0]?.f;
}
const mergedJsonl = newestJsonl(merged);
// Host counterpart: strip the merged prefix; the remainder is an absolute path.
const hostCounterpart = mergedJsonl ? mergedJsonl.slice(merged.length) : null;
const hostJsonlCandidates = hostCounterpart ? readdirSync(join(homedir(), '.claude', 'projects'), { recursive: true, withFileTypes: false }) : [];
check('transcript written into merged tree', !!mergedJsonl, mergedJsonl ?? '(none found)');
if (mergedJsonl) {
  check('merged transcript carries the turn', readFileSync(mergedJsonl, 'utf8').includes(marker));
  const hostHasSame = existsSync(hostCounterpart)
    && readFileSync(hostCounterpart, 'utf8').includes(marker);
  check('host-real transcript has NO trace of the scratch turn', !hostHasSame, hostCounterpart);
  void hostJsonlCandidates;
}

sbx.cleanup();
check('cleanup done', !existsSync(join(dataDir, 'sandboxes', sid)));
rmSync(workDir, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
