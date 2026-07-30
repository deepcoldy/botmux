import { describe, expect, it } from 'vitest';
import { resolveDaemonEnv } from '../src/cli/daemon-lifecycle-env.js';

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
    })).toEqual({
      WEB_EXTERNAL_HOST: '',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: '',
      BOTMUX_DASHBOARD_HOST: '0.0.0.0',
      BOTMUX_DASHBOARD_PORT: '',
      BOTMUX_DAEMON_IPC_BASE_PORT: '',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: '',
      BOTMUX_PUBLIC_URL: '',
    });
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
    ].join('\n'))).toEqual({
      WEB_EXTERNAL_HOST: 'relay.example.com',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: 'dashboard.example.com',
      BOTMUX_DASHBOARD_HOST: '127.0.0.1',
      BOTMUX_DASHBOARD_PORT: '7991',
      BOTMUX_DAEMON_IPC_BASE_PORT: '7992',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
      BOTMUX_PUBLIC_URL: 'http://botmux.example.com',
    });
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
    ].join('\n'))).toEqual({
      WEB_EXTERNAL_HOST: 'shell.example.com',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: 'dashboard.example.com',
      BOTMUX_DASHBOARD_HOST: '127.0.0.2',
      BOTMUX_DASHBOARD_PORT: '7992',
      BOTMUX_DAEMON_IPC_BASE_PORT: '7993',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
      BOTMUX_PUBLIC_URL: 'http://shell.proxy.example.com',
    });
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
    ].join('\n'))).toEqual({
      WEB_EXTERNAL_HOST: '',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: '',
      BOTMUX_DASHBOARD_HOST: '0.0.0.0',
      BOTMUX_DASHBOARD_PORT: '',
      BOTMUX_DAEMON_IPC_BASE_PORT: '',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: '',
      BOTMUX_PUBLIC_URL: '',
    });
  });
});
