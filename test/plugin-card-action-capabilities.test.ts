import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPluginCardActionCapabilitiesSnapshot,
  parsePluginCardActionCapabilitiesSnapshot,
  pluginCardActionCapabilityRecords,
  serializePluginCardActionCapabilitiesSnapshot,
} from '../src/core/plugins/card-actions/capabilities.js';
import type {
  InstalledPluginRecord,
  PluginCardActionsContribution,
  PluginRegistryFile,
} from '../src/core/plugins/types.js';

const record = (
  id: string,
  cardActions?: PluginCardActionsContribution,
): InstalledPluginRecord => ({
  id,
  packageName: `@botmux-ai/plugin-${id}`,
  version: '1.0.0',
  source: { type: 'local', spec: `/plugins/${id}` },
  manifest: { schemaVersion: 1, id },
  contributions: cardActions ? { cardActions } : undefined,
  installedAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

const registryOf = (...records: InstalledPluginRecord[]): PluginRegistryFile => ({
  schemaVersion: 1,
  plugins: Object.fromEntries(records.map(item => [item.id, item])),
});

describe('plugin card-action capability snapshot', () => {
  it('carries only public selectors for the enabled session plugins', () => {
    const enabled = record('happy-cloud', {
      schemaVersion: 1,
      actions: ['happy_cloud_mr_review_fix_submit'],
      endpoint: '/botmux/card-actions/v1',
    });
    const disabled = record('disabled', {
      schemaVersion: 1,
      actions: ['disabled.submit'],
      endpoint: '/actions',
    });
    const snapshot = buildPluginCardActionCapabilitiesSnapshot(
      ['happy-cloud', 'happy-cloud', 'missing'],
      registryOf(enabled, disabled),
    );

    expect(snapshot).toEqual({
      schemaVersion: 1,
      plugins: [{
        id: 'happy-cloud',
        cardActions: {
          schemaVersion: 1,
          actions: ['happy_cloud_mr_review_fix_submit'],
          endpoint: '/botmux/card-actions/v1',
        },
      }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('token');
    expect(pluginCardActionCapabilityRecords(snapshot)).toMatchObject([
      { id: 'happy-cloud', contributions: { cardActions: { actions: ['happy_cloud_mr_review_fix_submit'] } } },
    ]);
  });

  it('round-trips a valid snapshot and rejects forged core selectors', () => {
    const valid = {
      schemaVersion: 1 as const,
      plugins: [{
        id: 'review-fix',
        cardActions: {
          schemaVersion: 1 as const,
          actionPrefixes: ['review_fix.'],
          endpoint: '/actions',
        },
      }],
    };
    expect(parsePluginCardActionCapabilitiesSnapshot(
      serializePluginCardActionCapabilitiesSnapshot(valid),
    )).toEqual(valid);

    expect(parsePluginCardActionCapabilitiesSnapshot(JSON.stringify({
      schemaVersion: 1,
      plugins: [{
        id: 'hijack',
        cardActions: { schemaVersion: 1, actions: ['close'], endpoint: '/actions' },
      }],
    }))).toBeUndefined();
    expect(parsePluginCardActionCapabilitiesSnapshot(JSON.stringify({
      schemaVersion: 1,
      plugins: [{
        id: 'hijack',
        cardActions: { schemaVersion: 1, actionPrefixes: ['dash_'], endpoint: '/actions' },
      }],
    }))).toBeUndefined();
  });

  it('drops malformed or reserved registry contributions when building', () => {
    const malformed = record('malformed', {
      schemaVersion: 1,
      actions: ['close'],
      endpoint: '/actions',
    });
    const snapshot = buildPluginCardActionCapabilitiesSnapshot(
      ['malformed'],
      registryOf(malformed),
    );
    expect(snapshot.plugins).toEqual([]);
  });

  it('wires the snapshot into local, persistent, Riff, and Mojo generations', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(worker).toContain('[PLUGIN_CARD_ACTION_CAPABILITIES_ENV]: cardActionCapabilities');
    expect(worker).toContain('mergedEnv[PLUGIN_CARD_ACTION_CAPABILITIES_ENV] = cardActionCapabilities');
    expect(worker).toContain('childEnv[PLUGIN_CARD_ACTION_CAPABILITIES_ENV] = cardActionCapabilities');
  });
});
