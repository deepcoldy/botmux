/**
 * Regression chain for "tmux 不可用" on a live session under host load (PR #833).
 *
 * Every tmux existence probe times out (has-session → ETIMEDOUT → 'unknown').
 * The chain under test is the real one: worker gate resolution → frozen
 * reattach bias → pre-spawn re-probe → selectSessionBackend → TmuxPipeBackend
 * .spawn → the worker's pure fresh/reattach decisions. It pins that an
 * indeterminate probe
 *   - never gates the session with the misleading install card,
 *   - never goes through "create, then swallow `duplicate session`" — the
 *     backend's predicted and actual outcome are the SAME (reattach), so:
 *       P1 isolation: no fresh boot marker is written for a pane whose wrapper
 *          never ran, and the read-isolation gate refuses an unverifiable pane;
 *       P1 argv prompt: an args-baked first prompt is queued, not dropped;
 *       P2 startupCommands: not replayed into the live CLI;
 *   - fails CLOSED (spawn throws, nothing created) if the pane is in fact gone,
 *   - and an authoritative 'missing' on the re-probe yields a proper cold spawn.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Same factory shape as tmux-pipe-backend.test.ts (bun-compatible: sync require + spread).
vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return {
    ...actual,
    execSync: vi.fn(),
    execFileSync: vi.fn(),
    spawnSync: vi.fn(),
  };
});

vi.mock('node:fs', () => {
  const actual: any = require('node:fs');
  return {
    ...actual,
    openSync: vi.fn(() => 7),
    createReadStream: vi.fn(() => ({
      on() { return this; },
      destroy: vi.fn(),
    })),
    unlinkSync: vi.fn(),
    closeSync: vi.fn(),
    writeSync: vi.fn(),
    constants: actual.constants,
  };
});

import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { TmuxPipeBackend, setStartupTmuxRetrySleepForTests } from '../src/adapters/backend/tmux-pipe-backend.js';
import {
  decideBackendGate,
  persistentReattachBias,
  reconcileBiasedReattachProbe,
  resolveTmuxBackendGate,
  selectSessionBackend,
} from '../src/adapters/backend/session-backend-selector.js';
import { evaluatePersistentPaneMigration } from '../src/adapters/cli/read-isolation.js';
import {
  shouldDeferInitialPromptForReattach,
  shouldDeferInitialPromptForStartup,
  shouldRunStartupCommandsOnSpawn,
} from '../src/core/startup-commands.js';
import { resolveInitialPromptDelivery } from '../src/utils/pending-input-queue.js';
import { shouldQueueInitialPrompt } from '../src/codex-rpc-lifecycle.js';
import { resetTmuxVersionCacheForTests } from '../src/setup/ensure-tmux.js';
import type { SessionProbe } from '../src/adapters/backend/types.js';
import { bufferSpawnResult } from './helpers/spawn-result.js';
import { takePaneLaunchFile } from './helpers/pane-launch.js';

setStartupTmuxRetrySleepForTests(() => {});

const mockedExecSync = vi.mocked(execSync);
const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawnSync = vi.mocked(spawnSync);
const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

const SESSION_ID = 'abcdef12-3456-7890-abcd-ef1234567890';
const noSleep = () => {};

function timeoutError(): Error {
  return Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
}

/** Every tmux command issued so far (execSync strings + execFileSync argv). */
function tmuxCommands(): string[] {
  return [
    ...mockedExecSync.mock.calls.map(c => String(c[0])),
    ...mockedExecFileSync.mock.calls
      .filter(c => c[0] === 'tmux')
      .map(c => `tmux ${(c[1] as string[]).join(' ')}`),
  ];
}

let hasSessionAnswer: () => SessionProbe;

beforeEach(() => {
  mockedExecSync.mockReset().mockReturnValue(Buffer.from('') as any);
  mockedSpawnSync.mockReset().mockReturnValue(bufferSpawnResult({ status: 0 }));
  mockedExecFileSync.mockReset().mockImplementation(((bin: string, args: string[]) => {
    if (bin === 'tmux' && args[0] === 'has-session') {
      const answer = hasSessionAnswer();
      if (answer === 'exists') return Buffer.from('');
      if (answer === 'missing') {
        throw Object.assign(new Error('no session'), {
          status: 1, signal: null, stderr: Buffer.from(`can't find session: ${args[2]}`),
        });
      }
      throw timeoutError();
    }
    return Buffer.from('') as any;
  }) as any);
  hasSessionAnswer = () => 'unknown';
  resetTmuxVersionCacheForTests();
});

function resolveGate(probeFunctional = vi.fn(() => ({ ok: false as const, reason: 'tmux new-session 探测超时（10000ms，signal=SIGTERM）' }))) {
  const name = TmuxBackend.sessionName(SESSION_ID);
  const resolved = resolveTmuxBackendGate({
    probeSession: () => TmuxBackend.probeSessionWithRetry(name, { sleep: noSleep }),
    binaryOnPath: () => true,
    probeFunctional,
  });
  return { resolved, probeFunctional };
}

describe('TmuxBackend.probeSessionWithRetry', () => {
  it('retries only the indeterminate answer', () => {
    const answers: SessionProbe[] = ['unknown', 'unknown', 'exists'];
    const probe = vi.fn(() => answers.shift()!);
    expect(TmuxBackend.probeSessionWithRetry('bmx-x', { probe, sleep: noSleep })).toBe('exists');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('returns authoritative answers immediately (no added cold-start latency)', () => {
    for (const answer of ['exists', 'missing'] as const) {
      const probe = vi.fn(() => answer);
      const sleep = vi.fn();
      expect(TmuxBackend.probeSessionWithRetry('bmx-x', { probe, sleep })).toBe(answer);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it('still reports unknown after exhausting its bounded attempts', () => {
    const probe = vi.fn((): SessionProbe => 'unknown');
    expect(TmuxBackend.probeSessionWithRetry('bmx-x', { probe, sleep: noSleep, attempts: 3 })).toBe('unknown');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('reads a missing socket (clean host / fresh TMUX_TMPDIR) as missing for launch selection only', () => {
    mockedExecFileSync.mockImplementation(((bin: string, args: string[]) => {
      if (bin === 'tmux' && args[0] === 'has-session') {
        throw Object.assign(new Error('no server'), {
          status: 1, signal: null,
          stderr: Buffer.from('error connecting to /tmp/tmux-0/default (No such file or directory)'),
        });
      }
      return Buffer.from('') as any;
    }) as any);
    const sleep = vi.fn();
    expect(TmuxBackend.probeSessionWithRetry('bmx-x', { sleep })).toBe('missing');
    expect(sleep).not.toHaveBeenCalled();
    // Verification callers keep the strict reading: unreachable ≠ proven gone.
    expect(TmuxBackend.probeSession('bmx-x')).toBe('unknown');
  });

  it('keeps a refused connection (busy shared server) indeterminate', () => {
    mockedExecFileSync.mockImplementation(((bin: string, args: string[]) => {
      if (bin === 'tmux' && args[0] === 'has-session') {
        throw Object.assign(new Error('refused'), {
          status: 1, signal: null,
          stderr: Buffer.from('error connecting to /tmp/tmux-0/default (Connection refused)'),
        });
      }
      return Buffer.from('') as any;
    }) as any);
    expect(TmuxBackend.probeSessionWithRetry('bmx-x', { sleep: noSleep })).toBe('unknown');
  });

  it('classifies a real has-session timeout as unknown (never missing)', () => {
    expect(TmuxBackend.probeSessionWithRetry('bmx-x', { sleep: noSleep })).toBe('unknown');
    const hasSessionCalls = mockedExecFileSync.mock.calls.filter(c => (c[1] as string[])[0] === 'has-session');
    expect(hasSessionCalls).toHaveLength(3);
  });
});

describe('resolveTmuxBackendGate', () => {
  it('does NOT gate (and skips the load-starved functional probe) when existence is indeterminate', () => {
    const { resolved, probeFunctional } = resolveGate();
    expect(resolved.probe).toBe('unknown');
    expect(resolved.existingSessionUnknown).toBe(true);
    expect(probeFunctional).not.toHaveBeenCalled();
    expect(decideBackendGate({ requested: 'tmux', ...resolved }).action).toBe('spawn');
  });

  it('turns unknown into missing when the binary is not on PATH, so the install card still shows', () => {
    const probeFunctional = vi.fn(() => ({ ok: false as const, reason: 'tmux -V 启动/探测失败：spawnSync tmux ENOENT' }));
    const resolved = resolveTmuxBackendGate({
      probeSession: () => 'unknown',
      binaryOnPath: () => false,
      probeFunctional,
    });
    expect(resolved.probe).toBe('missing');
    expect(probeFunctional).toHaveBeenCalledTimes(1);
    expect(decideBackendGate({ requested: 'tmux', ...resolved }).action).toBe('gate');
  });

  it('still gates on an authoritative missing + failed functional probe', () => {
    hasSessionAnswer = () => 'missing';
    const { resolved, probeFunctional } = resolveGate();
    expect(probeFunctional).toHaveBeenCalledTimes(1);
    expect(decideBackendGate({ requested: 'tmux', ...resolved }).action).toBe('gate');
  });

  it('reattaches an authoritative existing session without the functional probe (PR#249)', () => {
    hasSessionAnswer = () => 'exists';
    const { resolved, probeFunctional } = resolveGate();
    expect(probeFunctional).not.toHaveBeenCalled();
    expect(resolved.hasExistingSession).toBe(true);
    expect(persistentReattachBias(resolved.probe)).toBe(true);
  });
});

describe('indeterminate probe → selector → spawn → worker decisions (single chain)', () => {
  function runChain() {
    const { resolved } = resolveGate();
    const gate = decideBackendGate({ requested: 'tmux', ...resolved });
    const reconciled = reconcileBiasedReattachProbe(
      resolved.probe,
      () => TmuxBackend.probeSessionWithRetry(TmuxBackend.sessionName(SESSION_ID), { sleep: noSleep }),
    );
    const selected = selectSessionBackend({
      sessionId: SESSION_ID,
      backendType: 'tmux',
      hasExistingSession: persistentReattachBias(reconciled),
    });
    return { gate, reconciled, selected };
  }

  it('reattaches with predicted === actual outcome; no new-session, so nothing is swallowed', () => {
    const { gate, reconciled, selected } = runChain();
    expect(gate.action).toBe('spawn');
    expect(reconciled).toBe('unknown');
    // (a) predicted AND actual are reattach — the worker's willReattachPersistent
    // is computed from selected.isReattach and the backend getter agrees.
    expect(selected.isReattach).toBe(true);
    const backend = selected.backend as TmuxPipeBackend;
    expect(backend).toBeInstanceOf(TmuxPipeBackend);
    expect(backend.isReattach).toBe(true);

    const willReattachPersistent = selected.isReattach === true;
    backend.spawn('gemini', ['-i', 'first user message'], {
      cwd: '/tmp', cols: 200, rows: 50,
      env: process.env as Record<string, string>,
      strictEnvReattach: willReattachPersistent,
    });
    const cmds = tmuxCommands();
    expect(cmds.some(c => c.includes('new-session'))).toBe(false);
    expect(cmds.some(c => c.includes('pipe-pane') && c.includes('bmx-abcdef12'))).toBe(true);
    expect(backend.isReattach).toBe(true);

    // (b) P2: startupCommands are NOT replayed into the live CLI.
    expect(shouldRunStartupCommandsOnSpawn({ willReattachPersistent })).toBe(false);

    // (c) P1: an args-baked first prompt is not left in a never-executed argv;
    // it is queued for the live CLI (and init only commits it via the queue).
    const defer = shouldDeferInitialPromptForStartup({
      hasStartupCommands: false, adoptMode: false, passesInitialPromptViaArgs: true,
    }) || shouldDeferInitialPromptForReattach({
      willReattachPersistent, adoptMode: false, passesInitialPromptViaArgs: true,
    });
    expect(defer).toBe(true);
    const delivery = resolveInitialPromptDelivery({ originalPrompt: 'first user message', defer });
    expect(delivery.argvPrompt).toBeUndefined();
    expect(delivery.queuedContent).toBe('first user message');
    expect(shouldQueueInitialPrompt({
      hasPrompt: true,
      rpcEngineActive: false,
      queuePrompt: false,
      passesInitialPromptViaArgs: true,
      deferInitialPrompt: defer,
    })).toBe(true);

    // (d) P1 isolation: with a policy-ON spawn the read-isolation gate refuses
    // an unverifiable pane outright (no marker cleared, no fresh marker forged),
    // and the fresh boot marker is only ever written on a predicted-fresh path.
    expect(evaluatePersistentPaneMigration({
      appliedIsolationCapabilities: ['file'],
      isolationCapableBackend: true,
      noTransport: false,
      isolationMarkerPresent: true,
      policyOffTombstonePresent: false,
      policyOffTombstoneValid: false,
      paneProbe: 'unknown',
      pendingProvenancePresent: false,
      isolationMarkerReattachSafe: false,
    } as any).action).toBe('refuse-inconclusive-probe');
  });

  it('fails CLOSED when the biased reattach meets a pane that is really gone', () => {
    mockedExecSync.mockImplementation(((cmd: any) => {
      if (String(cmd).includes('pipe-pane')) {
        throw Object.assign(new Error('cmd failed'), {
          status: 1, signal: null, stderr: Buffer.from("can't find pane: bmx-abcdef12"),
        });
      }
      return Buffer.from('') as any;
    }) as any);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { selected } = runChain();
      const exits: unknown[] = [];
      selected.backend.onExit((code, signal) => exits.push([code, signal]));
      expect(() => selected.backend.spawn('gemini', ['-i', 'first user message'], {
        cwd: '/tmp', cols: 200, rows: 50, env: process.env as Record<string, string>,
        strictEnvReattach: true,
      })).toThrow();
      // No fresh session was created behind the worker's back.
      expect(tmuxCommands().some(c => c.includes('new-session'))).toBe(false);
      expect(exits).toEqual([[1, null]]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('an authoritative missing on the pre-spawn re-probe yields a real cold spawn', () => {
    const answers: SessionProbe[] = ['unknown', 'unknown', 'unknown', 'missing'];
    hasSessionAnswer = () => answers.shift() ?? 'missing';
    const { gate, reconciled, selected } = runChain();
    expect(gate.action).toBe('spawn');
    expect(reconciled).toBe('missing');
    expect(selected.isReattach).toBe(false);
    selected.backend.spawn('gemini', ['-i', 'first user message'], {
      cwd: '/tmp', cols: 200, rows: 50, env: process.env as Record<string, string>,
    });
    const newSession = mockedExecFileSync.mock.calls.find(c => (c[1] as string[]).includes('new-session'));
    expect(newSession).toBeDefined();
    // The CLI argv reaches the pane through its launch file, not the tmux command.
    expect(takePaneLaunchFile(newSession![1] as string[]).body).toContain(`'first user message'`);
  });

  it('keeps the fresh-path invariant: a predicted-fresh create that collides throws (no duplicate swallowing)', () => {
    hasSessionAnswer = () => 'missing';
    mockedExecFileSync.mockImplementation(((bin: string, args: string[]) => {
      if (bin === 'tmux' && args[0] === 'has-session') {
        throw Object.assign(new Error('no session'), { status: 1, signal: null, stderr: Buffer.from("can't find session") });
      }
      if (bin === 'tmux' && args.includes('new-session')) {
        throw Object.assign(new Error('duplicate'), { status: 1, signal: null, stderr: Buffer.from('duplicate session: bmx-abcdef12') });
      }
      return Buffer.from('') as any;
    }) as any);
    const selected = selectSessionBackend({ sessionId: SESSION_ID, backendType: 'tmux', hasExistingSession: false });
    expect(() => selected.backend.spawn('gemini', [], {
      cwd: '/tmp', cols: 200, rows: 50, env: process.env as Record<string, string>,
    })).toThrow(/duplicate/);
  });
});

describe('worker consumes the reattach prediction at spawn', () => {
  // 源码结构护栏(K2/K3)：worker.ts 是无导出的进程入口，下面两处消费 willReattachPersistent 的分支在
  // spawn 闭包里，没有行为 seam（上面的链路用例跑的是它们调用的纯函数）。#833 写明预测 reattach 时：
  // ① 读隔离不得为未执行 wrapper 的旧 pane 写 fresh boot marker——那等于伪造隔离证明（K2）；
  // ② argv 传首条 prompt 的 CLI 必须改走输入队列——reattach 不执行启动 argv，原来会静默丢首条消息（K3）。
  it('never writes a fresh isolation proof nor bakes the first prompt into argv on a predicted reattach', () => {
    const markerGate = workerSource.match(/if \(appliedIsolationCapabilities\.length > 0 && [^)]*\)/);
    expect(markerGate?.[0]).toContain('!willReattachPersistent');
    expect(workerSource).toMatch(/shouldDeferInitialPromptForReattach\(\{[^}]*\bwillReattachPersistent\b/);
  });
});
