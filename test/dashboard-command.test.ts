import { describe, expect, it, vi } from 'vitest';
import {
  executeDashboardCommand,
  formatDashboardFallbackFailure,
} from '../src/cli/dashboard-command.js';
import type { DashboardEndpoint } from '../src/cli/dashboard-endpoint.js';

describe('executeDashboardCommand', () => {
  it.each([['--help'], ['-h'], ['help']])('%s is non-mutating', async (...args) => {
    const callEndpoint = vi.fn();
    expect(await executeDashboardCommand(args, callEndpoint)).toEqual({ kind: 'help' });
    expect(callEndpoint).not.toHaveBeenCalled();
  });

  it.each([
    { args: ['--help', 'rotate'] },
    { args: ['rotate', '--help'] },
    { args: ['current', 'unexpected', '-h'] },
    { args: ['unexpected', 'help', 'rotate'] },
  ])('treats help anywhere in $args as non-mutating help', async ({ args }) => {
    const callEndpoint = vi.fn();
    expect(await executeDashboardCommand(args, callEndpoint)).toEqual({ kind: 'help' });
    expect(callEndpoint).not.toHaveBeenCalled();
  });

  it.each([{ args: [] }, { args: ['current'] }])('$args gets or creates the current URL and never calls rotate', async ({ args }) => {
    const callEndpoint = vi.fn(async (path: DashboardEndpoint) => path === '/__cli/current'
      ? { ok: false as const, reason: 'no-active-token' as const }
      : { ok: true as const, url: 'https://dashboard.test/?t=synthetic-created-token' });
    const result = await executeDashboardCommand(args, callEndpoint);
    expect(callEndpoint.mock.calls.map(([path]) => path)).toEqual([
      '/__cli/current',
      '/__cli/ensure',
    ]);
    expect(result).toEqual({
      kind: 'endpoint',
      action: 'current',
      result: { ok: true, url: 'https://dashboard.test/?t=synthetic-created-token' },
    });
  });

  it('returns an existing current URL without touching a token-writing endpoint', async () => {
    const callEndpoint = vi.fn(async () => ({
      ok: true as const,
      url: 'https://dashboard.test/?t=synthetic-current-token',
    }));

    const result = await executeDashboardCommand(['current'], callEndpoint);

    expect(callEndpoint).toHaveBeenCalledOnce();
    expect(callEndpoint).toHaveBeenCalledWith('/__cli/current');
    expect(result).toMatchObject({
      kind: 'endpoint',
      action: 'current',
      result: { ok: true, url: 'https://dashboard.test/?t=synthetic-current-token' },
    });
  });

  it.each([
    { ok: false as const, reason: 'unreachable' as const },
    { ok: false as const, reason: 'auth-failed' as const },
    { ok: false as const, reason: 'wrong-service' as const },
  ])('does not touch a token-writing endpoint when current fails with $reason', async (currentFailure) => {
    const callEndpoint = vi.fn(async () => currentFailure);

    const result = await executeDashboardCommand(['current'], callEndpoint);

    expect(callEndpoint).toHaveBeenCalledOnce();
    expect(callEndpoint).toHaveBeenCalledWith('/__cli/current');
    expect(result).toEqual({ kind: 'endpoint', action: 'current', result: currentFailure });
  });

  it('falls back to legacy rotate only after current confirms a dashboard with no token and ensure is missing', async () => {
    const callEndpoint = vi.fn(async (path: DashboardEndpoint) => {
      if (path === '/__cli/current') {
        return { ok: false as const, reason: 'no-active-token' as const };
      }
      if (path === '/__cli/ensure') {
        return {
          ok: false as const,
          reason: 'wrong-service' as const,
          detail: '404 {"error":"not_found","path":"/__cli/ensure"}',
        };
      }
      if (path === '/__cli/rotate') {
        return { ok: true as const, url: 'https://dashboard.test/?t=legacy-token' };
      }
      throw new Error(`unexpected endpoint: ${path}`);
    });

    const result = await executeDashboardCommand(['current'], callEndpoint);

    expect(callEndpoint.mock.calls.map(([path]) => path)).toEqual([
      '/__cli/current',
      '/__cli/ensure',
      '/__cli/current',
      '/__cli/rotate',
    ]);
    expect(result).toEqual({
      kind: 'endpoint',
      action: 'current',
      result: { ok: true, url: 'https://dashboard.test/?t=legacy-token' },
    });
  });

  it('recognizes the legacy token-gate response for an unsupported ensure route', async () => {
    const callEndpoint = vi.fn(async (path: DashboardEndpoint) => {
      if (path === '/__cli/current') {
        return { ok: false as const, reason: 'no-active-token' as const };
      }
      if (path === '/__cli/ensure') {
        return {
          ok: false as const,
          reason: 'http-error' as const,
          detail: '401 <h1>Token expired</h1><p>Run <code>botmux dashboard</code> to get a fresh URL.</p>',
        };
      }
      if (path === '/__cli/rotate') {
        return { ok: true as const, url: 'https://dashboard.test/?t=legacy-token' };
      }
      throw new Error(`unexpected endpoint: ${path}`);
    });

    const result = await executeDashboardCommand([], callEndpoint);

    expect(callEndpoint.mock.calls.map(([path]) => path)).toEqual([
      '/__cli/current',
      '/__cli/ensure',
      '/__cli/current',
      '/__cli/rotate',
    ]);
    expect(result).toMatchObject({
      kind: 'endpoint',
      action: 'current',
      result: { ok: true, url: 'https://dashboard.test/?t=legacy-token' },
    });
  });

  it('rechecks current before legacy rotation so a concurrently-created token survives', async () => {
    let currentCalls = 0;
    const callEndpoint = vi.fn(async (path: DashboardEndpoint) => {
      if (path === '/__cli/current') {
        currentCalls += 1;
        return currentCalls === 1
          ? { ok: false as const, reason: 'no-active-token' as const }
          : { ok: true as const, url: 'https://dashboard.test/?t=concurrent-token' };
      }
      if (path === '/__cli/ensure') {
        return { ok: false as const, reason: 'wrong-service' as const };
      }
      throw new Error(`unexpected endpoint: ${path}`);
    });

    const result = await executeDashboardCommand(['current'], callEndpoint);

    expect(callEndpoint.mock.calls.map(([path]) => path)).toEqual([
      '/__cli/current',
      '/__cli/ensure',
      '/__cli/current',
    ]);
    expect(result).toMatchObject({
      kind: 'endpoint',
      action: 'current',
      result: { ok: true, url: 'https://dashboard.test/?t=concurrent-token' },
    });
  });

  it('does not rotate when the new ensure route fails closed', async () => {
    const ensureFailure = {
      ok: false as const,
      reason: 'http-error' as const,
      detail: '500 {"error":"token_persist_failed"}',
    };
    const callEndpoint = vi.fn(async (path: DashboardEndpoint) => path === '/__cli/current'
      ? { ok: false as const, reason: 'no-active-token' as const }
      : ensureFailure);

    const result = await executeDashboardCommand(['current'], callEndpoint);

    expect(callEndpoint.mock.calls.map(([path]) => path)).toEqual([
      '/__cli/current',
      '/__cli/ensure',
    ]);
    expect(result).toEqual({ kind: 'endpoint', action: 'current', result: ensureFailure });
  });

  it('rotates only when explicitly requested', async () => {
    const callEndpoint = vi.fn(async () => ({
      ok: true as const,
      url: 'https://dashboard.test/?t=synthetic-rotated-token',
    }));
    const result = await executeDashboardCommand(['rotate'], callEndpoint);
    expect(callEndpoint).toHaveBeenCalledTimes(1);
    expect(callEndpoint).toHaveBeenCalledWith('/__cli/rotate');
    expect(result).toMatchObject({ kind: 'endpoint', action: 'rotate' });
  });

  it.each([
    { args: ['current', 'unexpected'] },
    { args: ['rotate', 'unexpected'] },
    { args: ['current', 'rotate'] },
    { args: ['rotate', 'current'] },
  ])('rejects extra argv in $args without touching either endpoint', async ({ args }) => {
    const callEndpoint = vi.fn();
    expect(await executeDashboardCommand(args, callEndpoint)).toEqual({
      kind: 'invalid',
      argument: args.join(' '),
    });
    expect(callEndpoint).not.toHaveBeenCalled();
  });

  it('rejects unknown subcommands without touching either endpoint', async () => {
    const callEndpoint = vi.fn();
    expect(await executeDashboardCommand(['wat'], callEndpoint)).toEqual({
      kind: 'invalid',
      argument: 'wat',
    });
    expect(callEndpoint).not.toHaveBeenCalled();
  });
});

describe('formatDashboardFallbackFailure', () => {
  it.each([
    {
      failure: { ok: false as const, reason: 'auth-failed' as const },
      expected: 'Dashboard lookup failed: auth-failed',
    },
    {
      failure: { ok: false as const, reason: 'http-error' as const, detail: '500 upstream error' },
      expected: 'Dashboard lookup failed: 500 upstream error',
    },
    {
      failure: {
        ok: false as const,
        reason: 'http-error' as const,
        detail: 'malformed response (no url)',
      },
      expected: 'Dashboard lookup failed: malformed response (no url)',
    },
  ])('labels current failures as a lookup failure: $failure', ({ failure, expected }) => {
    const message = formatDashboardFallbackFailure('current', failure);
    expect(message).toBe(expected);
    expect(message).not.toContain('Rotation');
  });

  it('retains the rotation-specific label for rotate failures', () => {
    expect(formatDashboardFallbackFailure('rotate', {
      ok: false,
      reason: 'http-error',
      detail: '500 upstream error',
    })).toBe('Rotation failed: 500 upstream error');
  });
});
