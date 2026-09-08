/**
 * Loopback peer predicate for internal HMAC-authenticated HTTP endpoints.
 *
 * Historically three call sites each inlined the same strict literal check
 * (`127.0.0.1` / `::1` / `::ffff:127.0.0.1`). On hosts with a customized
 * network stack the kernel can report a loopback TCP peer's address as a LAN
 * IP, which made every internal HMAC request fail with 401. This module keeps
 * the exact same default allow-list and adds an opt-in env extension:
 *
 *   BOTMUX_LOOPBACK_PEERS=10.0.0.5,192.168.0.0/16,fd00::/8
 *
 * Comma-separated IPv4/IPv6 literals or CIDRs. Invalid items are ignored
 * (fail-closed: never throw, never allow) and logged once at parse time.
 *
 * The parsed env is cached for the process lifetime — daemon env is immutable
 * after boot; tests reset the cache via __resetLoopbackPeersCacheForTest().
 */

import { logger } from './logger.js';

/** Default loopback literals — semantics identical to the legacy inline checks. */
function isDefaultLoopback(addr: string): boolean {
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    // covers ::ffff:127.0.0.1 (IPv4-mapped loopback); kept as a suffix check
    // for byte-for-byte compatibility with the previous three call sites.
    addr.endsWith('::ffff:127.0.0.1')
  );
}

interface ParsedIp {
  version: 4 | 6;
  /** 32-bit value for IPv4, 128-bit value for IPv6. */
  value: bigint;
  /** Embedded IPv4 for IPv4-mapped IPv6 (::ffff:a.b.c.d), else undefined. */
  mappedV4?: bigint;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4Octets(addr: string): number[] | null {
  const m = IPV4_RE.exec(addr);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((o) => o > 255)) return null;
  return octets;
}

function ipv4OctetsToBigInt(octets: number[]): bigint {
  return (
    (BigInt(octets[0]) << 24n) |
    (BigInt(octets[1]) << 16n) |
    (BigInt(octets[2]) << 8n) |
    BigInt(octets[3])
  );
}

const IPV6_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;

/**
 * Parse an IPv6 literal, including the dotted-quad tail form
 * (`::ffff:192.168.1.1`). Returns null on any malformed input.
 */
function parseIpv6(addr: string): ParsedIp | null {
  // Strip a zone index (fe80::1%eth0) — socket peer addresses never carry
  // one, but be lenient with hand-written env entries.
  const zoneIdx = addr.indexOf('%');
  let body = zoneIdx >= 0 ? addr.slice(0, zoneIdx) : addr;
  if (body === '') return null;

  // Dotted-quad tail occupies the final 32 bits (2 groups). Rewrite it as two
  // hex groups up front so the ellipsis logic below only deals with pure IPv6.
  const lastColon = body.lastIndexOf(':');
  if (lastColon >= 0) {
    const tail = body.slice(lastColon + 1);
    if (tail.includes('.')) {
      const octets = parseIpv4Octets(tail);
      if (octets === null) return null;
      const hi = ((octets[0] << 8) | octets[1]).toString(16);
      const lo = ((octets[2] << 8) | octets[3]).toString(16);
      body = `${body.slice(0, lastColon + 1)}${hi}:${lo}`;
    }
  }

  const halves = body.split('::');
  if (halves.length > 2) return null;

  let groups: string[];
  if (halves.length === 2) {
    const head = halves[0] === '' ? [] : halves[0].split(':');
    const tailGroups = halves[1] === '' ? [] : halves[1].split(':');
    const missing = 8 - head.length - tailGroups.length;
    if (missing < 1) return null; // '::' must compress at least one group
    groups = [...head, ...Array<string>(missing).fill('0'), ...tailGroups];
  } else {
    // No ellipsis: exactly 8 groups, no padding.
    groups = body.split(':');
    if (groups.length !== 8) return null;
  }
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const g of groups) {
    if (!IPV6_GROUP_RE.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }

  // IPv4-mapped (::ffff:a.b.c.d): top 80 bits zero, next 16 bits 0xffff.
  // Parenthesize explicitly — `&` binds looser than `===` in JS.
  const mappedV4 =
    (value >> 48n) === 0n && ((value >> 32n) & 0xffffn) === 0xffffn
      ? value & 0xffffffffn
      : undefined;

  return { version: 6, value, mappedV4 };
}

function parseIp(addr: string): ParsedIp | null {
  const trimmed = addr.trim();
  if (!trimmed) return null;
  if (trimmed.includes(':')) return parseIpv6(trimmed);
  const octets = parseIpv4Octets(trimmed);
  if (octets === null) return null;
  return { version: 4, value: ipv4OctetsToBigInt(octets) };
}

interface CidrEntry {
  version: 4 | 6;
  network: bigint;
  mask: bigint;
}

function prefixMask(bits: number, prefix: number): bigint {
  if (prefix === 0) return 0n;
  if (prefix >= bits) return (1n << BigInt(bits)) - 1n;
  return ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n);
}

/** Parse one env item (IP literal or CIDR). Returns null for invalid items. */
function parseEntry(raw: string): CidrEntry | null {
  const item = raw.trim();
  if (!item) return null;
  const slash = item.indexOf('/');
  if (slash < 0) {
    const ip = parseIp(item);
    if (ip === null) return null;
    const bits = ip.version === 4 ? 32 : 128;
    return { version: ip.version, network: ip.value, mask: prefixMask(bits, bits) };
  }
  const ipPart = item.slice(0, slash).trim();
  const prefixPart = item.slice(slash + 1).trim();
  if (!/^\d+$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  const ip = parseIp(ipPart);
  if (ip === null) return null;
  const bits = ip.version === 4 ? 32 : 128;
  if (prefix > bits) return null;
  const mask = prefixMask(bits, prefix);
  // Normalize host bits away so e.g. 192.168.1.5/16 behaves like 192.168.0.0/16.
  return { version: ip.version, network: ip.value & mask, mask };
}

let cachedEntries: CidrEntry[] | null = null;

function getEntries(): CidrEntry[] {
  if (cachedEntries === null) {
    cachedEntries = parseEnv(process.env.BOTMUX_LOOPBACK_PEERS);
  }
  return cachedEntries;
}

function parseEnv(raw: string | undefined): CidrEntry[] {
  if (!raw) return [];
  const entries: CidrEntry[] = [];
  for (const part of raw.split(',')) {
    const entry = parseEntry(part);
    if (entry === null) {
      // Fail-closed: skip the item, but surface the typo once at startup.
      logger.warn(
        `[loopback-peers] ignoring invalid BOTMUX_LOOPBACK_PEERS item: ${JSON.stringify(part)}`,
      );
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

function entryMatches(entry: CidrEntry, ip: ParsedIp): boolean {
  if (entry.version === 4) {
    // An IPv4 env entry matches a native IPv4 peer and an IPv4-mapped IPv6
    // peer (::ffff:192.168.1.1 counts as 192.168.1.1) — a custom kernel may
    // report either family for the same loopback connection.
    const v4 = ip.version === 4 ? ip.value : ip.mappedV4;
    if (v4 === undefined) return false;
    return (v4 & entry.mask) === entry.network;
  }
  // IPv6 env entries compare full 128-bit values; a native IPv4 peer never
  // matches an IPv6 entry (write an IPv4 entry for those).
  if (ip.version !== 6) return false;
  return (ip.value & entry.mask) === entry.network;
}

/**
 * Whether a socket peer address counts as loopback for internal HMAC auth.
 *
 * Default semantics (unchanged): `127.0.0.1`, `::1`, and any address ending
 * with `::ffff:127.0.0.1`. Additional peers come from BOTMUX_LOOPBACK_PEERS.
 * Empty/undefined/unparseable addresses are rejected.
 */
export function isLoopbackPeer(addr: string | undefined | null): boolean {
  if (!addr) return false;
  if (isDefaultLoopback(addr)) return true;
  const ip = parseIp(addr);
  if (ip === null) return false;
  return getEntries().some((e) => entryMatches(e, ip));
}

/** Test-only: drop the cached env parse so the next call re-reads the env. */
export function __resetLoopbackPeersCacheForTest(): void {
  cachedEntries = null;
}
