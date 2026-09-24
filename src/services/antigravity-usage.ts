import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSyncNow } from './sqlite-compat.js';
import type { SessionContextUsage, SessionTokenUsage } from '../core/cost-calculator.js';

interface ProtoField {
  wireType: number;
  val: number | Buffer;
}

/** Decode protobuf wire format fields into a map of field_number -> ProtoField[] */
export function decodeProtoBuffer(buf: Buffer): Map<number, ProtoField[]> {
  const fields = new Map<number, ProtoField[]>();
  let i = 0;
  const len = buf.length;

  while (i < len) {
    let key = 0;
    let shift = 0;
    while (i < len) {
      const b = buf[i++];
      key |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const fieldNum = key >> 3;
    const wireType = key & 0x07;

    if (wireType === 0) {
      // Varint
      let val = 0;
      shift = 0;
      while (i < len) {
        const b = buf[i++];
        val += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
        if (!(b & 0x80)) break;
      }
      let list = fields.get(fieldNum);
      if (!list) { list = []; fields.set(fieldNum, list); }
      list.push({ wireType, val });
    } else if (wireType === 2) {
      // Length-delimited (bytes, string, embedded message)
      let length = 0;
      shift = 0;
      while (i < len) {
        const b = buf[i++];
        length += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
        if (!(b & 0x80)) break;
      }
      if (i + length > len) break; // Truncated buffer
      const val = buf.subarray(i, i + length);
      i += length;
      let list = fields.get(fieldNum);
      if (!list) { list = []; fields.set(fieldNum, list); }
      list.push({ wireType, val });
    } else if (wireType === 1) {
      // 64-bit fixed
      i += 8;
    } else if (wireType === 5) {
      // 32-bit fixed
      i += 4;
    } else {
      // Unknown or unsupported wire type
      break;
    }
  }

  return fields;
}

export interface AntigravityStepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  model: string;
}

export function parseGenMetadataRow(raw: Buffer | Uint8Array): AntigravityStepUsage | null {
  if (!raw || raw.length === 0) return null;
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const top = decodeProtoBuffer(data);
  const f1List = top.get(1);
  if (!f1List || f1List.length === 0) return null;
  const f1Raw = f1List[0].val;
  if (!f1Raw || (typeof f1Raw !== 'object')) return null;
  const f1Buf = Buffer.isBuffer(f1Raw) ? f1Raw : Buffer.from(f1Raw as Uint8Array);

  const f1 = decodeProtoBuffer(f1Buf);
  let model = '';
  const modelList = f1.get(19);
  if (modelList && modelList.length > 0 && typeof modelList[0].val === 'object') {
    const mBuf = Buffer.isBuffer(modelList[0].val) ? modelList[0].val : Buffer.from(modelList[0].val as Uint8Array);
    model = mBuf.toString('utf8').trim();
  }

  const f4List = f1.get(4);
  if (!f4List || f4List.length === 0 || typeof f4List[0].val !== 'object') {
    return model ? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, model } : null;
  }

  const f4Buf = Buffer.isBuffer(f4List[0].val) ? f4List[0].val : Buffer.from(f4List[0].val as Uint8Array);
  const f4 = decodeProtoBuffer(f4Buf);
  const inputTokens = typeof f4.get(2)?.[0]?.val === 'number' ? (f4.get(2)![0].val as number) : 0;
  const outputTokens = typeof f4.get(3)?.[0]?.val === 'number' ? (f4.get(3)![0].val as number) : 0;
  const cacheReadTokens = typeof f4.get(5)?.[0]?.val === 'number' ? (f4.get(5)![0].val as number) : 0;
  const reasoningTokens = typeof f4.get(9)?.[0]?.val === 'number' ? (f4.get(9)![0].val as number) : 0;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    reasoningTokens,
    model,
  };
}

export function getAntigravityModelContextWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('claude')) {
    if (m.includes('1m')) return 1_000_000;
    return 200_000;
  }
  if (m.includes('gemini')) {
    return 1_000_000;
  }
  return 1_000_000;
}

export interface AntigravityUsageReadResult {
  agg: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    model: string;
    turns: number;
    latestCodexUsage: SessionTokenUsage | null;
    latestContextUsage: SessionContextUsage | null;
    latestCodexUsageSource: null;
    latestContextUsageSource: null;
    modelSource: null;
    turnInputTokens: number;
    turnOutputTokens: number;
    reasoningEffort: string;
  };
  result: SessionTokenUsage | null;
}

export function readAntigravityTokenUsage(
  cliSessionId: string,
  opts?: { conversationsDir?: string; dbPath?: string },
): AntigravityUsageReadResult | null {
  if (!cliSessionId || !/^[a-zA-Z0-9._-]+$/.test(cliSessionId)) return null;

  const dbPath = opts?.dbPath
    ?? join(opts?.conversationsDir ?? join(homedir(), '.gemini', 'antigravity-cli', 'conversations'), `${cliSessionId}.db`);
  if (!existsSync(dbPath)) return null;

  const db = openDatabaseSyncNow(dbPath, { readOnly: true });
  if (!db) return null;

  try {
    const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all() as Array<{ idx: unknown; data: unknown }>;
    if (!rows || rows.length === 0) return null;

    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let turns = 0;
    let latestModel = '';
    let lastStepInput = 0;
    let lastStepOutput = 0;
    let lastStepCache = 0;

    for (const row of rows) {
      const data = Buffer.isBuffer(row.data)
        ? row.data
        : (row.data instanceof Uint8Array ? Buffer.from(row.data) : null);
      if (!data) continue;
      const parsed = parseGenMetadataRow(data);
      if (!parsed) continue;

      if (parsed.model) latestModel = parsed.model;
      totalInput += parsed.inputTokens;
      totalOutput += parsed.outputTokens;
      totalCacheRead += parsed.cacheReadTokens;
      if (parsed.outputTokens > 0) turns++;

      lastStepInput = parsed.inputTokens;
      lastStepOutput = parsed.outputTokens;
      lastStepCache = parsed.cacheReadTokens;
    }

    const usedTokens = lastStepInput + lastStepCache;
    const windowTokens = getAntigravityModelContextWindow(latestModel);
    const percentUsed = windowTokens > 0
      ? Math.max(0, Math.min(100, Math.round((usedTokens / windowTokens) * 100)))
      : undefined;

    const latestContextUsage: SessionContextUsage = {
      usedTokens,
      windowTokens,
      ...(percentUsed !== undefined ? { percentUsed } : {}),
    };

    const rawInput = totalInput + totalCacheRead;
    const result: SessionTokenUsage = {
      in: rawInput,
      out: totalOutput,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreateTokens: 0,
      model: latestModel,
      turns,
    };

    const agg = {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreateTokens: 0,
      model: latestModel,
      turns,
      latestCodexUsage: null,
      latestContextUsage: usedTokens > 0 ? latestContextUsage : null,
      latestCodexUsageSource: null,
      latestContextUsageSource: null,
      modelSource: null,
      turnInputTokens: 0,
      turnOutputTokens: 0,
      reasoningEffort: '',
    };

    return { agg, result };
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
