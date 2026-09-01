/**
 * "The platform can never prove it" is not the same failure as "it should have been
 * provable and was not", and collapsing the two produces a permanent wedge.
 *
 * On a host with no /proc the subtree scan answers `unsupported-platform` forever.
 * Routed into the latched write fence, that means: every /close fails, every retry
 * fails for the same unchangeable reason, and write() never returns true again — the
 * session becomes impossible to close AND impossible to use. Nothing in that state
 * is evidence of a surviving process; it is evidence that we cannot look.
 *
 * `alive` (a positive sighting) and `unscannable` (a transient/partial read failure
 * on a host that normally CAN enumerate) are the opposite: a credentialed process
 * may be running right now, and a retry can genuinely change the answer, so both
 * must keep the fence.
 *
 * Both directions are pinned here because each has a matching mutation:
 *   - latch unsupported-platform too  -> the wedge returns
 *   - let unscannable close as residual -> a live subtree's row closes
 *
 * Run:  pnpm vitest run test/mojo-unprovable-platform-close.test.ts
 */
import { describe, expect, it } from 'bun:test';
import { classifyUnprovenTermination } from '../src/adapters/backend/destroy-result.js';

describe('classifyUnprovenTermination', () => {
  it('lets a permanently unprovable platform close with residual instead of wedging', () => {
    const verdict = classifyUnprovenTermination('unsupported-platform');
    expect(verdict.outcome).toBe('residual-close');
    // The reason names the PLATFORM, not a suspected survivor: an operator reading
    // this must not think a process was seen.
    expect(verdict.reason).toBe('mojo_local_termination_unprovable_on_platform');
  });

  it('keeps the fence for a positive sighting', () => {
    // `alive` means the scan actually found members.
    expect(classifyUnprovenTermination('alive')).toEqual({
      outcome: 'fence',
      reason: 'mojo_local_child_termination_unproven',
    });
  });

  it('keeps the fence for a transient scan failure', () => {
    // The distinction that makes the whole split safe: unscannable is a host that
    // CAN normally enumerate, so a retry may prove termination. Treating it as
    // residual would close the row over a possibly-live credentialed subtree.
    const verdict = classifyUnprovenTermination('unscannable');
    expect(verdict.outcome).toBe('fence');
    expect(verdict.reason).toBe('mojo_local_termination_unscannable');
  });

  it('fails closed on an absent or unrecognised kind', () => {
    // A new quiescence kind added upstream must not silently inherit the residual
    // path just because nobody updated this switch.
    for (const kind of [undefined, '', 'contained-proven', 'diagnostic-clean', 'something-new']) {
      expect(classifyUnprovenTermination(kind).outcome, `kind=${String(kind)}`).toBe('fence');
    }
  });

  it('never routes anything but unsupported-platform to residual-close', () => {
    // Guards the blast radius: residual-close is only sound while the credential
    // boundary is held by an unprovable containment handle that can never be
    // released. Any additional kind reaching it needs that same backstop proven
    // first, so widening this set must break a test.
    const residual = [
      'unsupported-platform', 'alive', 'unscannable', 'contained-proven',
      'diagnostic-clean', undefined, 'bogus',
    ].filter(k => classifyUnprovenTermination(k).outcome === 'residual-close');
    expect(residual).toEqual(['unsupported-platform']);
  });
});
