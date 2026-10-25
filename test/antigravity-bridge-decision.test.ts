/**
 * Behaviour tests for the antigravity zero-prompt bridge ticker decision.
 *
 * The /new lazy-create race (the pending NEW conversation B vs the RETIRED
 * conversation A still held open by the process) used to live inline in
 * worker.ts and could only be asserted via source-string checks; the decision
 * is now a pure function.
 */
import { describe, it, expect } from 'vitest';
import {
  antigravityRecoveryBindPath,
  decideAntigravityFullUpgrade,
  decideAntigravityNotifyAction,
  decideAntigravityTickerAction,
  type AntigravityFullUpgradeInput,
} from '../src/services/antigravity-bridge-decision.js';

const A = '/home/u/.gemini/antigravity-cli/brain/A/.system_generated/logs/transcript.jsonl';
const B = '/home/u/.gemini/antigravity-cli/brain/B/.system_generated/logs/transcript.jsonl';

describe('decideAntigravityTickerAction', () => {
  it('unbound + pending sid resolves → initial bind', () => {
    expect(decideAntigravityTickerAction({
      pendingSid: 'B',
      resolveBySid: () => B,
      resolveByPid: () => undefined,
    })).toEqual({ kind: 'bind-initial', path: B });
  });

  it('unbound + no sid file + pid hit → initial bind via pid', () => {
    expect(decideAntigravityTickerAction({
      resolveBySid: () => undefined,
      resolveByPid: () => A,
    })).toEqual({ kind: 'bind-initial', path: A });
  });

  it('bound + pending B whose file is not created yet, pid STILL returns retired A → idle and KEEPS pending B', () => {
    // The regression: the old inline code cleared the pending id on any
    // same-path hit, so B was never probed again and its first turn's answer
    // was lost. The action must be idle (no clear, no rotate).
    const action = decideAntigravityTickerAction({
      boundPath: A,
      pendingSid: 'B',
      resolveBySid: () => undefined,
      resolveByPid: () => A,
    });
    expect(action).toEqual({ kind: 'idle' });
  });

  it('bound + pending B file appears → rotate to B', () => {
    expect(decideAntigravityTickerAction({
      boundPath: A,
      pendingSid: 'B',
      resolveBySid: () => B,
      resolveByPid: () => A,
    })).toEqual({ kind: 'rotate', path: B });
  });

  it('bound + no pending sid file + pid switched to B → rotate', () => {
    expect(decideAntigravityTickerAction({
      boundPath: A,
      pendingSid: 'B',
      resolveBySid: () => undefined,
      resolveByPid: () => B,
    })).toEqual({ kind: 'rotate', path: B });
  });

  it('bound + pending sid directly resolves to the bound path → clear-pending', () => {
    // Provenance: only an authoritative SID hit may clear the marker.
    expect(decideAntigravityTickerAction({
      boundPath: A,
      pendingSid: 'A',
      resolveBySid: () => A,
      resolveByPid: () => A,
    })).toEqual({ kind: 'clear-pending' });
  });

  it('bound + no pending → idle (no pid probing churn)', () => {
    expect(decideAntigravityTickerAction({
      boundPath: A,
      resolveBySid: () => undefined,
      resolveByPid: () => B, // must NOT rotate without a pending conversation
    })).toEqual({ kind: 'idle' });
  });

  it('unbound + nothing resolvable → idle', () => {
    expect(decideAntigravityTickerAction({
      pendingSid: 'B',
      resolveBySid: () => undefined,
      resolveByPid: () => undefined,
    })).toEqual({ kind: 'idle' });
  });
});

const A_FULL = A.replace('transcript.jsonl', 'transcript_full.jsonl');
const B_FULL = B.replace('transcript.jsonl', 'transcript_full.jsonl');

describe('decideAntigravityTickerAction across the compact and full logs', () => {
  it('a pending id whose full log now exists, while its compact log is bound, is the SAME conversation', () => {
    // A bind made in the few ms before agy created transcript_full.jsonl: the
    // next lookup resolves the full log. Rotating would rebind fresh-empty and
    // replay the whole conversation from byte 0.
    expect(decideAntigravityTickerAction({
      boundPath: A,
      pendingSid: 'A',
      resolveBySid: () => A_FULL,
      resolveByPid: () => A_FULL,
    })).toEqual({ kind: 'clear-pending' });
  });

  it('a pid holding the full log of the bound conversation is not a rotation', () => {
    expect(decideAntigravityTickerAction({
      boundPath: A,
      pendingSid: 'B',
      resolveBySid: () => undefined,
      resolveByPid: () => A_FULL,
    })).toEqual({ kind: 'idle' });
  });

  it('a different conversation still rotates, full log or not', () => {
    expect(decideAntigravityTickerAction({
      boundPath: A,
      pendingSid: 'B',
      resolveBySid: () => B_FULL,
      resolveByPid: () => A,
    })).toEqual({ kind: 'rotate', path: B_FULL });
  });
});

describe('decideAntigravityFullUpgrade', () => {
  const idle: AntigravityFullUpgradeInput = {
    boundPath: A,
    offset: 1234,
    pendingTail: '',
    hasHeldCandidate: false,
    hasUnfinishedTurn: false,
    fullExists: () => true,
    mapOffset: () => 4321,
  };

  it('moves a compact bind to the full log at the mapped offset at a turn boundary', () => {
    const calls: unknown[][] = [];
    const action = decideAntigravityFullUpgrade({ ...idle, mapOffset: (...args) => { calls.push(args); return 4321; } });
    expect(action).toEqual({ kind: 'rebind', path: A_FULL, offset: 4321 });
    expect(calls).toEqual([[A, 1234, A_FULL]]);
  });

  it.each([
    ['a record is half written', { pendingTail: '{"step_index":' }],
    ['a final from the compact log is held', { hasHeldCandidate: true }],
    ['a Lark turn still waits for its final', { hasUnfinishedTurn: true }],
    ['agy never wrote a full log', { fullExists: () => false }],
    ['the full log has not caught up', { mapOffset: () => undefined }],
  ] as const)('stays on the compact log while %s', (_label, patch) => {
    expect(decideAntigravityFullUpgrade({ ...idle, ...patch } as AntigravityFullUpgradeInput)).toEqual({ kind: 'stay' });
  });

  it('never touches a bind that is already on the full log, or no bind', () => {
    expect(decideAntigravityFullUpgrade({ ...idle, boundPath: A_FULL })).toEqual({ kind: 'stay' });
    expect(decideAntigravityFullUpgrade({ ...idle, boundPath: undefined })).toEqual({ kind: 'stay' });
  });
});

describe('antigravityRecoveryBindPath', () => {
  it('binds the compact log when the previous generation journaled pending turns against it', () => {
    expect(antigravityRecoveryBindPath({
      path: A_FULL,
      compactExists: () => true,
      restorableTurnsOn: p => (p === A ? 1 : 0),
    })).toBe(A);
  });

  it('keeps the full log when nothing is journaled against the compact one', () => {
    expect(antigravityRecoveryBindPath({ path: A_FULL, compactExists: () => true, restorableTurnsOn: () => 0 })).toBe(A_FULL);
    expect(antigravityRecoveryBindPath({ path: A_FULL, compactExists: () => false, restorableTurnsOn: () => 1 })).toBe(A_FULL);
    expect(antigravityRecoveryBindPath({ path: A, compactExists: () => true, restorableTurnsOn: () => 1 })).toBe(A);
  });
});

describe('decideAntigravityNotifyAction', () => {
  it('a submit report resolving to the full log of the compact-bound conversation is not a /new', () => {
    // Bound to the compact log (a restored turn pinned it, or the bind beat
    // agy creating the full log) while a turn is in flight: a rotation here
    // would force-release that turn's held final and rebind fresh.
    expect(decideAntigravityNotifyAction(A, A_FULL)).toEqual({ kind: 'same' });
    expect(decideAntigravityNotifyAction(A_FULL, A_FULL)).toEqual({ kind: 'same' });
  });

  it('a different conversation rotates; an unbound one binds; a missing log waits', () => {
    expect(decideAntigravityNotifyAction(A, B_FULL)).toEqual({ kind: 'rotate', path: B_FULL });
    expect(decideAntigravityNotifyAction(undefined, A_FULL)).toEqual({ kind: 'bind-initial', path: A_FULL });
    expect(decideAntigravityNotifyAction(A, undefined)).toEqual({ kind: 'wait-pending' });
  });
});
