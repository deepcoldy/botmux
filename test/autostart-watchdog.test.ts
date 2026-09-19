/**
 * Unit tests for the Linux user-systemd autostart integration, focused on the
 * crash-watchdog units added so a dead fleet self-heals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Capture every spawnSync call and report success so the autostart code thinks
// systemctl accepted enable/disable without actually touching the host.
const calls: { cmd: string; args: string[] }[] = [];
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn((cmd: string, args: string[]) => {
    calls.push({ cmd, args: [...(args || [])] });
    return { status: 0, stdout: '', stderr: '' };
  }),
}));

import {
  AUTOSTART_UNIT_ENV,
  clearWatchdogStopped,
  disableAutostart,
  enableAutostart,
  markWatchdogStopped,
  refreshAutostart,
  watchdogStopRequested,
} from '../src/autostart.js';

let home: string;
function opts() {
  return {
    pkgRoot: join(home, 'pkg'),
    configDir: join(home, '.botmux'),
    logDir: join(home, '.botmux', 'logs'),
    standalone: true,
    execPath: '/opt/botmux',
    environmentPath: '/home/u/.local/bin:/usr/bin',
  };
}

describe('Linux autostart crash watchdog', () => {
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    calls.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('enable writes and enables the watchdog service + timer', () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    // Run only the Linux path regardless of the host running the tests.
    const o = opts();
    vi.stubEnv('HOME', home);
    // platform() reads process.platform; force the Linux branch by stubbing.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    // userSystemdAvailable() shells out; our mock returns status 0 already.

    enableAutostart(o);

    const unitDir = join(home, '.config', 'systemd', 'user');
    expect(existsSync(join(unitDir, 'botmux-watchdog.service'))).toBe(true);
    expect(existsSync(join(unitDir, 'botmux-watchdog.timer'))).toBe(true);

    // The timer is enabled --now so it starts watching immediately.
    const enableCall = calls.find(
      (c) => c.cmd === 'systemctl' && c.args.includes('botmux-watchdog.timer'),
    );
    expect(enableCall?.args).toEqual(
      expect.arrayContaining(['--user', 'enable', '--now', 'botmux-watchdog.timer']),
    );
    const reloadAt = calls.findIndex(
      (c) => c.cmd === 'systemctl' && c.args.join(' ') === '--user daemon-reload',
    );
    const enableAt = calls.findIndex(
      (c) => c.cmd === 'systemctl' && c.args.includes('botmux-watchdog.timer'),
    );
    expect(reloadAt).toBeGreaterThanOrEqual(0);
    expect(enableAt).toBeGreaterThan(reloadAt);

    // The watchdog must let the detached supervisor outlive the oneshot's
    // inactive transition, and it must retain the non-interactive start marker.
    const service = readFileSync(join(unitDir, 'botmux-watchdog.service'), 'utf-8');
    expect(service).toContain('Type=oneshot');
    expect(service).toContain('KillMode=process');
    expect(service).toContain(`WorkingDirectory=${o.configDir}`);
    expect(service).toContain('Environment=PATH=/home/u/.local/bin:/usr/bin');
    expect(service).toContain(`Environment=${AUTOSTART_UNIT_ENV}=1`);
    expect(service).toContain('ExecStart=/opt/botmux __watchdog');
    expect(service).not.toContain('RemainAfterExit');

    // Monotonic timers use OnActiveSec for their first tick. Persistent only
    // applies to OnCalendar timers and must not imply catch-up semantics here.
    const timer = readFileSync(join(unitDir, 'botmux-watchdog.timer'), 'utf-8');
    expect(timer).toContain('OnActiveSec=30s');
    expect(timer).toContain('OnUnitActiveSec=30s');
    expect(timer).not.toContain('Persistent=');
  });

  it('disable stops and removes the watchdog so it cannot resurrect the fleet', () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    const o = opts();
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    enableAutostart(o);
    calls.length = 0;
    const unitDir = join(home, '.config', 'systemd', 'user');

    disableAutostart(o);

    const disableCall = calls.find(
      (c) => c.cmd === 'systemctl' && c.args.includes('botmux-watchdog.timer'),
    );
    expect(disableCall?.args).toEqual(
      expect.arrayContaining(['--user', 'disable', '--now', 'botmux-watchdog.timer']),
    );
    expect(existsSync(join(unitDir, 'botmux-watchdog.service'))).toBe(false);
    expect(existsSync(join(unitDir, 'botmux-watchdog.timer'))).toBe(false);
    expect(calls.some(
      (c) => c.cmd === 'systemctl' && c.args.join(' ') === '--user daemon-reload',
    )).toBe(true);
  });

  it('migrates an existing main autostart unit to the watchdog units', () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    const o = opts();
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const unitDir = join(home, '.config', 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, 'botmux.service'), 'old main unit');

    expect(refreshAutostart(o)).toBe(true);

    expect(existsSync(join(unitDir, 'botmux-watchdog.service'))).toBe(true);
    expect(existsSync(join(unitDir, 'botmux-watchdog.timer'))).toBe(true);
    const reloadAt = calls.findIndex(
      (c) => c.cmd === 'systemctl' && c.args.join(' ') === '--user daemon-reload',
    );
    expect(reloadAt).toBeGreaterThanOrEqual(0);
  });

  it('persists and clears an explicit stop intent', () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    const configDir = join(home, '.botmux');

    expect(watchdogStopRequested(configDir)).toBe(false);
    markWatchdogStopped(configDir);
    expect(watchdogStopRequested(configDir)).toBe(true);
    clearWatchdogStopped(configDir);
    expect(watchdogStopRequested(configDir)).toBe(false);
  });

  it('checks supervisor liveness before dependency and credential preflight', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
    const start = src.indexOf('async function cmdStart(): Promise<void> {');
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);

    const livenessAt = body.indexOf('liveSupervisorPid()');
    const dependenciesAt = body.indexOf('ensureSystemDependencies()');
    const credentialsAt = body.indexOf('preflightConfiguredBotCredentials()');
    expect(livenessAt).toBeGreaterThan(-1);
    expect(livenessAt).toBeLessThan(dependenciesAt);
    expect(livenessAt).toBeLessThan(credentialsAt);
  });

  it('re-checks explicit stop intent under the fleet mutation lock', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
    const start = src.indexOf('async function startConfiguredFleet(');
    const end = src.indexOf('\n}\n\n/**', start);
    const body = src.slice(start, end);
    const lockAt = body.indexOf('withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET');
    const intentAt = body.indexOf('watchdogStopRequested(CONFIG_DIR)', lockAt);

    expect(lockAt).toBeGreaterThan(-1);
    expect(intentAt).toBeGreaterThan(lockAt);
  });
});
