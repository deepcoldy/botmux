import { afterEach, describe, expect, it, vi } from 'bun:test';

// Only the dashboard external host matters for URL shape; a getter lets each
// test flip it. formatUrlHost stays REAL so the IPv6-bracketing fix is exercised
// end-to-end through serviceUrls, not stubbed away.
let dashboardExternalHost = '10.0.12.34';
vi.mock('../src/config.js', () => ({
  config: {
    dashboard: {
      get externalHost() {
        return dashboardExternalHost;
      },
      port: 7891,
    },
  },
}));

import { serviceUrls, rewriteLoopbackServiceUrl } from '../src/core/plugins/service-manager.js';
import type { InstalledPluginRecord } from '../src/core/plugins/types.js';
import type { PluginServiceDefinition } from '../src/core/plugins/runtime.js';

function fakeRecord(): InstalledPluginRecord {
  return {
    id: 'demo-plugin',
    packageName: '@acme/demo-plugin',
    version: '1.0.0',
    source: { type: 'npm', spec: '@acme/demo-plugin@1.0.0' },
    manifest: { schemaVersion: 1, id: 'demo-plugin' },
    installedAt: '2026-07-29T00:00:00Z',
  } as InstalledPluginRecord;
}

describe('plugin serviceUrls IPv6-safe host', () => {
  afterEach(() => {
    dashboardExternalHost = '10.0.12.34';
  });

  // Class 1: default openUrl (no urls() defined) — the `http://${host}:${port}/`
  // exit that produced the invalid `http://::1:8080/` before the fix.
  it('default openUrl brackets an IPv6 external host into a valid URL', () => {
    dashboardExternalHost = '::1';
    const def: PluginServiceDefinition = { port: 8080, pm2: { script: 'server.js' } };
    const { openUrl } = serviceUrls(fakeRecord(), def);
    expect(openUrl).toBe('http://[::1]:8080/');
    expect(() => new URL(openUrl!)).not.toThrow();
  });

  it('default openUrl leaves IPv4 unchanged', () => {
    dashboardExternalHost = '10.0.12.34';
    const def: PluginServiceDefinition = { port: 8080, pm2: { script: 'server.js' } };
    expect(serviceUrls(fakeRecord(), def).openUrl).toBe('http://10.0.12.34:8080/');
  });

  // Class 2: custom urls() — the contract now hands a URL-ready host, so a plugin
  // interpolating it straight into a URL still gets a valid IPv6 URL.
  it('custom urls() receives a URL-ready (bracketed) IPv6 host', () => {
    dashboardExternalHost = '::1';
    let seenHost = '';
    const def: PluginServiceDefinition = {
      port: 8080,
      pm2: { script: 'server.js' },
      urls: ({ host, port }) => {
        seenHost = host;
        return { openUrl: `http://${host}:${port}/app`, healthUrl: `http://${host}:${port}/healthz` };
      },
    };
    const { openUrl, healthUrl } = serviceUrls(fakeRecord(), def);
    expect(seenHost).toBe('[::1]');
    expect(openUrl).toBe('http://[::1]:8080/app');
    expect(healthUrl).toBe('http://[::1]:8080/healthz');
    expect(() => new URL(openUrl!)).not.toThrow();
    expect(() => new URL(healthUrl!)).not.toThrow();
  });

  // Class 3: loopback rewrite — a plugin advertising a 127.0.0.1/localhost URL
  // gets its host rewritten to the external host, and the WHATWG hostname setter
  // must receive the bracketed IPv6 or it silently no-ops.
  it('rewrites a loopback URL to a bracketed IPv6 external host', () => {
    dashboardExternalHost = '::1';
    expect(rewriteLoopbackServiceUrl('http://127.0.0.1:8080/app')).toBe('http://[::1]:8080/app');
    expect(rewriteLoopbackServiceUrl('http://localhost:8080/app')).toBe('http://[::1]:8080/app');
  });

  it('rewrites a loopback URL to an IPv4 external host', () => {
    dashboardExternalHost = '192.168.31.88';
    expect(rewriteLoopbackServiceUrl('http://127.0.0.1:8080/app')).toBe('http://192.168.31.88:8080/app');
  });

  it('leaves a non-loopback URL untouched', () => {
    dashboardExternalHost = '::1';
    expect(rewriteLoopbackServiceUrl('http://example.com:8080/app')).toBe('http://example.com:8080/app');
  });
});
