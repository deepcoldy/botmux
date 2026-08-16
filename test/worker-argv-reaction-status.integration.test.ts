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

    // Argv-baked first prompt (no flushPending). The fake stays running for the
    // whole first turn, then clears the screen so the turn settles idle. The
    // window must span at least a couple of SCREEN_UPDATE_INTERVAL_MS ticks so the
    // first-turn publisher gets a chance to emit the projected working.
    const fakePi = join(root, 'fake-pi');
    writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('Working...\\n');
setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[HDone without transcript final\\n'), 6_000);
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
      backendType: 'pty',
      prompt: 'hello from argv',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_turn',
    } satisfies DaemonToWorker);

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
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
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
