import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { t } from '../src/i18n/index.js';

const WAIT_MS = 60_000;

// An in-worker respawn (`/restart`) never re-forks the worker, so the new CLI is
// built from the fork-time snapshot unless the restart IPC carries the latest
// value. After an operator switches replyDelivery and restarts, the replacement
// CLI's system prompt and env snapshot must follow the new value; a restart
// that carries none keeps the snapshot.
it.each([
  ['carries send', 'send', 'send'],
  ['carries nothing', undefined, 'transcript'],
] as const)('a /restart that %s respawns the CLI with replyDelivery=%s', async (_label, carried, expected) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-restart-delivery-'));
  const dataDir = join(root, 'data'); mkdirSync(dataDir);
  const output = join(root, 'spawns.jsonl');
  const fakeCli = join(root, 'fake-pi');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify({pid:process.pid,prompt:process.env.BOTMUX_APPEND_SYSTEM_PROMPT,snapshot:process.env.BOTMUX_REPLY_DELIVERY ?? null})+'\\n');
process.stdout.write('Ready\\n');
setInterval(()=>{},1000);
`, { mode: 0o755 });
  const env = { ...process.env, HOME: root, USERPROFILE: root, BOTMUX_HOME: join(root, '.botmux'),
    SESSION_DATA_DIR: dataDir, PATH: process.env.PATH, BOTMUX_NO_CLAIM: '1' };
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], { env, cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; child.stdout?.on('data', b => logs += b); child.stderr?.on('data', b => logs += b);
  const exit = new Promise(r => child.once('exit', r));
  const lines = (): any[] => existsSync(output)
    ? readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
  const waitFor = async (n: number) => {
    const deadline = Date.now() + WAIT_MS;
    while (lines().length < n && child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  };
  try {
    child.send!({ type: 'init', sessionId: randomUUID(), chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: dataDir, cliId: 'pi', cliPathOverride: fakeCli, backendType: 'pty', prompt: '',
      larkAppId: 'cli_current_app', larkAppSecret: 'test-only-secret', locale: 'zh', replyDelivery: 'transcript' });
    await waitFor(1);
    expect(lines().length, logs).toBe(1);
    await new Promise(r => setTimeout(r, 1500));
    child.send!({ type: 'restart', attemptId: 'attempt-1', ...(carried ? { replyDelivery: carried } : {}) });
    await waitFor(2);
    const [first, second] = lines();
    expect(second, logs).toBeDefined();
    expect(second.pid).not.toBe(first.pid);
    expect(first.snapshot).toBe('transcript');
    expect(second.snapshot).toBe(expected);
    const transcriptIntro = t('ai.routing.intro_transcript', undefined, 'zh');
    if (expected === 'transcript') expect(second.prompt).toContain(transcriptIntro);
    else {
      expect(second.prompt).not.toContain(transcriptIntro);
      expect(second.prompt).toContain(t('ai.routing.intro', undefined, 'zh'));
    }
  } finally {
    if (child.connected) child.send!({ type: 'close' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit; clearTimeout(timer); rmSync(root, { recursive: true, force: true });
  }
}, WAIT_MS * 2 + 15_000);
