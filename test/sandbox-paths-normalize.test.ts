import { describe, expect, it } from 'bun:test';
import { normalizeSandboxPaths } from '../src/services/sandbox-store.js';
import { effectiveAccess } from '../src/dashboard/web/bot-defaults-page.js';

// Regression for the dashboard sandbox-paths picker: what gets STORED must
// resolve a same-path cross-tier conflict the SAME way fs-policy's mergeFsRules
// does (deny > readOnly > readWrite), so the UI/tester never disagree with the
// sandbox the compiler builds. Tier-internal dedup alone left both entries.
describe('normalizeSandboxPaths (cross-tier dedup for the picker)', () => {
  it('trims + dedups within a tier', () => {
    expect(normalizeSandboxPaths({ readWrite: [' ~/a ', '~/a', '', '~/b'] }))
      .toEqual({ readWrite: ['~/a', '~/b'] });
  });

  it('a path in both readWrite and deny resolves to deny (more restrictive wins)', () => {
    expect(normalizeSandboxPaths({ readWrite: ['/repo'], deny: ['/repo'] }))
      .toEqual({ deny: ['/repo'] });
  });

  it('a path in both readWrite and readOnly resolves to readOnly', () => {
    expect(normalizeSandboxPaths({ readWrite: ['/x'], readOnly: ['/x'] }))
      .toEqual({ readOnly: ['/x'] });
  });

  it('a path in all three tiers resolves to deny only', () => {
    expect(normalizeSandboxPaths({ readWrite: ['/x'], readOnly: ['/x'], deny: ['/x'] }))
      .toEqual({ deny: ['/x'] });
  });

  it('trailing-slash variants are treated as the same path for cross-tier dedup', () => {
    expect(normalizeSandboxPaths({ readWrite: ['/repo/'], deny: ['/repo'] }))
      .toEqual({ deny: ['/repo'] });
  });

  it('keeps distinct paths across tiers untouched', () => {
    expect(normalizeSandboxPaths({ readWrite: ['/proj'], readOnly: ['/ref'], deny: ['/proj/secret'] }))
      .toEqual({ readWrite: ['/proj'], readOnly: ['/ref'], deny: ['/proj/secret'] });
  });

  it('all-empty (or whitespace-only) collapses to {} so the caller clears the field', () => {
    expect(normalizeSandboxPaths({ readWrite: ['  '], readOnly: [], deny: [] })).toEqual({});
    expect(normalizeSandboxPaths({})).toEqual({});
  });
});

// The picker's live labels + path tester call effectiveAccess. It must agree
// with the sandbox on BOTH the same-path tie-break (deny > readOnly > readWrite)
// and `~` expansion under a symlinked $HOME — the regression codex(sg1) flagged:
// a `~/.claude` read-only tier entry must resolve against the CANONICAL home the
// tree nodes + worker use, or the UI silently mislabels.
describe('effectiveAccess (picker live labels / tester)', () => {
  const HOME = '/data00/home/u'; // canonical home (symlinked from /home/u)

  it('deepest rule wins (longest-prefix)', () => {
    const t = { readWrite: ['/data00/home/u/proj'], readOnly: [], deny: ['/data00/home/u/proj/secret'] };
    expect(effectiveAccess(t, '/data00/home/u/proj/main.py', HOME).access).toBe('readWrite');
    expect(effectiveAccess(t, '/data00/home/u/proj/secret/key', HOME).access).toBe('deny');
  });

  it('same path across tiers: more restrictive wins (matches backend mergeFsRules)', () => {
    expect(effectiveAccess({ readWrite: ['/repo'], deny: ['/repo'], readOnly: [] }, '/repo', HOME).access).toBe('deny');
    expect(effectiveAccess({ readWrite: ['/x'], readOnly: ['/x'], deny: [] }, '/x', HOME).access).toBe('readOnly');
  });

  it('expands `~` against canonical HOME so it matches absolute tree nodes', () => {
    const t = { readWrite: [], readOnly: ['~/.claude'], deny: [] };
    // A `~/.claude` rule must cover the canonical absolute node the tree shows.
    expect(effectiveAccess(t, '/data00/home/u/.claude/settings.json', HOME).access).toBe('readOnly');
    // And a bare `~` test path expands the same way.
    expect(effectiveAccess({ readWrite: ['~/.claude'], readOnly: [], deny: [] }, '~/.claude/x', HOME).access).toBe('readWrite');
  });

  it('no covering rule → none (deny-by-default)', () => {
    expect(effectiveAccess({ readWrite: ['/data00/home/u/proj'], readOnly: [], deny: [] }, '/etc/passwd', HOME).access).toBe('none');
  });
});
