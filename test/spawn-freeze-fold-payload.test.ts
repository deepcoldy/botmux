import { describe, expect, it } from 'vitest';
import { foldReplayPayload } from '../src/core/worker-pool.js';
import type { CliTurnPayload } from '../src/types.js';

/**
 * `foldReplayPayload` merges the turns a user sent while a spawn-freeze held the
 * session into the single opening that gets replayed on release. The load-bearing
 * subtlety is the two channels: plain CLIs read `.content`; codex-app reads
 * `codexAppInput.text` INSTEAD, so a fold that touched only one would silently
 * drop the later turns on whichever CLI reads the other.
 */
describe('foldReplayPayload', () => {
  it('returns the original payload untouched when nothing was folded', () => {
    expect(foldReplayPayload('only', [])).toBe('only');
    const payload: CliTurnPayload = { content: 'only', codexAppInput: { text: 't' } };
    expect(foldReplayPayload(payload, [])).toBe(payload);
  });

  it('merges plain-string turns into one blank-line-separated opening string', () => {
    const merged = foldReplayPayload('first', [{ content: 'second' }, { content: 'third' }]);
    expect(merged).toBe('first\n\nsecond\n\nthird');
  });

  it('merges .content for a payload opening with no sidecar', () => {
    const merged = foldReplayPayload({ content: 'first' }, [{ content: 'second' }]);
    expect(merged).toEqual({ content: 'first\n\nsecond' });
  });

  it('merges BOTH channels when a codex-app sidecar is present on the opening', () => {
    const merged = foldReplayPayload(
      { content: 'c-first', codexAppInput: { text: 't-first' } },
      [{ content: 'c-second', codexAppInput: { text: 't-second' } }],
    );
    expect(merged).toEqual({
      content: 'c-first\n\nc-second',
      codexAppInput: { text: 't-first\n\nt-second' },
    });
  });

  it('lifts a sidecar that first appears on a FOLDED turn (opening had none)', () => {
    // The opening was a plain turn; a later codex-app turn folded in. Its sidecar
    // text must still be carried, or codex-app would read an empty/at-open .text
    // and lose that turn.
    const merged = foldReplayPayload(
      { content: 'c-first' },
      [{ content: 'c-second', codexAppInput: { text: 't-second' } }],
    );
    expect(merged).toEqual({
      content: 'c-first\n\nc-second',
      codexAppInput: { text: 't-second' },
    });
  });

  it('preserves the opening sidecar metadata (images / context) while merging text', () => {
    const merged = foldReplayPayload(
      {
        content: 'c-first',
        codexAppInput: {
          text: 't-first',
          localImages: [{ path: '/img.png' }],
          additionalContext: { k: { type: 'application', value: 'v' } as never },
        },
      },
      [{ content: 'c-second', codexAppInput: { text: 't-second' } }],
    );
    expect(merged).toMatchObject({
      content: 'c-first\n\nc-second',
      codexAppInput: {
        text: 't-first\n\nt-second',
        localImages: [{ path: '/img.png' }],
        additionalContext: { k: { type: 'application', value: 'v' } },
      },
    });
  });

  it('skips blank content parts so a promptless fold cannot inject stray blank lines', () => {
    const merged = foldReplayPayload({ content: 'first' }, [{ content: '   ' }, { content: 'third' }]);
    expect(merged).toEqual({ content: 'first\n\nthird' });
  });
});
