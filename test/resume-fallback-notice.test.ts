/**
 * "Resume fell back to a fresh session": the history gate, the copy, and the
 * daemon handler.
 *
 * The worker reports the FACT on every demotion (a `/restart` forks a new
 * worker, so it cannot own the latch); the daemon decides whether the user is
 * told. Acceptance rules:
 *
 *   1. a brand-new session (or one restored after a daemon restart with no CLI
 *      turn, or one whose context was `/clear`ed) gets 0 notices;
 *   2. a session that held a CLI conversation gets exactly ONE notice across
 *      two consecutive demotions — while the second report is still recorded
 *      as structured log output.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  decideResumeFallbackReport,
  handleResumeFallbackReport,
  resumeFallbackNotice,
  sessionHasResumeHistory,
} from '../src/services/resume-fallback-notice.js';

describe('resumeFallbackNotice', () => {
  it('tier 0 is neutral: it never claims the launch failed', () => {
    const text = resumeFallbackNotice('no-exact-id');
    expect(text).toContain('本次未能精确定位原会话，已开启新会话；历史上下文不会恢复');
    expect(text).not.toContain('启动失败');
  });

  it.each(['probe-missing', 'restart-loop'] as const)('%s keeps the startup-failure wording', (tier) => {
    const text = resumeFallbackNotice(tier);
    expect(text).toContain('启动失败');
    expect(text).toContain('历史上下文');
  });
});

describe('sessionHasResumeHistory — persisted CLI evidence only', () => {
  it('the persisted last CLI input proves a conversation existed', () => {
    expect(sessionHasResumeHistory({ session: { lastCliInput: 'fix the build' } })).toBe(true);
  });

  it('a RESTORED session with hasHistory:true but no evidence has no history to lose', () => {
    // The restore path sets hasHistory=true for EVERY persisted session
    // (session-manager.ts), so trusting it would announce a history loss for a
    // session that never ran a turn.
    expect(sessionHasResumeHistory({ hasHistory: true, session: {} })).toBe(false);
    expect(sessionHasResumeHistory({ hasHistory: true })).toBe(false);
  });

  it('lastUserPrompt alone is not enough: the first message can be an alert card', () => {
    // No CLI turn ran, so there is no conversation context to lose.
    expect(sessionHasResumeHistory({ session: { lastUserPrompt: 'alarm card' } })).toBe(false);
  });

  it('runtime/top-level mirrors are not authoritative', () => {
    // Absent right after a restore; reading them would be a different answer
    // depending on whether the daemon had seen a turn.
    expect(sessionHasResumeHistory({ hasHistory: false, lastCliInput: 'x' })).toBe(false);
  });

  it('after /clear the session has nothing to lose (0 notices)', () => {
    // /clear wipes both persisted fields; the gate must say false.
    expect(sessionHasResumeHistory({
      hasHistory: true,
      session: { lastUserPrompt: undefined, lastCliInput: undefined },
    })).toBe(false);
    expect(sessionHasResumeHistory({ session: { lastCliInput: '   ' } })).toBe(false);
  });
});

describe('resume fallback delivery policy', () => {
  it('acceptance 1: a new session with no history posts 0 notices', () => {
    const outcome = decideResumeFallbackReport({
      tier: 'no-exact-id',
      hasSessionHistory: false,
      alreadyNotified: false,
    });
    expect(outcome.notice).toBeUndefined();
    expect(outcome.structured).toMatchObject({ kind: 'resume_fallback', tier: 'no-exact-id', suppressed: 'no-history' });
  });

  it('acceptance 2: two consecutive demotions on a session WITH history post exactly 1 notice, and the second report stays structured', () => {
    let notified = false;
    const notices: string[] = [];
    const structured: Array<ReturnType<typeof decideResumeFallbackReport>['structured']> = [];
    for (const _ of [1, 2]) {
      const outcome = decideResumeFallbackReport({
        tier: 'no-exact-id',
        reason: 'no persisted CLI session id',
        hasSessionHistory: true,
        alreadyNotified: notified,
      });
      structured.push(outcome.structured);
      if (outcome.notice) {
        notices.push(outcome.notice);
        notified = true;
      }
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe(resumeFallbackNotice('no-exact-id'));
    expect(structured).toHaveLength(2);
    expect(structured[1]).toMatchObject({ kind: 'resume_fallback', suppressed: 'already-notified' });
  });

  it('a report with nothing user-visible lost never notifies, even with history', () => {
    const outcome = decideResumeFallbackReport({
      tier: 'probe-missing',
      hasSessionHistory: true,
      alreadyNotified: false,
      lost: false,
    });
    expect(outcome.notice).toBeUndefined();
    expect(outcome.structured.suppressed).toBe('nothing-lost');
  });

  it('tier 1/2 sessions with history get the startup-failure copy once', () => {
    const first = decideResumeFallbackReport({
      tier: 'restart-loop',
      hasSessionHistory: true,
      alreadyNotified: false,
    });
    expect(first.notice).toContain('启动失败');
    const second = decideResumeFallbackReport({
      tier: 'restart-loop',
      hasSessionHistory: true,
      alreadyNotified: true,
    });
    expect(second.notice).toBeUndefined();
  });

  // A silent scheduled / meeting-driven turn must never surface auxiliary Lark
  // UI: the report stays structured. This is the gate the worker-pool wiring
  // feeds from managedAuxUiSuppressed; the old default user_notify path broke
  // out on it before sending.
  it('an auxiliary-UI-suppressed turn posts no notice even with real history', () => {
    const outcome = decideResumeFallbackReport({
      tier: 'no-exact-id',
      hasSessionHistory: true,
      alreadyNotified: false,
      auxUiSuppressed: true,
    });
    expect(outcome.notice).toBeUndefined();
    expect(outcome.structured.suppressed).toBe('aux-ui-suppressed');
    // Transport suppression is not content suppression: a human would have
    // been told, so the lifecycle attention signal still fires.
    expect(outcome.attention).toBe(true);
  });

  // The worker reports EVERY demotion (master's worker filtered nothing-lost and
  // repeats before sending), so attention must follow the content gate: noise
  // reports raise nothing whether or not the turn is also transport-suppressed.
  it.each([
    ['nothing-lost', { hasSessionHistory: true, alreadyNotified: false, lost: false }],
    ['no-history', { hasSessionHistory: false, alreadyNotified: false }],
    ['already-notified', { hasSessionHistory: true, alreadyNotified: true }],
  ] as const)('a %s report is never an attention event, transport-suppressed or not', (suppressed, gates) => {
    for (const auxUiSuppressed of [false, true]) {
      const outcome = decideResumeFallbackReport({ tier: 'probe-missing', ...gates, auxUiSuppressed });
      expect(outcome.notice).toBeUndefined();
      expect(outcome.structured.suppressed).toBe(suppressed);
      expect(outcome.attention).toBe(false);
    }
  });

  it('a notice-worthy report is an attention event', () => {
    const outcome = decideResumeFallbackReport({ tier: 'no-exact-id', hasSessionHistory: true, alreadyNotified: false });
    expect(outcome.notice).toBe(resumeFallbackNotice('no-exact-id'));
    expect(outcome.attention).toBe(true);
  });
});

/**
 * The daemon handler, against restore-shaped sessions and a REAL send spy.
 * Worker-pool.ts only wraps this with `sendTurnNotice`; the gate + latch live
 * here so they can be asserted without booting a daemon.
 */
describe('handleResumeFallbackReport (daemon handler seam)', () => {
  const report = { tier: 'no-exact-id' as const, reason: 'no persisted CLI session id' };

  it('posts once for a restored session with persisted CLI history, then suppresses the repeat with a structured log', async () => {
    const ds = { hasHistory: true, session: { lastCliInput: 'fix the build' }, resumeFreshFallbackNotified: undefined };
    const send = vi.fn(async () => {});
    const log = vi.fn();
    const first = await handleResumeFallbackReport({ ds, report, send, log });
    expect(first.delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(resumeFallbackNotice('no-exact-id'));
    expect(ds.resumeFreshFallbackNotified).toBe(true);
    // "attempting" is logged before the await and "delivered" only after it.
    expect(log.mock.calls.map(call => call[0])).toEqual([
      expect.stringContaining('notice attempting'),
      expect.stringContaining('notice delivered'),
    ]);

    const second = await handleResumeFallbackReport({ ds, report, send, log });
    expect(second.delivered).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    // The fact is never swallowed: the second report is still logged.
    expect(log.mock.calls[1 + 1][0]).toContain('suppressed (already-notified)');
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('a restored session with hasHistory:true but no persisted turn posts 0 notices', async () => {
    const ds = { hasHistory: true, session: {}, resumeFreshFallbackNotified: undefined };
    const send = vi.fn(async () => {});
    const log = vi.fn();
    const result = await handleResumeFallbackReport({ ds, report, send, log });
    expect(result.delivered).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain('suppressed (no-history)');
    expect(ds.resumeFreshFallbackNotified).toBeUndefined();
  });

  it('after /clear the session gets 0 notices', async () => {
    const ds = {
      hasHistory: true,
      session: { lastUserPrompt: undefined, lastCliInput: undefined },
      resumeFreshFallbackNotified: undefined,
    };
    const send = vi.fn(async () => {});
    const result = await handleResumeFallbackReport({ ds, report, send, log: vi.fn() });
    expect(result.delivered).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('a failed send releases the latch and the next report retries', async () => {
    const ds = { hasHistory: true, session: { lastCliInput: 'go' }, resumeFreshFallbackNotified: undefined };
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('lark down'))
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const failed = await handleResumeFallbackReport({ ds, report, send, log });
    expect(failed.delivered).toBe(false);
    expect(failed.outcome.structured.deliveryFailed).toBe(true);
    expect(ds.resumeFreshFallbackNotified).toBe(false);
    // Contradictory logs are impossible: "delivered" was never written.
    const lines = log.mock.calls.map(call => call[0]);
    expect(lines).toEqual([
      expect.stringContaining('notice attempting'),
      expect.stringContaining('delivery failed'),
    ]);
    expect(lines.join('\n')).not.toContain('notice delivered');

    const retried = await handleResumeFallbackReport({ ds, report, send, log });
    expect(retried.delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(ds.resumeFreshFallbackNotified).toBe(true);
  });

  it('nothing-lost reports stay structured but never call send', async () => {
    const ds = { hasHistory: true, session: { lastCliInput: 'go' }, resumeFreshFallbackNotified: undefined };
    const send = vi.fn(async () => {});
    const result = await handleResumeFallbackReport({
      ds, report: { tier: 'probe-missing', lost: false }, send, log: vi.fn(),
    });
    expect(result.delivered).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('a suppressed turn sends nothing AND keeps the latch for a later visible turn', async () => {
    const ds = { hasHistory: true, session: { lastCliInput: 'go' }, resumeFreshFallbackNotified: undefined };
    const send = vi.fn(async () => {});
    const log = vi.fn();

    const silent = await handleResumeFallbackReport({
      ds,
      report: { tier: 'no-exact-id', turnId: 'silent-turn' },
      auxUiSuppressed: true,
      send,
      log,
    });
    expect(silent.delivered).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain('suppressed (aux-ui-suppressed)');
    // Latch untouched: a silent run must not spend the one warning a human turn
    // is entitled to.
    expect(ds.resumeFreshFallbackNotified).toBeUndefined();

    // The next demotion belongs to a normal, visible turn and still delivers.
    const visible = await handleResumeFallbackReport({
      ds,
      report: { tier: 'no-exact-id', turnId: 'human-turn' },
      auxUiSuppressed: false,
      send,
      log,
    });
    expect(visible.delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ds.resumeFreshFallbackNotified).toBe(true);
  });

  it('raises attention for a delivered or transport-suppressed notice, never for noise', async () => {
    const run = async (ds: Parameters<typeof handleResumeFallbackReport>[0]['ds'], extra: { lost?: boolean; auxUiSuppressed?: boolean } = {}) => {
      const onAttention = vi.fn();
      const send = vi.fn(async () => {});
      await handleResumeFallbackReport({
        ds, report: { tier: 'probe-missing', lost: extra.lost }, auxUiSuppressed: extra.auxUiSuppressed,
        onAttention, send, log: vi.fn(),
      });
      return { attention: onAttention.mock.calls.length, sent: send.mock.calls.length };
    };
    const told = { session: { lastCliInput: 'go' }, resumeFreshFallbackNotified: undefined as boolean | undefined };
    expect(await run(told, { auxUiSuppressed: true })).toEqual({ attention: 1, sent: 0 });
    expect(await run(told)).toEqual({ attention: 1, sent: 1 });
    expect(await run(told)).toEqual({ attention: 0, sent: 0 }); // already told
    expect(await run({ session: {} })).toEqual({ attention: 0, sent: 0 }); // no history
    expect(await run({ session: { lastCliInput: 'go' } }, { lost: false })).toEqual({ attention: 0, sent: 0 });
  });
});
