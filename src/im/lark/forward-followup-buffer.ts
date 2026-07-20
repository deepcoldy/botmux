export interface ForwardFollowupSeed<T> {
  larkAppId: string;
  chatId: string;
  senderOpenId: string;
  messageId: string;
  payload: T;
  flush: (payload: T) => void | Promise<void>;
}

export interface ForwardFollowupMatch {
  larkAppId: string;
  chatId: string;
  senderOpenId: string;
  rootId: string;
}

interface PendingForwardFollowup<T> {
  seed: ForwardFollowupSeed<T>;
  timer: ReturnType<typeof setTimeout>;
}

/** In-memory grace window for a forwarded topic's immediate clarification. */
export class ForwardFollowupBuffer<T> {
  private readonly pending = new Map<string, PendingForwardFollowup<T>>();

  constructor(
    private readonly waitMs: number,
    private readonly onFlushError: (error: unknown) => void = () => {},
  ) {}

  get size(): number {
    return this.pending.size;
  }

  hold(seed: ForwardFollowupSeed<T>, waitMs = this.waitMs): boolean {
    if (waitMs <= 0) return false;
    if (this.pending.has(seed.messageId)) return true;

    const timer = setTimeout(() => {
      const entry = this.pending.get(seed.messageId);
      if (!entry) return;
      this.pending.delete(seed.messageId);
      void Promise.resolve(entry.seed.flush(entry.seed.payload)).catch(this.onFlushError);
    }, waitMs);
    this.pending.set(seed.messageId, { seed, timer });
    return true;
  }

  take(match: ForwardFollowupMatch): ForwardFollowupSeed<T> | undefined {
    const entry = this.pending.get(match.rootId);
    if (!entry) return undefined;
    const { seed } = entry;
    if (
      seed.larkAppId !== match.larkAppId
      || seed.chatId !== match.chatId
      || seed.senderOpenId !== match.senderOpenId
    ) {
      return undefined;
    }

    clearTimeout(entry.timer);
    this.pending.delete(match.rootId);
    return seed;
  }

  clear(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }
}
