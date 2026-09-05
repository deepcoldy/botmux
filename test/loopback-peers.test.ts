import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockWarn = vi.fn();
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: (...a: any[]) => mockWarn(...a), error: vi.fn() },
}));

import {
  isLoopbackPeer,
  __resetLoopbackPeersCacheForTest,
} from '../src/utils/loopback-peers.js';

const ENV_KEY = 'BOTMUX_LOOPBACK_PEERS';
let savedEnv: string | undefined;

function setEnv(value: string | undefined): void {
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  __resetLoopbackPeersCacheForTest();
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  __resetLoopbackPeersCacheForTest();
  mockWarn.mockReset();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  __resetLoopbackPeersCacheForTest();
});

describe('isLoopbackPeer — defaults (no env)', () => {
  it('allows the legacy loopback literals', () => {
    expect(isLoopbackPeer('127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('::1')).toBe(true);
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects LAN and non-loopback addresses', () => {
    expect(isLoopbackPeer('192.168.1.5')).toBe(false);
    expect(isLoopbackPeer('10.0.0.1')).toBe(false);
    expect(isLoopbackPeer('172.16.0.1')).toBe(false);
    expect(isLoopbackPeer('fe80::1')).toBe(false);
    expect(isLoopbackPeer('2001:db8::1')).toBe(false);
  });

  it('rejects empty / undefined / unparseable input', () => {
    expect(isLoopbackPeer(undefined)).toBe(false);
    expect(isLoopbackPeer(null)).toBe(false);
    expect(isLoopbackPeer('')).toBe(false);
    expect(isLoopbackPeer('localhost')).toBe(false);
  });
});

describe('isLoopbackPeer — BOTMUX_LOOPBACK_PEERS IP literals', () => {
  it('allows an env-configured IPv4 while still rejecting other LAN IPs', () => {
    setEnv('10.0.0.5');
    expect(isLoopbackPeer('10.0.0.5')).toBe(true);
    expect(isLoopbackPeer('10.0.0.6')).toBe(false);
    expect(isLoopbackPeer('192.168.1.5')).toBe(false);
    // defaults still hold
    expect(isLoopbackPeer('127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
  });

  it('allows an env-configured IPv6 literal', () => {
    setEnv('fd00::1234');
    expect(isLoopbackPeer('fd00::1234')).toBe(true);
    expect(isLoopbackPeer('fd00::1235')).toBe(false);
  });

  it('tolerates whitespace around entries', () => {
    setEnv(' 10.0.0.5 , 192.168.1.10 ');
    expect(isLoopbackPeer('10.0.0.5')).toBe(true);
    expect(isLoopbackPeer('192.168.1.10')).toBe(true);
    expect(isLoopbackPeer('10.0.0.6')).toBe(false);
  });
});

describe('isLoopbackPeer — CIDR', () => {
  it('matches IPv4 CIDR in-segment and rejects out-of-segment', () => {
    setEnv('192.168.0.0/16');
    expect(isLoopbackPeer('192.168.1.5')).toBe(true);
    expect(isLoopbackPeer('192.168.255.254')).toBe(true);
    expect(isLoopbackPeer('192.169.1.1')).toBe(false);
    expect(isLoopbackPeer('10.0.0.1')).toBe(false);
  });

  it('normalizes host bits in an IPv4 CIDR entry', () => {
    setEnv('192.168.1.5/16');
    expect(isLoopbackPeer('192.168.2.3')).toBe(true);
  });

  it('matches IPv6 CIDR with bigint mask comparison', () => {
    setEnv('fd00::/8');
    expect(isLoopbackPeer('fd00::1')).toBe(true);
    expect(isLoopbackPeer('fdff::1')).toBe(true);
    expect(isLoopbackPeer('fe00::1')).toBe(false);
    expect(isLoopbackPeer('fe80::1')).toBe(false);
  });

  it('matches an IPv4-mapped IPv6 peer against an IPv4 CIDR entry', () => {
    setEnv('192.168.0.0/16');
    expect(isLoopbackPeer('::ffff:192.168.1.5')).toBe(true);
    expect(isLoopbackPeer('::ffff:10.0.0.1')).toBe(false);
  });

  it('matches an IPv4-mapped IPv6 env entry against the same peer', () => {
    setEnv('::ffff:192.168.1.1');
    expect(isLoopbackPeer('::ffff:192.168.1.1')).toBe(true);
    expect(isLoopbackPeer('::ffff:192.168.1.2')).toBe(false);
  });

  it('supports a /0 catch-all per family', () => {
    setEnv('0.0.0.0/0');
    expect(isLoopbackPeer('8.8.8.8')).toBe(true);
    expect(isLoopbackPeer('fd00::1')).toBe(false);
    setEnv('::/0');
    expect(isLoopbackPeer('fd00::1')).toBe(true);
    expect(isLoopbackPeer('8.8.8.8')).toBe(false);
  });
});

describe('isLoopbackPeer — invalid env items are ignored (fail-closed)', () => {
  it('ignores non-IP, out-of-range octets, and oversized prefixes without throwing', () => {
    expect(() => setEnv('not-an-ip,999.1.1.1/8,10.0.0.0/99')).not.toThrow();
    expect(isLoopbackPeer('10.0.0.1')).toBe(false);
    expect(isLoopbackPeer('999.1.1.1')).toBe(false);
    expect(isLoopbackPeer('127.0.0.1')).toBe(true);
    // each invalid item surfaced a warning, never an allow
    expect(mockWarn).toHaveBeenCalledTimes(3);
  });

  it('keeps valid entries alongside invalid ones', () => {
    setEnv('not-an-ip,10.0.0.5,garbage/24');
    expect(isLoopbackPeer('10.0.0.5')).toBe(true);
    expect(isLoopbackPeer('10.0.0.6')).toBe(false);
  });

  it('ignores IPv6 prefixes longer than 128', () => {
    expect(() => setEnv('fd00::/129')).not.toThrow();
    expect(isLoopbackPeer('fd00::1')).toBe(false);
  });

  it('treats an empty env as no extra entries', () => {
    setEnv('');
    expect(isLoopbackPeer('10.0.0.1')).toBe(false);
    expect(isLoopbackPeer('127.0.0.1')).toBe(true);
  });
});

describe('isLoopbackPeer — ::ffff:127.0.0.1 invariant', () => {
  it('is always allowed regardless of env', () => {
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
    setEnv('10.0.0.5');
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
    setEnv('not-an-ip');
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
  });
});
