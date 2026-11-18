import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabaseSyncNow } from '../../src/services/sqlite-compat.js';

function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

function encodeVarintField(fieldNo: number, value: number): number[] {
  if (value === 0) return [];
  return [...encodeVarint((fieldNo << 3) | 0), ...encodeVarint(value)];
}

function encodeStringField(fieldNo: number, text: string): number[] {
  const bytes = Buffer.from(text, 'utf8');
  return [...encodeVarint((fieldNo << 3) | 2), ...encodeVarint(bytes.length), ...bytes];
}

export function encodeExecutorMetadataProto(opts: {
  terminationReason: number;
  numInvocations?: number;
  lastStepIdx: number;
  proceededWithAutoContinue?: boolean;
  executionId?: string;
}): Buffer {
  return Buffer.from([
    ...encodeVarintField(1, opts.terminationReason),
    ...encodeVarintField(2, opts.numInvocations ?? 1),
    ...encodeVarintField(3, opts.lastStepIdx),
    ...encodeVarintField(4, opts.proceededWithAutoContinue ? 1 : 0),
    ...(opts.executionId ? encodeStringField(9, opts.executionId) : []),
  ]);
}

export function encodeRawSummaryProto(opts: {
  notFullyIdle?: boolean;
  interrupted?: boolean;
  latestTerminationReason?: number;
  backgroundTaskCount?: number;
  hasRunningSubagents?: boolean;
}): Buffer {
  return Buffer.from([
    ...encodeVarintField(21, opts.notFullyIdle ? 1 : 0),
    ...encodeVarintField(25, opts.interrupted ? 1 : 0),
    ...encodeVarintField(28, opts.latestTerminationReason ?? 0),
    ...encodeVarintField(29, opts.backgroundTaskCount ?? 0),
    ...encodeVarintField(30, opts.hasRunningSubagents ? 1 : 0),
  ]);
}

export function encodeGenMetadataProto(opts: {
  model: string;
  modelDisplayName?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}): Buffer {
  // Matches src/services/antigravity-usage.ts parseGenMetadataRow:
  // top.f1 -> f1 { f19 = model, f21 = modelDisplayName, f4 = { f2 = input, f3 = output, f5 = cacheRead } }
  const f4 = Buffer.from([
    ...encodeVarintField(2, opts.inputTokens ?? 100),
    ...encodeVarintField(3, opts.outputTokens ?? 50),
    ...encodeVarintField(5, opts.cacheReadTokens ?? 0),
  ]);
  const f1 = Buffer.from([
    ...encodeStringField(19, opts.model),
    ...(opts.modelDisplayName ? encodeStringField(21, opts.modelDisplayName) : []),
    ...encodeVarint((4 << 3) | 2),
    ...encodeVarint(f4.length),
    ...f4,
  ]);
  return Buffer.from([
    ...encodeVarint((1 << 3) | 2),
    ...encodeVarint(f1.length),
    ...f1,
  ]);
}

export function writeAntigravityExecutionDbFixture(opts: {
  geminiCliDir: string;
  conversationId: string;
  maxStepIdx: number;
  execMetadataRows?: ReadonlyArray<{
    idx: number;
    terminationReason: number;
    lastStepIdx: number;
    proceededWithAutoContinue?: boolean;
  }>;
  genMetadataRows?: ReadonlyArray<{
    idx: number;
    model: string;
    modelDisplayName?: string;
    inputTokens?: number;
    outputTokens?: number;
  }>;
  summary?: {
    stepCount: number;
    status: string;
    notFullyIdle?: boolean;
    killed?: boolean;
    workspaceUris?: string[];
    backgroundTaskCount?: number;
    hasRunningSubagents?: boolean;
    latestTerminationReason?: number;
  } | null;
}): { convDbPath: string; summariesDbPath: string } {
  const convDbPath = join(opts.geminiCliDir, 'conversations', `${opts.conversationId}.db`);
  const summariesDbPath = join(opts.geminiCliDir, 'conversation_summaries.db');
  mkdirSync(dirname(convDbPath), { recursive: true });

  const convDb = openDatabaseSyncNow(convDbPath);
  if (!convDb) throw new Error(`Failed to open ${convDbPath}`);
  try {
    convDb.exec(`
      CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER);
      CREATE TABLE IF NOT EXISTS executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      DELETE FROM steps;
      DELETE FROM executor_metadata;
      DELETE FROM gen_metadata;
    `);
    const insStep = convDb.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)');
    for (let i = 0; i <= opts.maxStepIdx; i++) {
      insStep.run(i, i === 0 ? 14 : 15, 3);
    }
    const insExec = convDb.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)');
    for (const row of opts.execMetadataRows ?? []) {
      insExec.run(row.idx, encodeExecutorMetadataProto(row));
    }
    const insGen = convDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
    for (const row of opts.genMetadataRows ?? []) {
      insGen.run(row.idx, encodeGenMetadataProto(row));
    }
  } finally {
    convDb.close();
  }

  if (opts.summary !== null && opts.summary !== undefined) {
    const sumDb = openDatabaseSyncNow(summariesDbPath);
    if (!sumDb) throw new Error(`Failed to open ${summariesDbPath}`);
    try {
      sumDb.exec(`
        CREATE TABLE IF NOT EXISTS conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          step_count INTEGER,
          status TEXT,
          not_fully_idle INTEGER,
          killed INTEGER,
          workspace_uris TEXT,
          last_modified_time INTEGER,
          raw_summary BLOB
        );
      `);
      const raw = encodeRawSummaryProto({
        notFullyIdle: opts.summary.notFullyIdle,
        latestTerminationReason: opts.summary.latestTerminationReason,
        backgroundTaskCount: opts.summary.backgroundTaskCount,
        hasRunningSubagents: opts.summary.hasRunningSubagents,
      });
      sumDb.prepare(`
        INSERT OR REPLACE INTO conversation_summaries
          (conversation_id, step_count, status, not_fully_idle, killed, workspace_uris, last_modified_time, raw_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        opts.conversationId,
        opts.summary.stepCount,
        opts.summary.status,
        opts.summary.notFullyIdle ? 1 : 0,
        opts.summary.killed ? 1 : 0,
        JSON.stringify((opts.summary.workspaceUris ?? []).map(p => `file://${p}`)),
        Date.now(),
        raw,
      );
    } finally {
      sumDb.close();
    }
  }

  return { convDbPath, summariesDbPath };
}
