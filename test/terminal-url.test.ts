// test/terminal-url.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../src/config.js';
import { setTerminalProxyPort, resetTerminalProxy, buildTerminalUrl } from '../src/core/terminal-url.js';

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
