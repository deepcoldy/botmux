import type { PersistentBackendTarget, SessionProbe } from '../adapters/backend/types.js';

export type SessionListWakeRequest = () => Promise<
  | { ok: true }
  | { ok: false; error: string }
>;

export type SessionListWakeResult =
  | { ok: true }
  | { ok: false; error: string; lastProbe?: SessionProbe };

export function canWakeDormantBackendForAttach(input: {
  isAdopt: boolean;
  probe: SessionProbe;
  realManagedSession: boolean;
  attachBackend?: 'tmux' | 'zmx';
  target?: PersistentBackendTarget;
}): boolean {
  return !input.isAdopt
    && input.probe === 'missing'
    && input.realManagedSession
    && !!input.attachBackend
    && !!input.target;
}

/**
 * Ask the owning daemon to materialize a dormant session, then wait until its
 * exact persistent backend target is attachable. The daemon request is the
 * concurrency fence; this helper only observes the backing target afterwards.
 */
export async function wakeDormantBackendForAttach(options: {
  target: PersistentBackendTarget;
  wake: SessionListWakeRequest;
  probe: (target: PersistentBackendTarget) => SessionProbe;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SessionListWakeResult> {
  const wake = await options.wake();
  if (!wake.ok) return wake;

  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 100);
  const attempts = Math.max(1, Math.ceil((options.timeoutMs ?? 15_000) / pollIntervalMs));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let lastProbe: SessionProbe = 'missing';

  for (let attempt = 0; attempt < attempts; attempt++) {
    lastProbe = options.probe(options.target);
    if (lastProbe === 'exists') return { ok: true };
    if (attempt + 1 < attempts) await sleep(pollIntervalMs);
  }

  return {
    ok: false,
    error: lastProbe === 'unknown'
      ? '后端已唤醒，但持久后端状态无法确认'
      : '后端已唤醒，但等待持久会话启动超时',
    lastProbe,
  };
}
