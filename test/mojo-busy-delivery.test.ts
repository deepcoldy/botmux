/**
 * Delivery truth for the mojo backend when the REMOTE session is busy.
 *
 * Field shape (@byted/mojo 1.0.13): the remote session stays RUNNING although
 * its current turn already COMPLETED. `-p -r <sid>` then passes the CLI's own
 * "正在执行中" pre-check, emits `system/init`, gets the prompt queued but never
 * started, and after 10s reports `result{error.code:"session_busy"}`. botmux
 * used to account for that as an ordinary finished turn: the explanation went
 * only to the synthetic terminal, the turn boundary fired `completed` with an
 * empty answer, and the reply card closed empty — a message silently lost.
 *
 * The fake (test/helpers/fake-mojo-remote.ts) models the remote session state
 * and records every client launch, so these assert what really reached the
 * "remote": which prompts started a turn, which were only queued, and how many
 * full `-p` clients (each one a local mojo-daemon start in host execution) a
 * busy session cost.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MojoBackend } from '../src/adapters/backend/mojo-backend.js';
import type { BackendTurnFailure } from '../src/adapters/backend/types.js';
import type { EffectiveMojoConfig } from '../src/adapters/backend/mojo-types.js';
import {
  idleSession,
  liveSession,
  stuckSession,
  writeFakeMojoRemote,
  type FakeMojoRemote,
  type FakeMojoSession,
} from './helpers/fake-mojo-remote.js';

const SID = 'c0ffee00-5e55-4a1d-9b0e-0000000b0581';
const STUCK_TURN = '7e1d0c3a-2f6b-4c55-8e21-d0e5c0de7a11';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mojo-busy-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

interface TurnRecord {
  out: string;
  finals: string[];
  failures: BackendTurnFailure[];
}

function remote(sessions: Record<string, FakeMojoSession>, answer?: string): FakeMojoRemote {
  return writeFakeMojoRemote(dir, sessions, { queueWaitMs: 200, ...(answer !== undefined ? { answer } : {}) });
}

/** Drive one turn and resolve at its boundary (onTaskDone). */
function driveTurn(
  fake: FakeMojoRemote,
  prompt: string,
  extra: Partial<EffectiveMojoConfig> = {},
): Promise<TurnRecord> {
  return new Promise((resolve, reject) => {
    const backend = new MojoBackend({
      bin: fake.bin,
      resumeCliSessionId: SID,
      env: { HOME: dir },
      ...extra,
    }, 'session-busy-under-test');
    const rec: TurnRecord = { out: '', finals: [], failures: [] };
    backend.onData((d) => { rec.out += d; });
    backend.onTurnFinal((text) => { rec.finals.push(text); });
    backend.onTurnFailure?.((f) => { rec.failures.push(f); });
    backend.onTaskDone(() => resolve(rec));
    const timer = setTimeout(() => reject(new Error(`turn never settled; out=${rec.out}`)), 30_000);
    timer.unref?.();
    backend.spawn('', [], {} as never);
    backend.write(prompt);
  });
}

describe('mojo remote session stuck busy (RUNNING lock, current turn COMPLETED)', () => {
  it('fails the turn visibly instead of closing it as an empty success', async () => {
    const fake = remote({ [SID]: stuckSession(STUCK_TURN) });
    const rec = await driveTurn(fake, '派单：请处理 issue 42');

    // The remote never started a turn: the prompt only sits in its queue.
    expect(fake.read().startedTurns).toEqual([]);
    expect(fake.read().sessions[SID].pendingPrompts).toHaveLength(1);

    // No completed answer may stand in for the lost message …
    expect(rec.finals).toEqual([]);
    // … the boundary is an explicit, retryable failure carrying the reason.
    expect(rec.failures).toHaveLength(1);
    const [failure] = rec.failures;
    expect(failure).toMatchObject({ status: 'failed', code: 'mojo_session_busy', retryable: true });
    expect(failure.message).toContain('远端会话一直忙');
    expect(failure.message).toContain('没有送达');
    // State mismatch is reported with the remote's own evidence.
    expect(failure.message).toContain(STUCK_TURN.slice(0, 8));
    expect(failure.message).toContain('completed');
  });

  it('does not resubmit a queued prompt (each retry would pile up the remote queue)', async () => {
    const fake = remote({ [SID]: stuckSession(STUCK_TURN) });
    await driveTurn(fake, '撤销刚才的派单');
    expect(fake.printInvocations()).toHaveLength(1);
    expect(fake.read().sessions[SID].pendingPrompts).toEqual([expect.stringContaining('撤销刚才的派单')]);
  });

  it('still takes the queued path when the busy result line is only flushed at exit', async () => {
    // Same 1.0.13 envelope, but without the trailing newline: the line reaches
    // the parser from the exit-time tail flush instead of the stream handler.
    const bin = join(dir, 'mojo-tail');
    writeFileSync(bin, `#!/usr/bin/env bash
if [ "$1" = "session" ]; then
  echo '{"schema_version":1,"operation":"session.get","status":"completed","state":"completed","session_id":"${SID}","turn_id":"${STUCK_TURN}","error":null}'
  exit 0
fi
echo '{"type":"system","subtype":"init","session_id":"${SID}"}'
printf '%s' '{"type":"result","status":"error","result":"","session_id":"${SID}","num_tool_calls":0,"warnings":[],"error":{"code":"session_busy","message":"prompt 被后端排队而回合未启动"}}'
exit 1
`);
    chmodSync(bin, 0o755);
    const rec = await driveTurn({ ...remote({}), bin }, '尾部冲出的 busy');
    expect(rec.failures).toHaveLength(1);
    expect(rec.failures[0].code).toBe('mojo_session_busy');
    expect(rec.failures[0].message).toContain(STUCK_TURN.slice(0, 8));
  });

  it('surfaces a full remote queue (stalled) as a failure too, never as success', async () => {
    const stuck = stuckSession(STUCK_TURN);
    stuck.pendingPrompts = ['a', 'b', 'c', 'd', 'e'];
    const fake = remote({ [SID]: stuck });
    const rec = await driveTurn(fake, 'sixth message');
    expect(rec.finals).toEqual([]);
    expect(rec.failures).toEqual([expect.objectContaining({ status: 'failed', code: 'mojo_stalled' })]);
  });
});

describe('mojo pre-check busy (a remote turn is genuinely still executing)', () => {
  it('waits with cheap session probes and launches the client once more, not once per backoff step', async () => {
    // Live for two checks: the first client launch, then the first probe.
    const fake = remote({ [SID]: liveSession(2) }, '答复：{prompt}');
    const rec = await driveTurn(fake, '续投这条');

    expect(rec.failures).toEqual([]);
    expect(rec.finals).toEqual([expect.stringContaining('续投这条')]);
    expect(fake.read().startedTurns).toEqual([expect.objectContaining({ prompt: expect.stringContaining('续投这条') })]);
    // One rejected launch + one successful launch. The old fixed ladder
    // relaunched the full client (and a local mojo-daemon) on every step.
    expect(fake.printInvocations()).toHaveLength(2);
    expect(fake.read().daemonStarts).toBe(2);
    expect(fake.sessionGetInvocations().length).toBeGreaterThanOrEqual(2);
  });

  it('gives up after busyWaitSec with an explicit not-delivered failure', async () => {
    const fake = remote({ [SID]: liveSession(1_000) });
    const rec = await driveTurn(fake, '一直忙', { busyWaitSec: 2 });

    expect(rec.finals).toEqual([]);
    expect(rec.failures).toHaveLength(1);
    expect(rec.failures[0]).toMatchObject({ status: 'failed', code: 'mojo_session_busy', retryable: true });
    expect(rec.failures[0].message).toContain('远端会话一直忙');
    expect(rec.failures[0].message).toContain('没有送达');
    expect(rec.failures[0].message).toContain('running');
    expect(fake.read().startedTurns).toEqual([]);
    expect(fake.printInvocations()).toHaveLength(1);
  }, 20_000);
});

describe('mojo turn evidence', () => {
  it('a result with no output at all is not reported as a delivered answer', async () => {
    const fake = remote({ [SID]: idleSession() }, '');
    const rec = await driveTurn(fake, '有人吗');
    expect(rec.finals).toEqual([]);
    expect(rec.failures).toEqual([expect.objectContaining({ status: 'failed', code: 'mojo_no_turn_output', retryable: true })]);
  });

  it('a normal turn on an idle session still completes with its answer', async () => {
    const fake = remote({ [SID]: idleSession() }, '正常回答');
    const rec = await driveTurn(fake, 'hello');
    expect(rec.failures).toEqual([]);
    expect(rec.finals).toEqual(['正常回答']);
  });
});

// ── Lifecycle × busy wait ─────────────────────────────────────────────────────
// A message can now wait on a busy remote for up to busyWaitSec, so whatever
// happens to the session during that window must leave exactly one honest
// boundary (or, after a real teardown, none) — never a stranded turn.

interface Boundary {
  kind: 'final' | 'failure';
  turnId?: string;
  text?: string;
  failure?: BackendTurnFailure;
}

function openSession(fake: FakeMojoRemote, extra: Partial<EffectiveMojoConfig> = {}) {
  const backend = new MojoBackend({
    bin: fake.bin,
    resumeCliSessionId: SID,
    env: { HOME: dir },
    ...extra,
  }, 'session-busy-lifecycle');
  const boundaries: Boundary[] = [];
  let done = 0;
  backend.onTurnFinal((text, turnId) => { boundaries.push({ kind: 'final', text, turnId }); });
  backend.onTurnFailure?.((failure) => { boundaries.push({ kind: 'failure', failure, turnId: failure.turnId }); });
  backend.onTaskDone(() => { done += 1; });
  backend.spawn('', [], {} as never);
  return { backend, boundaries, done: () => done };
}

async function until(predicate: () => boolean, timeoutMs: number, what: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(what());
    await new Promise<void>(r => setTimeout(r, 50));
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('mojo busy wait × session lifecycle', () => {
  it('a /close that rolls back mid-wait resumes the message instead of stranding it', async () => {
    const fake = remote({ [SID]: liveSession(1) }, '关闭回滚后送达');
    // The close stays in progress across several probe steps.
    fake.control({ sessions: { [SID]: 'live' }, cancelFails: true, cancelDelayMs: 3_000 });
    const s = openSession(fake);
    s.backend.write('第一条');
    await until(() => fake.printInvocations().length >= 1, 15_000, () => 'never launched');

    const closed = await s.backend.destroySession();
    expect(closed).toMatchObject({ ok: false, recovery: 'retryable', admission: 'restorable' });
    expect(s.backend.abortDestroySession()).toEqual({ admissionRestored: true });
    fake.control({ sessions: { [SID]: 'free' } });

    await until(() => s.done() > 0, 30_000, () => `turn stranded: ${JSON.stringify(s.boundaries)}`);
    expect(s.boundaries).toEqual([expect.objectContaining({ kind: 'final', text: '关闭回滚后送达' })]);
    s.backend.kill();
  }, 45_000);

  it('a /close that succeeds mid-wait ends the message silently and launches nothing more', async () => {
    const fake = remote({ [SID]: liveSession(1) });
    fake.control({ sessions: { [SID]: 'live' } });
    const s = openSession(fake);
    s.backend.write('第一条');
    await until(() => fake.printInvocations().length >= 1, 15_000, () => 'never launched');

    expect(await s.backend.destroySession()).toMatchObject({ ok: true });
    fake.control({ sessions: { [SID]: 'free' } });
    await sleep(3_000);
    expect(s.boundaries).toEqual([]);
    expect(fake.printInvocations()).toHaveLength(1);
  }, 30_000);

  it('a prepared shutdown detach launches nothing until it is aborted', async () => {
    const fake = remote({ [SID]: liveSession(1) }, '恢复后送达');
    fake.control({ sessions: { [SID]: 'live' } });
    const s = openSession(fake);
    s.backend.write('第一条');
    await until(() => fake.printInvocations().length >= 1, 15_000, () => 'never launched');

    expect(await s.backend.prepareShutdownDetach()).toMatchObject({ ok: true });
    fake.control({ sessions: { [SID]: 'free' } });
    // Several probe steps' worth: a launch here would run a prompt whose
    // client the committed detach is about to kill.
    await sleep(3_500);
    expect(fake.printInvocations()).toHaveLength(1);
    expect(s.done()).toBe(0);

    expect(await s.backend.abortShutdownDetach()).toMatchObject({ ok: true });
    await until(() => s.done() > 0, 30_000, () => `turn stranded: ${JSON.stringify(s.boundaries)}`);
    expect(s.boundaries).toEqual([expect.objectContaining({ kind: 'final', text: '恢复后送达' })]);
    s.backend.kill();
  }, 45_000);

  it('reports each boundary for the turn its write carried, not the newest turn', async () => {
    const fake = remote({ [SID]: liveSession(1) }, '第二条的回答');
    fake.control({ sessions: { [SID]: 'live' } });
    const s = openSession(fake, { busyWaitSec: 2 });
    s.backend.bindNextTurn?.('om_T1');
    s.backend.write('第一条');
    await until(() => fake.printInvocations().length >= 1, 15_000, () => 'never launched');
    // A passthrough command lands while the first message is still waiting.
    s.backend.bindNextTurn?.('om_T2');
    s.backend.write('/model');

    await until(() => s.boundaries.length >= 1, 20_000, () => 'first message never settled');
    fake.control({ sessions: { [SID]: 'free' } });
    await until(() => s.boundaries.length >= 2, 20_000, () => `second never settled: ${JSON.stringify(s.boundaries)}`);
    expect(s.boundaries.map(b => [b.kind, b.turnId])).toEqual([['failure', 'om_T1'], ['final', 'om_T2']]);
    s.backend.kill();
  }, 45_000);

  it('gives up early when the remote keeps refusing although it reports its turn ended', async () => {
    const fake = remote({ [SID]: liveSession(1) });
    fake.control({ sessions: { [SID]: 'refuses' } });
    const startedAt = Date.now();
    const rec = await driveTurn(fake, '自相矛盾的远端', { busyWaitSec: 600 });

    expect(rec.finals).toEqual([]);
    expect(rec.failures).toEqual([expect.objectContaining({ status: 'failed', code: 'mojo_session_busy', retryable: true })]);
    expect(rec.failures[0].message).toContain('没有送达');
    expect(rec.failures[0].message).toContain('completed');
    // Bounded by the contradiction, not by the 600s budget, and each launch
    // was a full client start — a handful, not one per backoff step.
    expect(Date.now() - startedAt).toBeLessThan(60_000);
    expect(fake.printInvocations().length).toBeLessThan(8);
  }, 70_000);

  it('does not deliver on a credential that was cleared while the message waited', async () => {
    const fake = remote({ [SID]: liveSession(1) });
    fake.control({ sessions: { [SID]: 'live' } });
    const s = openSession(fake, { jwt: 'tok-A' });
    s.backend.write('第一条');
    await until(() => fake.printInvocations().length >= 1, 15_000, () => 'never launched');

    s.backend.applyLivePatch({ jwt: null });
    fake.control({ sessions: { [SID]: 'free' } });
    await until(() => s.done() > 0, 30_000, () => 'never settled');
    expect(s.boundaries).toEqual([expect.objectContaining({ kind: 'failure', failure: expect.objectContaining({ code: 'mojo_credential_changed' }) })]);
    expect(fake.read().startedTurns).toEqual([]);
    expect(fake.printInvocations()).toHaveLength(1);
    s.backend.kill();
  }, 45_000);
});

describe('mojo launch classification', () => {
  function countingBin(name: string, body: string): { bin: string; launches: () => number } {
    const counter = join(dir, `${name}.count`);
    writeFileSync(counter, '0');
    const bin = join(dir, name);
    writeFileSync(bin, `#!/usr/bin/env bash
if [ "$1" = "session" ]; then echo '{"schema_version":1,"operation":"session.get","state":"completed","error":null}'; exit 0; fi
N=$(cat ${counter}); echo $((N+1)) > ${counter}
${body}
`);
    chmodSync(bin, 0o755);
    return { bin, launches: () => Number(readFileSync(counter, 'utf-8').trim()) };
  }

  it('never resubmits once the launch printed to stdout, even if stderr then reads busy', async () => {
    const { bin, launches } = countingBin('mojo-late-busy', `echo '{"type":"system","subtype":"init","session_id":"${SID}"}'
echo "submit failed: session already running" >&2
exit 1`);
    const rec = await driveTurn({ ...remote({}), bin }, '只能提交一次');
    expect(launches()).toBe(1);
    expect(rec.finals).toEqual([]);
    expect(rec.failures).toEqual([expect.objectContaining({ code: 'mojo_exit_1' })]);
  });

  it('without --include-partial the answer is delivered once, not text + result again', async () => {
    const { bin } = countingBin('mojo-no-partial', `cat <<'J'
{"type":"system","subtype":"init","session_id":"${SID}"}
{"type":"text","text":"plain text"}
{"type":"result","status":"completed","result":"plain text","session_id":"${SID}","warnings":[]}
J`);
    const rec = await driveTurn({ ...remote({}), bin }, 'hi', { stream: false });
    expect(rec.finals).toEqual(['plain text']);
  });
});

// ── Round-2 edges ─────────────────────────────────────────────────────────────

/** Same backend with a short probe ladder, for cases that need many steps. */
class FastLadderMojoBackend extends MojoBackend {
  protected override get busyProbeLadderMs(): { initial: number; max: number } {
    return { initial: 100, max: 200 };
  }
}

describe('mojo busy wait: further lifecycle and remote edges', () => {
  it('a /close that kills the running client and then rolls back fails the message visibly', async () => {
    const fake = remote({ [SID]: idleSession() }, '不会到达');
    fake.control({ answerDelayMs: 8_000, cancelFails: true, cancelDelayMs: 500 });
    const s = openSession(fake);
    s.backend.write('正在执行时被关闭');
    await until(() => fake.read().startedTurns.length === 1, 15_000, () => 'turn never started');

    expect(await s.backend.destroySession()).toMatchObject({ ok: false, admission: 'restorable' });
    await until(() => s.done() > 0, 30_000, () => `turn stranded: ${JSON.stringify(s.boundaries)}`);
    expect(s.boundaries).toEqual([expect.objectContaining({
      kind: 'failure',
      failure: expect.objectContaining({ code: 'mojo_interrupted_by_close', retryable: true }),
    })]);
    s.backend.kill();
  }, 45_000);

  it('a plain-text notice on stdout does not turn a busy pre-check into a failure', async () => {
    const fake = remote({ [SID]: liveSession(1) }, '提示行之后送达');
    fake.control({ sessions: { [SID]: 'live' }, stdoutNotice: true });
    const s = openSession(fake);
    s.backend.write('第一条');
    await until(() => fake.printInvocations().length >= 1, 15_000, () => 'never launched');
    fake.control({ sessions: { [SID]: 'free' }, stdoutNotice: true });
    await until(() => s.done() > 0, 30_000, () => 'never settled');
    expect(s.boundaries).toEqual([expect.objectContaining({ kind: 'final', text: '提示行之后送达' })]);
    s.backend.kill();
  }, 45_000);

  it('stays bounded when the remote flaps between running and ended', async () => {
    const fake = remote({ [SID]: liveSession(1) });
    fake.control({ sessions: { [SID]: 'flaps' } });
    const backend = new FastLadderMojoBackend({
      bin: fake.bin, resumeCliSessionId: SID, env: { HOME: dir }, busyWaitSec: 600,
    }, 'session-busy-flaps');
    const failures: BackendTurnFailure[] = [];
    let done = 0;
    backend.onTurnFailure((f) => { failures.push(f); });
    backend.onTaskDone(() => { done += 1; });
    backend.spawn('', [], {} as never);
    backend.write('翻转的远端');
    await until(() => done > 0, 40_000, () => `still waiting after ${fake.printInvocations().length} launches`);
    expect(failures).toEqual([expect.objectContaining({ code: 'mojo_session_busy' })]);
    expect(fake.printInvocations().length).toBeLessThan(8);
  }, 60_000);

  it('does not resubmit on a credential cleared while the probe was running', async () => {
    const fake = remote({ [SID]: liveSession(1) });
    fake.control({ sessions: { [SID]: 'live' } });
    const s = openSession(fake, { jwt: 'tok-A' });
    s.backend.write('第一条');
    await until(() => fake.printInvocations().length >= 1, 15_000, () => 'never launched');
    fake.control({ sessions: { [SID]: 'free' }, getDelayMs: 1_500 });
    await until(() => fake.sessionGetInvocations().length >= 1, 15_000, () => 'never probed');
    s.backend.applyLivePatch({ jwt: null });

    await until(() => s.done() > 0, 30_000, () => 'never settled');
    expect(s.boundaries).toEqual([expect.objectContaining({ kind: 'failure', failure: expect.objectContaining({ code: 'mojo_credential_changed' }) })]);
    expect(fake.printInvocations()).toHaveLength(1);
    s.backend.kill();
  }, 45_000);

  it('without --include-partial keeps a final answer that only `result` carries', async () => {
    const bin = join(dir, 'mojo-result-only-final');
    writeFileSync(bin, `#!/usr/bin/env bash
cat <<'J'
{"type":"system","subtype":"init","session_id":"${SID}"}
{"type":"text","text":"我先看看仓库结构。"}
{"type":"tool_call","id":"t1","name":"Bash","input":{"command":"ls"}}
{"type":"tool_result","id":"t1","output":"src"}
{"type":"result","status":"completed","result":"最终答案：在 src 下。","session_id":"${SID}","num_tool_calls":1,"warnings":[]}
J`);
    chmodSync(bin, 0o755);
    const rec = await driveTurn({ ...remote({}), bin }, 'hi', { stream: false });
    expect(rec.finals).toHaveLength(1);
    expect(rec.finals[0]).toContain('最终答案：在 src 下。');
  });
});
