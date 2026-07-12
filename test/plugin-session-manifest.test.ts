import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureSessionPluginManifest,
  readSessionPluginManifest,
  refreshSessionPluginManifest,
  sessionPluginManifestPath,
} from '../src/core/plugins/session-manifest.js';

describe('plugin session manifest', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-plugin-session-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps one CLI generation stable and refreshes the same session explicitly', () => {
    const first = ensureSessionPluginManifest({
      sessionId: 'session-1',
      bot: { larkAppId: 'app-1' },
      global: { plugins: ['chrome', 'gitlab'] },
      dataDir,
      now: () => '2026-07-12T00:00:00.000Z',
    });
    const stable = ensureSessionPluginManifest({
      sessionId: 'session-1',
      bot: { larkAppId: 'app-1' },
      global: { plugins: [] },
      dataDir,
    });
    const refreshed = refreshSessionPluginManifest({
      sessionId: 'session-1',
      bot: { larkAppId: 'app-1' },
      global: { plugins: ['review'] },
      dataDir,
      now: () => '2026-07-12T01:00:00.000Z',
    });

    expect(first).toMatchObject({
      botId: 'app-1',
      source: 'machine-default',
      pluginIds: ['chrome', 'gitlab'],
    });
    expect(stable).toEqual(first);
    expect(refreshed).toMatchObject({ pluginIds: ['review'], generatedAt: '2026-07-12T01:00:00.000Z' });
    expect(readSessionPluginManifest('session-1', dataDir)).toEqual(refreshed);
    expect(sessionPluginManifestPath('session-1', dataDir)).toBe(join(dataDir, 'sessions', 'session-1', 'plugin-manifest.json'));
  });

  it('keeps global plugins active when a Bot has no additions', () => {
    const manifest = ensureSessionPluginManifest({
      sessionId: 'session-2',
      bot: { larkAppId: 'app-2', name: 'review', plugins: [] },
      global: { plugins: ['chrome'] },
      dataDir,
    });
    expect(manifest).toMatchObject({ botId: 'review', source: 'bot', pluginIds: ['chrome'] });
  });

  it('rejects traversal-like session ids', () => {
    expect(() => sessionPluginManifestPath('../other', dataDir)).toThrow(/invalid_plugin_session_id/);
  });
});
