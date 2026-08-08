import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainCodexRollout, codexSessionIdFromRolloutPath, findCodexRolloutBySessionId, findCodexSessionIdByBotmuxSessionId, codexHistorySidIsOwned, splitCodexEventsByCutoff, extractLastCodexTurn, scanCodexThreadSettings, type CodexBridgeEvent } from '../src/services/codex-transcript.js';

let dir: string;
let path: string;

function ev(obj: any): string {
  return JSON.stringify(obj) + '\n';
}

function userResponseItem(text: string, ts = '2026-04-29T07:00:00.000Z') {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  };
}

function assistantFinalResponseItem(text: string, ts = '2026-04-29T07:00:01.000Z') {
  // The turn terminal is now event_msg/task_complete, NOT the assistant
  // response_item. Codex >=0.146 dropped phase:'final_answer', so this helper
  // emits the task_complete record that actually closes the turn. `text`
  // becomes last_agent_message. Kept named "assistantFinal…" so existing
  // call sites read naturally.
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: `turn-${ts}`,
      last_agent_message: text,
    },
  };
}

/** An assistant `response_item` message — mid-turn OR final, both phase-less in
 *  codex >=0.146. The reader must NOT treat any of these as a turn boundary. */
function assistantMessageResponseItem(text: string, phase?: string, ts = '2026-04-29T07:00:01.000Z') {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      ...(phase !== undefined ? { phase } : {}),
      content: [{ type: 'output_text', text }],
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-transcript-'));
  path = join(dir, 'rollout.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('codexSessionIdFromRolloutPath', () => {
  it('extracts sessionId suffix from a canonical rollout path', () => {
    expect(codexSessionIdFromRolloutPath(
      '/root/.codex/sessions/2026/04/29/rollout-2026-04-29T07-04-39-019dd80d-d922-7a11-8339-0208d8c5b4ec.jsonl',
    )).toBe('019dd80d-d922-7a11-8339-0208d8c5b4ec');
  });

  it('returns undefined for non-rollout paths', () => {
    expect(codexSessionIdFromRolloutPath('/var/log/syslog')).toBeUndefined();
    expect(codexSessionIdFromRolloutPath('/root/.codex/history.jsonl')).toBeUndefined();
  });

  it('returns undefined when filename is malformed', () => {
    expect(codexSessionIdFromRolloutPath('/root/.codex/sessions/foo/bar.jsonl')).toBeUndefined();
    expect(codexSessionIdFromRolloutPath('rollout-no-suffix-just-text.jsonl')).toBeUndefined();
  });
});

describe('findCodexRolloutBySessionId', () => {
  it('honors CODEX_HOME when locating rollout transcripts', () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const sid = '019dd80d-d922-7a11-8339-0208d8c5b4ec';
    const rolloutDir = join(codexHome, 'sessions', '2026', '06', '02');
    const rolloutPath = join(rolloutDir, `rollout-2026-06-02T08-14-07-${sid}.jsonl`);
    process.env.CODEX_HOME = codexHome;
    try {
      mkdirSync(rolloutDir, { recursive: true });
      writeFileSync(rolloutPath, '');
      expect(findCodexRolloutBySessionId(sid)).toBe(rolloutPath);
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe('codexHistorySidIsOwned (pure attach-ownership decision)', () => {
  // This is the exact predicate BOTH worker attach entry points (notify
  // re-attach + initial-attach guard) consult via codexHistorySidOwnedByCurrentPid.
  // Testing it directly proves "owned B is selected, foreign A is rejected"
  // without a live worker — and without a parallel copy of the decision.
  const OWNED = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  const SIBLING = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
  const FOREIGN = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

  it('accepts an owned sid (single-rollout pid)', () => {
    expect(codexHistorySidIsOwned(OWNED, new Set([OWNED]))).toBe(true);
  });

  it('accepts EITHER owned sid in the parent+sibling multi-rollout case', () => {
    const owned = new Set([OWNED, SIBLING]);
    expect(codexHistorySidIsOwned(OWNED, owned)).toBe(true);
    expect(codexHistorySidIsOwned(SIBLING, owned)).toBe(true);
  });

  it('rejects a foreign sid (shared-CODEX_HOME sibling pane collision)', () => {
    expect(codexHistorySidIsOwned(FOREIGN, new Set([OWNED, SIBLING]))).toBe(false);
  });

  it('is case-insensitive on the sid', () => {
    expect(codexHistorySidIsOwned(OWNED.toUpperCase(), new Set([OWNED]))).toBe(true);
  });

  it('fails closed when the owned set is unavailable (fd enumeration failed)', () => {
    expect(codexHistorySidIsOwned(OWNED, undefined)).toBe(false);
  });

  it('fails closed against an empty owned set (pid holds no rollout yet)', () => {
    expect(codexHistorySidIsOwned(OWNED, new Set())).toBe(false);
  });
});

describe('findCodexSessionIdByBotmuxSessionId', () => {
  it('bounds the history scan to the requested tail window', () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const historyPath = join(codexHome, 'history.jsonl');
    process.env.CODEX_HOME = codexHome;
    try {
      const oldLine = JSON.stringify({ session_id: 'old-codex-sid', text: 'hello <session_id>botmux-tail-sid</session_id>' });
      const padding = Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({ session_id: `pad-${i}`, text: 'x'.repeat(100) }),
      ).join('\n');
      writeFileSync(historyPath, `${oldLine}\n${padding}\n`);

      // The marker lives outside a 1 KiB tail window — must not be found
      // (and, crucially, the whole multi-MB file must not be slurped).
      expect(findCodexSessionIdByBotmuxSessionId('botmux-tail-sid', { maxTailBytes: 1024 })).toBeUndefined();
      // The default window is large enough to cover the entire file here.
      expect(findCodexSessionIdByBotmuxSessionId('botmux-tail-sid')).toBe('old-codex-sid');
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('honors CODEX_HOME and returns the newest history entry for a botmux session', () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const historyPath = join(codexHome, 'history.jsonl');
    process.env.CODEX_HOME = codexHome;
    try {
      writeFileSync(historyPath, [
        JSON.stringify({ session_id: 'older-codex-sid', text: 'hello <session_id>botmux-sid</session_id>' }),
        JSON.stringify({ session_id: 'unrelated-codex-sid', text: 'hello another-session' }),
        JSON.stringify({ session_id: 'newer-codex-sid', text: 'resume <session_id>botmux-sid</session_id>' }),
      ].join('\n') + '\n');

      expect(findCodexSessionIdByBotmuxSessionId('botmux-sid')).toBe('newer-codex-sid');
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe('splitCodexEventsByCutoff', () => {
  const ev = (uuid: string, kind: 'user' | 'assistant_final', timestampMs: number, text = 't'): CodexBridgeEvent =>
    ({ uuid, timestampMs, kind, text });

  it('partitions by strict less-than: events at cutoff land in live', () => {
    const events = [ev('a', 'user', 50), ev('b', 'user', 100), ev('c', 'assistant_final', 150)];
    const out = splitCodexEventsByCutoff(events, 100);
    expect(out.history.map(e => e.uuid)).toEqual(['a']);
    expect(out.live.map(e => e.uuid)).toEqual(['b', 'c']);
  });

  it('all-history when every event predates cutoff', () => {
    const events = [ev('a', 'user', 10), ev('b', 'assistant_final', 20)];
    const out = splitCodexEventsByCutoff(events, 100);
    expect(out.history.map(e => e.uuid)).toEqual(['a', 'b']);
    expect(out.live).toEqual([]);
  });

  it('all-live when every event is at-or-after cutoff', () => {
    const events = [ev('a', 'user', 100), ev('b', 'assistant_final', 200)];
    const out = splitCodexEventsByCutoff(events, 100);
    expect(out.history).toEqual([]);
    expect(out.live.map(e => e.uuid)).toEqual(['a', 'b']);
  });

  it('preserves event order within each partition', () => {
    const events = [
      ev('hist1', 'user', 10),
      ev('live1', 'user', 200),
      ev('hist2', 'assistant_final', 50),
      ev('live2', 'assistant_final', 250),
    ];
    const out = splitCodexEventsByCutoff(events, 100);
    expect(out.history.map(e => e.uuid)).toEqual(['hist1', 'hist2']);
    expect(out.live.map(e => e.uuid)).toEqual(['live1', 'live2']);
  });

  it('empty input returns empty partitions', () => {
    const out = splitCodexEventsByCutoff([], 100);
    expect(out.history).toEqual([]);
    expect(out.live).toEqual([]);
  });
});

describe('extractLastCodexTurn', () => {
  const mk = (kind: 'user' | 'assistant_final', text: string) => ({ kind, text });

  it('returns last user/assistant_final pair from a typical history', () => {
    const out = extractLastCodexTurn([
      mk('user', 'u1'), mk('assistant_final', 'a1'),
      mk('user', 'u2'), mk('assistant_final', 'a2'),
    ]);
    expect(out).toEqual({ userText: 'u2', assistantText: 'a2' });
  });

  it('pairs the last assistant_final with the nearest preceding user', () => {
    // u1 没回复 → 配 (u2, a) 而不是 (u1, a)
    const out = extractLastCodexTurn([
      mk('user', 'u1'),
      mk('user', 'u2'),
      mk('assistant_final', 'a'),
    ]);
    expect(out).toEqual({ userText: 'u2', assistantText: 'a' });
  });

  it('returns undefined when there is no assistant_final', () => {
    expect(extractLastCodexTurn([mk('user', 'u1'), mk('user', 'u2')])).toBeUndefined();
  });

  it('returns undefined when assistant_final has no preceding user', () => {
    // 罕见但可能：rollout 起手就是 assistant message（例如 resume 截断）
    expect(extractLastCodexTurn([mk('assistant_final', 'a')])).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(extractLastCodexTurn([])).toBeUndefined();
  });

  it('ignores trailing user that has no reply yet', () => {
    // ...u1 a1 u2  → 最后一对完整 turn 仍是 (u1, a1)
    const out = extractLastCodexTurn([
      mk('user', 'u1'), mk('assistant_final', 'a1'),
      mk('user', 'u2'),
    ]);
    expect(out).toEqual({ userText: 'u1', assistantText: 'a1' });
  });
});

describe('drainCodexRollout', () => {
  it('returns empty for missing file', () => {
    const r = drainCodexRollout(join(dir, 'missing.jsonl'), 0);
    expect(r.events).toEqual([]);
    expect(r.newOffset).toBe(0);
  });

  it('extracts user (response_item) + assistant_final (task_complete)', () => {
    writeFileSync(path,
      ev(userResponseItem('hello there')) +
      ev(assistantFinalResponseItem('hi back')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[0].kind).toBe('user');
    expect(r.events[0].text).toBe('hello there');
    expect(r.events[1].kind).toBe('assistant_final');
    expect(r.events[1].text).toBe('hi back');
  });

  it('skips developer role messages', () => {
    writeFileSync(path,
      ev({
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys instr' }] },
      }) +
      ev(userResponseItem('real user prompt')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('user');
    expect(r.events[0].text).toBe('real user prompt');
  });

  // Regression for the codex >=0.146 phase-drift bug: mid-turn AND final
  // assistant response_item messages are both phase-less and must NOT be a
  // turn boundary. Only task_complete closes the turn. Keying on a phase-less
  // assistant message would close the turn on the first mid-turn preamble
  // ("I'll run the commands…") and truncate the real answer.
  it('never treats an assistant response_item message as terminal (mid-turn preamble + phase-less final)', () => {
    writeFileSync(path,
      ev(userResponseItem('do two things')) +
      ev(assistantMessageResponseItem("I'll run the commands.")) +   // mid-turn preamble, phase:undefined
      ev(assistantMessageResponseItem('step1 step2 DONE')) +          // final answer, ALSO phase:undefined (0.146)
      ev(assistantFinalResponseItem('step1 step2 DONE')));            // the real terminal
    const r = drainCodexRollout(path, 0);
    // Exactly one user + one assistant_final (from task_complete). Neither
    // assistant response_item produced an event.
    expect(r.events).toHaveLength(2);
    expect(r.events[0].kind).toBe('user');
    expect(r.events[1].kind).toBe('assistant_final');
    expect(r.events[1].text).toBe('step1 step2 DONE');
  });

  // Old codex (0.139 / 0.145) still tags the final message phase:'final_answer'
  // AND emits task_complete. We take ONLY task_complete → exactly one
  // assistant_final, no double-close (the queue would buffer a stray second
  // final and could mis-close a later turn).
  it('old-codex final_answer response_item + task_complete → single assistant_final', () => {
    writeFileSync(path,
      ev(userResponseItem('hi')) +
      ev(assistantMessageResponseItem('legacy final', 'final_answer')) +  // old phase-tagged final
      ev(assistantFinalResponseItem('legacy final')));                    // task_complete for same turn
    const r = drainCodexRollout(path, 0);
    const finals = r.events.filter(e => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe('legacy final');
  });

  // A task_complete with empty last_agent_message still closes the turn (a
  // silent successful turn must release its durable delivery).
  it('empty last_agent_message still yields an assistant_final', () => {
    writeFileSync(path,
      ev(userResponseItem('go')) +
      ev({ timestamp: '2026-04-29T07:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: '' } }));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[1].kind).toBe('assistant_final');
    expect(r.events[1].text).toBe('');
  });

  // task_complete without a turn_id is a malformed/partial record — ignored
  // (belt-and-suspenders on top of the newline-completeness guard).
  it('task_complete without turn_id is ignored', () => {
    writeFileSync(path,
      ev(userResponseItem('go')) +
      ev({ timestamp: '2026-04-29T07:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'no turn id' } }));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('user');
  });

  // A cancelled turn writes turn_aborted (no task_complete) → ambiguous
  // terminal so the durable delivery releases instead of wedging as running.
  it('turn_aborted yields an ambiguous assistant_final', () => {
    writeFileSync(path,
      ev(userResponseItem('go')) +
      ev({ timestamp: '2026-04-29T07:00:02.000Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1', reason: 'user interrupt' } }));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[1].kind).toBe('assistant_final');
    expect(r.events[1].terminalStatus).toBe('ambiguous');
    expect(r.events[1].terminalErrorCode).toBe('codex_turn_aborted:user_interrupt');
  });

  it('skips reasoning / function_call / function_call_output / non-terminal event_msg', () => {
    writeFileSync(path,
      ev({ type: 'response_item', payload: { type: 'reasoning' } }) +
      ev({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }) +
      ev({ type: 'response_item', payload: { type: 'function_call_output' } }) +
      ev({ type: 'event_msg', payload: { type: 'token_count', total: 42 } }) +
      ev({ type: 'event_msg', payload: { type: 'agent_message', message: 'mid-turn chatter' } }) +
      ev(userResponseItem('actual prompt')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('user');
    expect(r.events[0].text).toBe('actual prompt');
  });

  it('extracts turn_aborted as a no-output terminal edge', () => {
    writeFileSync(path,
      ev(userResponseItem('interrupt me')) +
      ev({
        timestamp: '2026-04-29T07:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' },
      }));
    const r = drainCodexRollout(path, 0);
    expect(r.events.map(event => ({ kind: event.kind, text: event.text, status: event.terminalStatus }))).toEqual([
      { kind: 'user', text: 'interrupt me', status: undefined },
      { kind: 'assistant_final', text: '', status: 'ambiguous' },
    ]);
  });

  it('keeps an empty final_answer as a normal completed terminal edge', () => {
    writeFileSync(path,
      ev(userResponseItem('finish without visible text')) +
      ev(assistantFinalResponseItem('')));
    const r = drainCodexRollout(path, 0);
    expect(r.events.map(event => ({ kind: event.kind, text: event.text }))).toEqual([
      { kind: 'user', text: 'finish without visible text' },
      { kind: 'assistant_final', text: '' },
    ]);
  });

  it('skips messages with no input_text/output_text content', () => {
    writeFileSync(path,
      ev({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'image_url', url: 'x' }] },
      }) +
      ev(userResponseItem('text after image-only')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].text).toBe('text after image-only');
  });

  it('ignores malformed JSON lines', () => {
    writeFileSync(path,
      'not json\n' +
      ev(userResponseItem('after bad line')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].text).toBe('after bad line');
  });

  it('byte-offset stable: re-drain from newOffset returns no events', () => {
    writeFileSync(path,
      ev(userResponseItem('first')) +
      ev(assistantFinalResponseItem('reply')));
    const first = drainCodexRollout(path, 0);
    const second = drainCodexRollout(path, first.newOffset);
    expect(second.events).toEqual([]);
    expect(second.newOffset).toBe(first.newOffset);
  });

  it('appended events drain incrementally', () => {
    writeFileSync(path, ev(userResponseItem('first')));
    const r1 = drainCodexRollout(path, 0);
    expect(r1.events).toHaveLength(1);
    appendFileSync(path, ev(assistantFinalResponseItem('reply')));
    const r2 = drainCodexRollout(path, r1.newOffset);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].kind).toBe('assistant_final');
  });

  it('partial trailing line is held back as pendingTail', () => {
    writeFileSync(path, ev(userResponseItem('complete')) + '{"type":"response_item",partial');
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.pendingTail).toContain('partial');
    expect(r.newOffset).toBeLessThan(statSync(path).size);
  });

  it('uuid encodes path:byteStart and is stable across re-drains', () => {
    writeFileSync(path,
      ev(userResponseItem('uuid-one')) +
      ev(userResponseItem('uuid-two')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[0].uuid).toMatch(/^.+\.jsonl:0$/);
    expect(r.events[1].uuid).not.toBe(r.events[0].uuid);
    // Re-drain from 0 should produce identical uuids.
    const r2 = drainCodexRollout(path, 0);
    expect(r2.events.map(e => e.uuid)).toEqual(r.events.map(e => e.uuid));
  });

  it('truncated file (size < fromOffset) re-drains from top', () => {
    writeFileSync(path,
      ev(userResponseItem('original message that is reasonably long for offset')) +
      ev(assistantFinalResponseItem('long original answer to take up bytes')));
    const r1 = drainCodexRollout(path, 0);
    // Simulate truncation: rewrite with strictly shorter content so the new
    // size is below r1.newOffset and the re-drain branch fires.
    writeFileSync(path, ev(userResponseItem('s')));
    const r2 = drainCodexRollout(path, r1.newOffset);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].text).toBe('s');
  });
});

function threadSettingsApplied(serviceTier: string, ts = '2026-04-29T07:00:00.000Z', model = 'gpt-5.6-sol') {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      thread_settings: {
        model,
        model_provider_id: 'byteseed',
        service_tier: serviceTier,
      },
    },
  };
}

describe('Codex thread settings observation', () => {
  it('returns undefined when the rollout has no applied-settings record yet', () => {
    writeFileSync(path,
      ev(userResponseItem('hi')) + ev(assistantFinalResponseItem('hello')));
    expect(scanCodexThreadSettings(path)).toBeUndefined();
  });

  it('returns undefined for a missing / empty rollout file', () => {
    expect(scanCodexThreadSettings(join(dir, 'does-not-exist.jsonl'))).toBeUndefined();
    writeFileSync(path, '');
    expect(scanCodexThreadSettings(path)).toBeUndefined();
  });

  it('reads the applied model and service tier', () => {
    writeFileSync(path,
      ev(threadSettingsApplied('default')) + ev(userResponseItem('hi')));
    expect(scanCodexThreadSettings(path)).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'default',
    });
  });

  it('returns the LATEST applied tier when the session switched mid-way', () => {
    writeFileSync(path,
      ev(threadSettingsApplied('default', '2026-04-29T07:00:00.000Z')) +
      ev(userResponseItem('go fast')) +
      ev(threadSettingsApplied('priority', '2026-04-29T07:05:00.000Z')) +
      ev(assistantFinalResponseItem('done')));
    expect(scanCodexThreadSettings(path)).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'priority',
    });
  });

  it('ignores non-settings lines and tolerates malformed json', () => {
    writeFileSync(path,
      'not json at all\n' +
      ev(userResponseItem('hi')) +
      ev(threadSettingsApplied('priority')) +
      'still garbage\n');
    expect(scanCodexThreadSettings(path)?.serviceTier).toBe('priority');
  });

  it('does not confuse a settings event that carries no service_tier', () => {
    writeFileSync(path, ev({
      timestamp: '2026-04-29T07:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: { model: 'x' } },
    }));
    expect(scanCodexThreadSettings(path)).toBeUndefined();
  });

  it('reports the latest settings from the newly appended byte range', () => {
    writeFileSync(path,
      ev(threadSettingsApplied('default')) + ev(userResponseItem('first')));
    const first = drainCodexRollout(path, 0);
    expect(first.latestThreadSettings).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'default',
    });

    // Both toggles can land between two 1s bridge polls. The final executor
    // state must still be observed even when no PTY screen update follows.
    appendFileSync(path,
      ev(threadSettingsApplied('priority', '2026-04-29T07:01:00.000Z'))
      + ev(threadSettingsApplied('default', '2026-04-29T07:01:00.100Z')));
    const second = drainCodexRollout(path, first.newOffset);

    expect(second.events).toEqual([]);
    expect(second.latestThreadSettings).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'default',
    });
  });

  it('reverse-scans across chunk and UTF-8 boundaries without loading the whole rollout', () => {
    const latest = ev(threadSettingsApplied('priority', '2026-04-29T07:05:00.000Z'));
    // 900 trailing bytes force the preceding settings line to straddle the
    // scanner's 1024-byte read boundary. Earlier multi-byte content exercises
    // the byte-oriented carry path as well.
    writeFileSync(path,
      ev(threadSettingsApplied('default'))
      + ev(userResponseItem('边界'.repeat(800)))
      + latest
      + `${'x'.repeat(899)}\n`);

    expect(scanCodexThreadSettings(path, { chunkBytes: 1024 })).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'priority',
    });
  });
});
