import { type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { fingerprintPromptText, prefixOf } from '../src/services/prompt-context-store.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { canStartInjectionFlush } from '../src/core/inject-queue-policy.js';

interface Harness {
  child: ChildProcess;
  logs: string[];
  messages: WorkerToDaemon[];
  root: string;
}

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

async function waitFor(
  harness: Harness,
  predicate: () => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (harness.child.exitCode !== null || harness.child.signalCode !== null) {
      throw new Error(`worker exited before ${description}\n${harness.logs.join('')}`);
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${description}\n${harness.logs.join('')}`);
}

function startWorker(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'botmux-prompt-submitted-'));
  tempDirs.add(root);

  // A CLI that emits prompt marker '❯ ' and stays alive
  const fakeCli = join(root, 'fake-dsh-tui');
  writeFileSync(fakeCli, '#!/bin/sh\nprintf "❯ "\nexec sleep 300\n');
  chmodSync(fakeCli, 0o755);

  const sessionId = `promptsub${Date.now().toString(36)}${process.pid.toString(36)}`;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];

  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      SESSION_DATA_DIR: root,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_prompt_sub',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.on('message', raw => messages.push(raw as WorkerToDaemon));

  child.send({
    type: 'init',
    sessionId,
    chatId: 'oc_prompt_sub',
    rootMessageId: 'om_prompt_sub',
    workingDir: root,
    cliId: 'dsh-tui',
    cliPathOverride: fakeCli,
    backendType: 'pty',
    prompt: '',
    turnId: 'turn-init',
    larkAppId: 'app_prompt_sub',
    larkAppSecret: 'secret',
  } satisfies DaemonToWorker);

  return { child, logs, messages, root };
}

describe('worker prompt_submitted handler', () => {
  it('flips a ready worker to working without the previous turn id', async () => {
    const harness = startWorker();

    // 1. Wait until worker finishes initialization and announces ready
    await waitFor(
      harness,
      () => harness.messages.some(m => m.type === 'ready'),
      'worker readiness',
    );

    // Release startup ready gate
    harness.child.send({ type: 'session_ready', source: 'startup' } satisfies DaemonToWorker);

    // 2. Wait until worker becomes prompt_ready
    await waitFor(
      harness,
      () => harness.messages.some(m => m.type === 'prompt_ready'),
      'worker to emit prompt_ready',
    );

    const submissionMessageIndex = harness.messages.length;

    // 3. Send prompt_submitted while isPromptReady is true
    harness.child.send({ type: 'prompt_submitted' } satisfies DaemonToWorker);

    // 4. Worker should publish working state with clearTurnId (turnId: undefined)
    await waitFor(
      harness,
      () => harness.messages.slice(submissionMessageIndex).some(
        m => m.type === 'screen_update' && m.status === 'working' && m.turnId === undefined,
      ),
      'worker to publish working state with clearTurnId',
    );
  });

  it.each([true, false])('publishes working only for a ready edge (initially ready: %s)', async initiallyReady => {
    // The live worker's periodic screen sampler can publish independently of
    // this handler. Exercise the actual IPC case without that timer so a
    // repeated submission cannot hide among unrelated screen updates.
    const reset = vi.fn();
    const publishScreenStatus = vi.fn();
    const scope = {
      isPromptReady: initiallyReady,
      promptReadinessRevision: 0,
      idleDetector: { reset },
      publishScreenStatus,
      log: vi.fn(),
      writtenInputs: { takeSubmitted: vi.fn() },
      send: vi.fn(),
    };
    const handle = loadWorkerMessageHandler('prompt_submitted', scope);
    const submission = { type: 'prompt_submitted' } satisfies DaemonToWorker;

    await handle(submission);
    expect(scope.isPromptReady).toBe(false);
    if (initiallyReady) {
      expect(reset).toHaveBeenCalledTimes(1);
      // A fingerprint-less submission is a real human direct submit: the working
      // frame carries directSubmit (see the R10 keep-alive cases below).
      expect(publishScreenStatus).toHaveBeenCalledExactlyOnceWith('working', {
        force: true, clearTurnId: true, directSubmit: true,
      });
    } else {
      expect(reset).not.toHaveBeenCalled();
      expect(publishScreenStatus).not.toHaveBeenCalled();
    }

    reset.mockClear();
    publishScreenStatus.mockClear();
    await handle(submission);
    expect(scope.isPromptReady).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(publishScreenStatus).not.toHaveBeenCalled();
  });

  it('reports the written turn a submitted prompt was, and nothing for another prompt', async () => {
    const harness = startWorker();
    await waitFor(harness, () => harness.messages.some(m => m.type === 'ready'), 'worker readiness');
    harness.child.send({ type: 'session_ready', source: 'startup' } satisfies DaemonToWorker);
    await waitFor(harness, () => harness.messages.some(m => m.type === 'prompt_ready'), 'worker to emit prompt_ready');

    const turnId = 'workflow-event:run-1:3';
    const content = 'checkpoint after node a: review its result';
    harness.child.send({ type: 'message', content, turnId } satisfies DaemonToWorker);
    await waitFor(
      harness,
      () => harness.messages.some(m => m.type === 'turn_execution_started' && m.turnId === turnId),
      'the turn to be written',
    );
    const submittedFor = () => harness.messages.filter(m => m.type === 'prompt_submitted_input');

    const other = 'what is the status?';
    harness.child.send({ type: 'prompt_submitted', fingerprint: fingerprintPromptText(other), prefix: prefixOf(other) } satisfies DaemonToWorker);
    await delay(300);
    expect(submittedFor()).toEqual([]);

    harness.child.send({ type: 'prompt_submitted', fingerprint: fingerprintPromptText(content), prefix: prefixOf(content) } satisfies DaemonToWorker);
    await waitFor(harness, () => submittedFor().length > 0, 'the submitted turn to be reported');
    harness.child.send({ type: 'prompt_submitted', fingerprint: fingerprintPromptText(content), prefix: prefixOf(content) } satisfies DaemonToWorker);
    await delay(300);
    expect(submittedFor()).toEqual([{ type: 'prompt_submitted_input', turnId }]);
  });

  it('emits direct_submit_started even when prompt_ready never fired (stuck-after-terminal shape)', async () => {
    const harness = startWorker();
    await waitFor(
      harness,
      () => harness.messages.some(m => m.type === 'ready'),
      'worker readiness',
    );
    // Deliberately do NOT send session_ready: the startup ready-gate stays held,
    // so prompt_ready is never published and isPromptReady stays false — the
    // exact shape of a worker stranded after a terminal.
    const before = harness.messages.filter(m => m.type === 'direct_submit_started').length;
    harness.child.send({ type: 'prompt_submitted' } satisfies DaemonToWorker);
    await waitFor(
      harness,
      () => harness.messages.filter(m => m.type === 'direct_submit_started').length > before,
      'direct_submit_started provenance without prompt_ready',
    );
    // Provenance is decoupled from the screen edge: no working screen_update is
    // forced while not ready (the existing no-duplicate contract holds).
    await delay(300);
    const workingUpdates = harness.messages.filter(
      m => m.type === 'screen_update' && m.status === 'working' && m.turnId === undefined,
    );
    expect(workingUpdates).toEqual([]);
  });
});
describe('keep-alive vs direct-submit provenance (worker message handler)', () => {
  const keepaliveFingerprint = fingerprintPromptText('the keepalive command text');
  const humanFingerprint = fingerprintPromptText('a real human task');

  function scopeWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const sent: WorkerToDaemon[] = [];
    const inFlightKeepaliveFingerprints = new Map<string, number>();
    return {
      isPromptReady: false,
      revokePromptReadiness: () => {},
      idleDetector: undefined,
      log: () => {},
      writtenInputs: { takeSubmitted: () => undefined },
      inFlightKeepaliveFingerprints,
      KEEPALIVE_HOOK_CLAIM_MS: 30_000,
      send: (m: WorkerToDaemon) => { sent.push(m); },
      __sent: sent,
      ...overrides,
    } as Record<string, unknown>;
  }
  const emitsProvenance = (scope: Record<string, unknown>) =>
    (scope.__sent as WorkerToDaemon[]).some(m => m.type === 'direct_submit_started');
  // Seed the scope's own Map (the purge helper closes over this instance, so
  // tests must mutate it rather than replace it).
  const seedKeepalive = (scope: Record<string, unknown>, at: number = Date.now()) => {
    (scope.inFlightKeepaliveFingerprints as Map<string, number>).set(keepaliveFingerprint, at);
    return scope.inFlightKeepaliveFingerprints as Map<string, number>;
  };

  it('suppresses direct_submit_started when the hook fingerprint matches an in-flight keep-alive', async () => {
    const scope = scopeWith();
    const pending = seedKeepalive(scope);
    await loadWorkerMessageHandler('prompt_submitted', scope)({ type: 'prompt_submitted', fingerprint: keepaliveFingerprint });

    expect(emitsProvenance(scope)).toBe(false);
    expect(pending.has(keepaliveFingerprint)).toBe(false); // consumed
  });

  it('R8 reordering: a human hook arriving first still emits, and the late keep-alive hook is then suppressed', async () => {
    const scope = scopeWith();
    const pending = seedKeepalive(scope);

    await loadWorkerMessageHandler('prompt_submitted', scope)({ type: 'prompt_submitted', fingerprint: humanFingerprint });
    expect(emitsProvenance(scope)).toBe(true);
    expect(pending.has(keepaliveFingerprint)).toBe(true); // survives the human hook

    await loadWorkerMessageHandler('prompt_submitted', scope)({ type: 'prompt_submitted', fingerprint: keepaliveFingerprint });
    const signals = (scope.__sent as WorkerToDaemon[]).filter(m => m.type === 'direct_submit_started');
    expect(signals).toHaveLength(1); // still just the human one
    expect(pending.has(keepaliveFingerprint)).toBe(false);
  });

  it('R8 reordering: an expired keep-alive entry cannot suppress a later real submit with the same fingerprint', async () => {
    const scope = scopeWith();
    const pending = seedKeepalive(scope, Date.now() - 31_000);
    await loadWorkerMessageHandler('prompt_submitted', scope)({ type: 'prompt_submitted', fingerprint: keepaliveFingerprint });

    expect(emitsProvenance(scope)).toBe(true);
    expect(pending.size).toBe(0); // purged as abandoned
  });

  it('emits direct_submit_started when the hook carries no fingerprint (cannot be a matched keep-alive)', async () => {
    const scope = scopeWith();
    const pending = seedKeepalive(scope);
    await loadWorkerMessageHandler('prompt_submitted', scope)({ type: 'prompt_submitted' });

    expect(emitsProvenance(scope)).toBe(true);
    expect(pending.size).toBe(1); // untouched
  });

  it('emits direct_submit_started on a normal prompt_submitted with no keep-alive in flight', async () => {
    const scope = scopeWith();
    await loadWorkerMessageHandler('prompt_submitted', scope)({ type: 'prompt_submitted', fingerprint: humanFingerprint });
    expect(emitsProvenance(scope)).toBe(true);
  });

  it('R9: a keep-alive entry survives an unrelated injection, so its late hook is still suppressed', async () => {
    // The keep-alive was written and is awaiting its hook. An unrelated normal
    // injection (e.g. /compact) writes in between; it must NOT clear the entry.
    const scope = scopeWith();
    const pending = seedKeepalive(scope);

    // The keep-alive's independent HTTP hook then arrives late.
    await loadWorkerMessageHandler('prompt_submitted', scope)({
      type: 'prompt_submitted', fingerprint: keepaliveFingerprint,
    });

    expect(emitsProvenance(scope)).toBe(false); // still recognized as keep-alive
    expect(pending.has(keepaliveFingerprint)).toBe(false); // matched and consumed
  });

  it('R9 flush: writing a normal injection does not clear an unconfirmed keep-alive entry', async () => {
    const keepaliveEntries = new Map([[keepaliveFingerprint, Date.now()]]);
    const pendingInjections = [{ command: '/compact', barrier: false }];
    const scope: Record<string, unknown> = {
      nativeSessionForkPending: () => false,
      codexModelMigrationCheckNeeded: () => false,
      idleDetector: { isStartupPending: () => false, reset: () => {} },
      cliRestartInProgress: false,
      injectionFlushing: false,
      userFlushing: false,
      isFlushing: false,
      commandLineWritesPending: 0,
      pendingInjections,
      pendingMessages: [],
      pendingRawInputs: [],
      pendingSessionRename: null,
      backend: {},
      isPromptReady: true,
      bareShellLaunchBlocked: false,
      sessionRenameInFlight: () => false,
      bareShellChecked: true, // skip the bare-shell launch detector
      canStartInjectionFlush,
      revokePromptReadiness: () => {},
      log: () => {},
      sendRawCommandLineWithRecoveryFence: async () => {},
      awaitPtyQuiescence: async () => {},
      STARTUP_CMD_QUIET_MS: 1,
      STARTUP_CMD_CAP_MS: 10,
      inFlightKeepaliveFingerprints: keepaliveEntries,
      KEEPALIVE_HOOK_CLAIM_MS: 30_000,
    };

    await loadWorkerFunction<() => Promise<void>>('flushPendingInjections', scope)();

    expect(pendingInjections).toHaveLength(0); // the /compact was written
    expect(keepaliveEntries.has(keepaliveFingerprint)).toBe(true); // entry retained
  });

  it('R10 ready keep-alive: the working frame does NOT carry directSubmit', async () => {
    const publishCalls: Array<{ status: string; opts: Record<string, unknown> }> = [];
    const scope = scopeWith({
      isPromptReady: true,
      idleDetector: { isStartupPending: () => false, reset: () => {} },
      publishScreenStatus: (status: string, opts: Record<string, unknown>) => publishCalls.push({ status, opts }),
    });
    seedKeepalive(scope); // the keep-alive fingerprint is awaiting its hook

    await loadWorkerMessageHandler('prompt_submitted', scope)({
      type: 'prompt_submitted', fingerprint: keepaliveFingerprint,
    });

    // One ready→working frame, but it must not be tagged as a direct-submit.
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].status).toBe('working');
    expect(publishCalls[0].opts.directSubmit).toBeUndefined();
    expect(publishCalls[0].opts.clearTurnId).toBe(true);
    expect(emitsProvenance(scope)).toBe(false);
  });

  it('R10 ready human submit: the working frame DOES carry directSubmit', async () => {
    const publishCalls: Array<{ status: string; opts: Record<string, unknown> }> = [];
    const scope = scopeWith({
      isPromptReady: true,
      idleDetector: { isStartupPending: () => false, reset: () => {} },
      publishScreenStatus: (status: string, opts: Record<string, unknown>) => publishCalls.push({ status, opts }),
    });

    await loadWorkerMessageHandler('prompt_submitted', scope)({
      type: 'prompt_submitted', fingerprint: humanFingerprint,
    });

    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].opts.directSubmit).toBe(true);
    expect(emitsProvenance(scope)).toBe(true);
  });
});
