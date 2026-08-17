import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DAEMON_ENV_KEYS, resolveDaemonEnv } from '../src/cli/daemon-lifecycle-env.js';
import { DASHBOARD_H5_ENV_KEYS, DASHBOARD_H5_ENV_PREFIX } from '../src/utils/child-env.js';

/**
 * Every key resolves to '' unless a source sets it, except the dashboard bind
 * host whose historical default lands in resolveDaemonEnv itself. Built from
 * DAEMON_ENV_KEYS so the exact-shape assertions below keep working (and keep
 * being exact) as the list grows.
 */
function expected(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(DAEMON_ENV_KEYS.map(key => [key, ''])),
    BOTMUX_DASHBOARD_HOST: '0.0.0.0',
    ...overrides,
  };
}

describe('resolveDaemonEnv()', () => {
  it('clears inherited settings when restart comes from a botmux session', () => {
    expect(resolveDaemonEnv({
      BOTMUX_SESSION_ID: 'session-1',
      WEB_EXTERNAL_HOST: '10.255.64.131',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: '10.255.64.131',
      BOTMUX_DASHBOARD_HOST: '10.255.64.131',
      BOTMUX_DASHBOARD_PORT: '9999',
      BOTMUX_DAEMON_IPC_BASE_PORT: '9998',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
      BOTMUX_PUBLIC_URL: 'http://stale.proxy.example.com',
      BOTMUX_DASHBOARD_FEISHU_H5_ENABLED: 'true',
      BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET: 'stale-secret',
    })).toEqual(expected());
  });

  it('reloads explicit settings from .env for a session-origin restart', () => {
    expect(resolveDaemonEnv({
      BOTMUX_SESSION_ID: 'session-1',
      WEB_EXTERNAL_HOST: 'stale.example.com',
      BOTMUX_DASHBOARD_HOST: '0.0.0.0',
      BOTMUX_DASHBOARD_PORT: '7891',
    }, [
      'WEB_EXTERNAL_HOST=relay.example.com',
      'BOTMUX_DASHBOARD_EXTERNAL_HOST=dashboard.example.com',
      'BOTMUX_DASHBOARD_HOST=127.0.0.1',
      'BOTMUX_DASHBOARD_PORT=7991',
      'BOTMUX_DAEMON_IPC_BASE_PORT=7992',
      'BOTMUX_DASHBOARD_PUBLIC_READONLY=false',
      // The regression this pins: a bot session's pane wrapper unsets BOTMUX_*,
      // so a self-upgrade restart from inside a session has NO inherited value —
      // only the .env snapshot can keep web-terminal links on the proxy domain.
      'BOTMUX_PUBLIC_URL=http://botmux.example.com',
    ].join('\n'))).toEqual(expected({
      WEB_EXTERNAL_HOST: 'relay.example.com',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: 'dashboard.example.com',
      BOTMUX_DASHBOARD_HOST: '127.0.0.1',
      BOTMUX_DASHBOARD_PORT: '7991',
      BOTMUX_DAEMON_IPC_BASE_PORT: '7992',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
      BOTMUX_PUBLIC_URL: 'http://botmux.example.com',
    }));
  });

  it('keeps ordinary shell overrides ahead of .env', () => {
    expect(resolveDaemonEnv({
      WEB_EXTERNAL_HOST: 'shell.example.com',
      BOTMUX_DASHBOARD_HOST: '127.0.0.2',
      BOTMUX_DASHBOARD_PORT: '7992',
      BOTMUX_DAEMON_IPC_BASE_PORT: '7993',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
      BOTMUX_PUBLIC_URL: 'http://shell.proxy.example.com',
    }, [
      'WEB_EXTERNAL_HOST=file.example.com',
      'BOTMUX_DASHBOARD_EXTERNAL_HOST=dashboard.example.com',
      'BOTMUX_DASHBOARD_HOST=127.0.0.1',
      'BOTMUX_DASHBOARD_PORT=7991',
      'BOTMUX_DAEMON_IPC_BASE_PORT=7992',
      'BOTMUX_DASHBOARD_PUBLIC_READONLY=true',
      'BOTMUX_PUBLIC_URL=http://file.proxy.example.com',
    ].join('\n'))).toEqual(expected({
      WEB_EXTERNAL_HOST: 'shell.example.com',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: 'dashboard.example.com',
      BOTMUX_DASHBOARD_HOST: '127.0.0.2',
      BOTMUX_DASHBOARD_PORT: '7992',
      BOTMUX_DAEMON_IPC_BASE_PORT: '7993',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
      BOTMUX_PUBLIC_URL: 'http://shell.proxy.example.com',
    }));
  });

  it('lets an ordinary shell explicitly clear persisted settings', () => {
    expect(resolveDaemonEnv({
      WEB_EXTERNAL_HOST: '',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: '   ',
      BOTMUX_DASHBOARD_HOST: '',
      BOTMUX_DASHBOARD_PORT: '   ',
      BOTMUX_DAEMON_IPC_BASE_PORT: '',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: '',
      BOTMUX_PUBLIC_URL: '',
    }, [
      'WEB_EXTERNAL_HOST=file.example.com',
      'BOTMUX_DASHBOARD_EXTERNAL_HOST=dashboard.example.com',
      'BOTMUX_DASHBOARD_HOST=127.0.0.1',
      'BOTMUX_DASHBOARD_PORT=7991',
      'BOTMUX_DAEMON_IPC_BASE_PORT=7992',
      'BOTMUX_DASHBOARD_PUBLIC_READONLY=false',
      'BOTMUX_PUBLIC_URL=http://file.proxy.example.com',
    ].join('\n'))).toEqual(expected());
  });
});

describe('DAEMON_ENV_KEYS carries the non-secret dashboard settings only', () => {
  // `botmux-dashboard` is its own PM2 app. Non-secret dashboard settings reach
  // it via the env block baked from this list; the Feishu H5 login family
  // (APP_SECRET included) deliberately does NOT — the dashboard entry point
  // (index-dashboard.ts) dotenv-loads ~/.botmux/.env itself, so the credential
  // never enters the SHARED env block that every bot daemon receives and that
  // persists on disk in ~/.botmux/ecosystem.config.json.
  it('excludes every H5 var — the family flows through index-dashboard.ts dotenv, not this block', () => {
    for (const key of DASHBOARD_H5_ENV_KEYS) {
      expect(DAEMON_ENV_KEYS as readonly string[], key).not.toContain(key);
    }
  });

  it('keeps every var resolveDashboardH5AuthConfig reads OFF the whitelist (drift guard)', () => {
    // Scrape the single consumer's source: an H5 knob added to h5-auth.ts and
    // then "helpfully" whitelisted here would put a credential-family key back
    // into the shared baked block. Also sweep the whole prefix so no future
    // DAEMON_ENV_KEYS entry can smuggle the family in under a new name.
    const h5 = readFileSync(new URL('../src/dashboard/h5-auth.ts', import.meta.url), 'utf-8');
    const read = new Set(h5.match(/BOTMUX_DASHBOARD_FEISHU_H5_[A-Z0-9_]+/g) ?? []);
    expect(read.size).toBeGreaterThan(0);
    for (const key of read) {
      expect(DAEMON_ENV_KEYS as readonly string[], key).not.toContain(key);
    }
    for (const key of DAEMON_ENV_KEYS) {
      expect(key.startsWith(DASHBOARD_H5_ENV_PREFIX), key).toBe(false);
    }
  });

  it('emits no H5 key even when the inherited env AND .env are fully populated', () => {
    // The isolation red line: resolveDaemonEnv's output IS the ecosystem env
    // block (cli.ts ecosystemConfig), shared by the dashboard and every bot
    // daemon and written to ~/.botmux/ecosystem.config.json. Flood both
    // sources with the complete named family plus a future prefix knob; none
    // may surface, for a shell-origin or a session-origin restart alike.
    const floodedEnv = {
      ...Object.fromEntries(DASHBOARD_H5_ENV_KEYS.map(key => [key, 'secret-from-env'])),
      [`${DASHBOARD_H5_ENV_PREFIX}FUTURE_KNOB`]: 'secret-from-env',
    };
    const floodedFile = [
      ...DASHBOARD_H5_ENV_KEYS.map(key => `${key}=secret-from-file`),
      `${DASHBOARD_H5_ENV_PREFIX}FUTURE_KNOB=secret-from-file`,
    ].join('\n');
    for (const inherited of [floodedEnv, { ...floodedEnv, BOTMUX_SESSION_ID: 'session-1' }]) {
      const resolved = resolveDaemonEnv(inherited, floodedFile);
      const leaked = Object.keys(resolved).filter(key => key.startsWith(DASHBOARD_H5_ENV_PREFIX));
      expect(leaked).toEqual([]);
      expect(JSON.stringify(resolved)).not.toContain('secret-from');
    }
  });

  it('includes the audit-path and terminal-lease settings from .env.example', () => {
    expect(DAEMON_ENV_KEYS as readonly string[]).toContain('BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH');
    expect(DAEMON_ENV_KEYS as readonly string[]).toContain('BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS');
  });

  it('resolves the non-secret dashboard settings from the .env snapshot end to end', () => {
    const resolved = resolveDaemonEnv({ BOTMUX_SESSION_ID: 'session-1' }, [
      // The H5 lines sit in the SAME file the audit/TTL settings come from —
      // they must stay out of the resolved block while their neighbors land.
      'BOTMUX_DASHBOARD_FEISHU_H5_ENABLED=true',
      'BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET=h5-secret',
      'BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH=/var/lib/botmux/audit/dashboard-control.ndjson',
      'BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS=300000',
    ].join('\n'));
    // expected() is derived from DAEMON_ENV_KEYS, so the exact-shape equality
    // doubles as "no H5 key in the output".
    expect(resolved).toEqual(expected({
      BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH: '/var/lib/botmux/audit/dashboard-control.ndjson',
      BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS: '300000',
    }));
  });
});
