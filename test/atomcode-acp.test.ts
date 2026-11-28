import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AtomcodeAcpSession,
  type AtomcodeAcpSessionOptions,
  type AtomcodeAcpTurnOptions,
  createAtomcodeFrameReader,
  parseAtomcodeIdleTimeout,
} from '../src/services/atomcode-acp.js';

const fixtureScript = resolve('test/fixtures/fake-atomcode-acp.mjs');
const tempDirs: string[] = [];

function createFixture(extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-atomcode-acp-'));
  tempDirs.push(root);
  const logFile = join(root, 'acp.log');
  const bin = join(root, 'atomcode');
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixtureScript)} "$@"\n`);
  chmodSync(bin, 0o755);
  return {
    root,
    bin,
    logFile,
    env: { ...process.env, ATOMCODE_TEST_LOG: logFile, ...extraEnv },
    readLog: () => {
      try {
        return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isSpawnGone(spawnEntry: { pid: number; ppid?: number } | undefined): boolean {
  if (!spawnEntry?.pid) return false;
  if (isPidAlive(spawnEntry.pid)) return false;
  // spawnOwnedModelProcess wraps the native CLI in an OWNER_GUARD shell (ppid);
  // wait until that wrapper exits too so the OS child process has actually closed.
  if (spawnEntry.ppid && spawnEntry.ppid !== process.pid && isPidAlive(spawnEntry.ppid)) {
    return false;
  }
  return true;
}

async function runSingleTurn(
  opts: AtomcodeAcpSessionOptions & AtomcodeAcpTurnOptions,
  signal: AbortSignal,
) {
  const session = new AtomcodeAcpSession({
    executable: opts.executable,
    cwd: opts.cwd,
    env: opts.env,
    nativeSessionId: opts.nativeSessionId,
    model: opts.model,
    effort: opts.effort,
    permission: opts.permission,
    idleTimeoutMs: 0,
    onSession: opts.onSession,
  });
  try {
    return await session.runTurn({
      content: opts.content,
      onUpdate: opts.onUpdate,
      onUserInput: opts.onUserInput,
      onInteractionPending: opts.onInteractionPending,
    }, signal);
  } finally {
    await session.close(false);
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for expected ACP state');
    await new Promise(r => setTimeout(r, 15));
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createAtomcodeFrameReader', () => {
  it('reassembles UTF-8 characters split across chunks', () => {
    const lines: string[] = [];
    const read = createAtomcodeFrameReader(line => { lines.push(line); });
    const raw = Buffer.from('{"text":"你好世界"}\n', 'utf8');
    read(raw.subarray(0, 11));
    read(raw.subarray(11));
    expect(lines).toEqual(['{"text":"你好世界"}']);
  });
});

describe('parseAtomcodeIdleTimeout', () => {
  it('accepts omitted default, zero, and positive integers while rejecting invalid values', () => {
    expect(parseAtomcodeIdleTimeout(undefined)).toBeGreaterThan(0);
    expect(parseAtomcodeIdleTimeout('0')).toBe(0);
    expect(parseAtomcodeIdleTimeout('15000')).toBe(15_000);
    expect(() => parseAtomcodeIdleTimeout('')).toThrow();
    expect(() => parseAtomcodeIdleTimeout('-1')).toThrow();
    expect(() => parseAtomcodeIdleTimeout('1.5')).toThrow();
    expect(() => parseAtomcodeIdleTimeout('abc')).toThrow();
    expect(() => parseAtomcodeIdleTimeout('2147483648')).toThrow();
  });
});

describe('AtomcodeAcpSession single-turn mode', () => {
  it('starts a new session, applies model/effort/mode options, and closes cleanly', async () => {
    const f = createFixture();
    const sessions: string[] = [];
    const result = await runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'hello',
      model: 'codingplan/glm-5',
      effort: 'high',
      permission: 'full',
      onSession: sid => sessions.push(sid),
      onUserInput: async () => ({}),
    }, new AbortController().signal);

    expect(result).toEqual({
      sessionId: 'acp-fixture-session-1',
      content: 'echo:hello|mode=bypass|model=codingplan/glm-5|effort=high',
    });
    expect(sessions).toEqual(['acp-fixture-session-1']);
    const entries = f.readLog();
    expect(entries[0].args).toEqual(['--no-telemetry', '--dangerously-skip-permissions', 'acp']);
    expect(entries.some(e => e.message?.method === 'session/close')).toBe(true);
  });

  it('resumes an existing session and ignores pre-prompt replay updates', async () => {
    const f = createFixture();
    const result = await runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: '/compact',
      nativeSessionId: 'acp-existing-123',
      permission: 'smart',
      onUserInput: async () => ({}),
    }, new AbortController().signal);

    expect(result.sessionId).toBe('acp-existing-123');
    expect(result.content).toContain('compact requested');
    const entries = f.readLog();
    expect(entries[0].args).toEqual(['--no-telemetry', 'acp']);
    expect(entries.some(e => e.message?.method === 'session/resume' && e.message.params.sessionId === 'acp-existing-123')).toBe(true);
  });

  it('retains only the final assistant message block across tool calls and messageId changes', async () => {
    const f = createFixture();
    const updates: string[] = [];
    const result = await runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'multi-round',
      permission: 'full',
      onUpdate: u => updates.push(u.sessionUpdate),
      onUserInput: async () => ({}),
    }, new AbortController().signal);

    expect(result.content).toBe('final answer');
    expect(updates).toContain('tool_call');
  });

  it('bridges elicitation/create and session/request_permission while toggling onInteractionPending', async () => {
    const f = createFixture();
    const pendingTransitions: boolean[] = [];
    const formResult = await runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'ask-form',
      permission: 'smart',
      onInteractionPending: w => pendingTransitions.push(w),
      onUserInput: async (method) => {
        expect(method).toBe('elicitation/create');
        return { action: 'accept', content: { answer: 'B' } };
      },
    }, new AbortController().signal);
    expect(formResult.content).toBe('form:{"action":"accept","content":{"answer":"B"}}');
    expect(pendingTransitions).toEqual([true, false]);

    const permResult = await runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'ask-permission',
      permission: 'smart',
      onUserInput: async (method) => {
        expect(method).toBe('session/request_permission');
        return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
      },
    }, new AbortController().signal);
    expect(permResult.content).toBe('perm:{"outcome":{"outcome":"selected","optionId":"allow_once"}}');
  });

  it('fails closed on unavailable model, unsupported protocol version, refusal, and abort', async () => {
    const f = createFixture();
    await expect(runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'hello',
      model: 'missing-model',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal)).rejects.toThrow(/不支持配置 model=missing-model/);

    const fVer = createFixture({ ATOMCODE_ACP_SCENARIO: 'version' });
    await expect(runSingleTurn({
      executable: fVer.bin,
      cwd: fVer.root,
      env: fVer.env,
      content: 'hello',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal)).rejects.toThrow(/atomcode_acp_version_unsupported/);

    await expect(runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'refusal',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal)).rejects.toThrow(/refusal/);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    await expect(runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'hang',
      permission: 'full',
      onUserInput: async () => ({}),
    }, controller.signal)).rejects.toThrow(/aborted/);
  });

  it('replies -32601 to unsupported client methods without breaking the turn', async () => {
    const f = createFixture();
    const result = await runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'unknown-client-method',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal);
    expect(result.content).toBe('unsupported:-32601');
  });

  it('accepts a decoded 8 MB reply whose NDJSON frame exceeds 8 MB via envelope and escaping', async () => {
    const f = createFixture();
    const ascii = await runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'big-ascii-8m',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal);
    expect(Buffer.byteLength(ascii.content)).toBe(8_000_000);

    const quoted = await runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'big-quotes-4m',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal);
    expect(quoted.content).toBe('"'.repeat(4_000_000));

    // Six-byte control-char escaping: only 2.8 MB decoded but ~16.8 MB on the
    // wire. Must stay within the frame cap derived from the 6x content ratio.
    const nul = await runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'big-nul-2m8',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal);
    expect(Buffer.byteLength(nul.content)).toBe(2_800_000);
  });

  it('still rejects decoded content past the 8 MB cap and wire frames past the line cap', async () => {
    const f = createFixture();
    await expect(runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'over-content',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal)).rejects.toThrow(/atomcode_acp_content_limit/);

    await expect(runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'oversized-frame',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal)).rejects.toThrow(/atomcode_acp_frame_limit/);
  });
});

describe('AtomcodeAcpSession persistent lifecycle', () => {
  it('reuses one warm ACP process across consecutive turns including interactive prompts without state leakage', async () => {
    const f = createFixture();
    const sessions: string[] = [];
    const session = new AtomcodeAcpSession({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      model: 'codingplan/glm-5',
      effort: 'high',
      permission: 'smart',
      idleTimeoutMs: 30_000,
      onSession: sid => sessions.push(sid),
    });

    let firstSpawn: { pid: number; ppid?: number } | undefined;
    try {
      const r1 = await session.runTurn({
        content: 'multi-round',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      expect(r1).toEqual({ sessionId: 'acp-fixture-session-1', content: 'final answer' });
      firstSpawn = f.readLog().find(e => Array.isArray(e.args));
      expect(isPidAlive(firstSpawn!.pid)).toBe(true);

      const pendingTransitions: boolean[] = [];
      const r2 = await session.runTurn({
        content: 'ask-form',
        onInteractionPending: w => pendingTransitions.push(w),
        onUserInput: async () => ({ action: 'accept', content: { answer: 'A' } }),
      }, new AbortController().signal);
      expect(r2.content).toBe('form:{"action":"accept","content":{"answer":"A"}}');
      expect(pendingTransitions).toEqual([true, false]);

      const r3 = await session.runTurn({
        content: 'third-turn',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      expect(r3.content).toBe('echo:third-turn|mode=build|model=codingplan/glm-5|effort=high');
      expect(sessions).toEqual(['acp-fixture-session-1']);
    } finally {
      await session.close();
    }

    expect(isSpawnGone(firstSpawn)).toBe(true);
    const entries = f.readLog();
    const spawns = entries.filter(e => Array.isArray(e.args));
    expect(spawns).toHaveLength(1);
    expect(entries.filter(e => e.message?.method === 'initialize')).toHaveLength(1);
    expect(entries.filter(e => e.message?.method === 'session/new')).toHaveLength(1);
    expect(entries.filter(e => e.message?.method === 'session/resume')).toHaveLength(0);
    expect(entries.filter(e => e.message?.method === 'session/prompt')).toHaveLength(3);
    expect(entries.filter(e => e.message?.method === 'session/close')).toHaveLength(1);
  });

  it('releases the idle ACP process and session lease after idleTimeoutMs and resumes cleanly on the next turn', async () => {
    const f = createFixture();
    const session = new AtomcodeAcpSession({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      permission: 'full',
      idleTimeoutMs: 100,
    });

    try {
      const r1 = await session.runTurn({
        content: 'before-idle',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      expect(r1.sessionId).toBe('acp-fixture-session-1');
      const firstSpawn = f.readLog().find(e => Array.isArray(e.args));

      await waitFor(() => f.readLog().some(e => e.event === 'close_done') && isSpawnGone(firstSpawn));

      const r2 = await session.runTurn({
        content: 'after-idle',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      expect(r2.sessionId).toBe('acp-fixture-session-1');
      expect(r2.content).toContain('echo:after-idle');
    } finally {
      await session.close();
    }

    const entries = f.readLog();
    const spawns = entries.filter(e => Array.isArray(e.args));
    expect(spawns).toHaveLength(2);
    expect(spawns[0].pid).not.toBe(spawns[1].pid);
    expect(entries.some(e => e.message?.method === 'session/resume' && e.message.params.sessionId === 'acp-fixture-session-1')).toBe(true);
  });

  it('serializes a new turn behind an in-flight idle session/close so lease release completes before respawn', async () => {
    const f = createFixture({ ATOMCODE_ACP_CLOSE_DELAY_MS: '220' });
    const session = new AtomcodeAcpSession({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      permission: 'full',
      idleTimeoutMs: 60,
    });

    try {
      await session.runTurn({
        content: 'turn-1',
        onUserInput: async () => ({}),
      }, new AbortController().signal);

      // Wait until the idle close request has actually reached process #1, while
      // process #1 is still delaying its close_done response (holding the lease).
      await waitFor(() => f.readLog().some(e => e.message?.method === 'session/close'));
      expect(f.readLog().some(e => e.event === 'close_done')).toBe(false);

      const r2 = await session.runTurn({
        content: 'turn-2-during-close',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      expect(r2.content).toContain('echo:turn-2-during-close');
    } finally {
      await session.close();
    }

    const entries = f.readLog();
    const spawns = entries
      .map((entry, idx) => ({ entry, idx }))
      .filter(({ entry }) => Array.isArray(entry.args));
    expect(spawns).toHaveLength(2);
    const firstCloseDoneIdx = entries.findIndex(e => e.event === 'close_done' && e.pid === spawns[0].entry.pid);
    expect(firstCloseDoneIdx).toBeGreaterThan(-1);
    expect(firstCloseDoneIdx).toBeLessThan(spawns[1].idx);
  });

  it('recovers via session/resume after mid-turn crash, invalid JSON, or abort without losing sessionId', async () => {
    const f = createFixture();
    const session = new AtomcodeAcpSession({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      permission: 'full',
      idleTimeoutMs: 30_000,
    });

    try {
      const r1 = await session.runTurn({
        content: 'seed',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      expect(r1.sessionId).toBe('acp-fixture-session-1');

      await expect(session.runTurn({
        content: 'crash',
        onUserInput: async () => ({}),
      }, new AbortController().signal)).rejects.toThrow(/atomcode_acp_process_exited/);

      const rAfterCrash = await session.runTurn({
        content: 'after-crash',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      expect(rAfterCrash).toEqual({
        sessionId: 'acp-fixture-session-1',
        content: 'echo:after-crash|mode=bypass|model=demo-default|effort=off',
      });

      await expect(session.runTurn({
        content: 'invalid-json',
        onUserInput: async () => ({}),
      }, new AbortController().signal)).rejects.toThrow();

      const rAfterBadJson = await session.runTurn({
        content: 'after-bad-json',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      expect(rAfterBadJson.content).toContain('echo:after-bad-json');

      const abortController = new AbortController();
      setTimeout(() => abortController.abort(), 60);
      await expect(session.runTurn({
        content: 'hang',
        onUserInput: async () => ({}),
      }, abortController.signal)).rejects.toThrow(/aborted/);

      const rAfterAbort = await session.runTurn({
        content: 'after-abort',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      expect(rAfterAbort.content).toContain('echo:after-abort');
    } finally {
      await session.close();
    }

    const entries = f.readLog();
    const spawns = entries.filter(e => Array.isArray(e.args));
    expect(spawns).toHaveLength(4);
    expect(entries.filter(e => e.message?.method === 'session/resume')).toHaveLength(3);
  });

  it('detaches cleanly on idle child exit, idle garbage frame, or unsolicited idle request and resumes on next turn', async () => {
    for (const trigger of ['idle-exit-after-turn', 'idle-garbage-after-turn', 'idle-request-after-turn'] as const) {
      const f = createFixture();
      const session = new AtomcodeAcpSession({
        executable: f.bin,
        cwd: f.root,
        env: f.env,
        permission: 'full',
        idleTimeoutMs: 30_000,
      });

      try {
        const r1 = await session.runTurn({
          content: trigger,
          onUserInput: async () => ({}),
        }, new AbortController().signal);
        expect(r1.sessionId).toBe('acp-fixture-session-1');
        const firstSpawn = f.readLog().find(e => Array.isArray(e.args));

        await waitFor(() => isSpawnGone(firstSpawn));

        const r2 = await session.runTurn({
          content: `recovered-${trigger}`,
          onUserInput: async () => ({}),
        }, new AbortController().signal);
        expect(r2.content).toContain(`echo:recovered-${trigger}`);
      } finally {
        await session.close();
      }

      const entries = f.readLog();
      expect(entries.filter(e => Array.isArray(e.args))).toHaveLength(2);
      expect(entries.filter(e => e.message?.method === 'session/resume')).toHaveLength(1);
    }
  });

  it('aborts an in-flight open() on close(), escalates slow idle close on close(false), and resets interaction state synchronously', async () => {
    // 1. close() during delayed initialize must abort open() promptly and never run session/prompt.
    const fInit = createFixture({ ATOMCODE_ACP_INIT_DELAY_MS: '1500' });
    const sInit = new AtomcodeAcpSession({
      executable: fInit.bin,
      cwd: fInit.root,
      env: fInit.env,
      permission: 'full',
      idleTimeoutMs: 30_000,
    });
    const turnDuringInit = sInit.runTurn({
      content: 'should-not-run',
      onUserInput: async () => ({}),
    }, new AbortController().signal);
    await waitFor(() => fInit.readLog().some(e => e.message?.method === 'initialize'));
    const tInit = Date.now();
    await sInit.close(false);
    await expect(turnDuringInit).rejects.toThrow(/aborted|closed/);
    expect(Date.now() - tInit).toBeLessThan(800);
    expect(fInit.readLog().some(e => e.message?.method === 'session/prompt')).toBe(false);

    // 2. close(false) must escalate an in-flight slow idle session/close immediately.
    const fClose = createFixture({ ATOMCODE_ACP_CLOSE_DELAY_MS: '2000' });
    const sClose = new AtomcodeAcpSession({
      executable: fClose.bin,
      cwd: fClose.root,
      env: fClose.env,
      permission: 'full',
      idleTimeoutMs: 50,
    });
    await sClose.runTurn({ content: 'hello', onUserInput: async () => ({}) }, new AbortController().signal);
    await waitFor(() => fClose.readLog().some(e => e.message?.method === 'session/close'));
    const t0 = Date.now();
    await sClose.close(false);
    expect(Date.now() - t0).toBeLessThan(1_000);

    // 3. close(true) during an active onUserInput wait must unblock immediately without waiting for session/close timeout,
    //    and onInteractionPending(false) must fire synchronously before runTurn() rejects.
    const fAsk = createFixture();
    const sAsk = new AtomcodeAcpSession({
      executable: fAsk.bin,
      cwd: fAsk.root,
      env: fAsk.env,
      permission: 'smart',
      idleTimeoutMs: 30_000,
    });
    let waiting = false;
    let inputAborted = false;
    let releaseLateInput!: () => void;
    const lateInput = new Promise<void>(resolve => { releaseLateInput = resolve; });
    const askTurn = sAsk.runTurn({
      content: 'ask-form',
      onInteractionPending: w => { waiting = w; },
      onUserInput: async (_method, _params, signal) => {
        signal.addEventListener('abort', () => { inputAborted = true; }, { once: true });
        await lateInput;
        return { action: 'accept', content: { answer: 'A' } };
      },
    }, new AbortController().signal);
    await waitFor(() => waiting);
    const tAsk = Date.now();
    await sAsk.close(true);
    await expect(askTurn).rejects.toThrow();
    expect(Date.now() - tAsk).toBeLessThan(1_500);
    expect(inputAborted).toBe(true);
    expect(waiting).toBe(false);
    expect(fAsk.readLog().some(e => e.event === 'interaction_cancelled' && e.id === 'form-1')).toBe(true);
    expect(fAsk.readLog().filter(e => e.event === 'cancel_received')).toHaveLength(1);
    releaseLateInput();

    // 4. Negative idleTimeoutMs is rejected fail-closed.
    expect(() => new AtomcodeAcpSession({
      executable: fAsk.bin,
      cwd: fAsk.root,
      env: fAsk.env,
      permission: 'full',
      idleTimeoutMs: -5,
    })).toThrow(/invalid_atomcode_idle_timeout/);
  });

  it('delivers session/cancel cooperatively on abort before tearing down the process', async () => {
    const f = createFixture();
    const session = new AtomcodeAcpSession({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      permission: 'full',
      idleTimeoutMs: 30_000,
    });
    const controller = new AbortController();
    const turn = session.runTurn({
      content: 'hang',
      onUserInput: async () => ({}),
    }, controller.signal);
    await waitFor(() => f.readLog().some(e => e.message?.method === 'session/prompt'));
    controller.abort();
    await expect(turn).rejects.toThrow(/aborted/);
    expect(f.readLog().some(e => e.event === 'cancel_received')).toBe(true);
    await session.close();
  });

  it('retries session/resume on the same ACP process until a busy lease releases, fails fast on non-lease errors, and honors abort', async () => {
    // 1. Exclusive lease held across several fixed-interval retries, then released -> one spawn and success.
    const fBusy = createFixture();
    const leaseFile = join(fBusy.root, 'session.lease');
    writeFileSync(leaseFile, 'held');
    const releaseTimer = setTimeout(() => { try { unlinkSync(leaseFile); } catch { /* ignore */ } }, 1_600);
    const sBusy = new AtomcodeAcpSession({
      executable: fBusy.bin,
      cwd: fBusy.root,
      env: { ...fBusy.env, ATOMCODE_ACP_LEASE_FILE: leaseFile },
      nativeSessionId: 'acp-fixture-session-1',
      permission: 'full',
      idleTimeoutMs: 30_000,
    });
    try {
      const result = await sBusy.runTurn({
        content: 'after-lease-release',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      expect(result).toEqual({
        sessionId: 'acp-fixture-session-1',
        content: 'echo:after-lease-release|mode=bypass|model=demo-default|effort=off',
      });
    } finally {
      clearTimeout(releaseTimer);
      await sBusy.close();
    }
    const busyEntries = fBusy.readLog();
    expect(busyEntries.filter(e => Array.isArray(e.args))).toHaveLength(1);
    expect(busyEntries.some(e => e.event === 'resume_lease_busy')).toBe(true);
    expect(busyEntries.filter(e => e.message?.method === 'session/resume').length).toBeGreaterThanOrEqual(2);
    const resumeTimes = busyEntries
      .filter(e => e.message?.method === 'session/resume')
      .map(e => e.at);
    expect(resumeTimes.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < resumeTimes.length; i++) {
      expect(resumeTimes[i] - resumeTimes[i - 1]).toBeGreaterThanOrEqual(400);
    }

    // 2. Non-lease RPC errors (e.g. unknown session) must fail immediately without retrying.
    const fUnknown = createFixture({ ATOMCODE_ACP_SCENARIO: 'unknown-session' });
    await expect(runSingleTurn({
      executable: fUnknown.bin,
      cwd: fUnknown.root,
      env: fUnknown.env,
      nativeSessionId: 'acp-missing',
      content: 'hello',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal)).rejects.toThrow(/unknown session/);
    expect(fUnknown.readLog().filter(e => e.message?.method === 'session/resume')).toHaveLength(1);

    const fWrongCode = createFixture({ ATOMCODE_ACP_RESUME_CONFLICT_CODE: '-32000' });
    const wrongCodeLease = join(fWrongCode.root, 'wrong-code.lease');
    writeFileSync(wrongCodeLease, 'held');
    await expect(runSingleTurn({
      executable: fWrongCode.bin,
      cwd: fWrongCode.root,
      env: { ...fWrongCode.env, ATOMCODE_ACP_LEASE_FILE: wrongCodeLease },
      nativeSessionId: 'acp-wrong-code',
      content: 'hello',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal)).rejects.toThrow(/session is active in another atomcode process/);
    expect(fWrongCode.readLog().filter(e => e.message?.method === 'session/resume')).toHaveLength(1);

    // 3. Caller abort during lease retry backoff unblocks immediately instead of waiting out the full budget.
    const fAbort = createFixture();
    const stuckLease = join(fAbort.root, 'stuck.lease');
    writeFileSync(stuckLease, 'held-forever');
    const sAbort = new AtomcodeAcpSession({
      executable: fAbort.bin,
      cwd: fAbort.root,
      env: { ...fAbort.env, ATOMCODE_ACP_LEASE_FILE: stuckLease },
      nativeSessionId: 'acp-fixture-session-1',
      permission: 'full',
      idleTimeoutMs: 30_000,
    });
    const controller = new AbortController();
    const abortTurn = sAbort.runTurn({
      content: 'should-abort',
      onUserInput: async () => ({}),
    }, controller.signal);
    await waitFor(() => fAbort.readLog().some(e => e.event === 'resume_lease_busy'));
    const abortedAt = Date.now();
    controller.abort();
    await expect(abortTurn).rejects.toThrow(/aborted/);
    expect(Date.now() - abortedAt).toBeLessThan(300);
    await sAbort.close(false);

    // 4. Subprocess crash during lease-wait backoff must surface atomcode_acp_process_exited (not aborted).
    const fCrashWait = createFixture({ ATOMCODE_ACP_SCENARIO: 'crash-during-lease-wait' });
    await expect(runSingleTurn({
      executable: fCrashWait.bin,
      cwd: fCrashWait.root,
      env: fCrashWait.env,
      nativeSessionId: 'acp-fixture-session-1',
      content: 'hello',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal)).rejects.toThrow(/atomcode_acp_process_exited/);
  });

  it('applies the same lease wait to the session/load fallback', async () => {
    const f = createFixture({ ATOMCODE_ACP_SCENARIO: 'load' });
    const leaseFile = join(f.root, 'load.lease');
    writeFileSync(leaseFile, 'held');
    const releaseTimer = setTimeout(() => { try { unlinkSync(leaseFile); } catch { /* ignore */ } }, 1_100);
    try {
      const result = await runSingleTurn({
        executable: f.bin,
        cwd: f.root,
        env: { ...f.env, ATOMCODE_ACP_LEASE_FILE: leaseFile },
        nativeSessionId: 'acp-load-lease',
        content: 'hello',
        permission: 'full',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      expect(result.content).toContain('echo:hello');
    } finally {
      clearTimeout(releaseTimer);
    }
    const entries = f.readLog();
    expect(entries.filter(e => e.message?.method === 'session/load').length).toBeGreaterThanOrEqual(2);
    expect(entries.some(e => e.message?.method === 'session/resume')).toBe(false);
  });

  it('fails the original lease conflict after the bounded wait when another process never releases', async () => {
    const f = createFixture();
    const leaseFile = join(f.root, 'permanent.lease');
    writeFileSync(leaseFile, 'held-by-another-process');
    await expect(runSingleTurn({
      executable: f.bin,
      cwd: f.root,
      env: { ...f.env, ATOMCODE_ACP_LEASE_FILE: leaseFile },
      nativeSessionId: 'acp-permanent-lease',
      content: 'hello',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal)).rejects.toThrow(/session is active in another atomcode process/);
    expect(f.readLog().filter(e => e.message?.method === 'session/resume').length).toBeGreaterThan(1);
  }, 20_000);

  it('unparks pending permission RPC on abort and lets close(true) cancel cooperatively without duplicate session/cancel', async () => {
    // 1. Aborting during session/request_permission replies with cancelled outcome so AtomCode unparks promptly.
    const fPerm = createFixture();
    const sPerm = new AtomcodeAcpSession({
      executable: fPerm.bin,
      cwd: fPerm.root,
      env: fPerm.env,
      permission: 'smart',
      idleTimeoutMs: 30_000,
    });
    let permWaiting = false;
    const permController = new AbortController();
    const permTurn = sPerm.runTurn({
      content: 'ask-permission',
      onInteractionPending: w => { permWaiting = w; },
      onUserInput: async (_method, _params, signal) => {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { outcome: { outcome: 'cancelled' } };
      },
    }, permController.signal);
    await waitFor(() => permWaiting);
    const tPerm = Date.now();
    permController.abort();
    await expect(permTurn).rejects.toThrow(/aborted/);
    expect(Date.now() - tPerm).toBeLessThan(1_000);
    expect(fPerm.readLog().some(e => e.event === 'interaction_cancelled' && e.id === 'perm-1')).toBe(true);
    await sPerm.close();

    // 2. close(true) during an active turn sends session/cancel once and waits cooperatively instead of SIGKILLing at 1ms.
    const fGrace = createFixture({ ATOMCODE_ACP_CANCEL_DELAY_MS: '150' });
    const sGrace = new AtomcodeAcpSession({
      executable: fGrace.bin,
      cwd: fGrace.root,
      env: fGrace.env,
      permission: 'full',
      idleTimeoutMs: 30_000,
    });
    const hangTurn = sGrace.runTurn({
      content: 'hang',
      onUserInput: async () => ({}),
    }, new AbortController().signal);
    await waitFor(() => fGrace.readLog().some(e => e.message?.method === 'session/prompt'));
    const tGrace = Date.now();
    await sGrace.close(true);
    await expect(hangTurn).rejects.toThrow(/aborted|closed/);
    expect(Date.now() - tGrace).toBeGreaterThanOrEqual(120);
    expect(Date.now() - tGrace).toBeLessThan(1_500);
    expect(fGrace.readLog().filter(e => e.event === 'cancel_received')).toHaveLength(1);
  });

  it('settles active turns and teardown promptly on OS exit even when a detached grandchild inherits stdio', async () => {
    const f = createFixture();
    const session = new AtomcodeAcpSession({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      permission: 'full',
      idleTimeoutMs: 30_000,
    });
    const grandchildPids: number[] = [];
    try {
      const seed = await session.runTurn({
        content: 'seed',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      expect(seed.sessionId).toBe('acp-fixture-session-1');

      // 1. Mid-turn crash with detached grandchild holding stdout/stderr open must reject promptly.
      const tCrash = Date.now();
      await expect(session.runTurn({
        content: 'detached-grandchild-crash',
        onUserInput: async () => ({}),
      }, new AbortController().signal)).rejects.toThrow(/atomcode_acp_process_exited/);
      expect(Date.now() - tCrash).toBeLessThan(2_000);

      // 2. Subsequent turn must resume cleanly instead of hanging on teardownPromise.
      const recovered = await session.runTurn({
        content: 'after-detached-crash',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      expect(recovered.content).toContain('echo:after-detached-crash');

      // 3. Force close while a hung turn has a detached grandchild holding stdio must settle promptly.
      const hangTurn = session.runTurn({
        content: 'detached-grandchild-hang',
        onUserInput: async () => ({}),
      }, new AbortController().signal);
      await waitFor(() => f.readLog().filter(e => e.event === 'grandchild_spawned').length === 2);
      const tClose = Date.now();
      await session.close(false);
      await expect(hangTurn).rejects.toThrow();
      expect(Date.now() - tClose).toBeLessThan(2_500);
    } finally {
      for (const entry of f.readLog()) {
        if (typeof entry.grandchildPid === 'number') grandchildPids.push(entry.grandchildPid);
      }
      for (const pid of grandchildPids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      await session.close(false);
    }
  });
});
