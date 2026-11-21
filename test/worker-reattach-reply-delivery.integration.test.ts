import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { killWorkerTmuxSession, workerTmuxArgs } from './helpers/worker-tmux-session.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';

const runnable = process.platform === 'linux' && probeTmuxFunctional().ok;
const WAIT_MS = 60_000;

// A daemon restart (or upgrade that changes the default) re-forks the worker
// onto a surviving tmux pane: the CLI process — and the prompt it was launched
// with — survives, while the new init carries today's replyDelivery. The worker
// must follow the pane's launch value (frozen in its environment), not the
// init, until the CLI is respawned; the pane itself is not restarted.
it.skipIf(!runnable)('a re-attached pane keeps the reply delivery it was launched with', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-reattach-delivery-'));
  const dataDir = join(root, 'data'); mkdirSync(dataDir);
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
  const output = join(root, 'spawns.jsonl');
  const fakeCli = join(root, 'fake-pi');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify({pid:process.pid,snapshot:process.env.BOTMUX_REPLY_DELIVERY ?? null})+'\\n');
process.stdout.write('Ready\\n');
setInterval(()=>{},1000);
`, { mode: 0o755 });
  const sessionId = randomUUID();
  const env = privateTmuxEnv(root, { HOME: root, USERPROFILE: root, BOTMUX_HOME: join(root, '.botmux'), SHELL: '/bin/sh',
    SESSION_DATA_DIR: dataDir, BOTMUX_NO_CLAIM: '1' });
  const lines = (): any[] => existsSync(output)
    ? readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
  const initBase = { type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: dataDir, cliId: 'pi', cliPathOverride: fakeCli, backendType: 'tmux', prompt: '',
    larkAppId: 'cli_current_app', larkAppSecret: 'test-only-secret', locale: 'zh' };
  const start = (replyDelivery: 'send' | 'transcript', resume: boolean) => {
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], { env, cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const logs: string[] = [];
    child.stdout?.on('data', b => logs.push(String(b))); child.stderr?.on('data', b => logs.push(String(b)));
    const exit = new Promise(r => child.once('exit', r));
    child.send!({ ...initBase, resume, replyDelivery, replyDeliveryLegacy: 'send' });
    return { child, logs, exit };
  };
  const session = `bmx-${sessionId.slice(0, 8)}`;
  let second: ReturnType<typeof start> | undefined;
  try {
    const first = start('send', false);
    const firstDeadline = Date.now() + WAIT_MS;
    while (lines().length < 1 && first.child.exitCode === null && Date.now() < firstDeadline) await new Promise(r => setTimeout(r, 50));
    expect(lines().length, first.logs.join('')).toBe(1);
    expect(lines()[0].snapshot).toBe('send');
    await new Promise(r => setTimeout(r, 1500));
    // Daemon restart: the IPC channel drops, the persistent pane only detaches.
    first.child.disconnect!();
    const killTimer = setTimeout(() => first.child.kill('SIGKILL'), 15_000);
    await first.exit; clearTimeout(killTimer);
    expect(execFileSync('tmux', [...workerTmuxArgs(env), 'list-sessions', '-F', '#{session_name}'], { env, encoding: 'utf8' }))
      .toContain(session);

    // The restarted daemon now resolves transcript (e.g. the new default).
    second = start('transcript', true);
    const pinned = /\[reply-delivery\] re-attached pane was launched with replyDelivery=send/;
    const secondDeadline = Date.now() + 20_000;
    while (!pinned.test(second.logs.join('')) && second.child.exitCode === null && Date.now() < secondDeadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    const log = second.logs.join('');
    expect(log).toMatch(/Re-attach/);
    expect(log).toMatch(pinned);
    // Still the first CLI generation: nothing was respawned.
    expect(lines()).toHaveLength(1);
    expect(second.child.exitCode, log).toBeNull();
  } finally {
    if (second?.child.connected) second.child.send!({ type: 'close' });
    if (second) { const timer = setTimeout(() => second!.child.kill('SIGKILL'), 8000); await second.exit; clearTimeout(timer); }
    killWorkerTmuxSession(session, env);
    try { execFileSync('tmux', [...workerTmuxArgs(env), 'kill-server'], { env, stdio: 'ignore' }); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true });
  }
}, WAIT_MS * 2 + 60_000);
