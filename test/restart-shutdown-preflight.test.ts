import { describe, expect, it } from 'vitest';
import { evaluateRestartShutdownPreflight } from '../src/cli/restart-shutdown-preflight.js';
import {
  fleetEntryProvesSignalDeathAutorestart,
  daemonRowsMissingSignalDeathAutorestart,
} from '../src/cli/pm2-start-transaction.js';
import type { FleetProcessEntry } from '../src/cli/fleet-shutdown.js';

const SENTINEL = 90;

function daemon(overrides: Partial<FleetProcessEntry> & { name: string }): FleetProcessEntry {
  return {
    pid: 1000 + Math.floor(Math.random() * 1000),
    online: true,
    autorestart: true,
    stopExitCodes: [SENTINEL],
    ...overrides,
  };
}

describe('fleetEntryProvesSignalDeathAutorestart', () => {
  it('accepts the exact sentinel policy (numeric or string)', () => {
    expect(fleetEntryProvesSignalDeathAutorestart(daemon({ name: 'botmux-local' }))).toBe(true);
    expect(fleetEntryProvesSignalDeathAutorestart(
      daemon({ name: 'botmux-local', autorestart: 'true', stopExitCodes: ['90'] }),
    )).toBe(true);
  });

  it('rejects an old policy: autorestart off, wrong/extra exit codes, or empty', () => {
    expect(fleetEntryProvesSignalDeathAutorestart(daemon({ name: 'a', autorestart: false }))).toBe(false);
    expect(fleetEntryProvesSignalDeathAutorestart(daemon({ name: 'a', stopExitCodes: [0] }))).toBe(false);
    expect(fleetEntryProvesSignalDeathAutorestart(daemon({ name: 'a', stopExitCodes: [90, 0] }))).toBe(false);
    expect(fleetEntryProvesSignalDeathAutorestart(daemon({ name: 'a', stopExitCodes: [] }))).toBe(false);
    expect(fleetEntryProvesSignalDeathAutorestart(daemon({ name: 'a', stopExitCodes: undefined }))).toBe(false);
  });
});

describe('daemonRowsMissingSignalDeathAutorestart', () => {
  it('returns exactly the rows on the old policy', () => {
    const rows = [
      daemon({ name: 'ok' }),
      daemon({ name: 'old-1', stopExitCodes: [0] }),
      daemon({ name: 'old-2', autorestart: false }),
    ];
    expect(daemonRowsMissingSignalDeathAutorestart(rows).map(r => r.name)).toEqual(['old-1', 'old-2']);
  });
});

describe('evaluateRestartShutdownPreflight', () => {
  it('requires bootstrap when a live daemon still runs the old policy', () => {
    const result = evaluateRestartShutdownPreflight(() => [
      daemon({ name: 'botmux-local', stopExitCodes: [0] }),
      daemon({ name: 'botmux-relay' }),
      { name: 'botmux-dashboard', pid: 5, online: true, autorestart: true, stopExitCodes: [0] },
    ]);
    expect(result.bootstrapRequired).toBe(true);
    // The dashboard row is never a signal target, so it is excluded even on the
    // old policy; only the worker daemon is flagged.
    expect(result.unsafeDaemonNames).toEqual(['botmux-local']);
  });

  it('does not require bootstrap when every live daemon proves the protocol', () => {
    const result = evaluateRestartShutdownPreflight(() => [
      daemon({ name: 'botmux-local' }),
      daemon({ name: 'botmux-relay' }),
      { name: 'botmux-dashboard', pid: 5, online: true, autorestart: true, stopExitCodes: [SENTINEL] },
    ]);
    expect(result.bootstrapRequired).toBe(false);
    expect(result.unsafeDaemonNames).toEqual([]);
  });

  it('ignores offline or non-live daemon rows', () => {
    const result = evaluateRestartShutdownPreflight(() => [
      // Old policy but offline → already retired, not a signal target.
      daemon({ name: 'botmux-local', online: false, stopExitCodes: [0] }),
      // Old policy but PID not OS-plausible.
      daemon({ name: 'botmux-relay', pid: 1, stopExitCodes: [0] }),
      daemon({ name: 'botmux-mira' }),
    ]);
    expect(result.bootstrapRequired).toBe(false);
  });

  it('reports no bootstrap for an empty fleet', () => {
    expect(evaluateRestartShutdownPreflight(() => []).bootstrapRequired).toBe(false);
  });

  it('excludes plugin rows from the daemon signal set', () => {
    const result = evaluateRestartShutdownPreflight(() => [
      { name: 'botmux-plugin-foo', pid: 9, online: true, autorestart: false, stopExitCodes: [0] },
      daemon({ name: 'botmux-local' }),
    ]);
    expect(result.bootstrapRequired).toBe(false);
  });
});
