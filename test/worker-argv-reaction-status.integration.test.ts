import { execFileSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
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
  predicate: (
    message: Extract<WorkerToDaemon, { type: 'screen_update' }>,
  ) => boolean = () => true,
  description = 'screen updates',
): Promise<Array<Extract<WorkerToDaemon, { type: 'screen_update' }>>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const updates = messages.filter(
      (message): message is Extract<WorkerToDaemon, { type: 'screen_update' }> =>
        message.type === 'screen_update' && predicate(message),
    );
    if (updates.length >= count) return updates;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker exited before ${count} ${description}\n${logs.join('')}`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(
    `timed out waiting for ${count} ${description}: ${JSON.stringify(messages)}\n${logs.join('')}`,
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

/** A Pi transcript `message` record, shaped like SessionManager's JSONL. */
function piTranscriptRecord(role: 'user' | 'assistant', text: string, stopReason?: string): string {
  return JSON.stringify({
    type: 'message',
    timestamp: new Date().toISOString(),
    message: {
      role,
      content: [{ type: 'text', text }],
      ...(stopReason ? { stopReason } : {}),
    },
  }) + '\n';
}

function ompTranscriptRecord(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  content: string,
  stopReason?: string,
): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role,
      content: content ? [{ type: 'text', text: content }] : [],
      ...(stopReason ? { stopReason } : {}),
    },
  }) + '\n';
}

describe('worker argv reaction status', () => {
  it('attaches a spawned OMP bridge and quiet-flushes one trailing final', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-omp-quiet-final-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    const sessionId = 'sid-worker-omp-quiet-final';
    const transcriptDir = join(root, '.omp', 'agent', 'sessions', 'botmux', sessionId);
    const transcriptPath = join(transcriptDir, 'session.jsonl');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(transcriptPath, '');

    const fakeOmp = join(root, 'fake-omp');
    writeFileSync(fakeOmp, `#!/usr/bin/env node
process.stdout.write('OMP ready\\n');
process.stdin.on('data', () => {
  process.stdout.write('\\r\\u001b[2KWorking...');
  setTimeout(() => process.stdout.write('\\r\\u001b[2KOMP ready\\n'), 3_000);
});
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeOmp, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.on('message', raw => {
      const message = raw as WorkerToDaemon;
      messages.push(message);
      if (message.type === 'error') logs.push(`worker error: ${message.message}\n`);
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    child.send({
      type: 'init',
      sessionId,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'oh-my-pi',
      cliPathOverride: fakeOmp,
      backendType: 'pty',
      prompt: '',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitForLog(child, logs, 'Codex bridge fresh-empty:');
    await waitForPromptReady(child, messages, logs);
    child.send({
      type: 'message',
      content: 'ordinary OMP turn',
      turnId: 'om_omp_turn',
    } satisfies DaemonToWorker);
    await waitForLog(child, logs, 'Writing to PTY (flush): "ordinary OMP turn');

    appendFileSync(transcriptPath,
      ompTranscriptRecord('u1', null, 'user', 'ordinary OMP turn')
      + ompTranscriptRecord('a1', 'u1', 'assistant', 'OMP final answer', 'stop'));

    await new Promise(resolvePromise => setTimeout(resolvePromise, 2_200));
    expect(messages.some(message =>
      message.type === 'final_output' && message.turnId === 'om_omp_turn')).toBe(false);

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !messages.some(message =>
      message.type === 'final_output' && message.turnId === 'om_omp_turn')) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    const finals = messages.filter(message =>
      message.type === 'final_output' && message.turnId === 'om_omp_turn');
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ content: 'OMP final answer' });
    expect(logs.join('')).toContain('Codex bridge fresh-empty:');
  }, 20_000);

  it('keeps an argv-baked Pi turn working until its viewport loses Working...', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-busy-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    // Real Pi writes a user record when it begins consuming the argv prompt
    // and a terminal assistant record when the turn ends. With pi in the
    // lifecycle-blocking allowlist a started turn without a terminal holds
    // ready, so the fake must produce the realistic transcript shape.
    const cliSessionId = 'deadbeef-1234-4678-9abc-def012345678';
    const piSessionsDir = join(root, '.pi', 'agent', 'sessions', dataDir.replace(/\//g, '--'));
    mkdirSync(piSessionsDir, { recursive: true });
    const transcriptPath = join(piSessionsDir, `20260810120000_${cliSessionId}.jsonl`);
    writeFileSync(transcriptPath, '');

    const fakePi = join(root, 'fake-pi');
    writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('Working...\\n');
setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[HDone after transcript final\\n'), 4_500);
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
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
      cliSessionId,
      backendType: 'pty',
      prompt: 'hello from argv',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_turn',
    } satisfies DaemonToWorker);

    await waitForLog(child, logs, 'Codex bridge fresh-empty:');
    appendFileSync(transcriptPath, piTranscriptRecord('user', 'hello from argv'));

    const deadline = Date.now() + 3_500;
    while (Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);

    appendFileSync(transcriptPath, piTranscriptRecord('assistant', 'final answer', 'stop'));

    await waitForScreenUpdates(
      child,
      messages,
      1,
      logs,
      update => update.status === 'idle',
      'idle screen update',
    );
    const updates = messages.filter(
      (message): message is Extract<WorkerToDaemon, { type: 'screen_update' }> =>
        message.type === 'screen_update',
    );
    expect(updates[0]?.status).toBe('working');
    expect(updates.at(-1)?.status).toBe('idle');
  }, 20_000);

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
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
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
    // The turn's start: real Pi writes the user record when it begins
    // consuming the argv prompt (required now that a started-without-terminal
    // pi turn lifecycle-blocks ready).
    appendFileSync(transcriptPath, piTranscriptRecord('user', 'hello from argv'));
    // Wait until the authoritative viewport provably shows Working... — the
    // first quiescence screen-idle deferral is that proof. Appending earlier
    // would race the fake's first write into the backend capture and the
    // external idle would correctly fall through instead of being deferred.
    await waitForLog(child, logs, 'screen-idle: authoritative viewport still shows busy marker');

    // assistant_final while the TUI still shows Working... — the race this
    // regression covers. drainPiTranscript maps a stopReason:"stop" record
    // without tool calls to a terminal assistant_final, and codexBridgeIngest
    // fireIdle()s on it (source=external).
    appendFileSync(transcriptPath, piTranscriptRecord('assistant', 'final answer', 'stop'));

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

    const updates = await waitForScreenUpdates(
      child,
      messages,
      1,
      logs,
      update => update.status === 'idle',
      'idle screen update',
    );
    expect(updates.at(-1)?.status).toBe('idle');
  }, 25_000);

  it('publishes a working card during an argv-baked first turn before it completes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-first-turn-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    // Realistic transcript shape (user at start, terminal at end) — a started
    // pi turn without a terminal lifecycle-blocks ready.
    const cliSessionId = 'deadbeef-1234-4678-9abc-def012345679';
    const piSessionsDir = join(root, '.pi', 'agent', 'sessions', dataDir.replace(/\//g, '--'));
    mkdirSync(piSessionsDir, { recursive: true });
    const transcriptPath = join(piSessionsDir, `20260810120000_${cliSessionId}.jsonl`);
    writeFileSync(transcriptPath, '');

    // Argv-baked first prompt (no flushPending). The fake stays running for the
    // whole first turn, then clears the screen so the turn settles idle. The
    // window must span at least a couple of SCREEN_UPDATE_INTERVAL_MS ticks so the
    // first-turn publisher gets a chance to emit the projected working.
    const fakePi = join(root, 'fake-pi');
    writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('Working...\\n');
setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[HDone after transcript final\\n'), 6_000);
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-worker-pi-first-turn',
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
      sessionId: 'sid-worker-pi-first-turn',
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

    await waitForLog(child, logs, 'Codex bridge fresh-empty:');
    appendFileSync(transcriptPath, piTranscriptRecord('user', 'hello from argv'));

    // The publisher must emit `working` WHILE the first turn is still running —
    // i.e. before prompt_ready. This log line is the proof it fired through the
    // first-turn gate (the async sampler stays gated until then). It publishes the
    // projected status ('working' because isPromptReady is still false), not a
    // scraped busy marker.
    await waitForLog(child, logs, 'Argv-baked first prompt in flight — publishing projected working');

    // A working screen_update reached the daemon before the turn ended, and no
    // prompt_ready has escaped yet. (Without the fix the whole first turn is
    // silent — the card would sit at `starting` until the terminal idle.)
    const preReady = messages.filter(
      (message): message is Extract<WorkerToDaemon, { type: 'screen_update' }> =>
        message.type === 'screen_update',
    );
    expect(preReady.some(message => message.status === 'working'), JSON.stringify(messages)).toBe(true);
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);
    // The turn's terminal: readiness follows once the fake clears Working...
    // (external idle defers on the busy viewport, then the probe/quiescence
    // finishes the turn).
    appendFileSync(transcriptPath, piTranscriptRecord('assistant', 'final answer', 'stop'));
    // Dedup: the publisher sends `working` at most once per first turn even
    // though it runs every tick (lastSentStatus guard). Count the working
    // updates emitted before the first prompt_ready lands.
    await waitForPromptReady(child, messages, logs);
    const readyIdx = messages.findIndex(message => message.type === 'prompt_ready');
    const workingBeforeReady = messages
      .slice(0, readyIdx)
      .filter(message => message.type === 'screen_update' && message.status === 'working');
    expect(workingBeforeReady.length, JSON.stringify(messages)).toBe(1);

    // Once the fake clears Working..., the turn settles idle as usual.
    const updates = await waitForScreenUpdates(
      child,
      messages,
      1,
      logs,
      update => update.status === 'idle',
      'idle screen update',
    );
    expect(updates.at(-1)?.status).toBe('idle');
  }, 25_000);

  it('re-arms a startup-window false idle until the argv-baked Pi first turn visibly starts', async () => {
    // Pi's TUI paints its input box seconds before the CLI begins consuming
    // the argv prompt (extension/model loading). In that startup window the
    // screen shows no Working... and the transcript has no user record, so a
    // quiescence idle means "not started yet" — it must be re-armed (no
    // prompt_ready, no working→idle seed) and the card must stay 工作中. Once
    // the transcript user record lands, a mid-turn quiescence idle is
    // suppressed by the structured lifecycle gate, and the transcript final
    // then drives the real ready edge.
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-startup-gap-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    const cliSessionId = 'deadbeef-1234-4678-9abc-def01234567a';
    const piSessionsDir = join(root, '.pi', 'agent', 'sessions', dataDir.replace(/\//g, '--'));
    mkdirSync(piSessionsDir, { recursive: true });
    const transcriptPath = join(piSessionsDir, `20260810120000_${cliSessionId}.jsonl`);
    writeFileSync(transcriptPath, '');

    // The fake reproduces the gap: an idle-looking input box at spawn, total
    // silence (NO Working...), then some mid-turn output so quiescence can
    // fire again while the started turn is running.
    const fakePi = join(root, 'fake-pi');
    writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('┌─ pi ──────────┐\\n│ ❯ type here   │\\n└───────────────┘\\n');
setTimeout(() => process.stdout.write('streaming tokens\\n'), 6_000);
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-worker-pi-startup-gap',
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
      sessionId: 'sid-worker-pi-startup-gap',
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

    // The startup-window quiescence idle is re-armed by the evidence gate —
    // this log is the proof it was caught (before the fix it flowed through
    // markPromptReady and seeded a premature working→idle).
    await waitForLog(child, logs, 'Argv-baked first prompt has not visibly started');
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);
    expect(
      messages.some(message => message.type === 'screen_update' && message.status === 'idle'),
      JSON.stringify(messages),
    ).toBe(false);

    // Turn actually starts: real Pi writes the user record at that instant.
    appendFileSync(transcriptPath, piTranscriptRecord('user', 'hello from argv'));

    // Mid-turn quiescence (the fake's 6s output going quiet) must now be
    // suppressed by the structured lifecycle gate (started turn, no terminal).
    await waitForLog(child, logs, 'Ignoring prompt-ready heuristic while a structured turn is unfinished');
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);

    // Terminal record → external idle → real ready + working→idle seed.
    appendFileSync(transcriptPath, piTranscriptRecord('assistant', 'final answer', 'stop'));
    await waitForPromptReady(child, messages, logs);

    // prompt_ready is sent before the seed's working→idle pair; wait for the
    // seed's idle to land instead of counting raw updates.
    await waitForScreenUpdates(
      child,
      messages,
      1,
      logs,
      update => update.status === 'idle',
      'idle screen update',
    );
    const updates = messages.filter(
      (message): message is Extract<WorkerToDaemon, { type: 'screen_update' }> =>
        message.type === 'screen_update',
    );
    expect(updates.some(message => message.status === 'working'), JSON.stringify(messages)).toBe(true);
    expect(updates.at(-1)?.status).toBe('idle');
  }, 30_000);

  it('delivers a message queued during startup even when every ready heuristic is lifecycle-blocked', async () => {
    // The terminate-gap deadlock: the argv first turn is transcript-started
    // but never gets a terminal record. A follow-up message arriving while
    // awaitingFirstPrompt is still true skips handleMessage's type-ahead write
    // and queues, relying on markPromptReady()'s tail flush — but the
    // lifecycle gate rejects every ready heuristic (quiescence idle, the
    // queued-message busy probe, the 15s first-prompt timeout all funnel into
    // the same rejected markPromptReady()). Without the rejected-ready
    // re-kick the message sits in pendingMessages forever and the card pins
    // at 工作中. The re-kick must deliver it via Pi's type-ahead while the
    // turn correctly stays non-ready.
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-queued-deadlock-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    const cliSessionId = 'deadbeef-1234-4678-9abc-def01234567b';
    const piSessionsDir = join(root, '.pi', 'agent', 'sessions', dataDir.replace(/\//g, '--'));
    mkdirSync(piSessionsDir, { recursive: true });
    const transcriptPath = join(piSessionsDir, `20260810120000_${cliSessionId}.jsonl`);
    writeFileSync(transcriptPath, '');

    // Input-box TUI, then permanent silence — the shape a custom-tool
    // terminate leaves behind (screen back at the prompt, no terminal record).
    const fakePi = join(root, 'fake-pi');
    writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('┌─ pi ──────────┐\\n│ ❯ type here   │\\n└───────────────┘\\n');
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-worker-pi-queued-deadlock',
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
      sessionId: 'sid-worker-pi-queued-deadlock',
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

    await waitForLog(child, logs, 'Codex bridge fresh-empty:');
    // Turn starts on disk but never terminates (terminate:true gap).
    appendFileSync(transcriptPath, piTranscriptRecord('user', 'hello from argv'));

    // Follow-up arrives while awaitingFirstPrompt is still true → must queue.
    child.send({
      type: 'message',
      content: 'second message please',
      turnId: 'om_turn_2',
    } satisfies DaemonToWorker);
    await waitForLog(child, logs, 'Queued message (');

    // The rejected-ready re-kick must deliver the queued message through Pi's
    // type-ahead path (driven by the quiescence idle / queued-message busy
    // probe whose markPromptReady() the lifecycle gate rejects).
    await waitForLog(child, logs, 'Writing to PTY (flush): "second message please');

    // Delivery must not have required (or produced) a false ready edge: the
    // started-without-terminal first turn keeps the session non-ready.
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);
  }, 30_000);

  it('holds a startup-queued message until turn-start evidence appears, then delivers via type-ahead', async () => {
    // Startup input safety: before ANY turn-start evidence (no busy marker on
    // the PTY stream, no transcript user record) the TUI may still be loading
    // extensions/models, so a type-ahead paste could be dropped or land in a
    // half-drawn screen. The evidence-gate rejection must therefore NOT
    // re-kick flushPending() — the queued message stays queued through the
    // gate's false-idle rejections. Once the transcript user record lands
    // (evidence + started turn), the next lifecycle-rejected ready edge
    // delivers it via Pi's type-ahead.
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-startup-hold-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    const cliSessionId = 'deadbeef-1234-4678-9abc-def01234567c';
    const piSessionsDir = join(root, '.pi', 'agent', 'sessions', dataDir.replace(/\//g, '--'));
    mkdirSync(piSessionsDir, { recursive: true });
    const transcriptPath = join(piSessionsDir, `20260810120000_${cliSessionId}.jsonl`);
    writeFileSync(transcriptPath, '');

    // Input box at spawn, then one later output burst so a quiescence edge can
    // re-drive markPromptReady() after the user record lands.
    const fakePi = join(root, 'fake-pi');
    writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('┌─ pi ──────────┐\\n│ ❯ type here   │\\n└───────────────┘\\n');
setTimeout(() => process.stdout.write('streaming tokens\\n'), 10_000);
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-worker-pi-startup-hold',
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
      sessionId: 'sid-worker-pi-startup-hold',
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

    await waitForLog(child, logs, 'Codex bridge fresh-empty:');
    // Follow-up during the no-evidence startup window → queues.
    child.send({
      type: 'message',
      content: 'second message please',
      turnId: 'om_turn_2',
    } satisfies DaemonToWorker);
    await waitForLog(child, logs, 'Queued message (');

    // The evidence gate rejects the startup false idle(s)...
    await waitForLog(child, logs, 'Argv-baked first prompt has not visibly started');
    // ...and must NOT deliver the queued message while there is still no
    // turn-start evidence (this window also covers the queued-message busy
    // probe's rejected markPromptReady()).
    await new Promise(resolvePromise => setTimeout(resolvePromise, 3_000));
    expect(
      logs.some(entry => entry.includes('Writing to PTY (flush)')),
      logs.join(''),
    ).toBe(false);
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);

    // Turn-start evidence lands (started turn, still no terminal). The next
    // rejected-ready edge (quiescence after the fake's 10s output, or the 15s
    // first-prompt timeout probe) must deliver the queued message.
    appendFileSync(transcriptPath, piTranscriptRecord('user', 'hello from argv'));
    await waitForLog(child, logs, 'Writing to PTY (flush): "second message please');
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);
  }, 35_000);

  it('delivers a startup-queued message when turn-start evidence lands after every probe and timeout died', async () => {
    // The slow-evidence deadlock: the transcript user record lands only AFTER
    // the 15s first-prompt timeout (whose probe fired a rejected
    // markPromptReady() and stopped), with a permanently silent PTY (no
    // quiescence edge will ever come) and the 90s fail-open standing down on
    // evidenceSeen. The evidence latch itself must act as the delivery
    // driver — without it the queued second message needs a third message or
    // fresh PTY output to unlock.
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-slow-evidence-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    const cliSessionId = 'deadbeef-1234-4678-9abc-def01234567d';
    const piSessionsDir = join(root, '.pi', 'agent', 'sessions', dataDir.replace(/\//g, '--'));
    mkdirSync(piSessionsDir, { recursive: true });
    const transcriptPath = join(piSessionsDir, `20260810120000_${cliSessionId}.jsonl`);
    writeFileSync(transcriptPath, '');

    // Input box once, then permanent silence.
    const fakePi = join(root, 'fake-pi');
    writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('┌─ pi ──────────┐\\n│ ❯ type here   │\\n└───────────────┘\\n');
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-worker-pi-slow-evidence',
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    const initSentAt = Date.now();
    child.send({
      type: 'init',
      sessionId: 'sid-worker-pi-slow-evidence',
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

    await waitForLog(child, logs, 'Codex bridge fresh-empty:');
    child.send({
      type: 'message',
      content: 'second message please',
      turnId: 'om_turn_2',
    } satisfies DaemonToWorker);
    await waitForLog(child, logs, 'Queued message (');

    // Outlive the 15s first-prompt timeout (its probe fires one rejected
    // markPromptReady and stops). Everything that could deliver has now died.
    while (Date.now() - initSentAt < 17_000) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
    expect(
      logs.some(entry => entry.includes('Writing to PTY (flush)')),
      logs.join(''),
    ).toBe(false);
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);

    // Evidence lands NOW — with a silent PTY the transcript latch is the only
    // remaining driver and must release the queued message itself.
    appendFileSync(transcriptPath, piTranscriptRecord('user', 'hello from argv'));
    await waitForLog(child, logs, 'releasing startup-queued input');
    await waitForLog(child, logs, 'Writing to PTY (flush): "second message please');
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);
  }, 40_000);

  it('never lets an idle escape between the two working edges on a Grok-class first turn', async () => {
    // Grok arms spawnArgvInitialPromptBusy (argv-baked prompt + injectsReadyHook +
    // reliableTurnTerminal): its FIRST ready edge is pre-execution — the argv-baked
    // first prompt is still running. markPromptReady() would otherwise publish a
    // generic snapshot (projected idle, since isPromptReady was just set true)
    // BEFORE the busy arm re-publishes working. Combined with the first-turn
    // publisher's working, the daemon would see working→idle and fire
    // finishTurnReactions() — a premature DONE mid-turn. This regression asserts the
    // fix: after the first working, no idle may reach the daemon before the busy arm.
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-grok-first-turn-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    // Fake Grok: emit output for ~4s (so the 2s first-turn publisher tick fires and
    // sends the projected working while awaitingFirstPrompt), WITHOUT ever rendering
    // Grok's busy marker (`Waiting for response…` / `Ctrl+c:cancel`) — otherwise the
    // screen-idle busy guard would defer readiness and markPromptReady()'s seed
    // (the code under test) would never run. Then go quiet so the idle detector
    // drives markPromptReady() (the ready-gate preflight fails without an installed
    // SessionStart hook, so readiness falls to the idle path — no session_ready IPC
    // needed). The composer `❯` renders idle-looking; the busy arm is what keeps the
    // turn `working`, exactly the pre-execution SessionStart shape.
    const fakeGrok = join(root, 'fake-grok');
    writeFileSync(fakeGrok, `#!/usr/bin/env node
process.stdout.write('❯ booting\\n');
let n = 0;
const iv = setInterval(() => { process.stdout.write('.'); if (++n >= 8) clearInterval(iv); }, 500);
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeGrok, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-worker-grok-first-turn',
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
      sessionId: 'sid-worker-grok-first-turn',
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'grok',
      cliPathOverride: fakeGrok,
      backendType: 'pty',
      prompt: 'hello from argv',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_turn',
    } satisfies DaemonToWorker);

    // The first-turn publisher emits the projected working before any ready edge.
    await waitForLog(child, logs, 'Argv-baked first prompt in flight — publishing projected working');
    // Then the Grok-class busy arm runs inside markPromptReady() and re-publishes
    // working. Reaching this log proves we passed the generic-snapshot point (9337)
    // that the fix must keep from emitting idle.
    await waitForLog(child, logs, 'reporting working (not idle) so turn reactions can settle later');
    // Let any stray snapshot land.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));

    // The daemon-visible sequence up to the busy arm must be all-working, no idle:
    // the publisher's working, then the arm's working — and crucially NO idle in
    // between (that idle is what fired the premature DONE / the 工作中→等待输入→工作中
    // flicker).
    const statuses = messages
      .filter((m): m is Extract<WorkerToDaemon, { type: 'screen_update' }> => m.type === 'screen_update')
      .map(m => m.status);
    expect(statuses.length, JSON.stringify(messages)).toBeGreaterThanOrEqual(1);
    expect(statuses.includes('working'), JSON.stringify(messages)).toBe(true);
    expect(statuses.includes('idle'), JSON.stringify(messages)).toBe(false);
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
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
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

    await waitForPromptReady(child, messages, logs);
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
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
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
