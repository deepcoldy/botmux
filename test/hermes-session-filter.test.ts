import { describe, expect, it } from 'vitest';
import { filterHermesEventsForBotmuxSession } from '../src/services/hermes-session-filter.js';
import type { CodexBridgeEvent } from '../src/services/codex-transcript.js';

function user(uuid: string, sourceSessionId: string | undefined, text: string): CodexBridgeEvent {
  return { uuid, timestampMs: 1, kind: 'user', sourceSessionId, text };
}

function assistant(uuid: string, sourceSessionId: string | undefined, text: string): CodexBridgeEvent {
  return { uuid, timestampMs: 2, kind: 'assistant_final', sourceSessionId, text };
}

describe('filterHermesEventsForBotmuxSession', () => {
  it('binds on the botmux session marker and drops foreign Hermes sessions while advancing caller offset externally', () => {
    const result = filterHermesEventsForBotmuxSession([
      assistant('a-foreign-before-bind', 'hermes-B', 'foreign stale final'),
      user('u-foreign', 'hermes-B', '<session_id>other-botmux</session_id>\nhello'),
      user('u-current', 'hermes-A', '<session_id>botmux-A</session_id>\nhello'),
      assistant('a-foreign-after-bind', 'hermes-B', 'wrong final'),
      assistant('a-current', 'hermes-A', 'right final'),
    ], { botmuxSessionId: 'botmux-A' });

    expect(result.newlyBoundSourceSessionId).toBe('hermes-A');
    expect(result.boundSourceSessionId).toBe('hermes-A');
    expect(result.events.map(e => e.uuid)).toEqual(['u-current', 'a-current']);
    expect(result.drops.map(d => [d.uuid, d.reason])).toEqual([
      ['a-foreign-before-bind', 'unbound'],
      ['u-foreign', 'unbound'],
      ['a-foreign-after-bind', 'foreign_source'],
    ]);
  });

  it('keeps using an existing binding and drops rows without sourceSessionId', () => {
    const result = filterHermesEventsForBotmuxSession([
      user('u-missing', undefined, '<session_id>botmux-A</session_id>'),
      assistant('a-current', 'hermes-A', 'right final'),
      assistant('a-missing', undefined, 'missing source'),
    ], { botmuxSessionId: 'botmux-A', boundSourceSessionId: 'hermes-A' });

    expect(result.newlyBoundSourceSessionId).toBeUndefined();
    expect(result.boundSourceSessionId).toBe('hermes-A');
    expect(result.events.map(e => e.uuid)).toEqual(['a-current']);
    expect(result.drops.map(d => [d.uuid, d.reason])).toEqual([
      ['u-missing', 'missing_source'],
      ['a-missing', 'missing_source'],
    ]);
  });
});
