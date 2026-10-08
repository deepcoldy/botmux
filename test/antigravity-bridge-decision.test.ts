/**
 * Behaviour tests for the antigravity zero-prompt bridge ticker decision.
 *
 * The /new lazy-create race (the pending NEW conversation B vs the RETIRED
 * conversation A still held open by the process) used to live inline in
 * worker.ts and could only be asserted via source-string checks; the decision
 * is now a pure function.
 */
import { describe, it, expect } from 'vitest';
import { decideAntigravityTickerAction } from '../src/services/antigravity-bridge-decision.js';

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
