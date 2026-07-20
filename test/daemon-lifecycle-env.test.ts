import { describe, expect, it } from 'vitest';
import { resolveDaemonExternalHostEnv } from '../src/cli/daemon-lifecycle-env.js';

describe('resolveDaemonExternalHostEnv()', () => {
  it('clears inherited host settings when restart comes from a botmux session', () => {
    expect(resolveDaemonExternalHostEnv({
      BOTMUX_SESSION_ID: 'session-1',
      WEB_EXTERNAL_HOST: '10.255.64.131',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: '10.255.64.131',
    })).toEqual({
      WEB_EXTERNAL_HOST: '',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: '',
    });
  });

  it('reloads explicit host settings from .env for a session-origin restart', () => {
    expect(resolveDaemonExternalHostEnv({
      BOTMUX_SESSION_ID: 'session-1',
      WEB_EXTERNAL_HOST: 'stale.example.com',
    }, [
      'WEB_EXTERNAL_HOST=relay.example.com',
      'BOTMUX_DASHBOARD_EXTERNAL_HOST=dashboard.example.com',
    ].join('\n'))).toEqual({
      WEB_EXTERNAL_HOST: 'relay.example.com',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: 'dashboard.example.com',
    });
  });

  it('keeps ordinary shell overrides ahead of .env', () => {
    expect(resolveDaemonExternalHostEnv({
      WEB_EXTERNAL_HOST: 'shell.example.com',
    }, [
      'WEB_EXTERNAL_HOST=file.example.com',
      'BOTMUX_DASHBOARD_EXTERNAL_HOST=dashboard.example.com',
    ].join('\n'))).toEqual({
      WEB_EXTERNAL_HOST: 'shell.example.com',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: 'dashboard.example.com',
    });
  });

  it('lets an ordinary shell explicitly clear persisted host settings', () => {
    expect(resolveDaemonExternalHostEnv({
      WEB_EXTERNAL_HOST: '',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: '   ',
    }, [
      'WEB_EXTERNAL_HOST=file.example.com',
      'BOTMUX_DASHBOARD_EXTERNAL_HOST=dashboard.example.com',
    ].join('\n'))).toEqual({
      WEB_EXTERNAL_HOST: '',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: '',
    });
  });
});
