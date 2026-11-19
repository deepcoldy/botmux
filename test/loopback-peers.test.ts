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

  it('rejects overly broad CIDR prefixes (/0 through /7) as fail-closed items', () => {
    // /0 matches the whole internet — the local-only guarantee would be gone.
    setEnv('0.0.0.0/0');
    expect(isLoopbackPeer('8.8.8.8')).toBe(false);
    expect(isLoopbackPeer('1.2.3.4')).toBe(false);
    expect(mockWarn).toHaveBeenCalledTimes(1);

    mockWarn.mockReset();
    setEnv('::/0');
    expect(isLoopbackPeer('fd00::1')).toBe(false);
    expect(isLoopbackPeer('2001:db8::1')).toBe(false);
    expect(mockWarn).toHaveBeenCalledTimes(1);

    // anything between /1 and /7 is rejected on either family as well
    mockWarn.mockReset();
    setEnv('128.0.0.0/1,2.0.0.0/7,fe00::/7');
    expect(isLoopbackPeer('8.8.8.8')).toBe(false);
    expect(isLoopbackPeer('2.4.0.1')).toBe(false);
    expect(isLoopbackPeer('fe80::1')).toBe(false);
    expect(mockWarn).toHaveBeenCalledTimes(3);

    // defaults never change when bad entries are skipped
    expect(isLoopbackPeer('127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('::1')).toBe(true);
  });

  it('accepts the /8 boundary block on either family', () => {
    setEnv('10.0.0.0/8');
    expect(isLoopbackPeer('10.1.2.3')).toBe(true);
    expect(isLoopbackPeer('11.1.2.3')).toBe(false);
    setEnv('fd00::/8');
    expect(isLoopbackPeer('fd00::1')).toBe(true);
    expect(isLoopbackPeer('fe00::1')).toBe(false);
  });

  it('skips an overly broad item but keeps sibling entries valid', () => {
    setEnv('0.0.0.0/0,10.0.0.5');
    expect(isLoopbackPeer('8.8.8.8')).toBe(false);
    expect(isLoopbackPeer('10.0.0.5')).toBe(true);
    expect(isLoopbackPeer('10.0.0.6')).toBe(false);
  });

  it('rejects IPv6 blocks that re-open the whole IPv4 space via mapped form (dual-stack reports ::ffff:a.b.c.d)', () => {
    // Dual-stack Node reports an IPv4 peer as ::ffff:8.8.8.8, so an IPv6 entry
    // covering ::ffff:0:0/96 is a v4 /0 in disguise and must not slip past the
    // width floor that only checked the native spelling.
    for (const bad of ['::/0', '::/8', '::/64', '::/80', '::ffff:0:0/96', '::ffff:0:0/100', '::ffff:0:0/103']) {
      setEnv(bad);
      expect(isLoopbackPeer('::ffff:8.8.8.8')).toBe(false);
      expect(isLoopbackPeer('8.8.8.8')).toBe(false);
    }
  });

  it('accepts IPv6-mapped entries at the v4-equivalent /8 boundary', () => {
    // ::ffff:10.0.0.0/104 is 10.0.0.0/8; the peer arrives in mapped form.
    setEnv('::ffff:10.0.0.0/104');
    expect(isLoopbackPeer('::ffff:10.1.2.3')).toBe(true);
    expect(isLoopbackPeer('::ffff:11.1.2.3')).toBe(false);
    // one step wider than /104 (v4 /7) is rejected
    setEnv('::ffff:10.0.0.0/103');
    expect(isLoopbackPeer('::ffff:10.1.2.3')).toBe(false);
    // a normal /112 mapped block (v4 /16) works
    setEnv('::ffff:192.168.0.0/112');
    expect(isLoopbackPeer('::ffff:192.168.5.5')).toBe(true);
    expect(isLoopbackPeer('::ffff:10.0.0.1')).toBe(false);
    // a mapped single-host literal is a v4 /32 and stays valid
    setEnv('::ffff:192.168.1.1');
    expect(isLoopbackPeer('::ffff:192.168.1.1')).toBe(true);
    expect(isLoopbackPeer('::ffff:192.168.1.2')).toBe(false);
  });

  it('still permits ordinary broad-but-bounded IPv6 blocks that do not touch mapped v4', () => {
    setEnv('fd00::/8,2001:db8::/32');
    expect(isLoopbackPeer('fd00::1')).toBe(true);
    expect(isLoopbackPeer('2001:db8::1')).toBe(true);
    expect(isLoopbackPeer('::ffff:8.8.8.8')).toBe(false);
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
