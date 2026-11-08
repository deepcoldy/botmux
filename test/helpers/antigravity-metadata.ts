/** Synthetic native gen_metadata protobuf, model-only (no token metrics). */
export function antigravityModelMetadata(model: string): Buffer {
  const varint = (n: number): number[] => {
    const bytes: number[] = [];
    do { bytes.push((n & 0x7f) | (n > 127 ? 0x80 : 0)); n = Math.floor(n / 128); } while (n);
    return bytes;
  };
  const text = Buffer.from(model, 'utf8');
  const generation = Buffer.concat([Buffer.from([0x9a, 0x01, ...varint(text.length)]), text]);
  return Buffer.concat([Buffer.from([0x0a, ...varint(generation.length)]), generation]);
}
