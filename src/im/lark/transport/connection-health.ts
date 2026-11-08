/** Unix milliseconds, sampled from the transport when the daemon publishes its heartbeat. */
export interface LarkConnectionHealth {
  state: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'disconnected';
  since: number;
  /** Attempts in this connection cycle, including the one that eventually succeeded. */
  attempts: number;
  /** Last actual inbound frame (event or pong), never a synthetic heartbeat. */
  lastInboundAt: number | null;
}

type ReadHealth = () => LarkConnectionHealth;
const providers = new Map<string, ReadHealth>();

export function registerLarkConnectionHealth(appId: string, read: ReadHealth): () => void {
  providers.set(appId, read);
  return () => {
    // A retired client may close after its replacement registered.
    if (providers.get(appId) === read) providers.delete(appId);
  };
}

export function getLarkConnectionHealth(appId: string): LarkConnectionHealth | undefined {
  return providers.get(appId)?.();
}

const states = new Set<LarkConnectionHealth['state']>([
  'connecting', 'connected', 'reconnecting', 'failed', 'disconnected',
]);

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
}

/** Older daemons omit this field, while API-only bots explicitly publish null. */
export function parseLarkConnectionHealth(value: unknown): LarkConnectionHealth | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || !value) return undefined;
  const { state, since, attempts, lastInboundAt } = value as Partial<LarkConnectionHealth>;
  if (!state || !states.has(state) || !isTimestamp(since)
      || typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0
      || (lastInboundAt !== null && !isTimestamp(lastInboundAt))) return undefined;
  return { state, since, attempts, lastInboundAt };
}
