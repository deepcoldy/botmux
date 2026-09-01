/**
 * The shared residual parser is the only thing standing between a JSON close
 * response and a consumer that would otherwise report "closed" for a remote
 * session that is still running with an injected credential.
 *
 * Run:  pnpm vitest run test/close-residual.test.ts
 */
import { describe, expect, it } from 'bun:test';
import {
  closeResidualClause,
  closeResidualIsLocal,
  describeCloseResidual,
  hasCloseResidual,
  parseCloseResidual,
} from '../src/core/close-residual.js';

describe('parseCloseResidual', () => {
  it('reads a well-formed residual', () => {
    expect(parseCloseResidual({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-parked-9' },
    })).toEqual({ reason: 'mojo_lineage_quarantined', taskId: 'mojo-parked-9' });
  });

  it('treats an ordinary close as no residual', () => {
    expect(parseCloseResidual({ ok: true, outcome: 'closed', alreadyClosed: false }))
      .toBeUndefined();
  });

  it('treats a daemon that predates `outcome` as an ordinary close', () => {
    // The ONE deliberate compatibility hole: such a daemon never produces a
    // residual either, so this cannot hide a live remote session.
    expect(parseCloseResidual({ ok: true, alreadyClosed: false })).toBeUndefined();
  });

  it('still warns when the body DECLARES a residual but the payload is broken', () => {
    // Fail closed. Degrading to a plain success because the shape was wrong is
    // exactly how this class of bug kept coming back.
    for (const body of [
      { outcome: 'closed_with_residual' },
      { outcome: 'closed_with_residual', residual: null },
      { outcome: 'closed_with_residual', residual: 'nope' },
      { outcome: 'closed_with_residual', residual: { taskId: 42 } },
      { outcome: 'closed_with_residual', residual: { taskId: '' } },
    ]) {
      expect(parseCloseResidual(body), JSON.stringify(body)).toBeDefined();
      expect(hasCloseResidual(body)).toBe(true);
    }
  });

  it('drops wrongly-typed fields instead of passing them through', () => {
    // A non-string id would otherwise render as [object Object] in a warning.
    expect(parseCloseResidual({
      outcome: 'closed_with_residual',
      residual: { reason: 7, taskId: { nested: true } },
    })).toEqual({});
  });

  it('never renders an empty label', () => {
    expect(describeCloseResidual({ taskId: 'mojo-9' })).toBe('mojo-9');
    expect(describeCloseResidual({})).toBe('unknown remote id');
    expect(describeCloseResidual(undefined)).toBe('');
  });

  it('is safe on non-objects', () => {
    for (const body of [undefined, null, 'closed', 42, []]) {
      expect(parseCloseResidual(body)).toBeUndefined();
    }
  });
});

describe('local vs remote residual copy (round-7 finding-4)', () => {
  it('classifies local-subtree reasons as local', () => {
    expect(closeResidualIsLocal({ reason: 'local_subtree_boundary_unproven' })).toBe(true);
    expect(closeResidualIsLocal({ reason: 'local_subtree_unprovable_on_platform' })).toBe(true);
    expect(closeResidualIsLocal({ reason: 'mojo_lineage_quarantined', taskId: 'x' })).toBe(false);
    expect(closeResidualIsLocal({ taskId: 'x' })).toBe(false);
  });

  it('never renders a local residual as a phantom "unknown remote id"', () => {
    // The exact mislabel: a local host-subtree concern with no remote id used to
    // render as "unknown remote id", sending the operator after a nonexistent
    // remote session.
    const local = describeCloseResidual({ reason: 'local_subtree_boundary_unproven' });
    expect(local).not.toContain('remote');
    expect(local).toContain('本地');
  });

  it('builds distinct clauses for local vs remote residuals', () => {
    expect(closeResidualClause({ reason: 'mojo_lineage_quarantined', taskId: 'mojo-9' }))
      .toContain('远端会话未取消');
    const localClause = closeResidualClause({ reason: 'local_subtree_unprovable_on_platform' });
    expect(localClause).toContain('本地');
    expect(localClause).not.toContain('远端会话未取消');
  });
});
