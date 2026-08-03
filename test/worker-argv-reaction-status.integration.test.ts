import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()));
  child.kill('SIGKILL');
  await Promise.race([
    exited,
    new Promise<void>(resolvePromise => setTimeout(resolvePromise, 2_000)),
  ]);
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  children.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function waitForScreenUpdates(
  child: ChildProcess,
  messages: WorkerToDaemon[],
  count: number,
  logs: string[],
): Promise<Array<Extract<WorkerToDaemon, { type: 'screen_update' }>>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const updates = messages.filter(
      (message): message is Extract<WorkerToDaemon, { type: 'screen_update' }> =>
        message.type === 'screen_update',
    );
    if (updates.length >= count) return updates;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker exited before ${count} screen updates\n${logs.join('')}`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(
    `timed out waiting for ${count} screen updates: ${JSON.stringify(messages)}\n${logs.join('')}`,
  );
}

describe('worker argv reaction status', () => {
  it('forces the synthetic working seed before classifying a limited settle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-argv-reaction-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    // A single rate-limit render followed by quiescence reaches the natural
    // argv first-turn completion path in ~3s. The worker must emit raw working
    // first, then classify the real idle settle as limited. If the synthetic
    // tick is classified too, both updates collapse to limited and card-off
    // GoGoGo never sees the busy edge required to flip DONE.
    const fakeGemini = join(root, 'fake-gemini');
    writeFileSync(fakeGemini, `#!/usr/bin/env node
process.stdout.write('Rate limit exceeded. Try again at 10:36 PM.\\n');
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeGemini, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-worker-argv-reaction',
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    child.send({
      type: 'init',
      sessionId: 'sid-worker-argv-reaction',
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'gemini',
      cliPathOverride: fakeGemini,
      backendType: 'pty',
      prompt: 'hello from argv',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_turn',
    } satisfies DaemonToWorker);

    const updates = await waitForScreenUpdates(child, messages, 2, logs);
    expect(updates.slice(0, 2).map(message => message.status)).toEqual([
      'working',
      'limited',
    ]);
    expect(updates[0]?.usageLimit).toBeUndefined();
    expect(updates[1]?.usageLimit?.limited).toBe(true);
  }, 15_000);
});
