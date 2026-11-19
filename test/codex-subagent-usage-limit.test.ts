import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_RATE_LIMIT_ERROR_CODE,
  codexSessionsRootFromRolloutPath,
  codexRolloutFailureCode,
  codexRolloutLimitKind,
  codexTaskFailureCode,
  drainCodexRollout,
  drainCodexSubagentLimits,
  findCodexSubagentRollout,
  isCodexRateLimitEvent,
  splitCodexEventsByCutoff,
} from '../src/services/codex-transcript.js';
import {
  CODEX_SUBAGENT_LOOKUP_WINDOW_MS,
  CodexSubagentLimitTracker,
  MAX_TRACKED_CODEX_SUBAGENTS,
} from '../src/services/codex-subagent-limit-tracker.js';
import { structuredCodexLimitState } from '../src/utils/cli-usage-limit.js';

// Verbatim shape of a Codex 0.156 quota failure (sub-agent and parent alike).
const USAGE_LIMIT_ERROR = {
  message: 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), '
    + 'visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 9:00 AM.',
  codex_error_info: 'usage_limit_exceeded',
};

const PARENT_ID = '01a0dd70-2d01-76a3-a82e-3f5101c55833';
const CHILD_ID = '01a136ee-7e6b-73e2-a780-3df1dc28a62b';

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

function subagentStarted(threadId: string, ts: string) {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: PARENT_ID,
      turn_id: 'turn-parent',
      item: { type: 'SubAgentActivity', id: 'call_x', kind: 'started', agent_thread_id: threadId, agent_path: '/root/review' },
    },
  };
}

function taskComplete(error: unknown, ts = '2026-10-13T20:24:04.521Z', turnId = 'turn-child') {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: turnId, last_agent_message: null, error },
  };
}

const FORK_TS = '2026-10-13T20:22:42.060Z';

/** Codex full-history fork layout: own session_meta, then the parent's
 *  records restamped with the fork time, then the sub-agent's own records
 *  from `subagent_history_start_ordinal` on. */
function forkedSubagentRollout(opts: { ordinal?: number | null; inherited: unknown[]; own: unknown[] }): string {
  const meta: Record<string, unknown> = {
    id: CHILD_ID,
    forked_from_id: PARENT_ID,
    parent_thread_id: PARENT_ID,
    thread_source: 'subagent',
    history_mode: 'paginated',
  };
  const ordinal = opts.ordinal === undefined ? 1 + opts.inherited.length : opts.ordinal;
  if (ordinal !== null) meta.subagent_history_start_ordinal = ordinal;
  return line({ timestamp: FORK_TS, type: 'session_meta', payload: meta })
    + opts.inherited.map(line).join('')
    + opts.own.map(line).join('');
}

const ownStarted = { timestamp: '2026-10-13T20:22:42.070Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-child' } };

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codex-subagent-limit-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function dayDir(sessions: string, ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dir = join(sessions, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('codexRolloutFailureCode: account usage limit', () => {
  it('classifies Codex usage_limit_exceeded as the structured rate-limit code', () => {
    expect(codexRolloutFailureCode(USAGE_LIMIT_ERROR)).toBe(CODEX_RATE_LIMIT_ERROR_CODE);
    expect(codexRolloutFailureCode({ codex_error_info: 'usage_limit_exceeded' })).toBe(CODEX_RATE_LIMIT_ERROR_CODE);
    expect(codexRolloutFailureCode({ message: 'boom' })).toBe(codexTaskFailureCode({ message: 'boom' }));
  });

  it('reports the structured limit kind from the raw error', () => {
    expect(codexRolloutLimitKind(USAGE_LIMIT_ERROR)).toBe('usage');
    expect(codexRolloutLimitKind({ codex_error_info: 'usage_limit_exceeded' })).toBe('usage');
    expect(codexRolloutLimitKind({ message: '429 Too Many Requests' })).toBe('rate');
    expect(codexRolloutLimitKind({ message: 'boom' })).toBeUndefined();
  });

  it('leaves the shared TRAE / pi classifier taxonomy unchanged', () => {
    expect(codexTaskFailureCode(USAGE_LIMIT_ERROR)).not.toBe(CODEX_RATE_LIMIT_ERROR_CODE);
  });

  it('turns a parent usage-limit terminal into a rate-limit event', () => {
    const path = join(root, 'parent.jsonl');
    writeFileSync(path, line(taskComplete(USAGE_LIMIT_ERROR)));
    const [final] = drainCodexRollout(path, 0).events.filter(e => e.kind === 'assistant_final');
    expect(isCodexRateLimitEvent(final)).toBe(true);
    expect(final.terminalLimitKind).toBe('usage');
  });

  it('keeps usage when the quota failure has no displayable summary', () => {
    const path = join(root, 'parent.jsonl');
    writeFileSync(path, line(taskComplete({ codex_error_info: 'usage_limit_exceeded' })));
    const [final] = drainCodexRollout(path, 0).events.filter(e => e.kind === 'assistant_final');
    expect(final.terminalErrorSummary).toBeUndefined();
    expect(final.terminalLimitKind).toBe('usage');
    // Same fallback text maybeEmitCodexStructuredRateLimit uses for an empty summary.
    expect(structuredCodexLimitState(final.terminalErrorSummary ?? '429 Too Many Requests', final.terminalLimitKind).kind)
      .toBe('usage');
  });
});

describe('structuredCodexLimitState', () => {
  const now = new Date(2026, 9, 14, 4, 24, 0);

  it('reports quota exhaustion as usage with the CLI retry time', () => {
    const state = structuredCodexLimitState(USAGE_LIMIT_ERROR.message, undefined, now);
    expect(state.kind).toBe('usage');
    expect(state.retryLabel).toBe('9:00 AM');
    expect(state.retryReady).toBe(false);
  });

  it('keeps HTTP 429 as rate', () => {
    expect(structuredCodexLimitState('429 Too Many Requests', undefined, now).kind).toBe('rate');
    expect(structuredCodexLimitState('', undefined, now).kind).toBe('rate');
  });

  it('lets the structured kind override the display text', () => {
    expect(structuredCodexLimitState('429 Too Many Requests', 'usage', now).kind).toBe('usage');
    const state = structuredCodexLimitState(USAGE_LIMIT_ERROR.message, 'usage', now);
    expect(state.kind).toBe('usage');
    expect(state.retryLabel).toBe('9:00 AM');
  });
});

describe('drainCodexRollout: spawned sub-agents', () => {
  it('reports SubAgentActivity started thread ids and ignores other kinds', () => {
    const path = join(root, 'parent.jsonl');
    const completed = subagentStarted(CHILD_ID, '2026-10-13T20:30:00.000Z');
    (completed.payload.item as any).kind = 'completed';
    writeFileSync(path, line(subagentStarted(CHILD_ID, '2026-10-13T20:22:42.059Z')) + line(completed)
      + line(subagentStarted('not-a-thread-id', '2026-10-13T20:22:43.000Z')));
    expect(drainCodexRollout(path, 0).spawnedSubagents).toEqual([
      { threadId: CHILD_ID, startedAtMs: Date.parse('2026-10-13T20:22:42.059Z') },
    ]);
  });

  it('omits the field when no sub-agent started', () => {
    const path = join(root, 'parent.jsonl');
    writeFileSync(path, line(taskComplete(null)));
    expect(drainCodexRollout(path, 0).spawnedSubagents).toBeUndefined();
  });
});

describe('findCodexSubagentRollout', () => {
  it('finds the rollout in the local-date directory of the start', () => {
    const sessions = join(root, 'sessions');
    const started = Date.parse('2026-10-13T20:22:42.059Z');
    const file = join(dayDir(sessions, started), `rollout-2026-10-14T04-22-42-${CHILD_ID}.jsonl`);
    writeFileSync(file, '');
    expect(findCodexSubagentRollout(CHILD_ID, started, { sessionsRoot: sessions })).toBe(file);
    expect(codexSessionsRootFromRolloutPath(file)).toBe(sessions);
  });

  it('rejects non-uuid thread ids before touching the filesystem', () => {
    expect(findCodexSubagentRollout('../../etc', Date.now(), { sessionsRoot: root })).toBeUndefined();
  });
});

describe('drainCodexSubagentLimits', () => {
  it('emits only usage/rate-limit terminals and advances by complete lines', () => {
    const path = join(root, 'child.jsonl');
    writeFileSync(path, line(taskComplete(null)) + line(taskComplete({ message: 'boom' })));
    const first = drainCodexSubagentLimits(path);
    expect(first.events).toEqual([]);

    appendFileSync(path, line(taskComplete(USAGE_LIMIT_ERROR)) + '{"partial":');
    const second = drainCodexSubagentLimits(path, first.cursor);
    expect(second.events).toHaveLength(1);
    expect(isCodexRateLimitEvent(second.events[0])).toBe(true);
    expect(second.events[0].terminalErrorSummary).toContain('usage limit');
    expect(second.events[0].terminalLimitKind).toBe('usage');
    expect(drainCodexSubagentLimits(path, second.cursor).events).toEqual([]);
  });

  it('ignores a limit inherited from the parent on fork when the sub-agent itself succeeds', () => {
    const path = join(root, 'child.jsonl');
    writeFileSync(path, forkedSubagentRollout({
      inherited: [taskComplete(USAGE_LIMIT_ERROR, FORK_TS, 'turn-parent-old')],
      own: [ownStarted, taskComplete(null, '2026-10-13T20:23:10.000Z')],
    }));
    expect(drainCodexSubagentLimits(path).events).toEqual([]);
  });

  it('still reports the sub-agent\'s own limit after inherited history, across incremental reads', () => {
    const path = join(root, 'child.jsonl');
    writeFileSync(path, forkedSubagentRollout({
      inherited: [taskComplete(USAGE_LIMIT_ERROR, FORK_TS, 'turn-parent-old')],
      own: [ownStarted],
    }));
    const first = drainCodexSubagentLimits(path);
    expect(first.events).toEqual([]);
    appendFileSync(path, line(taskComplete(USAGE_LIMIT_ERROR)));
    const second = drainCodexSubagentLimits(path, first.cursor);
    expect(second.events).toHaveLength(1);
    expect(second.events[0].sourceTurnId).toBe('turn-child');
  });

  it('distrusts a fork whose own-history boundary is missing', () => {
    const path = join(root, 'child.jsonl');
    writeFileSync(path, forkedSubagentRollout({
      ordinal: null,
      inherited: [taskComplete(USAGE_LIMIT_ERROR, FORK_TS, 'turn-parent-old')],
      own: [ownStarted, taskComplete(USAGE_LIMIT_ERROR)],
    }));
    expect(drainCodexSubagentLimits(path).events).toEqual([]);
  });

  it('trusts the whole file of a non-forked sub-agent', () => {
    const path = join(root, 'child.jsonl');
    writeFileSync(path, line({ timestamp: FORK_TS, type: 'session_meta', payload: { id: CHILD_ID, thread_source: 'subagent' } })
      + line(ownStarted) + line(taskComplete(USAGE_LIMIT_ERROR)));
    expect(drainCodexSubagentLimits(path).events).toHaveLength(1);
  });

  it('restarts ordinal counting after truncation', () => {
    const path = join(root, 'child.jsonl');
    writeFileSync(path, forkedSubagentRollout({
      inherited: [taskComplete(USAGE_LIMIT_ERROR, FORK_TS, 'turn-parent-old')],
      own: [ownStarted, taskComplete(null)],
    }));
    const first = drainCodexSubagentLimits(path);
    writeFileSync(path, forkedSubagentRollout({ inherited: [], own: [taskComplete(USAGE_LIMIT_ERROR)] }));
    expect(drainCodexSubagentLimits(path, first.cursor).events).toHaveLength(1);
  });
});

describe('CodexSubagentLimitTracker', () => {
  it('tails a sub-agent spawned live and surfaces its usage limit once', () => {
    const child = join(root, 'child.jsonl');
    writeFileSync(child, '');
    let lookups = 0;
    const tracker = new CodexSubagentLimitTracker(() => root, {
      findRollout: () => { lookups++; return child; },
    });
    tracker.observe([{ threadId: CHILD_ID, startedAtMs: 1_000 }], 1_000);
    expect(tracker.poll(1_000)).toEqual([]);

    appendFileSync(child, line(taskComplete(USAGE_LIMIT_ERROR)));
    const events = tracker.poll(2_000);
    expect(events).toHaveLength(1);
    expect(isCodexRateLimitEvent(events[0])).toBe(true);
    expect(tracker.poll(3_000)).toEqual([]);
    expect(lookups).toBe(1);
  });

  it('throttles lookups and gives up on a rollout that never appears', () => {
    let lookups = 0;
    const tracker = new CodexSubagentLimitTracker(() => root, {
      findRollout: () => { lookups++; return undefined; },
    });
    tracker.observe([{ threadId: CHILD_ID, startedAtMs: 0 }], 0);
    tracker.poll(0);
    tracker.poll(500);
    expect(lookups).toBe(1);
    tracker.poll(CODEX_SUBAGENT_LOOKUP_WINDOW_MS + 1);
    expect(tracker.size).toBe(0);
  });

  it('bounds the tracked set', () => {
    const tracker = new CodexSubagentLimitTracker(() => root, { findRollout: () => undefined });
    const subs = Array.from({ length: MAX_TRACKED_CODEX_SUBAGENTS + 5 }, (_, i) =>
      ({ threadId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, startedAtMs: 0 }));
    tracker.observe(subs, 0);
    expect(tracker.size).toBe(MAX_TRACKED_CODEX_SUBAGENTS);
  });

  it('times the lookup window from registration, not from the started record', () => {
    let lookups = 0;
    const tracker = new CodexSubagentLimitTracker(() => root, {
      findRollout: () => { lookups++; return undefined; },
    });
    // Adopt attach registers a sub-agent that started 10 minutes before.
    tracker.observe([{ threadId: CHILD_ID, startedAtMs: 0 }], 10 * 60_000);
    tracker.poll(10 * 60_000 + 1);
    expect(tracker.size).toBe(1);
    expect(lookups).toBe(1);
  });

  it('adopt split-live: registers only sub-agents started after the cutoff and surfaces their limit', () => {
    const sessions = join(root, 'sessions');
    const cutoff = Date.parse('2026-10-13T20:22:00.000Z');
    const OLD_ID = '01a136ee-0000-7000-8000-000000000001';
    const parent = join(root, 'parent.jsonl');
    writeFileSync(parent, line(subagentStarted(OLD_ID, '2026-10-13T20:10:00.000Z'))
      + line(subagentStarted(CHILD_ID, '2026-10-13T20:22:42.059Z')));
    for (const [id, ts] of [[OLD_ID, '2026-10-13T20:10:00.000Z'], [CHILD_ID, '2026-10-13T20:22:42.059Z']] as const) {
      writeFileSync(join(dayDir(sessions, Date.parse(ts)), `rollout-x-${id}.jsonl`),
        line({ timestamp: ts, type: 'session_meta', payload: { id } }) + line(taskComplete(USAGE_LIMIT_ERROR)));
    }
    const drained = drainCodexRollout(parent, 0);
    // Same predicate splitCodexEventsByCutoff applies to parent events.
    expect(splitCodexEventsByCutoff([{ uuid: 'x', kind: 'cot', text: '', timestampMs: cutoff }], cutoff).live).toHaveLength(1);
    const tracker = new CodexSubagentLimitTracker(() => sessions);
    tracker.observe(drained.spawnedSubagents?.filter(sub => sub.startedAtMs >= cutoff), Date.now());
    expect(tracker.size).toBe(1);
    const events = tracker.poll();
    expect(events).toHaveLength(1);
    expect(events[0].uuid).toContain(CHILD_ID);
  });
});
