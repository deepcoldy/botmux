import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDaemonClientFor,
  resolveDashboardUrl,
} from '../src/daemon-internal-client-wrapper.js';

const DEFAULT_URL = 'http://127.0.0.1:7891';

/** Build a tmp dir + helper to write `.dashboard-port` contents into it. */
function setupTmp(): { portPath: string; writePort(raw: string): void; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-c3-'));
  const portPath = join(dir, '.dashboard-port');
  return {
    portPath,
    writePort(raw: string) { writeFileSync(portPath, raw, 'utf8'); },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** ─── resolveDashboardUrl — strict port parser ──────────────────────── */

describe('resolveDashboardUrl', () => {
  let tmp: ReturnType<typeof setupTmp>;
  beforeEach(() => { tmp = setupTmp(); });
  afterEach(() => { tmp.cleanup(); });

  it('valid port → http://127.0.0.1:<port>', () => {
    tmp.writePort('9000');
    expect(resolveDashboardUrl(tmp.portPath)).toBe('http://127.0.0.1:9000');
  });

  it('valid port with trailing whitespace → parsed correctly', () => {
    tmp.writePort('  9001  \n');
    expect(resolveDashboardUrl(tmp.portPath)).toBe('http://127.0.0.1:9001');
  });

  it('lowest valid port (1) accepted', () => {
    tmp.writePort('1');
    expect(resolveDashboardUrl(tmp.portPath)).toBe('http://127.0.0.1:1');
  });

  it('highest valid port (65535) accepted', () => {
    tmp.writePort('65535');
    expect(resolveDashboardUrl(tmp.portPath)).toBe('http://127.0.0.1:65535');
  });

  it('file missing → fallback 7891', () => {
    // Don't write the file — directory exists but file does not.
    expect(resolveDashboardUrl(tmp.portPath)).toBe(DEFAULT_URL);
  });

  it('file empty → fallback 7891', () => {
    tmp.writePort('');
    expect(resolveDashboardUrl(tmp.portPath)).toBe(DEFAULT_URL);
  });

  it('file whitespace-only → fallback 7891', () => {
    tmp.writePort('   \n');
    expect(resolveDashboardUrl(tmp.portPath)).toBe(DEFAULT_URL);
  });

  it("'abc' (non-numeric) → fallback 7891", () => {
    tmp.writePort('abc');
    expect(resolveDashboardUrl(tmp.portPath)).toBe(DEFAULT_URL);
  });

  it("'7891abc' (trailing garbage) → fallback 7891 (v4 B4 regression — NOT parsed as 7891)", () => {
    tmp.writePort('7891abc');
    expect(resolveDashboardUrl(tmp.portPath)).toBe(DEFAULT_URL);
  });

  it("'7891.5' (non-integer) → fallback 7891", () => {
    tmp.writePort('7891.5');
    expect(resolveDashboardUrl(tmp.portPath)).toBe(DEFAULT_URL);
  });

  it("'0' (below range) → fallback 7891", () => {
    tmp.writePort('0');
    expect(resolveDashboardUrl(tmp.portPath)).toBe(DEFAULT_URL);
  });

  it("'-1' (negative) → fallback 7891", () => {
    tmp.writePort('-1');
    expect(resolveDashboardUrl(tmp.portPath)).toBe(DEFAULT_URL);
  });

  it("'65536' (above range) → fallback 7891", () => {
    tmp.writePort('65536');
    expect(resolveDashboardUrl(tmp.portPath)).toBe(DEFAULT_URL);
  });

  it("'1e3' (scientific notation) accepted as 1000 — integer + in range", () => {
    // Number('1e3') === 1000 and 1000 satisfies isInteger + range check, so
    // the strict parser accepts it. This is intentional: scientific notation
    // that produces a valid in-range integer port is a non-pathological input.
    tmp.writePort('1e3');
    expect(resolveDashboardUrl(tmp.portPath)).toBe('http://127.0.0.1:1000');
  });

  it("'NaN' literal → fallback 7891", () => {
    tmp.writePort('NaN');
    expect(resolveDashboardUrl(tmp.portPath)).toBe(DEFAULT_URL);
  });

  it("'Infinity' → fallback 7891", () => {
    tmp.writePort('Infinity');
    expect(resolveDashboardUrl(tmp.portPath)).toBe(DEFAULT_URL);
  });
});

/** ─── createDaemonClientFor — no cache + appId propagation ──────────── */

describe('createDaemonClientFor', () => {
  let tmp: ReturnType<typeof setupTmp>;
  beforeEach(() => { tmp = setupTmp(); tmp.writePort('9000'); });
  afterEach(() => { tmp.cleanup(); });

  it('returns a DaemonClient (truthy, has .request)', () => {
    const fakeClient = { request: vi.fn() };
    const createClient = vi.fn(() => fakeClient as any);
    const c = createDaemonClientFor('cli_a', { portPath: tmp.portPath, createClient });
    expect(c).toBe(fakeClient);
    expect(typeof c.request).toBe('function');
  });

  it('calls createDaemonClient with the resolved URL and the caller-supplied appId', () => {
    const createClient = vi.fn(() => ({ request: vi.fn() } as any));
    createDaemonClientFor('cli_codex', { portPath: tmp.portPath, createClient });
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith({
      dashboardUrl: 'http://127.0.0.1:9000',
      appId: 'cli_codex',
    });
  });

  it('does NOT cache: 3 calls produce 3 createDaemonClient invocations (v3 B6)', () => {
    const createClient = vi.fn(() => ({ request: vi.fn() } as any));
    createDaemonClientFor('cli_a', { portPath: tmp.portPath, createClient });
    createDaemonClientFor('cli_a', { portPath: tmp.portPath, createClient });
    createDaemonClientFor('cli_a', { portPath: tmp.portPath, createClient });
    expect(createClient).toHaveBeenCalledTimes(3);
  });

  it('different larkAppIds → different appId header values', () => {
    const createClient = vi.fn(() => ({ request: vi.fn() } as any));
    createDaemonClientFor('cli_alpha', { portPath: tmp.portPath, createClient });
    createDaemonClientFor('cli_beta', { portPath: tmp.portPath, createClient });
    expect((createClient.mock.calls[0]![0] as any).appId).toBe('cli_alpha');
    expect((createClient.mock.calls[1]![0] as any).appId).toBe('cli_beta');
  });

  it('picks up the LATEST port on each call (stale-port avoidance)', () => {
    const createClient = vi.fn(() => ({ request: vi.fn() } as any));
    tmp.writePort('9000');
    createDaemonClientFor('cli_a', { portPath: tmp.portPath, createClient });
    // Simulate dashboard restart on a new port.
    tmp.writePort('9001');
    createDaemonClientFor('cli_a', { portPath: tmp.portPath, createClient });
    expect((createClient.mock.calls[0]![0] as any).dashboardUrl).toBe('http://127.0.0.1:9000');
    expect((createClient.mock.calls[1]![0] as any).dashboardUrl).toBe('http://127.0.0.1:9001');
  });

  it('port file disappearance between calls → falls back to 7891 on the second call', () => {
    const createClient = vi.fn(() => ({ request: vi.fn() } as any));
    tmp.writePort('9000');
    createDaemonClientFor('cli_a', { portPath: tmp.portPath, createClient });
    tmp.cleanup();
    tmp = setupTmp(); // fresh empty tmpdir; portPath now points to nothing
    createDaemonClientFor('cli_a', { portPath: tmp.portPath, createClient });
    expect((createClient.mock.calls[0]![0] as any).dashboardUrl).toBe('http://127.0.0.1:9000');
    expect((createClient.mock.calls[1]![0] as any).dashboardUrl).toBe('http://127.0.0.1:7891');
  });
});
