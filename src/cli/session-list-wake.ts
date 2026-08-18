import type { PersistentBackendTarget, SessionProbe } from '../adapters/backend/types.js';
import { SESSION_WAKE_TIMEOUT_MS } from '../core/session-wake-deadline.js';

export interface SessionListWakeRequestContext {
  signal: AbortSignal;
  deadlineMs: number;
}

export type SessionListWakeRequest = (context: SessionListWakeRequestContext) => Promise<
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
  signal?: AbortSignal;
  now?: () => number;
}): Promise<SessionListWakeResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(0, options.timeoutMs ?? SESSION_WAKE_TIMEOUT_MS);
  const deadlineMs = now() + timeoutMs;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 100);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const controller = new AbortController();
  let deadlineExpired = false;
  let lastProbe: SessionProbe | undefined;
  const aborted = Symbol('aborted');
  const onCallerAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onCallerAbort();
  else options.signal?.addEventListener('abort', onCallerAbort, { once: true });

  const deadlineTimer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort(new Error('session wake deadline exceeded'));
  }, Math.max(0, deadlineMs - now()));
  deadlineTimer.unref?.();
  const abortPromise = new Promise<typeof aborted>(resolve => {
    if (controller.signal.aborted) resolve(aborted);
    else controller.signal.addEventListener('abort', () => resolve(aborted), { once: true });
  });
  const interrupted = (): SessionListWakeResult => ({
    ok: false,
    error: deadlineExpired || now() >= deadlineMs ? '恢复超时' : '恢复已取消',
    ...(lastProbe ? { lastProbe } : {}),
  });
  const probeTimeout = (): SessionListWakeResult => ({
    ok: false,
    error: lastProbe === 'unknown'
      ? '后端已唤醒，但持久后端状态无法确认'
      : '后端已唤醒，但等待持久会话启动超时',
    ...(lastProbe ? { lastProbe } : {}),
  });

  try {
    if (controller.signal.aborted) return interrupted();
    if (now() >= deadlineMs) {
      deadlineExpired = true;
      controller.abort(new Error('session wake deadline exceeded'));
      return interrupted();
    }
    const wake = await Promise.race([
      options.wake({ signal: controller.signal, deadlineMs }),
      abortPromise,
    ]);
    if (wake === aborted) return interrupted();
    if (now() >= deadlineMs) {
      deadlineExpired = true;
      controller.abort(new Error('session wake deadline exceeded'));
      return interrupted();
    }
    if (!wake.ok) return wake;

    for (;;) {
      if (controller.signal.aborted) return interrupted();
      if (now() >= deadlineMs) return probeTimeout();
      lastProbe = options.probe(options.target);
      if (lastProbe === 'exists') return { ok: true };

      const remainingMs = deadlineMs - now();
      if (remainingMs <= 0) return probeTimeout();
      const wait = await Promise.race([
        sleep(Math.min(pollIntervalMs, remainingMs)).then(() => 'slept' as const),
        abortPromise,
      ]);
      if (wait === aborted) return interrupted();
    }
  } catch (err) {
    if (controller.signal.aborted) return interrupted();
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}
