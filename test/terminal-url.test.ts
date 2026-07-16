// test/terminal-url.test.ts
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { config } from '../src/config.js';

vi.mock('../src/global-config.js', () => ({
  isRemoteAccessEnabled: vi.fn(() => false),
}));

// Partial mock: platformMachineBaseUrl is stubbed (no real platform.json on the
// test box should leak in), but publicReverseProxyBaseUrl stays REAL — the
// BOTMUX_PUBLIC_URL suite below drives it through process.env per test.
vi.mock('../src/platform/binding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/platform/binding.js')>();
  return {
    ...actual,
    platformMachineBaseUrl: vi.fn(() => null),
  };
});

import { isRemoteAccessEnabled } from '../src/global-config.js';
import { platformMachineBaseUrl } from '../src/platform/binding.js';

import {
  setTerminalProxyPort,
  setTerminalExternalPort,
  getTerminalAdvertisedPort,
  resetTerminalProxy,
  buildTerminalUrl,
} from '../src/core/terminal-url.js';

const ds = {
  session: { sessionId: 'sess-123' },
  workerPort: 9090,
  workerToken: 'wtok',
  workerViewToken: 'vtok',
};

// Keep the whole file hermetic w.r.t. BOTMUX_PUBLIC_URL, which buildTerminalUrl
// now reads live and may be set in the shell running the suite (in prod it IS).
// Clear it before every test so the default (local proxy/worker port) suites are
// deterministic; the public-url suite below opts in per test. Restore on exit.
const ORIGINAL_PUBLIC_URL = process.env.BOTMUX_PUBLIC_URL;
beforeEach(() => {
  delete process.env.BOTMUX_PUBLIC_URL;
});
afterAll(() => {
  if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.BOTMUX_PUBLIC_URL;
  else process.env.BOTMUX_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
});

describe('buildTerminalUrl', () => {
  beforeEach(() => {
    vi.mocked(isRemoteAccessEnabled).mockReturnValue(false);
    vi.mocked(platformMachineBaseUrl).mockReturnValue(null);
    setTerminalProxyPort(8801);
  });

  it('builds a read-only sub-path URL on the proxy port', () => {
    expect(buildTerminalUrl(ds)).toBe(`http://${config.web.externalHost}:8801/s/sess-123?viewToken=vtok`);
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
    expect(buildTerminalUrl(ds)).toBe(`http://${config.web.externalHost}:8899/s/sess-123?viewToken=vtok`);
  });
});

describe('buildTerminalUrl — platform remote access', () => {
  beforeEach(() => {
    setTerminalProxyPort(8801);
    vi.mocked(isRemoteAccessEnabled).mockReturnValue(true);
    vi.mocked(platformMachineBaseUrl).mockReturnValue('https://m-machine.botmux.example');
  });

  afterEach(() => {
    vi.mocked(isRemoteAccessEnabled).mockReturnValue(false);
    vi.mocked(platformMachineBaseUrl).mockReturnValue(null);
    resetTerminalProxy();
  });

  it('keeps public platform links read-only', () => {
    expect(buildTerminalUrl(ds)).toBe('https://m-machine.botmux.example/s/sess-123?viewToken=vtok');
  });

  it('preserves the private write token on platform links', () => {
    expect(buildTerminalUrl(ds, { write: true })).toBe(
      'https://m-machine.botmux.example/s/sess-123?token=wtok',
    );
  });
});

describe('buildTerminalUrl — WEB_EXTERNAL_PORT override', () => {
  beforeEach(() => setTerminalProxyPort(8801));
  afterEach(() => resetTerminalProxy());

  it('advertises the external port instead of the local proxy port', () => {
    setTerminalExternalPort(9000);
    expect(buildTerminalUrl(ds)).toBe(`http://${config.web.externalHost}:9000/s/sess-123?viewToken=vtok`);
  });

  it('keeps the external port when appending the write token', () => {
    setTerminalExternalPort(9000);
    expect(buildTerminalUrl(ds, { write: true })).toBe(
      `http://${config.web.externalHost}:9000/s/sess-123?token=wtok`,
    );
  });

  it('advertises the local proxy port when the external port is 0 (unset)', () => {
    setTerminalExternalPort(0);
    expect(buildTerminalUrl(ds)).toBe(`http://${config.web.externalHost}:8801/s/sess-123?viewToken=vtok`);
  });

  it('ignores the external port in direct fallback mode (per-session ports win)', () => {
    resetTerminalProxy();          // proxy never bound → direct worker ports
    setTerminalExternalPort(9000); // even with an external port configured...
    expect(buildTerminalUrl(ds)).toBe(`http://${config.web.externalHost}:9090?viewToken=vtok`); // ...the worker port is used
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

// Self-hosted reverse proxy (nginx etc.) in front of the dashboard, no central
// platform binding. Setting BOTMUX_PUBLIC_URL makes card terminal links route
// through the dashboard front door `<base>/s/<id>` — no per-bot proxy port, one
// domain for every bot. Token is kept (no platform SSO to gate write access).
describe('buildTerminalUrl — BOTMUX_PUBLIC_URL (self-hosted reverse proxy)', () => {
  beforeEach(() => setTerminalProxyPort(8801));
  afterEach(() => {
    resetTerminalProxy();
    delete process.env.BOTMUX_PUBLIC_URL;
  });

  it('routes read-only links through the front door with no port', () => {
    process.env.BOTMUX_PUBLIC_URL = 'https://botmux.example.com';
    expect(buildTerminalUrl(ds)).toBe('https://botmux.example.com/s/sess-123?viewToken=vtok');
  });

  it('keeps the write token on the front-door link (no platform SSO here)', () => {
    process.env.BOTMUX_PUBLIC_URL = 'https://botmux.example.com';
    expect(buildTerminalUrl(ds, { write: true })).toBe(
      'https://botmux.example.com/s/sess-123?token=wtok',
    );
  });

  it('trims a trailing slash on the configured base', () => {
    process.env.BOTMUX_PUBLIC_URL = 'https://botmux.example.com/';
    expect(buildTerminalUrl(ds)).toBe('https://botmux.example.com/s/sess-123?viewToken=vtok');
  });

  it('overrides the local proxy-port form when set', () => {
    process.env.BOTMUX_PUBLIC_URL = 'http://botmux.example.com';
    // even with a proxy port bound, the public base wins over host:8801
    expect(buildTerminalUrl(ds)).toBe('http://botmux.example.com/s/sess-123?viewToken=vtok');
  });

  it('falls back to the local proxy port when unset', () => {
    expect(buildTerminalUrl(ds)).toBe(`http://${config.web.externalHost}:8801/s/sess-123?viewToken=vtok`);
  });
});

describe('buildTerminalUrl — proxy unavailable fallback', () => {
  beforeEach(() => resetTerminalProxy());

  it('falls back to the direct worker port when the proxy never bound', () => {
    expect(buildTerminalUrl(ds)).toBe(`http://${config.web.externalHost}:9090?viewToken=vtok`);
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
