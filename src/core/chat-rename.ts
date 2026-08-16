export const CHAT_NAME_MAX_CODE_POINTS = 100;
export const CHAT_RENAME_COOLDOWN_MS = 10 * 60_000;

export function normalizeLarkChatName(input: unknown):
  | { ok: true; name: string }
  | { ok: false; error: 'invalid_chat_name' } {
  if (typeof input !== 'string') return { ok: false, error: 'invalid_chat_name' };
  const name = input.trim();
  if (
    !name
    || Array.from(name).length > CHAT_NAME_MAX_CODE_POINTS
    || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/u.test(name)
  ) {
    return { ok: false, error: 'invalid_chat_name' };
  }
  return { ok: true, name };
}

export class ChatRenameCooldown {
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly cooldownMs = CHAT_RENAME_COOLDOWN_MS) {}

  check(key: string, now = Date.now()):
    | { ok: true }
    | { ok: false; retryAfterSeconds: number } {
    const last = this.lastAt.get(key) ?? 0;
    if (now - last >= this.cooldownMs) return { ok: true };
    return {
      ok: false,
      retryAfterSeconds: Math.ceil((this.cooldownMs - (now - last)) / 1000),
    };
  }

  record(key: string, now = Date.now()): void {
    this.lastAt.set(key, now);
  }
}

/** Serializes the read → cooldown → write transaction for one bot/chat key. */
export class ChatRenameSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
