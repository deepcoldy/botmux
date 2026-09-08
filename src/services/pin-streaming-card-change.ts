import { logger } from '../utils/logger.js';

export type PinStreamingCardChangeHandler =
  (
    larkAppId: string,
    enabled: boolean,
    chatId?: string,
    chatEnabled?: boolean,
  ) => void | PromiseLike<void>;

let currentHandler: PinStreamingCardChangeHandler | null = null;
const configChangeQueues = new Map<string, Promise<void>>();

export function registerPinStreamingCardChangeHandler(
  handler: PinStreamingCardChangeHandler,
): () => void {
  currentHandler = handler;
  return () => {
    if (currentHandler === handler) currentHandler = null;
  };
}

/**
 * Serialize pinStreamingCard config mutations per bot across every write entry
 * point. The queue covers the whole write -> live-sync -> notify scheduling
 * critical section, but does not wait for the asynchronous reconciliation work
 * behind the notification handler itself.
 */
export async function serializePinStreamingCardConfigChange<T>(
  larkAppId: string,
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  const previous = configChangeQueues.get(larkAppId) ?? Promise.resolve();
  const ready = previous.catch(() => undefined);
  let release!: () => void;
  const tail = ready.then(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  configChangeQueues.set(larkAppId, tail);
  void tail.finally(() => {
    if (configChangeQueues.get(larkAppId) === tail) configChangeQueues.delete(larkAppId);
  });

  await ready;
  try {
    return await operation();
  } finally {
    release();
  }
}

export function notifyPinStreamingCardChanged(
  larkAppId: string,
  enabled: boolean,
  chatId?: string,
  chatEnabled?: boolean,
): void {
  if (!currentHandler) return;
  const invoke = () => (
    chatId === undefined && chatEnabled === undefined
      ? currentHandler!(larkAppId, enabled)
      : currentHandler!(larkAppId, enabled, chatId, chatEnabled)
  );
  try {
    Promise.resolve(invoke()).catch((error) => {
      logger.warn(
        `[pin-streaming-card] pinStreamingCard change handler failed `
        + `app=${larkAppId} enabled=${enabled} chat=${chatId ?? '-'} chatEnabled=${chatEnabled ?? '-'}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    });
  } catch (error) {
    logger.warn(
      `[pin-streaming-card] pinStreamingCard change handler failed `
      + `app=${larkAppId} enabled=${enabled} chat=${chatId ?? '-'} chatEnabled=${chatEnabled ?? '-'}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
