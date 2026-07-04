// LIVE-TURN probe: run a real non-interactive AI turn for each CLI INSIDE the
// overlay bwrap sandbox. This exercises the full path: process start → read real
// config/auth → use proxy env → reach the API → produce output. Bounded timeouts.
//
// Run: node scripts/sandbox-cli-live-turn-probe.mjs
import { spawnSync } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSandbox } from '../dist/adapters/backend/sandbox.js';
import { createCliAdapterSync } from '../dist/adapters/cli/registry.js';

const SRC = '/root/sandbox-demo';
const PROMPT = 'Reply with exactly the single word: PONG';

function childEnv(adapter, sbx) {
  const e = { ...process.env };
  if (adapter.spawnEnv) Object.assign(e, adapter.spawnEnv);
  Object.assign(e, sbx.env);
  return e;
}

const cases = [
  {
    cliId: 'claude-code',
    binPath: '/root/.local/bin/claude',
    args: ['--print', '--dangerously-skip-permissions', PROMPT],
    needle: /PONG/i,
  },
  {
    cliId: 'seed',
    binPath: '/root/.local/share/fnm/node-versions/v22.21.1/installation/bin/seed',
    args: ['--print', '--dangerously-skip-permissions', PROMPT],
    needle: /PONG/i,
  },
  {
    cliId: 'codex',
    binPath: '/root/.local/share/fnm/node-versions/v22.21.1/installation/bin/codex',
    args: ['exec', '--dangerously-bypass-approvals-and-sandbox', PROMPT],
    needle: /PONG/i,
  },
];

for (const c of cases) {
  console.log('─'.repeat(72));
  console.log(`### ${c.cliId} live turn: \`${c.cliId} ${c.args.join(' ')}\``);
  const adapter = createCliAdapterSync(c.cliId, c.binPath);
  const data = mkdtempSync(join(tmpdir(), `sbx-live-${c.cliId}-`));
  const sid = `live-${c.cliId}-${Date.now()}`;
  const sbx = prepareSandbox({
    enabled: true, cliId: c.cliId, sessionId: sid, sourceWorkingDir: SRC,
    dataDir: data, cliBin: adapter.resolvedBin, cliArgs: c.args, hidePaths: [],
  });
  if (!sbx) { console.log('prepareSandbox null — FAIL'); try { rmSync(data, { recursive: true, force: true }); } catch {} continue; }
  const env = childEnv(adapter, sbx);
  const r = spawnSync(sbx.bin, sbx.args, { env, encoding: 'utf8', timeout: 120000 });
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  console.log(`exit=${r.status} signal=${r.signal ?? ''} timedOut=${r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'}`);
  if (out) console.log('--- stdout (last 800 chars) ---\n' + out.slice(-800));
  if (err) console.log('--- stderr (last 800 chars) ---\n' + err.slice(-800));
  const got = c.needle.test(out);
  console.log(`VERDICT ${c.cliId}: live turn ${got ? 'PRODUCED EXPECTED OUTPUT (auth+proxy+API all worked)' : 'did NOT produce expected output'}`);
  sbx.cleanup();
  try { rmSync(data, { recursive: true, force: true }); } catch {}
}
