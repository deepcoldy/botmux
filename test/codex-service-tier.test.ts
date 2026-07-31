import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexServiceTierTracker,
  codexFastBadgeActive,
  resolveCodexServiceTierSnapshot,
  type CodexThreadSettings,
  type CodexServiceTierSnapshot,
} from '../src/services/codex-service-tier.js';

let codexHome: string;
let previousCodexHome: string | undefined;

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  codexHome = mkdtempSync(join(tmpdir(), 'codex-tier-'));
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(codexHome, { recursive: true, force: true });
});

function writeCatalog(): void {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({
    models: [
      {
        slug: 'gpt-5.6-sol',
        service_tiers: [
          { id: 'priority', name: 'Fast' },
          { id: 'flex', name: 'Flex' },
        ],
      },
      { slug: 'gpt-5.4-mini', service_tiers: [] },
    ],
  }));
}

describe('resolveCodexServiceTierSnapshot', () => {
  it('maps Fast from the model catalog instead of treating every non-default tier as Fast', () => {
    writeCatalog();

    expect(resolveCodexServiceTierSnapshot({
      model: 'gpt-5.6-sol', serviceTier: 'priority',
    }).fastActive).toBe(true);
    expect(resolveCodexServiceTierSnapshot({
      model: 'gpt-5.6-sol', serviceTier: 'flex',
    }).fastActive).toBe(false);
    expect(resolveCodexServiceTierSnapshot({
      model: 'gpt-5.4-mini', serviceTier: 'priority',
    }).fastActive).toBe(false);
    expect(resolveCodexServiceTierSnapshot({
      model: 'unknown-model', serviceTier: 'priority',
    }).fastActive).toBe(false);
  });

  it('fails closed when the catalog is absent or malformed', () => {
    expect(resolveCodexServiceTierSnapshot({
      model: 'gpt-5.6-sol', serviceTier: 'priority',
    }).fastActive).toBe(false);

    writeFileSync(join(codexHome, 'models_cache.json'), '{broken');
    expect(resolveCodexServiceTierSnapshot({
      model: 'gpt-5.6-sol', serviceTier: 'priority',
    }).fastActive).toBe(false);
  });
});

describe('CodexServiceTierTracker', () => {
  const resolve = (settings: CodexThreadSettings): CodexServiceTierSnapshot => ({
    ...settings,
    fastActive: settings.serviceTier === 'priority',
  });

  it('covers quick toggles, rollout replacement, and stale-path observations', () => {
    const updates: Array<CodexServiceTierSnapshot | null> = [];
    const tracker = new CodexServiceTierTracker(resolve, update => updates.push(update));

    tracker.bind('/rollout-a.jsonl');
    tracker.observe('/rollout-a.jsonl', { model: 'gpt-5.6-sol', serviceTier: 'priority' });
    tracker.observe('/rollout-a.jsonl', { model: 'gpt-5.6-sol', serviceTier: 'default' });
    tracker.bind('/rollout-b.jsonl');
    tracker.observe('/rollout-a.jsonl', { model: 'gpt-5.6-sol', serviceTier: 'priority' });

    expect(updates).toEqual([
      null,
      { model: 'gpt-5.6-sol', serviceTier: 'priority', fastActive: true },
      { model: 'gpt-5.6-sol', serviceTier: 'default', fastActive: false },
      null,
    ]);
  });

  it('deduplicates identical observations and explicitly clears on detach', () => {
    const updates: Array<CodexServiceTierSnapshot | null> = [];
    const tracker = new CodexServiceTierTracker(resolve, update => updates.push(update));
    const settings = { model: 'gpt-5.6-sol', serviceTier: 'priority' };

    tracker.bind('/rollout.jsonl', settings);
    tracker.observe('/rollout.jsonl', settings);
    tracker.detach();

    expect(updates).toEqual([
      null,
      { model: 'gpt-5.6-sol', serviceTier: 'priority', fastActive: true },
      null,
    ]);
  });
});

describe('codexFastBadgeActive', () => {
  const fast: CodexServiceTierSnapshot = {
    model: 'gpt-5.6-sol', serviceTier: 'priority', fastActive: true,
  };

  it('never leaks a Codex snapshot onto a non-Codex card', () => {
    expect(codexFastBadgeActive('codex', fast)).toBe(true);
    expect(codexFastBadgeActive('claude-code', fast)).toBe(false);
    expect(codexFastBadgeActive('codex', undefined)).toBe(false);
  });
});
