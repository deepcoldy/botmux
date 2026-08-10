import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const tmuxSessions = new Set<string>();
const tmuxAvailable = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

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
  for (const session of tmuxSessions) {
    try { execFileSync('tmux', ['kill-session', '-t', session]); } catch { /* already stopped */ }
  }
  tmuxSessions.clear();
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

async function waitForLog(child: ChildProcess, logs: string[], needle: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (logs.some(entry => entry.includes(needle))) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker exited before log "${needle}"\n${logs.join('')}`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for log "${needle}"\n${logs.join('')}`);
}

async function waitForPromptReady(
  child: ChildProcess,
  messages: WorkerToDaemon[],
  logs: string[],
): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (messages.some(message => message.type === 'prompt_ready')) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker exited before prompt_ready\n${logs.join('')}`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for prompt_ready: ${JSON.stringify(messages)}\n${logs.join('')}`);
}

describe('worker argv reaction status', () => {
  it('keeps an argv-baked Pi turn working until its viewport loses Working...', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-busy-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    const fakePi = join(root, 'fake-pi');
    writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('Working...\\n');
setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[HDone without transcript final\\n'), 4_500);
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-worker-pi-busy',
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
      sessionId: 'sid-worker-pi-busy',
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'pi',
      cliPathOverride: fakePi,
      backendType: 'pty',
      prompt: 'hello from argv',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_turn',
    } satisfies DaemonToWorker);

    const deadline = Date.now() + 3_500;
    while (Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);

    const updates = await waitForScreenUpdates(child, messages, 2, logs);
    expect(updates[0]?.status).toBe('working');
    expect(updates.at(-1)?.status).toBe('idle');
  }, 15_000);

  it('defers a Pi transcript final that lands while the viewport still shows Working...', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-external-busy-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    // Pre-create the Pi session transcript so the bridge attaches (fresh-empty)
    // during spawn; the terminal assistant record is appended mid-turn below.
    const cliSessionId = 'deadbeef-1234-4678-9abc-def012345678';
    const piSessionsDir = join(root, '.pi', 'agent', 'sessions', dataDir.replace(/\//g, '--'));
    mkdirSync(piSessionsDir, { recursive: true });
    const transcriptPath = join(piSessionsDir, `20260810120000_${cliSessionId}.jsonl`);
    writeFileSync(transcriptPath, '');

    const fakePi = join(root, 'fake-pi');
    // The marker stays up long enough for the worst-case ingest path: even if
    // fs.watch drops the append (documented macOS FSEvents gap) and the 1s
    // bridge poller has to pick it up, the external idle still lands while
    // the viewport is busy.
    writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('Working...\\n');
setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[HDone after transcript final\\n'), 6_000);
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-worker-pi-external-busy',
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
      sessionId: 'sid-worker-pi-external-busy',
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'pi',
      cliPathOverride: fakePi,
      cliSessionId,
      backendType: 'pty',
      prompt: 'hello from argv',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_turn',
    } satisfies DaemonToWorker);

    // The bridge must be attached before the terminal record lands, otherwise
    // the append below is never ingested and no external idle fires at all.
    await waitForLog(child, logs, 'Codex bridge fresh-empty:');
    // Wait until the authoritative viewport provably shows Working... — the
    // first quiescence screen-idle deferral is that proof. Appending earlier
    // would race the fake's first write into the backend capture and the
    // external idle would correctly fall through instead of being deferred.
    await waitForLog(child, logs, 'screen-idle: authoritative viewport still shows busy marker');

    // assistant_final while the TUI still shows Working... — the race this
    // regression covers. drainPiTranscript maps a stopReason:"stop" record
    // without tool calls to a terminal assistant_final, and codexBridgeIngest
    // fireIdle()s on it (source=external).
    appendFileSync(transcriptPath, JSON.stringify({
      type: 'message',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'final answer' }],
        stopReason: 'stop',
      },
    }) + '\n');

    // The external idle MUST reach the busy-viewport guard (this log line is
    // the proof the transcript final was ingested and deferred — without it
    // the ready assertions below could pass vacuously)...
    await waitForLog(child, logs, 'external-idle: authoritative viewport still shows busy marker');
    // ...and no prompt_ready may escape while the marker remains on screen.
    // (Without the guard this fireIdle marks ready immediately, so the 1.5s
    // window is ample for the bug to surface.)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_500));
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);
    expect(
      messages.some(message => message.type === 'screen_update' && message.status === 'idle'),
      JSON.stringify(messages),
    ).toBe(false);

    // Once the fake clears Working..., readiness follows (busy probe or the
    // clear redraw's quiescence, whichever matures first).
    await waitForPromptReady(child, messages, logs);

    const updates = await waitForScreenUpdates(child, messages, 1, logs);
    expect(updates.at(-1)?.status).toBe('idle');
  }, 25_000);

  it.skipIf(!tmuxAvailable)('keeps an adopted Pi pane working until its viewport loses Working...', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-adopt-busy-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    const fakePi = join(root, 'fake-pi');
    writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('Working...\\n');
setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[HDone without transcript final\\n'), 4_500);
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const tmuxSession = `botmux-adopt-pi-${process.pid}-${Date.now()}`;
    tmuxSessions.add(tmuxSession);
    execFileSync('tmux', ['new-session', '-d', '-s', tmuxSession, fakePi]);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-worker-pi-adopt-busy',
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
      sessionId: 'sid-worker-pi-adopt-busy',
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'pi',
      backendType: 'tmux',
      prompt: '',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_turn',
      adoptMode: true,
      adoptTmuxTarget: `${tmuxSession}:0.0`,
      adoptPaneCols: 160,
      adoptPaneRows: 50,
    } satisfies DaemonToWorker);

    const deadline = Date.now() + 3_500;
    while (Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);

    await new Promise(resolvePromise => setTimeout(resolvePromise, 4_000));
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(true);
  }, 15_000);

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
