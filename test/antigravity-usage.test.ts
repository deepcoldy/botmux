import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import {
  decodeProtoBuffer,
  parseGenMetadataRow,
  getAntigravityModelContextWindow,
  readAntigravityTokenUsage,
} from '../src/services/antigravity-usage.js';

describe('antigravity-usage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bmx-agy-usage-'));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('context window reflects model kind', () => {
    expect(getAntigravityModelContextWindow('gemini-3.8-flash-high')).toBe(1_000_000);
    expect(getAntigravityModelContextWindow('claude-opus-4-6-thinking')).toBe(200_000);
    expect(getAntigravityModelContextWindow('claude-3-7-sonnet-1m')).toBe(1_000_000);
    expect(getAntigravityModelContextWindow('unknown-model')).toBe(1_000_000);
  });

  it('decodeProtoBuffer decodes varint and length-delimited fields', () => {
    // Construct a test proto:
    // field 1 (wire 0, varint): 150 -> 0x08, 0x96, 0x01
    // field 2 (wire 2, bytes): "test" -> 0x12, 0x04, 't','e','s','t'
    const buf = Buffer.from([0x08, 0x96, 0x01, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
    const fields = decodeProtoBuffer(buf);
    expect(fields.get(1)?.[0]?.val).toBe(150);
    expect(fields.get(2)?.[0]?.val.toString('utf8')).toBe('test');
  });

  it('readAntigravityTokenUsage returns null for non-existent session', () => {
    const res = readAntigravityTokenUsage('non-existent-session-id', { conversationsDir: tmpDir });
    expect(res).toBeNull();
  });

  it('reads token usage and context correctly from SQLite DB', () => {
    const dbPath = join(tmpDir, 'test-conv.db');
    const db = openDatabaseSyncOrThrow(dbPath);
    db.exec(`
      CREATE TABLE gen_metadata (
        idx INTEGER PRIMARY KEY,
        data BLOB
      );
    `);

    // Helper to build a minimal gen_metadata record:
    // field 1 (embedded message):
    //   field 19 (string): "gemini-3.8-flash"
    //   field 4 (embedded message):
    //     field 2 (varint): input_tokens
    //     field 3 (varint): output_tokens
    //     field 5 (varint): cache_read_tokens
    function buildRecord(input: number, output: number, cache: number, model: string): Buffer {
      // f4:
      const f4Parts: Buffer[] = [];
      // field 2: input
      f4Parts.push(Buffer.from([0x10, input & 0x7f]));
      // field 3: output
      f4Parts.push(Buffer.from([0x18, output & 0x7f]));
      // field 5: cache
      f4Parts.push(Buffer.from([0x28, cache & 0x7f]));
      const f4Buf = Buffer.concat(f4Parts);

      // f1:
      const f1Parts: Buffer[] = [];
      // field 19 (wire 2): model
      const mBytes = Buffer.from(model, 'utf8');
      f1Parts.push(Buffer.from([0x9a, 0x01, mBytes.length]));
      f1Parts.push(mBytes);
      // field 4 (wire 2): f4
      f1Parts.push(Buffer.from([0x22, f4Buf.length]));
      f1Parts.push(f4Buf);
      const f1Buf = Buffer.concat(f1Parts);

      // top: field 1 (wire 2): f1
      const topParts: Buffer[] = [];
      topParts.push(Buffer.from([0x0a, f1Buf.length]));
      topParts.push(f1Buf);
      return Buffer.concat(topParts);
    }

    const rec1 = buildRecord(100, 50, 20, 'gemini-3.8-flash');
    const rec2 = buildRecord(120, 80, 40, 'gemini-3.8-flash');
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, rec1);
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, rec2);
    db.close();

    const res = readAntigravityTokenUsage('test-conv', { dbPath });
    expect(res).not.toBeNull();
    expect(res?.result?.model).toBe('gemini-3.8-flash');
    expect(res?.result?.inputTokens).toBe(220); // 100 + 120
    expect(res?.result?.outputTokens).toBe(130); // 50 + 80
    expect(res?.result?.cacheReadTokens).toBe(60); // 20 + 40
    expect(res?.result?.in).toBe(280); // 220 + 60
    expect(res?.result?.out).toBe(130);
    expect(res?.result?.turns).toBe(2);
    expect(res?.agg.latestContextUsage?.usedTokens).toBe(160); // last step 120 + 40
    expect(res?.agg.turnInputTokens).toBe(0);
    expect(res?.agg.turnOutputTokens).toBe(0);
  });
});
