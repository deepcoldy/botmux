import { describe, expect, it } from 'bun:test';
import {
  CodexServiceTierTracker,
  codexServiceTierBadge,
  resolveCodexServiceTierSnapshot,
  type CodexThreadSettings,
  type CodexServiceTierSnapshot,
} from '../src/services/codex-service-tier.js';

describe('resolveCodexServiceTierSnapshot', () => {
  it('flags any non-default tier as nonDefault WITHOUT a catalog lookup', () => {
    // The rollout records only the tier id; the catalog (models_cache.json) is
    // NOT guaranteed to exist (read-isolation provisions auth/config only), so
    // the snapshot must not depend on it. A non-`default` id is surfaced as-is.
    expect(resolveCodexServiceTierSnapshot({ model: 'gpt-5.6-sol', serviceTier: 'priority' }).nonDefault).toBe(true);
    expect(resolveCodexServiceTierSnapshot({ model: 'gpt-5.6-sol', serviceTier: 'flex' }).nonDefault).toBe(true);
    // model is irrelevant to the decision now (no catalog keyed by model).
    expect(resolveCodexServiceTierSnapshot({ model: 'unknown-model', serviceTier: 'priority' }).nonDefault).toBe(true);
  });

  it('treats default / empty as NOT non-default', () => {
    expect(resolveCodexServiceTierSnapshot({ model: 'gpt-5.6-sol', serviceTier: 'default' }).nonDefault).toBe(false);
    expect(resolveCodexServiceTierSnapshot({ model: 'gpt-5.6-sol', serviceTier: '' }).nonDefault).toBe(false);
  });

  it('does no filesystem I/O (works with no CODEX_HOME / no catalog present)', () => {
    // Regression guard for the P1: an isolated BOT_HOME has a rollout but no
    // models_cache.json, and the old catalog-mapping deterministically failed
    // closed there. The neutral resolver must still surface the tier.
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/nonexistent/codex-home-xyz';
    try {
      expect(resolveCodexServiceTierSnapshot({ model: 'gpt-5.6-sol', serviceTier: 'priority' }).nonDefault).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });
});

describe('codexServiceTierBadge', () => {
  const priority: CodexServiceTierSnapshot = { model: 'gpt-5.6-sol', serviceTier: 'priority', nonDefault: true };
  const flex: CodexServiceTierSnapshot = { model: 'gpt-5.6-sol', serviceTier: 'flex', nonDefault: true };
  const dflt: CodexServiceTierSnapshot = { model: 'gpt-5.6-sol', serviceTier: 'default', nonDefault: false };

  it('shows the ACTUAL tier id, never a hardcoded "Fast" (flex stays flex)', () => {
    expect(codexServiceTierBadge('codex', priority)).toBe('⚡ priority');
    expect(codexServiceTierBadge('codex', flex)).toBe('⚡ flex');
    expect(codexServiceTierBadge('codex', flex)).not.toContain('Fast');
  });

  it('has no badge for default / no snapshot', () => {
    expect(codexServiceTierBadge('codex', dflt)).toBeUndefined();
    expect(codexServiceTierBadge('codex', undefined)).toBeUndefined();
  });

  it('never leaks a Codex snapshot onto a non-Codex card', () => {
    // A stale Codex snapshot must not decorate a Claude card (e.g. after /role).
    expect(codexServiceTierBadge('claude-code', priority)).toBeUndefined();
  });
});

describe('CodexServiceTierTracker', () => {
  const resolve = (settings: CodexThreadSettings): CodexServiceTierSnapshot => ({
    ...settings,
    nonDefault: !!settings.serviceTier && settings.serviceTier !== 'default',
  });

  it('covers quick toggles, rollout replacement, and stale-path observations', () => {
    const updates: Array<CodexServiceTierSnapshot | null> = [];
    const tracker = new CodexServiceTierTracker(resolve, update => updates.push(update));

    tracker.bind('/rollout-a.jsonl');
    tracker.observe('/rollout-a.jsonl', { model: 'gpt-5.6-sol', serviceTier: 'priority' });
    tracker.observe('/rollout-a.jsonl', { model: 'gpt-5.6-sol', serviceTier: 'default' });
    tracker.bind('/rollout-b.jsonl');
    // A late observation tagged with the OLD rollout path must be ignored.
    tracker.observe('/rollout-a.jsonl', { model: 'gpt-5.6-sol', serviceTier: 'priority' });

    expect(updates).toEqual([
      null,
      { model: 'gpt-5.6-sol', serviceTier: 'priority', nonDefault: true },
      { model: 'gpt-5.6-sol', serviceTier: 'default', nonDefault: false },
      null,
    ]);
  });

  it('deduplicates identical observations and explicitly clears on detach', () => {
    const updates: Array<CodexServiceTierSnapshot | null> = [];
    const tracker = new CodexServiceTierTracker(resolve, update => updates.push(update));
    const settings = { model: 'gpt-5.6-sol', serviceTier: 'priority' };

    tracker.bind('/rollout.jsonl', settings);
    tracker.observe('/rollout.jsonl', settings);  // identical → no duplicate publish
    tracker.detach();

    expect(updates).toEqual([
      null,
      { model: 'gpt-5.6-sol', serviceTier: 'priority', nonDefault: true },
      null,
    ]);
  });

  it('re-publishes when only reasoningEffort changes (in-session /effort switch)', () => {
    const updates: Array<CodexServiceTierSnapshot | null> = [];
    const tracker = new CodexServiceTierTracker(resolve, update => updates.push(update));

    tracker.bind('/rollout.jsonl');
    tracker.observe('/rollout.jsonl', { model: 'gpt-5.6-sol', serviceTier: 'default', reasoningEffort: 'high' });
    // Same model + tier, different effort → must NOT dedupe away.
    tracker.observe('/rollout.jsonl', { model: 'gpt-5.6-sol', serviceTier: 'default', reasoningEffort: 'xhigh' });

    expect(updates).toEqual([
      null,
      { model: 'gpt-5.6-sol', serviceTier: 'default', reasoningEffort: 'high', nonDefault: false },
      { model: 'gpt-5.6-sol', serviceTier: 'default', reasoningEffort: 'xhigh', nonDefault: false },
    ]);
  });
});
