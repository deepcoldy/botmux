// test/terminal-url.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { config } from '../src/config.js';
import {
  setTerminalProxyPort,
  setTerminalExternalPort,
  getTerminalAdvertisedPort,
  resetTerminalProxy,
  buildTerminalUrl,
} from '../src/core/terminal-url.js';

const ds = { session: { sessionId: 'sess-123' }, workerPort: 9090, workerToken: 'wtok' };

describe('buildTerminalUrl', () => {
  beforeEach(() => setTerminalProxyPort(8801));

  it('builds a read-only sub-path URL on the proxy port', () => {
    expect(buildTerminalUrl(ds)).toBe(`http://${config.web.externalHost}:8801/s/sess-123`);
  });

  it('appends the worker token for write access', () => {
    expect(buildTerminalUrl(ds, { write: true })).toBe(
      `http://${config.web.externalHost}:8801/s/sess-123?token=wtok`,
    );
  });

  it('falls back to read-only URL when no worker token exists', () => {
    expect(buildTerminalUrl({ session: { sessionId: 's2' }, workerToken: null }, { write: true })).toBe(
      `http://${config.web.externalHost}:8801/s/s2`,
    );
  });

  it('reflects an updated proxy port', () => {
    setTerminalProxyPort(8899);
    expect(buildTerminalUrl(ds)).toBe(`http://${config.web.externalHost}:8899/s/sess-123`);
  });
});

describe('buildTerminalUrl — WEB_EXTERNAL_PORT override', () => {
  beforeEach(() => setTerminalProxyPort(8801));
  afterEach(() => resetTerminalProxy());

  it('advertises the external port instead of the local proxy port', () => {
    setTerminalExternalPort(9000);
    expect(buildTerminalUrl(ds)).toBe(`http://${config.web.externalHost}:9000/s/sess-123`);
  });

  it('keeps the external port when appending the write token', () => {
    setTerminalExternalPort(9000);
    expect(buildTerminalUrl(ds, { write: true })).toBe(
      `http://${config.web.externalHost}:9000/s/sess-123?token=wtok`,
    );
  });

  it('advertises the local proxy port when the external port is 0 (unset)', () => {
    setTerminalExternalPort(0);
    expect(buildTerminalUrl(ds)).toBe(`http://${config.web.externalHost}:8801/s/sess-123`);
  });

  it('ignores the external port in direct fallback mode (per-session ports win)', () => {
    resetTerminalProxy();          // proxy never bound → direct worker ports
    setTerminalExternalPort(9000); // even with an external port configured...
    expect(buildTerminalUrl(ds)).toBe(`http://${config.web.externalHost}:9090`); // ...the worker port is used
  });
});

// The dashboard builds its own terminal link (dashboard-rows → sessions.ts
// terminalHref) from the advertised port, NOT buildTerminalUrl — so the shared
// getter must agree with the card links or the dashboard "open terminal" entry
// points at the wrong port (e.g. local 8800 while the relay only listens on 9000).
describe('getTerminalAdvertisedPort — shared port for card + dashboard links', () => {
  beforeEach(() => setTerminalProxyPort(8801));
  afterEach(() => resetTerminalProxy());

  it('returns the external port when WEB_EXTERNAL_PORT is configured', () => {
    setTerminalExternalPort(9000);
    expect(getTerminalAdvertisedPort()).toBe(9000);
  });

  it('returns the bound proxy port when no external port is set', () => {
    expect(getTerminalAdvertisedPort()).toBe(8801);
  });

  it('returns 0 when the proxy never bound, even with an external port set', () => {
    resetTerminalProxy();
    setTerminalExternalPort(9000);
    expect(getTerminalAdvertisedPort()).toBe(0);
  });
});

describe('buildTerminalUrl — proxy unavailable fallback', () => {
  beforeEach(() => resetTerminalProxy());

  it('falls back to the direct worker port when the proxy never bound', () => {
    expect(buildTerminalUrl(ds)).toBe(`http://${config.web.externalHost}:9090`);
  });

  it('falls back with the write token appended', () => {
    expect(buildTerminalUrl(ds, { write: true })).toBe(
      `http://${config.web.externalHost}:9090?token=wtok`,
    );
  });

  it('uses the persisted session.webPort when the worker port is null', () => {
    const restored = { session: { sessionId: 's3', webPort: 7070 }, workerPort: null, workerToken: null };
    expect(buildTerminalUrl(restored)).toBe(`http://${config.web.externalHost}:7070`);
  });
});
