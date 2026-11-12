// `botmux suspend` 排队时要说清楚在等什么：daemon 回的 waitingFor 每一种都要说成不同的话，
// 等回复时带上还要等多久；旧 daemon 不回 waitingFor 时退回笼统说法。
import { describe, expect, it } from 'vitest';
import { deferredSuspendNote } from '../src/cli/suspend-output.js';

const NOW = 1_800_000_000_000;

describe('deferredSuspendNote', () => {
  it('tells each wait apart, and from a daemon that did not say', () => {
    const notes = ['turn', 'input', 'reply'].map(wait => deferredSuspendNote({ waitingFor: [wait] }, NOW));
    const fallback = deferredSuspendNote({}, NOW);
    expect(new Set([...notes, fallback]).size).toBe(4);
    expect(deferredSuspendNote({ waitingFor: ['unknown-wait'] }, NOW)).toBe(fallback);
    expect(deferredSuspendNote({ waitingFor: 'turn' }, NOW)).toBe(fallback);
  });

  it('names every wait it was given, once', () => {
    const both = deferredSuspendNote({ waitingFor: ['turn', 'reply', 'turn'] }, NOW);
    expect(both).toBe(deferredSuspendNote({ waitingFor: ['turn', 'reply'] }, NOW));
    expect(both).not.toBe(deferredSuspendNote({ waitingFor: ['turn'] }, NOW));
    expect(both).not.toBe(deferredSuspendNote({ waitingFor: ['reply'] }, NOW));
  });

  it('says how long the reply wait can still take', () => {
    const soon = deferredSuspendNote({ waitingFor: ['reply'], replyHoldUntil: NOW + 95_000 }, NOW);
    expect(soon).toMatch(/\b95\b/);
    const later = deferredSuspendNote({ waitingFor: ['reply'], replyHoldUntil: NOW + 9 * 60_000 + 1 }, NOW);
    expect(later).toMatch(/\b10\b/);
    expect(later).not.toMatch(/\b541\b/);
    expect(deferredSuspendNote({ waitingFor: ['reply'] }, NOW)).not.toMatch(/\d/);
  });
});
