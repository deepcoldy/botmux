/** Synthetic native gen_metadata protobuf, model-only (no token metrics). */
export function antigravityModelMetadata(model: string, opts: { displayName?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } = {}): Buffer {
  const varint = (n: number): number[] => {
    const bytes: number[] = [];
    do { bytes.push((n & 0x7f) | (n > 127 ? 0x80 : 0)); n = Math.floor(n / 128); } while (n);
    return bytes;
  };
  const bytes = (field: number, value: Buffer) => Buffer.concat([Buffer.from([...varint((field << 3) | 2), ...varint(value.length)]), value]);
  const parts = [bytes(19, Buffer.from(model))];
  if (opts.displayName !== undefined) parts.push(bytes(21, Buffer.from(opts.displayName)));
  if (opts.inputTokens !== undefined || opts.outputTokens !== undefined || opts.cacheReadTokens !== undefined) {
    parts.push(bytes(4, Buffer.from([
      0x10, ...varint(opts.inputTokens ?? 0), 0x18, ...varint(opts.outputTokens ?? 0), 0x28, ...varint(opts.cacheReadTokens ?? 0),
    ])));
  }
  const generation = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x0a, ...varint(generation.length)]), generation]);
}
