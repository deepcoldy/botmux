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

    expect(result.newlyBoundSourceSessionIds).toEqual(['hermes-A']);
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

    expect(result.newlyBoundSourceSessionIds).toEqual([]);
    expect(result.boundSourceSessionId).toBe('hermes-A');
    expect(result.events.map(e => e.uuid)).toEqual(['a-current']);
    expect(result.drops.map(d => [d.uuid, d.reason])).toEqual([
      ['u-missing', 'missing_source'],
      ['a-missing', 'missing_source'],
    ]);
  });

  it('rebinds when the same botmux session marker appears in a new Hermes session', () => {
    const result = filterHermesEventsForBotmuxSession([
      assistant('a-old', 'hermes-A', 'old final'),
      user('u-new', ' hermes-C ', '<session_id>botmux-A</session_id>\nafter clear'),
      assistant('a-new', 'hermes-C', 'new final'),
      assistant('a-old-late', 'hermes-A', 'late old final'),
    ], { botmuxSessionId: 'botmux-A', boundSourceSessionId: 'hermes-A' });

    expect(result.newlyBoundSourceSessionIds).toEqual(['hermes-C']);
    expect(result.boundSourceSessionId).toBe('hermes-C');
    expect(result.events.map(e => e.uuid)).toEqual(['a-old', 'u-new', 'a-new']);
    expect(result.drops.map(d => [d.uuid, d.reason, d.expectedSourceSessionId])).toEqual([
      ['a-old-late', 'foreign_source', 'hermes-C'],
    ]);
  });

  it('reports every source bound in one drain when starting unbound (clear rotation within a batch)', () => {
    // The worker attaches unbound (fresh spawn / re-attach) and a single drain
    // straddles a `/clear`: the first turn binds hermes-A, then the marker
    // reappears under the rotated hermes-C. Both finals are kept, and BOTH
    // sources are reported so the worker announces each to the daemon — the
    // completed hermes-A turn must not be dropped once hermes-C is bound.
    const result = filterHermesEventsForBotmuxSession([
      user('u-A', 'hermes-A', '<session_id>botmux-A</session_id>\nfirst question'),
      assistant('a-A', 'hermes-A', 'answer A'),
      user('u-C', 'hermes-C', '<session_id>botmux-A</session_id>\nafter clear'),
      assistant('a-C', 'hermes-C', 'answer C'),
    ], { botmuxSessionId: 'botmux-A' });

    expect(result.newlyBoundSourceSessionIds).toEqual(['hermes-A', 'hermes-C']);
    expect(result.boundSourceSessionId).toBe('hermes-C');
    expect(result.events.map(e => e.uuid)).toEqual(['u-A', 'a-A', 'u-C', 'a-C']);
    expect(result.drops).toEqual([]);
  });

  it('isolates two botmux workers reading the same interleaved Hermes rows', () => {
    const sharedEvents = [
      user('u-A', 'hermes-A', '<session_id>botmux-A</session_id>\nquestion A'),
      user('u-B', 'hermes-B', '<session_id>botmux-B</session_id>\nquestion B'),
      assistant('a-B', 'hermes-B', 'answer B'),
      assistant('a-A', 'hermes-A', 'answer A'),
    ];

    const workerA = filterHermesEventsForBotmuxSession(sharedEvents, { botmuxSessionId: 'botmux-A' });
    const workerB = filterHermesEventsForBotmuxSession(sharedEvents, { botmuxSessionId: 'botmux-B' });

    expect(workerA.boundSourceSessionId).toBe('hermes-A');
    expect(workerA.events.map(e => e.uuid)).toEqual(['u-A', 'a-A']);
    expect(workerA.drops.map(d => [d.uuid, d.reason])).toEqual([
      ['u-B', 'foreign_source'],
      ['a-B', 'foreign_source'],
    ]);

    expect(workerB.boundSourceSessionId).toBe('hermes-B');
    expect(workerB.events.map(e => e.uuid)).toEqual(['u-B', 'a-B']);
    expect(workerB.drops.map(d => [d.uuid, d.reason])).toEqual([
      ['u-A', 'unbound'],
      ['a-A', 'foreign_source'],
    ]);
  });
});
