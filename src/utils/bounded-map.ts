/**
 * A Map with a hard upper bound on entry count. When a new key would exceed
 * the cap, the oldest-inserted entry is evicted first (insertion-order ≈ LRU
 * for caches that re-`set` on refresh).
 *
 * Drop-in for `Map` — same get/set/delete/has API — so it can back caches that
 * are keyed by an unbounded dimension (per-chat, per-session) and would
 * otherwise grow for the whole process lifetime.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly maxEntries: number, entries?: Iterable<readonly [K, V]>) {
    super(entries);
    if (maxEntries <= 0) throw new Error('BoundedMap maxEntries must be > 0');
  }

  set(key: K, value: V): this {
    // Re-setting an existing key just updates it (no growth); only a genuinely
    // new key can push us over the cap.
    if (!this.has(key) && this.size >= this.maxEntries) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return super.set(key, value);
  }
}
