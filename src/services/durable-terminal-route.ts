import { isIP } from 'node:net';
import type {
  DurableAuxiliaryStateRecord,
  DurableCoordinationStore,
  DurableJson,
} from './durable-coordination.js';

export const DURABLE_TERMINAL_ROUTE_VERSION = 1 as const;
export const DURABLE_TERMINAL_ROUTE_TTL_MS = 45_000;

export function durableTerminalRoutePort(
  env: Readonly<{
    BOTMUX_TERMINAL_ROUTE_PORT?: string;
    BOTMUX_DASHBOARD_PORT?: string;
  }>,
): number | undefined {
  const explicit = env.BOTMUX_TERMINAL_ROUTE_PORT?.trim();
  const raw = explicit || env.BOTMUX_DASHBOARD_PORT?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535
    ? value
    : undefined;
}

export interface DurableTerminalRoute {
  version: typeof DURABLE_TERMINAL_ROUTE_VERSION;
  type: 'botmux.terminal-route';
  larkAppId: string;
  sessionId: string;
  ownerInstanceId: string;
  host: string;
  port: number;
  expiresAt: number;
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${name} must contain bounded non-empty text`);
  }
  return normalized;
}

function port(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error('terminal route port must be a TCP port');
  }
  return Number(value);
}

export function durableTerminalRouteKey(larkAppId: string, sessionId: string): string {
  return `auxiliary::terminal-route::${boundedText(larkAppId, 'larkAppId', 256)}`
    + `::${boundedText(sessionId, 'sessionId', 256)}`;
}

export function durableTerminalRouteSessionKey(sessionId: string): string {
  return `auxiliary::terminal-route::session::${boundedText(sessionId, 'sessionId', 256)}`;
}

export function parseDurableTerminalRoute(
  value: unknown,
  expected?: { larkAppId?: string; sessionId?: string },
): DurableTerminalRoute {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('terminal route must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== DURABLE_TERMINAL_ROUTE_VERSION || raw.type !== 'botmux.terminal-route') {
    throw new Error('terminal route has an incompatible envelope');
  }
  const larkAppId = boundedText(raw.larkAppId, 'larkAppId', 256);
  const sessionId = boundedText(raw.sessionId, 'sessionId', 256);
  const ownerInstanceId = boundedText(raw.ownerInstanceId, 'ownerInstanceId', 256);
  const host = boundedText(raw.host, 'host', 128);
  if (isIP(host) === 0) throw new Error('terminal route host must be a literal IP address');
  const expiresAt = Number(raw.expiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    throw new Error('terminal route expiresAt must be a non-negative safe integer');
  }
  if (expected?.larkAppId && larkAppId !== expected.larkAppId) {
    throw new Error('terminal route application identity changed');
  }
  if (expected?.sessionId && sessionId !== expected.sessionId) {
    throw new Error('terminal route Session identity changed');
  }
  return {
    version: DURABLE_TERMINAL_ROUTE_VERSION,
    type: 'botmux.terminal-route',
    larkAppId,
    sessionId,
    ownerInstanceId,
    host,
    port: port(raw.port),
    expiresAt,
  };
}

export function liveDurableTerminalRoute(
  record: DurableAuxiliaryStateRecord | undefined,
  input: { larkAppId?: string; sessionId: string; now?: number; localInstanceId?: string },
): DurableTerminalRoute | undefined {
  if (!record) return undefined;
  let route: DurableTerminalRoute;
  try {
    route = parseDurableTerminalRoute(record.value, input);
  } catch {
    return undefined;
  }
  const now = input.now ?? Date.now();
  if (route.expiresAt <= now) return undefined;
  if (input.localInstanceId && route.ownerInstanceId === input.localInstanceId) return undefined;
  return route;
}

export function createDurableTerminalRouteRegistry(input: {
  store: DurableCoordinationStore;
  ownerId: string;
  now?: () => number;
  ttlMs?: number;
}) {
  const ownerId = boundedText(input.ownerId, 'ownerId', 256);
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? DURABLE_TERMINAL_ROUTE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 300_000) {
    throw new Error('terminal route ttlMs must be between 5000 and 300000');
  }

  return {
    async publish(routeInput: Omit<DurableTerminalRoute, 'version' | 'type' | 'expiresAt'>) {
      const route = parseDurableTerminalRoute({
        version: DURABLE_TERMINAL_ROUTE_VERSION,
        type: 'botmux.terminal-route',
        ...routeInput,
        expiresAt: now() + ttlMs,
      });
      const publishAtKey = async (key: string) => {
        const acquired = await input.store.acquireSessionLease({
          sessionKey: key,
          ownerId,
          leaseDurationMs: Math.min(ttlMs, 30_000),
        });
        if (acquired.kind !== 'acquired') return { kind: 'occupied' as const };
        try {
          const current = await input.store.readAuxiliaryState(key);
          const written = await input.store.writeAuxiliaryState({
            lease: acquired.lease,
            expectedRevision: current?.revision ?? null,
            value: route as unknown as DurableJson,
          });
          return written.kind === 'written'
            ? { kind: 'published' as const, route, record: written.record }
            : { kind: written.kind };
        } finally {
          await input.store.releaseSessionLease(acquired.lease).catch(() => undefined);
        }
      };
      const scoped = await publishAtKey(durableTerminalRouteKey(route.larkAppId, route.sessionId));
      const session = await publishAtKey(durableTerminalRouteSessionKey(route.sessionId));
      return session.kind === 'published' ? session : scoped;
    },
    async resolve(larkAppId: string, sessionId: string, localInstanceId?: string) {
      const bySession = await input.store.readAuxiliaryState(
        durableTerminalRouteSessionKey(sessionId),
      );
      const liveBySession = liveDurableTerminalRoute(bySession, {
        larkAppId,
        sessionId,
        now: now(),
        ...(localInstanceId ? { localInstanceId } : {}),
      });
      if (liveBySession) return liveBySession;
      const scoped = await input.store.readAuxiliaryState(
        durableTerminalRouteKey(larkAppId, sessionId),
      );
      return liveDurableTerminalRoute(scoped, {
        larkAppId,
        sessionId,
        now: now(),
        ...(localInstanceId ? { localInstanceId } : {}),
      });
    },
    async resolveSession(sessionId: string, localInstanceId?: string) {
      const record = await input.store.readAuxiliaryState(
        durableTerminalRouteSessionKey(sessionId),
      );
      return liveDurableTerminalRoute(record, {
        sessionId,
        now: now(),
        ...(localInstanceId ? { localInstanceId } : {}),
      });
    },
  };
}
