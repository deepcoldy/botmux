import { describe, it, expect } from 'vitest';
import {
  shouldRunQuietRotation,
  evaluatePidResolverPullback,
  decideFingerprintSwitch,
  sessionIdFromJsonlPath,
} from '../src/services/bridge-rotation-policy.js';

describe('shouldRunQuietRotation', () => {
  it('skips when an earlier rotation step already switched (regardless of pidFollow)', () => {
    expect(shouldRunQuietRotation('unavailable', true)).toBe(false);
    expect(shouldRunQuietRotation('same', true)).toBe(false);
    expect(shouldRunQuietRotation('switched', true)).toBe(false);
  });

  it("skips when pid resolver actively switched the path", () => {
    expect(shouldRunQuietRotation('switched', false)).toBe(false);
  });

  it("skips when pid resolver confirmed 'same' (sibling-pane hijack guard)", () => {
    // 'same' is NOT proof that no rotation happened — Claude Code
    // 2.1.123 doesn't refresh pid file's sessionId on /clear. We still
    // skip the mtime heuristic because sibling-pane hijack is worse
    // than missing pure-local /clear without a pending Lark turn (the
    // user can unstick that case by sending one Lark message, which
    // arms fingerprint fallback). This test locks in the trade-off.
    expect(shouldRunQuietRotation('same', false)).toBe(false);
  });

  it("runs only when pid resolver was unavailable AND no earlier switch", () => {
    expect(shouldRunQuietRotation('unavailable', false)).toBe(true);
  });
});

describe('evaluatePidResolverPullback', () => {
  const SPAWN_SID = 'aaaaaaaa-1111-4222-8333-444444444444';
  const FRESH_CLEAR_SID = 'bbbbbbbb-2222-4333-8444-555555555555';
  const RESUME_SID = 'cccccccc-3333-4444-8555-666666666666';
  const SPAWN_PATH = `/projects/foo/${SPAWN_SID}.jsonl`;
  const RESUME_PATH = `/projects/foo/${RESUME_SID}.jsonl`;
  const CURRENT_PATH = `/projects/foo/${FRESH_CLEAR_SID}.jsonl`;

  it('no stale recorded ⇒ honour pid resolver', () => {
    const r = evaluatePidResolverPullback({
      resolvedCliSessionId: SPAWN_SID,
      resolvedPath: SPAWN_PATH,
      currentBridgeJsonlPath: CURRENT_PATH,
      stalePidStateSessionId: undefined,
    });
    expect(r).toEqual({ suppress: false, clearStale: false });
  });

  it('pid file still reports stale spawn-time sid ⇒ suppress pull-back', () => {
    // Watcher already moved to the post-/clear jsonl via fingerprint
    // accept; pid resolver wants to pull back to the spawn-time path.
    // We must say `same` to break the flap loop.
    const r = evaluatePidResolverPullback({
      resolvedCliSessionId: SPAWN_SID,
      resolvedPath: SPAWN_PATH,
      currentBridgeJsonlPath: CURRENT_PATH,
      stalePidStateSessionId: SPAWN_SID,
    });
    expect(r).toEqual({ suppress: true, clearStale: false });
  });

  it('pid file reports a NEW sid (fresh --resume / spawn) ⇒ clear stale, follow rotation', () => {
    const r = evaluatePidResolverPullback({
      resolvedCliSessionId: RESUME_SID,
      resolvedPath: RESUME_PATH,
      currentBridgeJsonlPath: CURRENT_PATH,
      stalePidStateSessionId: SPAWN_SID,
    });
    expect(r).toEqual({ suppress: false, clearStale: true });
  });
});

describe('sessionIdFromJsonlPath', () => {
  it('extracts the basename without .jsonl', () => {
    expect(
      sessionIdFromJsonlPath('/foo/bar/abcdefab-1234-5678-9abc-deadbeef0000.jsonl'),
    ).toBe('abcdefab-1234-5678-9abc-deadbeef0000');
  });

  it('returns empty string when the suffix is missing', () => {
    expect(sessionIdFromJsonlPath('/foo/bar/no-suffix')).toBe('');
  });
});

describe('decideFingerprintSwitch', () => {
  // Stable sids the tests can expect by string match.
  const SPAWN_SID = 'aaaaaaaa-1111-4222-8333-444444444444';
  const POST_CLEAR_SID = 'bbbbbbbb-2222-4333-8444-555555555555';
  const SIBLING_SID = 'cccccccc-3333-4444-8555-666666666666';
  const ANOTHER_UNKNOWN_SID = 'dddddddd-4444-4555-8666-777777777777';
  const SPAWN_PATH = `/projects/foo/${SPAWN_SID}.jsonl`;
  const POST_CLEAR_PATH = `/projects/foo/${POST_CLEAR_SID}.jsonl`;
  const SIBLING_PATH = `/projects/foo/${SIBLING_SID}.jsonl`;
  const ANOTHER_UNKNOWN_PATH = `/projects/foo/${ANOTHER_UNKNOWN_SID}.jsonl`;
  const NON_UUID_PATH = '/projects/foo/not-a-uuid.jsonl';

  function makeInput(opts: {
    knownSessionIds?: ReadonlySet<string>;
    contentNormalized?: string;
    substringMatch?: { path: string };
    exactMatches?: string[];
  }) {
    const accept = {
      substringFilter: undefined as ((p: string) => boolean) | undefined,
      exactFilter: undefined as ((p: string) => boolean) | undefined,
    };
    return {
      input: {
        contentFingerprint: 'who are you',
        contentNormalized: opts.contentNormalized,
        knownSessionIds: opts.knownSessionIds ?? new Set<string>(),
        findSubstring: (acceptCandidate: (p: string) => boolean) => {
          accept.substringFilter = acceptCandidate;
          if (!opts.substringMatch) return null;
          return acceptCandidate(opts.substringMatch.path) ? opts.substringMatch.path : null;
        },
        findExact: (acceptCandidate: (p: string) => boolean) => {
          accept.exactFilter = acceptCandidate;
          return (opts.exactMatches ?? []).filter((p) => acceptCandidate(p));
        },
      },
      accept,
    };
  }

  it('Phase 1 hit: substring match in known sid → switch (skips Phase 2)', () => {
    const { input, accept } = makeInput({
      knownSessionIds: new Set([SPAWN_SID]),
      substringMatch: { path: SPAWN_PATH },
      exactMatches: [POST_CLEAR_PATH], // would also match Phase 2; must NOT be reached
    });
    const r = decideFingerprintSwitch(input);
    expect(r).toEqual({ action: 'switch', path: SPAWN_PATH, reason: 'known-sid-substring' });
    expect(accept.substringFilter?.(SPAWN_PATH)).toBe(true);
    // Phase 2 finder shouldn't even have been consulted on accepted sid sets
    // (decideFingerprintSwitch returns immediately on Phase 1 hit).
    expect(accept.exactFilter).toBeUndefined();
  });

  it('Phase 1 reject sibling: substring match in non-known sid → falls through to Phase 2', () => {
    // Replicates the original sibling-pane hijack scenario: sibling has a
    // substring fingerprint hit but is not in the trust set, so Phase 1
    // ignores it. Without exact recovery this returns no-match.
    const { input, accept } = makeInput({
      knownSessionIds: new Set([SPAWN_SID]),
      // findSubstring's accept predicate filters out sibling, so even if a
      // sibling exists in the dir, the scanner won't return it. Simulate
      // by leaving substringMatch undefined.
      contentNormalized: 'who are you',
    });
    const r = decideFingerprintSwitch(input);
    expect(r).toEqual({ action: 'no-match' });
    // Phase 1 was tried (predicate registered), then Phase 2 ran with its own
    // predicate filtering OUT known-set members — covered below.
    expect(typeof accept.substringFilter).toBe('function');
  });

  it('Phase 2 unique unknown exact match → switch (in-pane /clear recovery)', () => {
    // The exact failure case Codex flagged: pid file stale, baseline locked
    // on old sid; the real adopted pane writes "who are you" to a new
    // post-/clear sid that's not in the trust set. Phase 1 finds nothing
    // (sibling guard), Phase 2 finds exactly one unknown exact match → switch.
    const { input } = makeInput({
      knownSessionIds: new Set([SPAWN_SID]),
      contentNormalized: 'who are you',
      exactMatches: [POST_CLEAR_PATH],
    });
    const r = decideFingerprintSwitch(input);
    expect(r).toEqual({ action: 'switch', path: POST_CLEAR_PATH, reason: 'unknown-sid-exact' });
  });

  it('Phase 2 multiple unknown exact matches → abstain with diagnostic', () => {
    const { input } = makeInput({
      knownSessionIds: new Set([SPAWN_SID]),
      contentNormalized: 'hello',
      exactMatches: [POST_CLEAR_PATH, SIBLING_PATH, ANOTHER_UNKNOWN_PATH],
    });
    const r = decideFingerprintSwitch(input);
    expect(r.action).toBe('abstain');
    if (r.action === 'abstain') {
      expect(r.reason).toBe('multiple-unknown-exact');
      expect(r.candidates).toEqual([POST_CLEAR_PATH, SIBLING_PATH, ANOTHER_UNKNOWN_PATH]);
    }
  });

  it('Phase 2 skipped when contentNormalized is empty / missing', () => {
    expect(
      decideFingerprintSwitch({
        ...makeInput({
          knownSessionIds: new Set(),
          exactMatches: [POST_CLEAR_PATH],
        }).input,
        contentNormalized: undefined,
      }),
    ).toEqual({ action: 'no-match' });
    expect(
      decideFingerprintSwitch({
        ...makeInput({
          knownSessionIds: new Set(),
          exactMatches: [POST_CLEAR_PATH],
        }).input,
        contentNormalized: '',
      }),
    ).toEqual({ action: 'no-match' });
  });

  it('non-UUID candidate filenames are filtered out by Phase 1 predicate', () => {
    // Even if a non-UUID jsonl is in the trust set (shouldn't happen, but
    // defensive), the substring predicate rejects it via the regex gate.
    const { input } = makeInput({
      knownSessionIds: new Set(['not-a-uuid']),
      substringMatch: { path: NON_UUID_PATH },
    });
    const r = decideFingerprintSwitch(input);
    expect(r).toEqual({ action: 'no-match' });
  });

  it('non-UUID candidate filenames are filtered out by Phase 2 predicate', () => {
    // Defends against accidentally-dropped non-Claude `.jsonl` files in
    // the project dir taking over the watcher when their content happens
    // to match the user's Lark message.
    const { input } = makeInput({
      knownSessionIds: new Set([SPAWN_SID]),
      contentNormalized: 'who are you',
      exactMatches: [NON_UUID_PATH],
    });
    const r = decideFingerprintSwitch(input);
    expect(r).toEqual({ action: 'no-match' });
  });

  it('Phase 2 predicate excludes known sids: only untrusted exact matches count', () => {
    // Belt-and-suspenders: even if the exact-content scanner returned a
    // path with a sid that's actually in the trust set (shouldn't happen
    // because Phase 1 should have caught it, but verifies the predicate
    // is rigorous), the Phase 2 predicate filters it out.
    const { input } = makeInput({
      knownSessionIds: new Set([SPAWN_SID, POST_CLEAR_SID]),
      contentNormalized: 'who are you',
      exactMatches: [POST_CLEAR_PATH], // POST_CLEAR_SID is in known-set
    });
    const r = decideFingerprintSwitch(input);
    expect(r).toEqual({ action: 'no-match' });
  });
});
