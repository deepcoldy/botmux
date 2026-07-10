export class NumericRingSeries {
  private readonly timestamps: Float64Array;
  private readonly values = new Map<string, Float64Array>();
  private next = 0;
  private count = 0;

  constructor(private readonly capacity: number, private readonly metricNames: readonly string[]) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('NumericRingSeries capacity must be a positive integer');
    }
    this.timestamps = new Float64Array(capacity);
    for (const name of metricNames) {
      this.values.set(name, new Float64Array(capacity));
    }
  }

  push(timestamp: number, metrics: Record<string, number | undefined>): void {
    this.timestamps[this.next] = timestamp;
    for (const name of this.metricNames) {
      const arr = this.values.get(name);
      if (!arr) continue;
      const value = metrics[name];
      arr[this.next] = Number.isFinite(value) ? Number(value) : 0;
    }
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  pushSparse(timestamp: number, metrics: Record<string, number | undefined>): void {
    this.timestamps[this.next] = timestamp;
    for (const name of this.metricNames) {
      const arr = this.values.get(name);
      if (!arr) continue;
      const value = metrics[name];
      arr[this.next] = Number.isFinite(value) ? Number(value) : Number.NaN;
    }
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  toJSON(sinceMs?: number): { timestamps: number[] } & Record<string, number[]> {
    const indices: number[] = [];
    for (let offset = 0; offset < this.count; offset++) {
      const idx = (this.next - this.count + offset + this.capacity) % this.capacity;
      if (sinceMs !== undefined && this.timestamps[idx] < sinceMs) continue;
      indices.push(idx);
    }

    const out: { timestamps: number[] } & Record<string, number[]> = {
      timestamps: indices.map(idx => this.timestamps[idx]),
    };
    for (const name of this.metricNames) {
      const arr = this.values.get(name);
      out[name] = arr ? indices.map(idx => arr[idx]).filter(Number.isFinite) : [];
    }
    return out;
  }
}
