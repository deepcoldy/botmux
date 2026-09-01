import { describe, expect, it } from 'vitest';
import {
  PM2_GRACEFUL_EXIT_CODE,
  PM2_GRACEFUL_EXIT_CODE_ENV,
  gracefulProcessExitCode,
  pm2ManagedExitConfig,
  stripPm2GracefulExitMarker,
} from '../src/pm2-graceful-exit.js';

describe('PM2 graceful exit sentinel', () => {
  it('uses a dedicated stop code instead of 0 for PM2-managed processes', () => {
    expect(pm2ManagedExitConfig()).toEqual({
      stopExitCodes: [PM2_GRACEFUL_EXIT_CODE],
      env: { [PM2_GRACEFUL_EXIT_CODE_ENV]: String(PM2_GRACEFUL_EXIT_CODE) },
    });
    expect(pm2ManagedExitConfig().stopExitCodes).not.toContain(0);
  });

  it('keeps restartable PM2 signal exits outside stop_exit_codes', () => {
    const managedEnv = {
      [PM2_GRACEFUL_EXIT_CODE_ENV]: String(PM2_GRACEFUL_EXIT_CODE),
    };
    expect(gracefulProcessExitCode(true, managedEnv)).toBe(PM2_GRACEFUL_EXIT_CODE);
    const restartableExit = gracefulProcessExitCode(false, managedEnv);
    expect(restartableExit).toBe(0);
    expect(pm2ManagedExitConfig().stopExitCodes).not.toContain(restartableExit);
    expect(gracefulProcessExitCode(true, {})).toBe(0);
    expect(gracefulProcessExitCode(true, { [PM2_GRACEFUL_EXIT_CODE_ENV]: '0' })).toBe(0);
  });
});

describe('stripPm2GracefulExitMarker', () => {
  it('removes the sentinel and returns a fresh copy (never mutates input)', () => {
    const input = { [PM2_GRACEFUL_EXIT_CODE_ENV]: '90', KEEP: 'v' };
    const out = stripPm2GracefulExitMarker(input);
    expect(PM2_GRACEFUL_EXIT_CODE_ENV in out).toBe(false);
    expect(out.KEEP).toBe('v');
    // Input untouched — callers pass process.env and must not mutate it.
    expect(input[PM2_GRACEFUL_EXIT_CODE_ENV]).toBe('90');
    expect(out).not.toBe(input);
  });

  it('returns a fresh copy even when the marker is absent (safe to mutate)', () => {
    const input = { KEEP: 'v' };
    const out = stripPm2GracefulExitMarker(input);
    expect(out).not.toBe(input);
    expect(out.KEEP).toBe('v');
    // A caller that deletes another key from the result must not hit process.env.
    delete (out as Record<string, string>).KEEP;
    expect(input.KEEP).toBe('v');
  });
});
