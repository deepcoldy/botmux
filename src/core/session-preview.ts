import { connect } from 'node:net';
import {
  isLiteralLoopbackHost,
  isTcpPort,
  type LiteralLoopbackHost,
} from './loopback-target.js';

export const PREVIEW_ROUTE_PREFIX = '/preview';
/**
 * Reserved path segment that introduces the sandboxed content stream:
 * `/preview/<sessionId>/__botmux_preview_content/<capability>/…`.
 *
 * It is a path segment rather than a query flag on purpose. The preview
 * document is served into an opaque-origin sandbox, so its own relative
 * subresources and WebSockets carry no dashboard cookie; a capability that
 * lives in the path is inherited by every relative URL the app resolves,
 * while a query flag would be dropped by the first `./app.js`.
 */
export const PREVIEW_CONTENT_SEGMENT = '__botmux_preview_content';
export const PREVIEW_PROBE_TIMEOUT_MS = 750;

/** DNS names are deliberately excluded: resolving even `localhost` would add a
 * rebinding/configuration surface to an SSRF boundary. */
export type PreviewLoopbackHost = LiteralLoopbackHost;

export interface SessionPreviewTarget {
  host: PreviewLoopbackHost;
  port: number;
  registeredAt: string;
}

export interface SessionPreviewDescriptor {
  path: string;
  registeredAt: string;
}

export function isPreviewPort(value: unknown): value is number {
  return isTcpPort(value);
}

export function isPreviewLoopbackHost(value: unknown): value is PreviewLoopbackHost {
  return isLiteralLoopbackHost(value);
}

/** Re-validate persisted/SSE data at every trust boundary. Invalid legacy or
 * attacker-shaped objects collapse to undefined and are never dialled. */
export function safeSessionPreviewTarget(value: unknown): SessionPreviewTarget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!isPreviewLoopbackHost(raw.host) || !isPreviewPort(raw.port)) return undefined;
  if (typeof raw.registeredAt !== 'string') {
    return undefined;
  }
  const registeredAt = new Date(raw.registeredAt);
  if (Number.isNaN(registeredAt.valueOf()) || registeredAt.toISOString() !== raw.registeredAt) {
    return undefined;
  }
  return {
    host: raw.host,
    port: raw.port,
    registeredAt: raw.registeredAt,
  };
}

export function sessionPreviewPath(sessionId: string): string {
  return `${PREVIEW_ROUTE_PREFIX}/${encodeURIComponent(sessionId)}/`;
}

/** Base path of the sandboxed content stream. Every relative URL the framed
 *  app resolves stays under it, which is how the capability survives without
 *  cookies or query strings. */
export function sessionPreviewContentPath(sessionId: string, capability: string): string {
  return `${sessionPreviewPath(sessionId)}${PREVIEW_CONTENT_SEGMENT}/${capability}/`;
}

export function sessionPreviewDescriptor(
  sessionId: string,
  value: unknown,
): SessionPreviewDescriptor | undefined {
  const target = safeSessionPreviewTarget(value);
  if (!target) return undefined;
  return {
    path: sessionPreviewPath(sessionId),
    registeredAt: target.registeredAt,
  };
}

function probeOne(host: PreviewLoopbackHost, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = connect({ host, port });
    socket.unref?.();
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Validate that a caller-selected port is reachable through a literal
 * loopback address. With no requested host, IPv4 is preferred and IPv6 is a
 * fallback so `botmux preview <port>` works for either bind family. */
export async function probeSessionPreviewTarget(input: {
  port: number;
  host?: PreviewLoopbackHost;
  timeoutMs?: number;
  now?: () => Date;
}): Promise<SessionPreviewTarget | undefined> {
  if (!isPreviewPort(input.port)) return undefined;
  const timeoutMs = input.timeoutMs ?? PREVIEW_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return undefined;
  const hosts: PreviewLoopbackHost[] = input.host ? [input.host] : ['127.0.0.1', '::1'];
  for (const host of hosts) {
    if (await probeOne(host, input.port, timeoutMs)) {
      return {
        host,
        port: input.port,
        registeredAt: (input.now?.() ?? new Date()).toISOString(),
      };
    }
  }
  return undefined;
}
