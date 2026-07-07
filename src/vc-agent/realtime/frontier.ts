import {
  concatProtoFields,
  decodeProtoFields,
  encodeBytes,
  encodeInt32,
  encodeString,
  encodeUint64,
  fieldBigInt,
  fieldBytes,
  fieldNumber,
  fieldString,
} from './protobuf.js';

export const FRONTIER_SERVICE = 33_555_721;
export const FRONTIER_METHOD = 1;
export const FRONTIER_FRAME_TYPE_NORMAL = 0;
export const FRONTIER_SKIP_FRAME_TYPES = new Set([1, 2, 16, 32]);
export const FRONTIER_PAYLOAD_ENCODING = 'binary';
export const FRONTIER_PAYLOAD_TYPE = 'application/x-protobuf';

export interface FrontierFrameInput {
  seqId: bigint | number;
  logId?: bigint | number;
  service: number;
  method: number;
  payload: Buffer;
  payloadEncoding?: string;
  payloadType?: string;
  logIdNew?: string;
  msgId?: string;
  frameType?: number;
}

export interface DecodedFrontierFrame {
  seqId?: bigint;
  logId?: bigint;
  service?: number;
  method?: number;
  payload?: Buffer;
  payloadEncoding?: string;
  payloadType?: string;
  logIdNew?: string;
  msgId?: string;
  frameType?: number;
  skipped: boolean;
}

export function encodeFrontierFrame(input: FrontierFrameInput): Buffer {
  const frameType = input.frameType ?? FRONTIER_FRAME_TYPE_NORMAL;
  return concatProtoFields([
    encodeUint64(1, input.seqId),
    encodeUint64(2, input.logId ?? 0n),
    encodeInt32(3, input.service),
    encodeInt32(4, input.method),
    encodeString(6, input.payloadEncoding ?? FRONTIER_PAYLOAD_ENCODING),
    encodeString(7, input.payloadType ?? FRONTIER_PAYLOAD_TYPE),
    encodeBytes(8, input.payload, { emitEmpty: true }),
    encodeString(9, input.logIdNew ?? '', { emitEmpty: true }),
    encodeString(11, input.msgId ?? '', { emitEmpty: true }),
    encodeInt32(12, frameType),
  ]);
}

export function decodeFrontierFrame(data: Buffer): DecodedFrontierFrame {
  const fields = decodeProtoFields(data);
  const frameType = fieldNumber(fields, 12) ?? FRONTIER_FRAME_TYPE_NORMAL;
  return {
    seqId: fieldBigInt(fields, 1),
    logId: fieldBigInt(fields, 2),
    service: fieldNumber(fields, 3),
    method: fieldNumber(fields, 4),
    payloadEncoding: fieldString(fields, 6),
    payloadType: fieldString(fields, 7),
    payload: fieldBytes(fields, 8),
    logIdNew: fieldString(fields, 9),
    msgId: fieldString(fields, 11),
    frameType,
    skipped: FRONTIER_SKIP_FRAME_TYPES.has(frameType),
  };
}
