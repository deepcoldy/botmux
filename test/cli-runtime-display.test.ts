import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  configuredRuntimeDisplayName,
  sessionConfiguredRuntimeDisplayName,
} from '../src/core/cli-runtime-display.js';

const configuredSnapshot = {
  id: 'vendor-codex',
  displayName: 'Vendor Codex',
  executable: 'vendor-codex',
  source: 'configured' as const,
  update: { provider: 'auto' as const },
};

const liveRuntime = {
  id: 'forge-codex',
  displayName: 'Forge Codex',
  executable: 'forge-codex',
};

describe('CLI runtime display identity', () => {
  it('uses a configured snapshot and ignores a later bot-level switch', () => {
    expect(sessionConfiguredRuntimeDisplayName({
      agentFrozen: true,
      cliRuntime: configuredSnapshot,
      cliPathOverride: 'vendor-codex',
    }, liveRuntime)).toBe('Vendor Codex');
  });

  it('does not relabel official or legacy snapshots', () => {
    expect(configuredRuntimeDisplayName({
      id: 'codex',
      displayName: 'Codex',
      executable: 'codex',
      source: 'official',
      update: { provider: 'internal' },
    })).toBeUndefined();
    expect(configuredRuntimeDisplayName({
      id: 'legacy-vendor-codex',
      displayName: 'vendor-codex',
      executable: 'vendor-codex',
      source: 'legacy-path',
      update: { provider: 'auto' },
    })).toBeUndefined();
  });

  it('does not borrow a live runtime for a partially stamped legacy session', () => {
    expect(sessionConfiguredRuntimeDisplayName({
      agentFrozen: false,
      cliPathOverride: '/opt/vendor/bin/vendor-codex',
    }, liveRuntime)).toBeUndefined();
  });

  it('uses the live runtime only before an unstamped session is first frozen', () => {
    expect(sessionConfiguredRuntimeDisplayName({}, liveRuntime)).toBe('Forge Codex');
  });

  it('keeps the frozen runtime wired into the previous-turn card handoff', () => {
    const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    const begin = source.indexOf('function beginNewTurn(');
    const end = source.indexOf('\nfunction ', begin + 1);
    const body = source.slice(begin, end);

    expect(body).toContain('const effectiveCliId = ds.session.cliId ?? dsBotCfg.cliId');
    expect(body).toContain('sessionConfiguredRuntimeDisplayName(ds.session, dsBotCfg.cliRuntime)');
    expect(body).toMatch(/getDaemonStreamingCardUsageSnapshot[\s\S]*runtimeDisplayName,/);
  });
});
