import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { isIP } from 'node:net';

/** Literal-only loopback target primitives shared by the terminal and session
 * preview reverse proxies. Keeping DNS names out of this module makes it
 * impossible for either proxy to grow a DNS-rebinding SSRF path accidentally. */
export type LiteralLoopbackHost = '127.0.0.1' | '::1';

export function isLiteralLoopbackHost(value: unknown): value is LiteralLoopbackHost {
  return value === '127.0.0.1' || value === '::1';
}

export function isTcpPort(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= 65_535;
}

/** Runtime-checked HTTP/WS handshake dial. Callers cannot override host/port
 * through RequestOptions because the validated values are written last. */
export function requestLiteralLoopback(
  target: { host: LiteralLoopbackHost; port: number },
  options: Omit<RequestOptions, 'host' | 'hostname' | 'port'>,
  callback?: (response: IncomingMessage) => void,
): ClientRequest {
  if (!isLiteralLoopbackHost(target.host)) throw new Error('remote_host_forbidden');
  if (!isTcpPort(target.port)) throw new Error('invalid_port');
  return httpRequest({ ...options, host: target.host, port: target.port }, callback);
}

/** Runtime-checked HTTP/WS dial for a control-plane-discovered peer Pod.
 * Hostnames stay forbidden so a poisoned shared route can never become a DNS
 * rebinding SSRF primitive. Callers must additionally authenticate/fence the
 * route record before it reaches this boundary. */
export function requestLiteralIp(
  target: { host: string; port: number },
  options: Omit<RequestOptions, 'host' | 'hostname' | 'port'>,
  callback?: (response: IncomingMessage) => void,
): ClientRequest {
  if (isIP(target.host) === 0) throw new Error('non_literal_ip_forbidden');
  if (!isTcpPort(target.port)) throw new Error('invalid_port');
  return httpRequest({ ...options, host: target.host, port: target.port }, callback);
}
