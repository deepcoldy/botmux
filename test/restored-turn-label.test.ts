/**
 * A reply the transcript bridge recovers after a restart may answer a turn the
 * conversation has long moved past. The reply carries which turn it answers —
 * when its input went in and how it began — and the daemon puts that above it.
 *
 * The label is not part of the reply's content or identity: the same reply may
 * be emitted live, then once more from the journal after a crash before its
 * delivery settled. Both emits must stay one output; a content prefix on only
 * the restored one made them conflict, which is why the old prefix was off
 * whenever durable output handoff was on — that is, always in production.
 */
import { describe, expect, it } from 'vitest';
import { restoredTurnLabel, restoredTurnNotice } from '../src/services/restored-turn-label.js';
import { mergeOutputReplay, outputSnapshot } from '../src/services/universal-output-handoff.js';
import type { WorkerFinalOutput } from '../src/types.js';

const askedAtMs = new Date(2026, 10, 11, 19, 45, 30).getTime();

describe('which turn a recovered reply answers', () => {
  it('names the time its input went in and how it began, bounded and on one line', () => {
    expect(restoredTurnLabel({ markTimeMs: askedAtMs, contentNormalized: 'deploy it locally first' }))
      .toEqual({ askedAtMs, excerpt: 'deploy it locally first' });
    const long = restoredTurnLabel({ markTimeMs: askedAtMs, contentNormalized: '用'.repeat(29) + '😀很长的问题' })!;
    expect(Array.from(long.excerpt!)).toHaveLength(31);
    expect(long.excerpt!.endsWith('😀…')).toBe(true);
    expect(restoredTurnLabel({ markTimeMs: askedAtMs, contentNormalized: 'a\n\n  b' })!.excerpt).toBe('a b');
    expect(restoredTurnLabel({ markTimeMs: askedAtMs })).toEqual({ askedAtMs });
    expect(restoredTurnLabel({})).toBeUndefined();
  });

  it('shows the time and the excerpt above the reply, the excerpt literally', () => {
    const zh = restoredTurnNotice({ askedAtMs, excerpt: '甲乙' }, 'zh');
    expect(zh).toContain('11-11 19:45');
    expect(zh).toContain('「甲乙」');
    expect(restoredTurnNotice({ askedAtMs, excerpt: 'q' }, 'en')).toContain('11-11 19:45');
    expect(restoredTurnNotice({ askedAtMs }, 'zh')).toContain('11-11 19:45');
    const hostile = restoredTurnNotice({ askedAtMs, excerpt: '<at id=all></at> **bold** [x](http://e)' }, 'zh');
    expect(hostile).not.toContain('<at');
    expect(hostile).not.toContain('**bold**');
    expect(hostile).not.toContain('[x](');
  });

  it('stays outside the reply\'s identity, so a live emit and its restored re-emit remain one output', () => {
    const live: WorkerFinalOutput = { type: 'final_output', sessionId: 's', content: 'the answer', lastUuid: 'u1', turnId: 'om_turn' };
    const restored: WorkerFinalOutput = { ...live, restoredTurn: { askedAtMs, excerpt: 'q' } };
    const first = outputSnapshot('app', live);
    const again = outputSnapshot('app', restored);
    expect(again.id).toBe(first.id);
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(mergeOutputReplay(first, again)).toBe(first);
    expect(again.output.restoredTurn).toEqual({ askedAtMs, excerpt: 'q' });
  });
});
