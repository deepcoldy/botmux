import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DAEMON_ENV_KEYS, resolveDaemonEnv } from '../src/cli/daemon-lifecycle-env.js';
import { DASHBOARD_H5_ENV_KEYS } from '../src/utils/child-env.js';

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

describe('DAEMON_ENV_KEYS carries the dashboard-only settings', () => {
  // `botmux-dashboard` is its own PM2 app and, unlike the bot daemons
  // (index-daemon.ts dotenv-loads ~/.botmux/.env), it sees ONLY the env block
  // baked from this list. A dashboard-only key left off silently falls back to
  // its built-in default: a fully configured H5 login stayed `enabled:false`
  // (entry path 404) and the TTL / Secure-cookie / allowlist knobs were ignored.
  it('includes every H5 var the dashboard auth config reads', () => {
    for (const key of DASHBOARD_H5_ENV_KEYS) {
      expect(DAEMON_ENV_KEYS as readonly string[], key).toContain(key);
    }
  });

  it('stays in step with resolveDashboardH5AuthConfig (drift guard)', () => {
    const h5 = readFileSync(new URL('../src/dashboard/h5-auth.ts', import.meta.url), 'utf-8');
    const read = new Set(h5.match(/BOTMUX_DASHBOARD_FEISHU_H5_[A-Z0-9_]+/g) ?? []);
    expect(read.size).toBeGreaterThan(0);
    for (const key of read) {
      expect(DAEMON_ENV_KEYS as readonly string[], key).toContain(key);
    }
  });

  it('includes the audit-path and terminal-lease settings from .env.example', () => {
    expect(DAEMON_ENV_KEYS as readonly string[]).toContain('BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH');
    expect(DAEMON_ENV_KEYS as readonly string[]).toContain('BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS');
  });

  it('resolves each dashboard setting from the .env snapshot end to end', () => {
    const resolved = resolveDaemonEnv({ BOTMUX_SESSION_ID: 'session-1' }, [
      'BOTMUX_DASHBOARD_FEISHU_H5_ENABLED=true',
      'BOTMUX_DASHBOARD_FEISHU_H5_BRAND=lark',
      'BOTMUX_DASHBOARD_FEISHU_H5_APP_ID=cli_h5',
      'BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET=h5-secret',
      'BOTMUX_DASHBOARD_FEISHU_H5_ALLOWED_OPEN_IDS=ou_a,ou_b',
      'BOTMUX_DASHBOARD_FEISHU_H5_ENTRY_PATH=/auth/feishu',
      'BOTMUX_DASHBOARD_FEISHU_H5_SESSION_TTL_MS=1800000',
      'BOTMUX_DASHBOARD_FEISHU_H5_SECURE_COOKIE=true',
      'BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH=/var/lib/botmux/audit/dashboard-control.ndjson',
      'BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS=300000',
    ].join('\n'));
    expect(resolved).toEqual(expected({
      BOTMUX_DASHBOARD_FEISHU_H5_ENABLED: 'true',
      BOTMUX_DASHBOARD_FEISHU_H5_BRAND: 'lark',
      BOTMUX_DASHBOARD_FEISHU_H5_APP_ID: 'cli_h5',
      BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET: 'h5-secret',
      BOTMUX_DASHBOARD_FEISHU_H5_ALLOWED_OPEN_IDS: 'ou_a,ou_b',
      BOTMUX_DASHBOARD_FEISHU_H5_ENTRY_PATH: '/auth/feishu',
      BOTMUX_DASHBOARD_FEISHU_H5_SESSION_TTL_MS: '1800000',
      BOTMUX_DASHBOARD_FEISHU_H5_SECURE_COOKIE: 'true',
      BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH: '/var/lib/botmux/audit/dashboard-control.ndjson',
      BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS: '300000',
    }));
  });
});
