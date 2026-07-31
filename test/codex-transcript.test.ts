import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainCodexRollout, codexSessionIdFromRolloutPath, findCodexRolloutBySessionId, findCodexSessionIdByBotmuxSessionId, splitCodexEventsByCutoff, extractLastCodexTurn, scanCodexServiceTier, isCodexNonDefaultServiceTier, codexServiceTierBadge, CodexServiceTierTracker, type CodexBridgeEvent } from '../src/services/codex-transcript.js';

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
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
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

  it('extracts user + assistant_final from response_item', () => {
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

  it('skips assistant phase=commentary (mid-turn status)', () => {
    writeFileSync(path,
      ev({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'thinking…' }],
        },
      }) +
      ev(assistantFinalResponseItem('done')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('assistant_final');
    expect(r.events[0].text).toBe('done');
  });

  it('skips reasoning / function_call / function_call_output / event_msg', () => {
    writeFileSync(path,
      ev({ type: 'response_item', payload: { type: 'reasoning' } }) +
      ev({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }) +
      ev({ type: 'response_item', payload: { type: 'function_call_output' } }) +
      ev({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'not picked up' } }) +
      ev(userResponseItem('actual prompt')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('user');
    expect(r.events[0].text).toBe('actual prompt');
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

function threadSettingsApplied(serviceTier: string, ts = '2026-04-29T07:00:00.000Z') {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      thread_settings: {
        model: 'gpt-5.6-sol',
        model_provider_id: 'byteseed',
        service_tier: serviceTier,
      },
    },
  };
}

describe('scanCodexServiceTier (read-only Fast Mode detection)', () => {
  it('returns undefined when the rollout has no applied-settings record yet', () => {
    writeFileSync(path,
      ev(userResponseItem('hi')) + ev(assistantFinalResponseItem('hello')));
    expect(scanCodexServiceTier(path)).toBeUndefined();
  });

  it('returns undefined for a missing / empty rollout file', () => {
    expect(scanCodexServiceTier(join(dir, 'does-not-exist.jsonl'))).toBeUndefined();
    writeFileSync(path, '');
    expect(scanCodexServiceTier(path)).toBeUndefined();
  });

  it('reads the applied service tier', () => {
    writeFileSync(path,
      ev(threadSettingsApplied('default')) + ev(userResponseItem('hi')));
    expect(scanCodexServiceTier(path)).toBe('default');
  });

  it('returns the LATEST applied tier when the session switched mid-way', () => {
    writeFileSync(path,
      ev(threadSettingsApplied('default', '2026-04-29T07:00:00.000Z')) +
      ev(userResponseItem('go fast')) +
      ev(threadSettingsApplied('priority', '2026-04-29T07:05:00.000Z')) +
      ev(assistantFinalResponseItem('done')));
    expect(scanCodexServiceTier(path)).toBe('priority');
  });

  it('ignores non-settings lines and tolerates malformed json', () => {
    writeFileSync(path,
      'not json at all\n' +
      ev(userResponseItem('hi')) +
      ev(threadSettingsApplied('priority')) +
      'still garbage\n');
    expect(scanCodexServiceTier(path)).toBe('priority');
  });

  it('does not confuse a settings event that carries no service_tier', () => {
    writeFileSync(path, ev({
      timestamp: '2026-04-29T07:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: { model: 'x' } },
    }));
    expect(scanCodexServiceTier(path)).toBeUndefined();
  });

  it('finds the latest tier without reading the whole file (large rollout, bounded)', () => {
    // A large early history, then the last settings switch near the END followed
    // by a few turns. A bounded reverse scan finds it without a whole-file read.
    const filler = ev(assistantFinalResponseItem('x'.repeat(4000)));
    const head = ev(threadSettingsApplied('default')) + ev(userResponseItem('start'));
    const lastSwitch = ev(threadSettingsApplied('priority', '2026-04-29T08:00:00.000Z'));
    // >3 MiB of history, THEN the switch, THEN a little more output.
    writeFileSync(path, head + filler.repeat(800) + lastSwitch + filler.repeat(3));
    expect(statSync(path).size).toBeGreaterThan(3 * 1024 * 1024);
    expect(scanCodexServiceTier(path)).toBe('priority');
  });

  it('returns undefined when the only settings event is far beyond the scan budget', () => {
    // Settings event at the very top, then >2 MiB (the scan cap) of turns.
    // The bounded scan intentionally stops rather than reading the whole file;
    // the worker keeps its last-known value in that case (does not downgrade).
    const filler = ev(assistantFinalResponseItem('y'.repeat(4000)));
    writeFileSync(path, ev(threadSettingsApplied('priority')) + filler.repeat(700));
    expect(statSync(path).size).toBeGreaterThan(2 * 1024 * 1024);
    expect(scanCodexServiceTier(path)).toBeUndefined();
  });
});

describe('isCodexNonDefaultServiceTier', () => {
  it('treats default / empty / undefined as default (no badge)', () => {
    expect(isCodexNonDefaultServiceTier('default')).toBe(false);
    expect(isCodexNonDefaultServiceTier('')).toBe(false);
    expect(isCodexNonDefaultServiceTier(undefined)).toBe(false);
  });

  it('treats any non-default tier id as non-default', () => {
    expect(isCodexNonDefaultServiceTier('priority')).toBe(true);
    expect(isCodexNonDefaultServiceTier('flex')).toBe(true);
  });
});

describe('codexServiceTierBadge', () => {
  it('has no badge for default / empty / undefined', () => {
    expect(codexServiceTierBadge('default')).toBeUndefined();
    expect(codexServiceTierBadge('')).toBeUndefined();
    expect(codexServiceTierBadge(undefined)).toBeUndefined();
  });

  it('shows the ACTUAL tier id, not a hardcoded "Fast" (flex stays flex)', () => {
    // The rollout records only the tier id, never the catalog display name, so
    // the badge must not assert "Fast" — flex is a distinct non-default tier.
    expect(codexServiceTierBadge('priority')).toBe('⚡ priority');
    expect(codexServiceTierBadge('flex')).toBe('⚡ flex');
    expect(codexServiceTierBadge('flex')).not.toContain('Fast');
  });
});

describe('CodexServiceTierTracker (badge cache invalidation)', () => {
  const P1 = '/roll/a.jsonl';
  const P2 = '/roll/b.jsonl';

  it('reports a change once, then suppresses unchanged ticks (throttled scan)', () => {
    const t = new CodexServiceTierTracker(1_000);
    const scan = () => 'priority';
    // First tick: reports the tier.
    expect(t.current({ isCodex: true, rolloutPath: P1, nowMs: 0, scan })).toBe('priority');
    // Within the window, unchanged: no re-report.
    expect(t.current({ isCodex: true, rolloutPath: P1, nowMs: 100, scan })).toBeUndefined();
    // After the window, still unchanged: still no re-report (value didn't move).
    expect(t.current({ isCodex: true, rolloutPath: P1, nowMs: 2_000, scan })).toBeUndefined();
  });

  it('does not re-scan inside the throttle window but converges on the NEXT tick (trailing scan)', () => {
    let tier: string | undefined = 'default';
    let scans = 0;
    const scan = () => { scans++; return tier; };
    const t = new CodexServiceTierTracker(1_000);
    // scanner returns the literal 'default' tier → reported as 'default' (no badge).
    expect(t.current({ isCodex: true, rolloutPath: P1, nowMs: 0, scan })).toBe('default');
    expect(scans).toBe(1);
    // Tier flips to priority, but we tick again inside the window: no scan yet,
    // and a trailing scan is armed.
    tier = 'priority';
    expect(t.current({ isCodex: true, rolloutPath: P1, nowMs: 200, scan })).toBeUndefined();
    expect(scans).toBe(1);
    // Next tick (still inside window): the armed trailing scan fires and the
    // change is picked up even though the screen went quiet.
    expect(t.current({ isCodex: true, rolloutPath: P1, nowMs: 300, scan })).toBe('priority');
    expect(scans).toBe(2);
  });

  it('maps a not-yet-scanned rollout (scanner → undefined) to the explicit-default "" clear', () => {
    const t = new CodexServiceTierTracker(1_000);
    // No settings event yet → scanner returns undefined → tracker reports '' so
    // the daemon shows no badge (rather than undefined = "keep last").
    expect(t.current({ isCodex: true, rolloutPath: P1, nowMs: 0, scan: () => undefined })).toBe('');
  });

  it('invalidates when the rollout PATH changes (no leak across sessions)', () => {
    const t = new CodexServiceTierTracker(1_000);
    expect(t.current({ isCodex: true, rolloutPath: P1, nowMs: 0, scan: () => 'priority' })).toBe('priority');
    // A brand-new rollout (fresh session / relay) that is still on default must
    // NOT keep showing the previous session's priority.
    expect(t.current({ isCodex: true, rolloutPath: P2, nowMs: 100, scan: () => 'default' })).toBe('default');
  });

  it('clears the badge once when the session is no longer codex (e.g. /role → Claude)', () => {
    const t = new CodexServiceTierTracker(1_000);
    expect(t.current({ isCodex: true, rolloutPath: P1, nowMs: 0, scan: () => 'priority' })).toBe('priority');
    // Switched to a non-codex CLI: clear the stale ⚡ badge exactly once...
    expect(t.current({ isCodex: false, rolloutPath: undefined, nowMs: 100, scan: () => 'priority' })).toBe('');
    // ...then stay quiet (no repeated clears every tick).
    expect(t.current({ isCodex: false, rolloutPath: undefined, nowMs: 200, scan: () => 'priority' })).toBeUndefined();
  });

  it('reset() drops all state', () => {
    const t = new CodexServiceTierTracker(1_000);
    expect(t.current({ isCodex: true, rolloutPath: P1, nowMs: 0, scan: () => 'priority' })).toBe('priority');
    t.reset();
    // After reset the same tier reads as a fresh change again.
    expect(t.current({ isCodex: true, rolloutPath: P1, nowMs: 100, scan: () => 'priority' })).toBe('priority');
  });
});
