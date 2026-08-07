/**
 * Unit tests for the /adopt V2 picker candidates cache (services/adopt-picker).
 * The cache exists so search / page re-renders of the picker card don't
 * re-shell-out to tmux; these pin the store / TTL / clear semantics.
 */
import { describe, it, expect, vi } from 'vitest';

const discovery = vi.hoisted(() => ({
  tmux: vi.fn(() => []),
  zellij: vi.fn(() => []),
}));

vi.mock('../src/core/session-discovery.js', () => ({
  discoverAdoptableSessions: discovery.tmux,
  excludeOwnedHerdrAdoptTargets: (sessions: unknown[]) => sessions,
}));

vi.mock('../src/core/zellij-adopt-discovery.js', () => ({
  discoverAdoptableZellijSessions: discovery.zellij,
}));

import {
  collectAdoptCandidates,
  cacheAdoptCandidates,
  getCachedAdoptCandidates,
  clearAdoptCandidates,
  type AdoptCandidates,
} from '../src/services/adopt-picker.js';

const sample = (): AdoptCandidates => ({
  sessions: [],
  resumable: [{ cliSessionId: 'sess-1', cwd: '/w', title: 't', lastActivityAt: 1 }],
  resumeLimit: 20,
});

describe('adopt-picker candidates cache', () => {
  it('stores and returns a snapshot within TTL', () => {
    const now = 1_000_000;
    cacheAdoptCandidates('root-a', sample(), now);
    const hit = getCachedAdoptCandidates('root-a', now + 1000);
    expect(hit?.resumable[0].cliSessionId).toBe('sess-1');
  });

  it('expires a snapshot past the 5-minute TTL', () => {
    const now = 2_000_000;
    cacheAdoptCandidates('root-b', sample(), now);
    const stale = getCachedAdoptCandidates('root-b', now + 5 * 60 * 1000 + 1);
    expect(stale).toBeUndefined();
  });

  it('clear() drops a snapshot immediately', () => {
    const now = 3_000_000;
    cacheAdoptCandidates('root-c', sample(), now);
    clearAdoptCandidates('root-c');
    expect(getCachedAdoptCandidates('root-c', now + 1)).toBeUndefined();
  });

  it('returns undefined for an unknown key (forces re-discovery)', () => {
    expect(getCachedAdoptCandidates('never-cached', 42)).toBeUndefined();
  });

  it('passes the bot effective executable to both live discovery backends', async () => {
    discovery.tmux.mockClear();
    discovery.zellij.mockClear();
    const discoverResumable = vi.fn(async () => []);

    await collectAdoptCandidates(
      'codex',
      '/opt/Vendor Codex/vendorCodex',
      new Map(),
      discoverResumable,
      20,
      '/opt/Vendor Codex/vendorCodex',
    );

    expect(discovery.tmux).toHaveBeenCalledWith('codex', '/opt/Vendor Codex/vendorCodex');
    expect(discovery.zellij).toHaveBeenCalledWith('codex', '/opt/Vendor Codex/vendorCodex');
    expect(discoverResumable).toHaveBeenCalledWith(
      'codex',
      '/opt/Vendor Codex/vendorCodex',
      expect.any(Map),
      20,
    );
  });

  it('keeps the legacy one-argument live discovery calls when no runtime is configured', async () => {
    discovery.tmux.mockClear();
    discovery.zellij.mockClear();

    await collectAdoptCandidates('codex', '/opt/wrapper-codex', new Map(), vi.fn(async () => []), 20);

    expect(discovery.tmux).toHaveBeenCalledWith('codex');
    expect(discovery.zellij).toHaveBeenCalledWith('codex');
  });
});
