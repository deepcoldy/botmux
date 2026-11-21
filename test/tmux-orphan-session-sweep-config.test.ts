import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../src/config.js';
import { globalConfigPath, invalidateGlobalConfigCache, mergeDashboardConfig, readGlobalConfig } from '../src/global-config.js';

/**
 * Both session-sweep switches reach the daemon through the same chain as
 * `reapOrphanTmuxServers` (global-config → live config getter → settings
 * applier → settings page), and the two have OPPOSITE defaults: the report
 * sweep is ON unless an operator explicitly stored `false`, the kill arm is OFF
 * unless explicitly `true`. Getting either polarity backwards is silent — the
 * daemon simply stops reporting, or worse, starts signalling panes nobody
 * opted into — so both directions are pinned here.
 */
describe('orphan tmux SESSION sweep switches (report default ON, kill default OFF)', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'botmux-orphan-session-sweep-'));
    vi.stubEnv('HOME', configDir);
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(configDir, { recursive: true, force: true });
  });

  it('reports on a fresh install but never kills without an explicit opt-in', () => {
    expect(config.tmuxOrphanSessionSweep).toBe(true);
    expect(config.tmuxOrphanSessionBareWrapperKill).toBe(false);
  });

  it('a stored false disables the report sweep (round-trips the explicit disable)', () => {
    mergeDashboardConfig({ tmuxOrphanSessionSweep: false });
    expect(config.tmuxOrphanSessionSweep).toBe(false);
    expect(readGlobalConfig().dashboard?.tmuxOrphanSessionSweep).toBe(false);

    mergeDashboardConfig({ tmuxOrphanSessionSweep: true });
    expect(config.tmuxOrphanSessionSweep).toBe(true);
  });

  it('the kill arm only turns on for an explicit true', () => {
    expect(config.tmuxOrphanSessionBareWrapperKill).toBe(false);
    mergeDashboardConfig({ tmuxOrphanSessionBareWrapperKill: true });
    expect(config.tmuxOrphanSessionBareWrapperKill).toBe(true);
    mergeDashboardConfig({ tmuxOrphanSessionBareWrapperKill: false });
    expect(config.tmuxOrphanSessionBareWrapperKill).toBe(false);
  });

  it.each([
    {},
    { tmuxOrphanSessionSweep: 'false', tmuxOrphanSessionBareWrapperKill: 'true' },
  ])('ignores an absent or non-boolean saved value: %j', (dashboard) => {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard }));
    invalidateGlobalConfigCache();
    // Absent/invalid ⇒ each getter falls back to its own default, never to a
    // truthy coercion of the string.
    expect(config.tmuxOrphanSessionSweep).toBe(true);
    expect(config.tmuxOrphanSessionBareWrapperKill).toBe(false);
    expect(readGlobalConfig().dashboard?.tmuxOrphanSessionSweep).toBeUndefined();
    expect(readGlobalConfig().dashboard?.tmuxOrphanSessionBareWrapperKill).toBeUndefined();
  });
});
