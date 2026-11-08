/**
 * A scratch session whose CLI crash-looped until the daemon parked it gets its
 * CLI started again by the next message (#2500). That retry prepares the same
 * session's tree again; the previous generation's cleanup must not then tear
 * the freshly prepared tree down under the new CLI.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lastJsonLine, privateMountNsAvailable, runInPrivateMountNs } from './helpers/private-mount-ns.js';

const runtime = privateMountNsAvailable();

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmdirSync(base);
});

describe.skipIf(!runtime)('scratch sandbox retry after a crash-loop stop (real mounts, private namespace)', () => {
  it('the retried CLI runs in a live tree that stays mounted', () => {
    // Outside /tmp: the base gets a namespace-private tmpfs, so on the host it stays an empty dir.
    const base = mkdtempSync(join(resolve('.'), '.scratch-retry-'));
    bases.push(base);
    // The worker talks to its parent only: no live daemon / bot identity leaks in.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BOTMUX_|LARK_)/.test(key)));
    const run = runInPrivateMountNs(`
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnNodeTsScript } from './test/helpers/ts-runner.js';
const base = ${JSON.stringify(base)};
const work = join(base, 'work');
mkdirSync(work);
mkdirSync(join(base, 'bin'));
writeFileSync(join(base, 'bin', 'package.json'), '{"type":"commonjs"}\\n');
const cli = join(base, 'bin', 'fake-claude');
const dataDir = join(base, 'botmux', 'data');
// The first launch crashes; once the test drops the marker, the next one stays
// up. Each reports from INSIDE the sandbox into the host-real relay outbox.
const stayUp = join(base, 'bin', 'stay-up');
writeFileSync(cli, "#!/usr/bin/env node\\nconst fs = require('fs');\\nif (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }\\n"
  + "const retried = fs.existsSync(" + JSON.stringify(stayUp) + ");\\n"
  + "const out = { retried };\\n"
  + "try { fs.writeFileSync('.cli-probe', 'x'); out.cwdWritable = true; } catch (e) { out.cwdWritable = e.code; }\\n"
  + "fs.writeFileSync(process.env.BOTMUX_SEND_RELAY + '/report-' + (retried ? 'retry' : 'first') + '.json', JSON.stringify(out));\\n"
  + "if (retried) setInterval(() => {}, 1000); else setTimeout(() => process.exit(3), 300);\\n", { mode: 0o755 });
const messages = [];
let logs = '';
const worker = spawnNodeTsScript('src/worker.ts', [], {
  env: { ...process.env, HOME: join(base, 'home'), SESSION_DATA_DIR: dataDir, BOTMUX_SANDBOX: 'scratch', BOTMUX_NO_CLAIM: '1' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
worker.on('message', m => messages.push(m));
worker.stdout.on('data', c => { logs += c; });
worker.stderr.on('data', c => { logs += c; });
const waitFor = async (pred, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !pred()) await new Promise(r => setTimeout(r, 100));
  return pred();
};
const sid = 'crash-stop-retry';
const tree = join(dataDir, 'sandboxes', sid);
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const merged = () => readJson(join(tree, 'scratch.json'))?.merged ?? join(tree, 'root');
const mounted = (dir) => readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').some(l => l.split(' ')[4] === dir);
worker.send({ type: 'init', sessionId: sid, chatId: 'oc_fixture', rootMessageId: 'om_fixture', workingDir: work,
  cliId: 'claude-code', cliPathOverride: cli, backendType: 'pty', prompt: '', larkAppId: 'app_test', larkAppSecret: 'fixture-secret' });
const crashed = await waitFor(() => messages.some(m => m.type === 'claude_exit'), 60_000);
const first = readJson(join(tree, 'outbox', 'report-first.json'));
writeFileSync(stayUp, '');
// What the daemon does once it stops auto-restarting, then the next message.
worker.send({ type: 'park_diagnostic' });
await new Promise(r => setTimeout(r, 300));
worker.send({ type: 'message', content: 'try again', turnId: 'om_retry' });
let retry = null;
await waitFor(() => { retry = readJson(join(tree, 'outbox', 'report-retry.json')); return !!retry; }, 60_000);
await new Promise(r => setTimeout(r, 1_000));
const mergedStillMounted = mounted(merged());
worker.kill('SIGKILL');
console.log(JSON.stringify({
  crashed, first, retry, mergedStillMounted,
  errors: messages.filter(m => m.type === 'error').map(m => m.message),
  logTail: logs.split('\\n').filter(l => /scratch|Sandbox|sandbox|crash|retry/i.test(l)).slice(-30).join('\\n'),
}));
`, { tmpfs: [base], env, timeoutMs: 150_000 });
    const result = lastJsonLine<{
      crashed: boolean; first: { cwdWritable: unknown } | null; retry: { cwdWritable: unknown } | null;
      mergedStillMounted: boolean; errors: string[]; logTail: string;
    }>(run);
    expect(result.crashed, run.stderr).toBe(true);
    expect(result.first?.cwdWritable, result.logTail).toBe(true);
    expect(result.retry?.cwdWritable, result.logTail).toBe(true);
    expect(result.mergedStillMounted, result.logTail).toBe(true);
    expect(result.errors).toEqual([]);
  }, 180_000);
});
