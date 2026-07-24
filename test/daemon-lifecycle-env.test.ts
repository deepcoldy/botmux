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
    })).toEqual({
      WEB_EXTERNAL_HOST: '',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: '',
      BOTMUX_DASHBOARD_HOST: '0.0.0.0',
      BOTMUX_DASHBOARD_PORT: '',
      BOTMUX_DAEMON_IPC_BASE_PORT: '',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: '',
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
    ].join('\n'))).toEqual({
      WEB_EXTERNAL_HOST: 'relay.example.com',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: 'dashboard.example.com',
      BOTMUX_DASHBOARD_HOST: '127.0.0.1',
      BOTMUX_DASHBOARD_PORT: '7991',
      BOTMUX_DAEMON_IPC_BASE_PORT: '7992',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
    });
  });

  it('keeps ordinary shell overrides ahead of .env', () => {
    expect(resolveDaemonEnv({
      WEB_EXTERNAL_HOST: 'shell.example.com',
      BOTMUX_DASHBOARD_HOST: '127.0.0.2',
      BOTMUX_DASHBOARD_PORT: '7992',
      BOTMUX_DAEMON_IPC_BASE_PORT: '7993',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
    }, [
      'WEB_EXTERNAL_HOST=file.example.com',
      'BOTMUX_DASHBOARD_EXTERNAL_HOST=dashboard.example.com',
      'BOTMUX_DASHBOARD_HOST=127.0.0.1',
      'BOTMUX_DASHBOARD_PORT=7991',
      'BOTMUX_DAEMON_IPC_BASE_PORT=7992',
      'BOTMUX_DASHBOARD_PUBLIC_READONLY=true',
    ].join('\n'))).toEqual({
      WEB_EXTERNAL_HOST: 'shell.example.com',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: 'dashboard.example.com',
      BOTMUX_DASHBOARD_HOST: '127.0.0.2',
      BOTMUX_DASHBOARD_PORT: '7992',
      BOTMUX_DAEMON_IPC_BASE_PORT: '7993',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
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
    }, [
      'WEB_EXTERNAL_HOST=file.example.com',
      'BOTMUX_DASHBOARD_EXTERNAL_HOST=dashboard.example.com',
      'BOTMUX_DASHBOARD_HOST=127.0.0.1',
      'BOTMUX_DASHBOARD_PORT=7991',
      'BOTMUX_DAEMON_IPC_BASE_PORT=7992',
      'BOTMUX_DASHBOARD_PUBLIC_READONLY=false',
    ].join('\n'))).toEqual({
      WEB_EXTERNAL_HOST: '',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: '',
      BOTMUX_DASHBOARD_HOST: '0.0.0.0',
      BOTMUX_DASHBOARD_PORT: '',
      BOTMUX_DAEMON_IPC_BASE_PORT: '',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: '',
    });
  });
});
