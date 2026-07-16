import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const children = new Set<ChildProcess>();

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error('worker did not exit after a fatal dependency error'));
    }, timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
});

describe('Codex App worker dependency failure', () => {
  it('flushes one turn-scoped error and never emits ready when nested codex is missing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-worker-missing-codex-'));
    const messages: WorkerToDaemon[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-missing-codex',
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.on('message', message => messages.push(message as WorkerToDaemon));

    const init: DaemonToWorker = {
      type: 'init',
      sessionId: 'sid-missing-codex',
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'codex-app',
      cliPathOverride: join(dataDir, 'definitely-missing-codex'),
      backendType: 'pty',
      prompt: '<user_message>legacy</user_message>',
      promptCodexAppInput: { text: 'clean visible text' },
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'turn-missing-codex',
    };

    try {
      child.send(init);
      const exitCode = await waitForExit(child);
      expect(exitCode).toBe(1);
      expect(messages.filter(message => message.type === 'ready')).toHaveLength(0);
      const errors = messages.filter((message): message is Extract<WorkerToDaemon, { type: 'error' }> => message.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(expect.objectContaining({
        turnId: 'turn-missing-codex',
        message: expect.stringContaining('definitely-missing-codex'),
      }));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
