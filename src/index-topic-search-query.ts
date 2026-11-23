#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { searchTopics, type SearchRequest } from './services/topic-search/query.js';
import type { Session } from './types.js';

const envelopeSchema = z.object({
  dataDir: z.string().min(1),
  request: z.unknown(),
  options: z.object({
    sessions: z.array(z.unknown()).optional(),
    anchors: z.array(z.string()).optional(),
    candidateLimit: z.number().optional(),
    visibleSessionIds: z.array(z.string()).optional(),
    busyTimeoutMs: z.number().optional(),
  }),
}).strict();

/** One-shot protocol worker: Dashboard stays responsive while SQLite scans and
 * ranks candidates here. A 0600 result file avoids runtime-specific pipe flush
 * behavior in the compiled binary; the parent removes it after reading. */
const resultPath = process.argv.at(-1)!;
function emit(envelope: { ok: boolean;result?: unknown;error?: string }): void {
  writeFileSync(resultPath,`${JSON.stringify(envelope)}\n`,{ mode: 0o600 });
  process.exit(0);
}
try {
  const input = envelopeSchema.parse(JSON.parse(readFileSync(0,'utf8')));
  const result = searchTopics(input.dataDir,input.request as SearchRequest,undefined,{
    sessions: input.options.sessions as Session[],
    anchors: input.options.anchors === undefined ? undefined : new Set(input.options.anchors),
    candidateLimit: input.options.candidateLimit,
    visibleSessionIds: input.options.visibleSessionIds === undefined ? undefined : new Set(input.options.visibleSessionIds),
    busyTimeoutMs: input.options.busyTimeoutMs,
  });
  emit({ ok: true,result });
} catch (error) {
  emit({ ok: false,error: error instanceof Error ? error.message : String(error) });
}
