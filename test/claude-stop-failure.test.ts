/**
 * Claude Code `StopFailure` fallback (services/claude-stop-failure.ts).
 *
 * Fixtures are the shapes Claude Code 2.1.296 produced for one real failure
 * (an API that drops the stream after a complete content block): the hook's
 * stdin payload and the transcript's API-error record. Paths and ids are
 * neutralised; field names and values are as captured.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeStopFailureBelongsToOwner,
  claudeStopFailureTranscriptRecord,
  classifyClaudeStopFailure,
  CLAUDE_STOP_FAILURE_NOTICE_COOLDOWN_MS,
  CLAUDE_STOP_FAILURE_RECORD_LOOKBACK_MS,
  CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS,
  CLAUDE_STOP_FAILURE_OUTBOX_MAX_AGE_MS,
  CLAUDE_STOP_FAILURE_OUTBOX_SUFFIX,
  decideClaudeStopFailureFallback,
  drainClaudeStopFailureOutbox,
  handleClaudeStopFailureReport,
  normalizeClaudeStopFailureReport,
  parseClaudeStopFailureHookInput,
  type ClaudeStopFailureReport,
  writeClaudeStopFailureOutboxReport,
} from '../src/services/claude-stop-failure.js';
import { classifyClaudeTerminalEvent, transcriptApiErrorRecordSince, type TranscriptEvent } from '../src/services/claude-transcript.js';

const SESSION_ID = '7bb7a763-27bb-449b-9b1f-72159ee31588';
const TRANSCRIPT = `/home/u/.claude/projects/-work/${SESSION_ID}.jsonl`;
const CONNECTION_LOST = 'API Error: Connection lost mid-response. The response above may be incomplete.';

/** StopFailure stdin as captured. */
const hookPayload = {
  session_id: SESSION_ID,
  transcript_path: TRANSCRIPT,
  cwd: '/home/u/work',
  prompt_id: '1d221304-e3cb-4d98-8cd2-baf80b0c5bd3',
  effort: { level: 'medium' },
  hook_event_name: 'StopFailure',
  error: 'server_error',
  last_assistant_message: CONNECTION_LOST,
};

/** The transcript record Claude wrote for the same failure (bookkeeping fields trimmed). */
const transcriptRecord: TranscriptEvent = {
  type: 'assistant',
  isSidechain: false,
  message: {
    model: '<synthetic>',
    role: 'assistant',
    stop_reason: 'stop_sequence',
    content: [{ type: 'text', text: CONNECTION_LOST }],
  },
  error: 'server_error',
  isApiErrorMessage: true,
} as TranscriptEvent;

function report(over: Partial<ClaudeStopFailureReport> = {}): ClaudeStopFailureReport {
  return { error: 'server_error', lastAssistantMessage: CONNECTION_LOST, ...over };
}

describe('parseClaudeStopFailureHookInput', () => {
  it('reads the error, the rendered line and the caller identity from the real payload', () => {
    expect(parseClaudeStopFailureHookInput(JSON.stringify(hookPayload), '782482')).toEqual({
      error: 'server_error',
      lastAssistantMessage: CONNECTION_LOST,
      cliSessionId: SESSION_ID,
      transcriptPath: TRANSCRIPT,
      claudePid: 782482,
    });
  });

  it('rejects other hook events, payloads without an error type and non-JSON', () => {
    expect(parseClaudeStopFailureHookInput(JSON.stringify({ ...hookPayload, hook_event_name: 'Stop' }))).toBeUndefined();
    expect(parseClaudeStopFailureHookInput(JSON.stringify({ ...hookPayload, error: '' }))).toBeUndefined();
    expect(parseClaudeStopFailureHookInput('not json')).toBeUndefined();
    expect(parseClaudeStopFailureHookInput('[]')).toBeUndefined();
  });

  it('drops a CLAUDE_PID that is not a positive integer', () => {
    expect(parseClaudeStopFailureHookInput(JSON.stringify(hookPayload), 'abc')?.claudePid).toBeUndefined();
    expect(parseClaudeStopFailureHookInput(JSON.stringify(hookPayload), '0')?.claudePid).toBeUndefined();
  });

  it('bounds attacker-sized fields', () => {
    const parsed = parseClaudeStopFailureHookInput(JSON.stringify({
      ...hookPayload,
      error: 'x'.repeat(10_000),
      last_assistant_message: 'y'.repeat(100_000),
    }));
    expect(parsed!.error.length).toBeLessThan(10_000);
    expect(parsed!.lastAssistantMessage!.length).toBeLessThan(100_000);
  });
});

describe('normalizeClaudeStopFailureReport', () => {
  it('round-trips a parsed report across the IPC boundary', () => {
    const parsed = parseClaudeStopFailureHookInput(JSON.stringify(hookPayload), '42')!;
    expect(normalizeClaudeStopFailureReport(JSON.parse(JSON.stringify({ sessionId: 's', ...parsed })))).toEqual(parsed);
  });

  it('rejects a body without an error type', () => {
    expect(normalizeClaudeStopFailureReport({ cliSessionId: SESSION_ID })).toBeUndefined();
    expect(normalizeClaudeStopFailureReport(null)).toBeUndefined();
  });
});

describe('classifyClaudeStopFailure', () => {
  it('classifies the hook exactly like the transcript record of the same failure', () => {
    const fromHook = classifyClaudeStopFailure(parseClaudeStopFailureHookInput(JSON.stringify(hookPayload))!);
    expect(fromHook).toEqual(classifyClaudeTerminalEvent(transcriptRecord));
    expect(fromHook).toEqual({ status: 'failed', errorCode: 'provider_server_error', retryable: true });
  });

  it('treats an overload as a retryable server error even without a status or text', () => {
    expect(classifyClaudeStopFailure({ error: 'overloaded' }))
      .toEqual({ status: 'failed', errorCode: 'provider_server_error', retryable: true });
  });

  it('leaves usage limits to the structured rate-limit path', () => {
    expect(classifyClaudeStopFailure(report({ error: 'rate_limit', lastAssistantMessage: "You've hit your limit" }))?.status)
      .toBe('rate_limited');
  });

  it('does not offer a retry for authentication or request errors', () => {
    expect(classifyClaudeStopFailure(report({ error: 'authentication_failed', lastAssistantMessage: 'Not logged in' })))
      .toEqual({ status: 'failed', errorCode: 'provider_authentication_failed', retryable: false });
    expect(classifyClaudeStopFailure(report({ error: 'invalid_request', lastAssistantMessage: 'API Error: 400' })))
      .toMatchObject({ status: 'failed', retryable: false });
  });

  it('keeps an unknown error without a transient signature ambiguous', () => {
    expect(classifyClaudeStopFailure(report({ error: 'unknown', lastAssistantMessage: 'API Error: something odd' })))
      .toEqual({ status: 'ambiguous', errorCode: 'provider_unknown_error', retryable: false });
  });
});

describe('claudeStopFailureBelongsToOwner', () => {
  const owner = {
    cliPid: 4242,
    cliSessionIds: new Set([SESSION_ID]),
    transcriptPath: TRANSCRIPT,
  };

  it('accepts the driven CLI by pid, by known session id or by transcript', () => {
    expect(claudeStopFailureBelongsToOwner(report({ claudePid: 4242 }), { ...owner, cliSessionIds: new Set(), transcriptPath: undefined })).toBe(true);
    // A sandboxed CLI reports a namespace-local pid; its session id still matches.
    expect(claudeStopFailureBelongsToOwner(report({ claudePid: 2, cliSessionId: SESSION_ID }), owner)).toBe(true);
    expect(claudeStopFailureBelongsToOwner(report({ transcriptPath: TRANSCRIPT }), { ...owner, cliSessionIds: new Set() })).toBe(true);
  });

  it('rejects a nested `claude -p` that inherited the session env', () => {
    const nested = report({
      claudePid: 9999,
      cliSessionId: 'c0ffee00-0000-4000-8000-000000000000',
      transcriptPath: '/home/u/.claude/projects/-work/c0ffee00-0000-4000-8000-000000000000.jsonl',
    });
    expect(claudeStopFailureBelongsToOwner(nested, owner)).toBe(false);
  });

  it('fails closed when neither side can be identified', () => {
    expect(claudeStopFailureBelongsToOwner(report(), { cliSessionIds: new Set() })).toBe(false);
  });
});

describe('decideClaudeStopFailureFallback', () => {
  const failed = classifyClaudeTerminalEvent(transcriptRecord);
  const base = { outcome: failed, turnId: 'om_turn', settled: false, surfaced: false, cliIdle: true };

  it('settles a turn that is still open with the classified failure', () => {
    expect(decideClaudeStopFailureFallback(base))
      .toEqual({ action: 'emit', status: 'failed', errorCode: 'provider_server_error', retryable: true });
  });

  it('stays out of the way once anything surfaced the failure', () => {
    expect(decideClaudeStopFailureFallback({ ...base, settled: true, surfaced: true }))
      .toEqual({ action: 'skip', reason: 'surfaced' });
  });

  it('tells the chat when no open turn is left to settle and nothing surfaced the failure', () => {
    // The turn was closed earlier (e.g. as completed) while the CLI kept working.
    expect(decideClaudeStopFailureFallback({ ...base, settled: true }))
      .toEqual({ action: 'notify', errorCode: 'provider_server_error' });
    expect(decideClaudeStopFailureFallback({ ...base, turnId: undefined }))
      .toEqual({ action: 'notify', errorCode: 'provider_server_error' });
  });

  it('only reports, never settles, once the CLI has moved on to the next input', () => {
    // Claude does not wait for the hook: the "active" turn may be the queued
    // input it started after the failure, which must not be failed.
    expect(decideClaudeStopFailureFallback({ ...base, cliIdle: false }))
      .toEqual({ action: 'notify', errorCode: 'provider_server_error' });
  });

  it('only logs when no turn is left and the transcript holds no record of the failure', () => {
    // Every turn of the conversation ended normally: the failure stopped no
    // work there, so the chat hears nothing.
    expect(decideClaudeStopFailureFallback({ ...base, settled: true, recorded: false }))
      .toEqual({ action: 'skip', reason: 'unrecorded' });
    expect(decideClaudeStopFailureFallback({ ...base, turnId: undefined, recorded: false }))
      .toEqual({ action: 'skip', reason: 'unrecorded' });
    // An unreadable transcript is no evidence either way: still notify.
    expect(decideClaudeStopFailureFallback({ ...base, settled: true, recorded: undefined }))
      .toEqual({ action: 'notify', errorCode: 'provider_server_error' });
  });

  it('still settles an open turn whether or not the transcript recorded the failure', () => {
    expect(decideClaudeStopFailureFallback({ ...base, recorded: false }))
      .toEqual({ action: 'emit', status: 'failed', errorCode: 'provider_server_error', retryable: true });
  });

  it('does not repeat a notice that went out recently', () => {
    expect(decideClaudeStopFailureFallback({ ...base, settled: true, recorded: true, repeated: true }))
      .toEqual({ action: 'skip', reason: 'repeated' });
  });

  it('never acts on a usage limit', () => {
    expect(decideClaudeStopFailureFallback({ ...base, outcome: classifyClaudeStopFailure(report({ error: 'rate_limit' })) }))
      .toEqual({ action: 'skip', reason: 'rate_limited' });
  });
});

describe('handleClaudeStopFailureReport', () => {
  function harness(opts: {
    settled?: 'completed' | 'failed';
    surfacedBy?: 'before' | 'catch-up';
    /** What the transcript holds around the report: a record key (default
     *  'rec-1'), false for none, undefined when it cannot tell. */
    record?: string | false | undefined;
  } = {}) {
    const timers: Array<{ delayMs: number; run: () => void }> = [];
    const settled = new Map<string, string>(opts.settled ? [['om_failed', opts.settled]] : []);
    let clock = 1_000_000;
    let surfacedAt: number | undefined = opts.surfacedBy === 'before' ? clock - 1_000 : undefined;
    const emitted: unknown[][] = [];
    const notices: unknown[][] = [];
    const noticeAt = new Map<string, number>();
    const noticedRecords = new Set<string>();
    const recordQueries: Array<[number, string | undefined]> = [];
    let record: string | false | undefined = 'record' in opts ? opts.record : 'rec-1';
    let idle = true;
    const ctx = {
      owner: { cliPid: 4242, cliSessionIds: new Set([SESSION_ID]), transcriptPath: TRANSCRIPT },
      activeTurn: { turnId: 'om_failed' as string | undefined, dispatchAttempt: undefined as number | undefined },
      schedule: (delayMs: number, run: () => void) => { timers.push({ delayMs, run }); return timers.length; },
      // The bridge reading its last bytes is what settles a transcript that was only behind.
      catchUp: () => {
        if (opts.surfacedBy === 'catch-up') { settled.set('om_failed', 'failed'); surfacedAt = clock; }
      },
      settledStatus: (turnId: string) => settled.get(turnId),
      cliIdle: () => idle,
      isKnownTurn: (turnId: string) => ['om_failed', 'om_older', 'om_next'].includes(turnId),
      lastFailureSurfacedAtMs: () => surfacedAt,
      transcriptApiErrorRecord: (sinceMs: number, path: string | undefined) => {
        recordQueries.push([sinceMs, path]);
        return record;
      },
      setRecord: (value: string | false | undefined) => { record = value; },
      recordNoticed: (key: string) => noticedRecords.has(key),
      lastNoticeAtMs: (code: string) => noticeAt.get(code),
      now: () => clock,
      advance: (ms: number) => { clock += ms; },
      setIdle: (value: boolean) => { idle = value; },
      emit: (...args: unknown[]) => { emitted.push(args); },
      notify: (code: string, replyTurnId: string | undefined, recordKey: string | undefined) => {
        notices.push([code, replyTurnId]);
        noticeAt.set(code, clock);
        if (recordKey) noticedRecords.add(recordKey);
      },
      log: () => undefined,
    };
    return { ctx, timers, emitted, notices, recordQueries };
  }
  const fromDrivenCli = parseClaudeStopFailureHookInput(JSON.stringify(hookPayload), '4242')!;

  it('settles a turn the transcript lost once the grace period is over', () => {
    const { ctx, timers, emitted, notices } = harness();
    handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_failed' }, ctx);
    expect(timers).toHaveLength(1);
    expect(timers[0].delayMs).toBe(CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS);
    expect(emitted).toEqual([]);
    // Claude dequeues the next type-ahead right after the failure; the frozen
    // turn, not the new active one, is the one that failed.
    ctx.activeTurn = { turnId: 'om_next', dispatchAttempt: undefined };
    timers[0].run();
    expect(emitted).toEqual([['om_failed', 'failed', 'provider_server_error', undefined, true]]);
    expect(notices).toEqual([]);
  });

  it('sends nothing when the transcript surfaced the failure, just before the report or on the catch-up read', () => {
    for (const surfacedBy of ['before', 'catch-up'] as const) {
      const { ctx, timers, emitted, notices } = harness({ settled: surfacedBy === 'before' ? 'failed' : undefined, surfacedBy });
      handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_failed' }, ctx);
      ctx.advance(CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS);
      timers[0].run();
      expect(emitted).toEqual([]);
      expect(notices).toEqual([]);
    }
  });

  it('counts the frozen turn\'s own failed terminal as surfaced, however late the report', () => {
    // A hook client that started unusually slowly reports long after the
    // transcript failed this very turn.
    const { ctx, timers, emitted, notices } = harness({ settled: 'failed' });
    ctx.lastFailureSurfacedAtMs = () => ctx.now() - 10 * CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS;
    handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_failed' }, ctx);
    timers[0].run();
    expect(emitted).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('does not take another failure surfaced long before the report for this one', () => {
    const { ctx, timers, notices } = harness({ settled: 'completed' });
    ctx.lastFailureSurfacedAtMs = () => ctx.now() - 10 * CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS;
    handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_failed' }, ctx);
    timers[0].run();
    expect(notices).toEqual([['provider_server_error', 'om_failed']]);
  });

  it('notifies instead of re-settling a turn that was already closed without the failure', () => {
    const { ctx, timers, emitted, notices } = harness({ settled: 'completed' });
    handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_failed' }, ctx);
    timers[0].run();
    expect(emitted).toEqual([]);
    expect(notices).toEqual([['provider_server_error', 'om_failed']]);
  });

  it('sends nothing for a closed turn when the transcript holds no record of the failure', () => {
    // Seen live: a report with error "unknown" some seconds after a turn that
    // ended normally, no API-error record anywhere in the transcript.
    const { ctx, timers, emitted, notices, recordQueries } = harness({ settled: 'completed', record: false });
    handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_failed' }, ctx);
    const arrivedAt = ctx.now();
    ctx.advance(CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS);
    timers[0].run();
    expect(emitted).toEqual([]);
    expect(notices).toEqual([]);
    // It looks back from the report's arrival, in the transcript the hook named too.
    expect(recordQueries).toEqual([[arrivedAt - CLAUDE_STOP_FAILURE_RECORD_LOOKBACK_MS, TRANSCRIPT]]);
  });

  it('still notifies for a closed turn when the transcript cannot be read', () => {
    const { ctx, timers, notices } = harness({ settled: 'completed', record: undefined });
    handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_failed' }, ctx);
    timers[0].run();
    expect(notices).toEqual([['provider_server_error', 'om_failed']]);
  });

  function reportAgain(h: ReturnType<typeof harness>) {
    handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_failed' }, h.ctx);
    h.ctx.advance(CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS);
    h.timers.at(-1)!.run();
  }

  it('tells each recorded failure once, and a new one even right after', () => {
    const h = harness({ settled: 'completed' });
    reportAgain(h);
    reportAgain(h); // the same record reported twice
    expect(h.notices).toHaveLength(1);
    h.ctx.setRecord('rec-2'); // another failure, seconds later
    reportAgain(h);
    expect(h.notices).toHaveLength(2);
  });

  it('without a record to go by, sends the same notice at most once per cooldown', () => {
    const h = harness({ settled: 'completed', record: undefined });
    reportAgain(h);
    h.ctx.advance(CLAUDE_STOP_FAILURE_NOTICE_COOLDOWN_MS - 2 * CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS);
    reportAgain(h);
    expect(h.notices).toHaveLength(1);
    h.ctx.advance(CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS);
    reportAgain(h);
    expect(h.notices).toHaveLength(2);
  });

  it('reads only the bridge transcript for a notify-only report', () => {
    const { ctx, timers, recordQueries } = harness({ settled: 'completed' });
    handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_failed' }, ctx, { notifyOnly: true });
    timers[0].run();
    expect(recordQueries.map(([, path]) => path)).toEqual([undefined]);
  });

  it('reports instead of failing the queued input Claude started after the failure', () => {
    const { ctx, timers, emitted, notices } = harness();
    // The reporter already read the next turn's marker, and the worker agrees.
    ctx.activeTurn = { turnId: 'om_next', dispatchAttempt: undefined };
    handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_next' }, ctx);
    ctx.setIdle(false);
    timers[0].run();
    expect(emitted).toEqual([]);
    expect(notices).toEqual([['provider_server_error', 'om_next']]);
  });

  it('never settles the turn a stale claim does not name, but still reports the failure', () => {
    const { ctx, timers, emitted, notices } = harness();
    handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_older' }, ctx);
    timers[0].run();
    expect(emitted).toEqual([]);
    expect(notices).toEqual([['provider_server_error', 'om_older']]);
  });

  it('replies to the session default when the claimed turn is one this worker does not know', () => {
    const { ctx, timers, notices } = harness();
    handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_from_elsewhere' }, ctx);
    timers[0].run();
    expect(notices).toEqual([['provider_server_error', undefined]]);
  });

  it('a notify-only report never settles a turn, even an open one on an idle CLI', () => {
    // The relay outbox: the sandbox controls those bytes.
    const { ctx, timers, emitted, notices } = harness();
    handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_failed' }, ctx, { notifyOnly: true });
    timers[0].run();
    expect(emitted).toEqual([]);
    expect(notices).toEqual([['provider_server_error', 'om_failed']]);
  });

  it('a notify-only report stays quiet once the failed turn has its failed terminal', () => {
    const { ctx, timers, notices } = harness({ settled: 'failed' });
    ctx.lastFailureSurfacedAtMs = () => ctx.now() - 10 * CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS;
    // The claim names the failed turn; the worker already moved on to the next input.
    ctx.activeTurn = { turnId: 'om_next', dispatchAttempt: undefined };
    handleClaudeStopFailureReport(fromDrivenCli, { turnId: 'om_failed' }, ctx, { notifyOnly: true });
    timers[0].run();
    expect(notices).toEqual([]);
  });

  it('ignores a nested `claude -p` entirely', () => {
    const { ctx, timers } = harness();
    handleClaudeStopFailureReport(
      { ...fromDrivenCli, claudePid: 9999, cliSessionId: 'other', transcriptPath: '/elsewhere.jsonl' },
      { turnId: 'om_failed' },
      ctx,
    );
    expect(timers).toEqual([]);
  });

  it('does nothing for a usage limit', () => {
    const { ctx, timers, emitted, notices } = harness();
    handleClaudeStopFailureReport({ ...fromDrivenCli, error: 'rate_limit' }, { turnId: 'om_failed' }, ctx);
    timers[0].run();
    expect(emitted).toEqual([]);
    expect(notices).toEqual([]);
  });
});

describe('claudeStopFailureTranscriptRecord', () => {
  const DATA = '/home/u/.claude';
  const BRIDGE = `${DATA}/projects/-work/a.jsonl`;
  const OTHER = `${DATA}/projects/-work/b.jsonl`;
  const lookup = (opts: {
    bridge?: string; reported?: string; files: Record<string, string | false | undefined>;
  }) => claudeStopFailureTranscriptRecord({
    bridgeTranscriptPath: opts.bridge,
    reportTranscriptPath: opts.reported,
    dataDir: DATA,
    sinceMs: 0,
    canonical: path => (path in opts.files || path === DATA ? path : undefined),
    probe: path => opts.files[path],
  });

  it('finds the record in the transcript the hook named when the bridge reads another', () => {
    expect(lookup({ bridge: BRIDGE, reported: OTHER, files: { [BRIDGE]: false, [OTHER]: 'rec' } })).toBe('rec');
  });

  it('says "no record" only when every transcript that may hold it was read', () => {
    expect(lookup({ bridge: BRIDGE, reported: BRIDGE, files: { [BRIDGE]: false } })).toBe(false);
    expect(lookup({ bridge: BRIDGE, reported: OTHER, files: { [BRIDGE]: false, [OTHER]: undefined } })).toBeUndefined();
  });

  it('cannot tell when the hook named a transcript it cannot check, or there is no bridge transcript', () => {
    expect(lookup({ bridge: BRIDGE, reported: '/elsewhere/x.jsonl', files: { [BRIDGE]: false, '/elsewhere/x.jsonl': false } }))
      .toBeUndefined();
    expect(lookup({ bridge: BRIDGE, reported: `${DATA}/projects/gone.jsonl`, files: { [BRIDGE]: false } })).toBeUndefined();
    expect(lookup({ reported: OTHER, files: { [OTHER]: false } })).toBeUndefined();
    expect(lookup({ files: {} })).toBeUndefined();
  });

  it('answers from the bridge alone for a report that names no transcript', () => {
    expect(lookup({ bridge: BRIDGE, files: { [BRIDGE]: false } })).toBe(false);
  });
});

describe('transcriptApiErrorRecordSince', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const at = (iso: string) => Date.parse(iso);
  function transcriptOf(lines: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-stop-failure-record-'));
    dirs.push(dir);
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    return path;
  }
  const turn = (ts: string) => [
    { type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'system', subtype: 'turn_duration', timestamp: ts, durationMs: 1_000 },
  ];

  it('finds the API-error record Claude writes before running the hook', () => {
    const path = transcriptOf([
      ...turn('2026-10-30T02:40:00.000Z'),
      { ...transcriptRecord, uuid: 'rec-uuid', timestamp: '2026-10-30T02:42:15.000Z' },
      { type: 'system', subtype: 'turn_duration', timestamp: '2026-10-30T02:42:15.010Z', durationMs: 3_000 },
    ]);
    expect(transcriptApiErrorRecordSince(path, at('2026-10-30T02:41:16.000Z'))).toBe('rec-uuid');
  });

  it('reports no record when every turn ended normally, or the only record is older than the window', () => {
    expect(transcriptApiErrorRecordSince(transcriptOf([
      ...turn('2026-10-30T02:41:30.000Z'), ...turn('2026-10-30T02:41:55.000Z'),
    ]), at('2026-10-30T02:41:16.000Z'))).toBe(false);
    expect(transcriptApiErrorRecordSince(transcriptOf([
      { ...transcriptRecord, timestamp: '2026-10-30T01:00:00.000Z' },
      ...turn('2026-10-30T02:41:55.000Z'),
    ]), at('2026-10-30T02:41:16.000Z'))).toBe(false);
  });

  it('cannot tell for a transcript that does not exist', () => {
    expect(transcriptApiErrorRecordSince('/nonexistent/botmux/session.jsonl', 0)).toBeUndefined();
  });

  it('cannot tell when the probe window runs out before records older than the window', () => {
    // A record pushed out of the probe by a large write after it (a big tool
    // result) must not read as "no record".
    const big = 'x'.repeat(64 * 1024);
    const filler = Array.from({ length: 20 }, (_, n) => ({
      type: 'user', timestamp: `2026-10-30T02:42:${String(20 + n).padStart(2, '0')}.000Z`, message: { content: big },
    }));
    expect(transcriptApiErrorRecordSince(transcriptOf([
      { ...transcriptRecord, timestamp: '2026-10-30T02:42:15.000Z' }, ...filler,
    ]), at('2026-10-30T02:41:16.000Z'))).toBeUndefined();
  });
});

describe('relay outbox reports', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const outbox = () => { const dir = mkdtempSync(join(tmpdir(), 'botmux-stop-failure-outbox-')); dirs.push(dir); return dir; };
  const NOW = 1_800_000_000_000;

  it('round-trips a report and consumes it', () => {
    const dir = outbox();
    writeClaudeStopFailureOutboxReport(dir, report({ cliSessionId: SESSION_ID, claudePid: 42 }), { turnId: 'om_failed', now: NOW });
    expect(drainClaudeStopFailureOutbox(dir, NOW + 1_000)).toEqual([{
      report: report({ cliSessionId: SESSION_ID, claudePid: 42 }),
      turnId: 'om_failed',
      atMs: NOW,
    }]);
    expect(readdirSync(dir)).toEqual([]);
    expect(drainClaudeStopFailureOutbox(dir, NOW + 2_000)).toEqual([]);
  });

  it('drops stale, future-dated, malformed and oversized reports, and leaves other files alone', () => {
    const dir = outbox();
    writeClaudeStopFailureOutboxReport(dir, report(), { now: NOW - CLAUDE_STOP_FAILURE_OUTBOX_MAX_AGE_MS - 1 });
    writeClaudeStopFailureOutboxReport(dir, report(), { now: NOW + 60_000 });
    writeFileSync(join(dir, `bad${CLAUDE_STOP_FAILURE_OUTBOX_SUFFIX}`), 'not json');
    writeFileSync(join(dir, `noerror${CLAUDE_STOP_FAILURE_OUTBOX_SUFFIX}`), JSON.stringify({ v: 1, atMs: NOW, report: {} }));
    writeFileSync(join(dir, `huge${CLAUDE_STOP_FAILURE_OUTBOX_SUFFIX}`), JSON.stringify({ v: 1, atMs: NOW, report: report(), pad: 'x'.repeat(64 * 1024) }));
    writeFileSync(join(dir, 'abc.req.json'), '{}');
    expect(drainClaudeStopFailureOutbox(dir, NOW)).toEqual([]);
    expect(readdirSync(dir)).toEqual(['abc.req.json']);
  });

  it('never follows a symlink planted in place of a report', () => {
    const dir = outbox();
    const secret = join(outbox(), 'host-file.json');
    writeFileSync(secret, JSON.stringify({ v: 1, atMs: NOW, report: report() }));
    symlinkSync(secret, join(dir, `link${CLAUDE_STOP_FAILURE_OUTBOX_SUFFIX}`));
    expect(drainClaudeStopFailureOutbox(dir, NOW)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(secret)).toBe(true);
  });
});
