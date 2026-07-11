import type { IncomingHttpHeaders } from 'node:http';

export interface TerminalWriteAccess {
  hasWrite: boolean;
  platformReadonly: boolean;
}

/**
 * Resolve terminal write access from either platform identity or a private
 * capability link. The platform strips client-supplied role headers, while the
 * per-worker token is only exposed through explicitly writable links.
 */
export function resolveTerminalWriteAccess(
  role: IncomingHttpHeaders['x-botmux-role'],
  tokenMatches: boolean,
): TerminalWriteAccess {
  if (tokenMatches) return { hasWrite: true, platformReadonly: false };
  if (typeof role === 'string' && role) {
    const hasWrite = role === 'owner';
    return { hasWrite, platformReadonly: !hasWrite };
  }
  return { hasWrite: false, platformReadonly: false };
}
