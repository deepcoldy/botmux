import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';

it.skipIf(spawnSync('tmux', ['-V']).status !== 0)('Kimi effort reaches its pane without leaking into the next session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-kimi-env-'));
  const data = join(root, 'data');
  mkdirSync(data);
  const fixture = join(root, 'kimi');
  const output = join(root, 'effort.txt');
  writeFileSync(fixture, '#!/bin/sh\nprintf "%s" "${KIMI_MODEL_THINKING_EFFORT-unset}" > '
    + "'" + output.replaceAll("'", "'\\''") + "'\nexec sleep 120\n", { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, BOTMUX_HOME: join(root, '.botmux'), SESSION_DATA_DIR: data,
    TMUX_TMPDIR: root, SHELL: '/bin/bash', BOTMUX_NO_CLAIM: '1', LARK_APP_ID: 'test', LARK_APP_SECRET: 'test' };
  delete env.KIMI_MODEL_THINKING_EFFORT;
  delete env.TMUX;
  delete env.TMUX_PANE;
  try {
    // 先建立专用 server，让 worker 能区分会话不存在与 socket 不可达。
    expect(spawnSync('tmux', ['new-session', '-d', '-s', 'fixture', 'sleep', '120'], { env }).status).toBe(0);
    for (const [reasoningEffort, botEnv, expected] of [
      ['max', { KIMI_MODEL_THINKING_EFFORT: 'low' }, 'max'],
      [undefined, {}, 'unset'],
      [undefined, { KIMI_MODEL_THINKING_EFFORT: 'high' }, 'high'],
    ] as const) {
      rmSync(output, { force: true });
      const child = spawnTsScript(resolve('src/worker.ts'), [], { env, cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let logs = '';
      child.stdout?.on('data', b => { logs += b; });
      child.stderr?.on('data', b => { logs += b; });
      const exited = new Promise<void>(r => child.once('exit', () => r()));
      try {
        child.send!({ type: 'init', sessionId: randomUUID(), chatId: 'oc_test', rootMessageId: 'om_test',
          workingDir: data, cliId: 'kimi', cliPathOverride: fixture, backendType: 'tmux', prompt: '',
          launchShell: '/bin/bash', model: 'kimi-code/k3-256k', reasoningEffort, env: botEnv,
          larkAppId: 'test', larkAppSecret: 'test', apiOnly: true });
        // Wait for the fake CLI to record the effort it was launched with. Deliberately
        // a plain deadline loop, not `expect.poll`: that assertion is vitest-only and
        // `bun test` runs this file's body on Bun, where it is undefined — the case died
        // with `expect.poll is not a function` BEFORE reaching any assertion, so the
        // `bun test` leg reported this file red while vitest stayed green. The loop is
        // runner-independent and still appends the worker logs when it times out.
        const deadline = Date.now() + 15000;
        while (!existsSync(output) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!existsSync(output)) throw new Error(`kimi never wrote its effort file within 15s\n${logs}`);
        expect(readFileSync(output, 'utf8'), logs).toBe(expected);
      } finally {
        if (child.connected) child.send!({ type: 'close' });
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(timer);
      }
    }
  } finally {
    spawnSync('tmux', ['kill-server'], { env, stdio: 'ignore' });
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
