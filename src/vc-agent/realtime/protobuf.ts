export const WIRE_VARINT = 0;
export const WIRE_LEN = 2;

export interface DecodedProtoField {
  field: number;
  wire: number;
  value: bigint | Buffer;
}

function assertFieldNumber(field: number): void {
  if (!Number.isInteger(field) || field <= 0) {
    throw new Error(`invalid protobuf field number: ${field}`);
  }
}

export function encodeVarint(value: bigint | number): Buffer {
  let n = typeof value === 'bigint' ? value : BigInt(value);
  if (n < 0n) throw new Error(`negative varint is unsupported: ${n}`);
  const bytes: number[] = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0n);
  return Buffer.from(bytes);
}

export function encodeTag(field: number, wire: number): Buffer {
  assertFieldNumber(field);
  return encodeVarint(BigInt((field << 3) | wire));
}

export function encodeUint64(field: number, value: bigint | number | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  return Buffer.concat([encodeTag(field, WIRE_VARINT), encodeVarint(value)]);
}

export function encodeInt64(field: number, value: bigint | number | undefined): Buffer | undefined {
  return encodeUint64(field, value);
}

export function encodeUint32(field: number, value: number | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid uint32 value: ${value}`);
  return Buffer.concat([encodeTag(field, WIRE_VARINT), encodeVarint(value)]);
}

export function encodeInt32(field: number, value: number | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error(`invalid int32 value: ${value}`);
  if (value < 0) throw new Error(`negative int32 values are not needed for realtime voice: ${value}`);
  return Buffer.concat([encodeTag(field, WIRE_VARINT), encodeVarint(value)]);
}

export function encodeBool(field: number, value: boolean | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  return Buffer.concat([encodeTag(field, WIRE_VARINT), encodeVarint(value ? 1 : 0)]);
}

export function encodeString(field: number, value: string | undefined, opts: { emitEmpty?: boolean } = {}): Buffer | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 && opts.emitEmpty !== true) return undefined;
  const data = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeTag(field, WIRE_LEN), encodeVarint(data.length), data]);
}

export function encodeBytes(field: number, value: Buffer | undefined, opts: { emitEmpty?: boolean } = {}): Buffer | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 && opts.emitEmpty !== true) return undefined;
  return Buffer.concat([encodeTag(field, WIRE_LEN), encodeVarint(value.length), value]);
}

export function concatProtoFields(fields: Array<Buffer | undefined>): Buffer {
  return Buffer.concat(fields.filter((f): f is Buffer => Boolean(f)));
}

export function readVarint(data: Buffer, offset = 0): { value: bigint; next: number } {
  let shift = 0n;
  let value = 0n;
  let pos = offset;
  while (pos < data.length) {
    const byte = data[pos];
    value |= BigInt(byte & 0x7f) << shift;
    pos += 1;
    if ((byte & 0x80) === 0) return { value, next: pos };
    shift += 7n;
    if (shift > 70n) throw new Error('protobuf varint is too long');
  }
  throw new Error('truncated protobuf varint');
}

export function decodeProtoFields(data: Buffer): DecodedProtoField[] {
  const fields: DecodedProtoField[] = [];
  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    offset = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 0x07n);
    if (field <= 0) throw new Error(`invalid protobuf field tag: ${tag.value}`);
    if (wire === WIRE_VARINT) {
      const decoded = readVarint(data, offset);
      offset = decoded.next;
      fields.push({ field, wire, value: decoded.value });
      continue;
    }
    if (wire === WIRE_LEN) {
      const len = readVarint(data, offset);
      offset = len.next;
      const end = offset + Number(len.value);
      if (end > data.length) throw new Error('truncated protobuf length-delimited field');
      fields.push({ field, wire, value: data.subarray(offset, end) });
      offset = end;
      continue;
    }
    if (wire === 1) {
      offset += 8;
      if (offset > data.length) throw new Error('truncated protobuf fixed64 field');
      continue;
    }
    if (wire === 5) {
      offset += 4;
      if (offset > data.length) throw new Error('truncated protobuf fixed32 field');
      continue;
    }
    throw new Error(`unsupported protobuf wire type: ${wire}`);
  }
  return fields;
}

export function firstField(fields: DecodedProtoField[], field: number): DecodedProtoField | undefined {
  return fields.find(f => f.field === field);
}

export function fieldString(fields: DecodedProtoField[], field: number): string | undefined {
  const value = firstField(fields, field)?.value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : undefined;
}

export function fieldBytes(fields: DecodedProtoField[], field: number): Buffer | undefined {
  const value = firstField(fields, field)?.value;
  return Buffer.isBuffer(value) ? value : undefined;
}

export function fieldBigInt(fields: DecodedProtoField[], field: number): bigint | undefined {
  const value = firstField(fields, field)?.value;
  return typeof value === 'bigint' ? value : undefined;
}

export function fieldNumber(fields: DecodedProtoField[], field: number): number | undefined {
  const value = fieldBigInt(fields, field);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`protobuf integer is outside safe JS range: ${value}`);
  return n;
}

export function fieldBool(fields: DecodedProtoField[], field: number): boolean | undefined {
  const value = fieldBigInt(fields, field);
  return value === undefined ? undefined : value !== 0n;
}
