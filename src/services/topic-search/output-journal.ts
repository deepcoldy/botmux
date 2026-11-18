import { z } from 'zod';
import { openReadonlySource } from './readonly-sqlite.js';
import type { SourceStatus } from './sources.js';

const cursorSchema = z.object({ updated_at: z.number().finite(), id: z.string() });
const rowSchema = cursorSchema.extend({ session_id: z.string(), turn_id: z.string(),
  created_at: z.number().finite(), state: z.string(), value: z.string() });
const valueSchema = z.object({
  output: z.object({ content: z.string() }),
  sink: z.object({ kind: z.string(), chatId: z.string().optional(), context: z.unknown().optional() }),
  receipt: z.object({ status: z.string(), messageId: z.string().optional() }).optional(),
});
const contextSchema = z.object({ target: z.object({ chatId: z.string().optional(), rootMessageId: z.string().optional() }).optional() });
export interface OutputCursor { updatedAt: number }
/** Within one scan only; never persisted as the source's synchronization cursor. */
export interface OutputPagePosition { updatedAt: number; id: string }
export type FinalOutput = {
  id: string; sessionId: string; turnId: string; createdAt: number; updatedAt: number;
  text: string; messageId?: string; chatId?: string; rootMessageId?: string;
};
export type OutputChange = { kind: 'upsert'; value: FinalOutput } | { kind: 'remove'; id: string };
export interface OutputJournalPage {
  status: SourceStatus; changes: OutputChange[]; cursor?: OutputCursor;
  nextPage?: OutputPagePosition; hasMore: boolean; malformedLines: number;
}

/** Start each scan without pageAfter to replay the fixed 60-second overlap. */
export function readOutputJournalPage(path: string, after?: OutputCursor, pageAfter?: OutputPagePosition): OutputJournalPage {
  // The writer currently leaves user_version at zero.
  const source = openReadonlySource(path, [0], ['outputs']);
  const empty = { changes: [], cursor: after, hasMore: false, malformedLines: 0 };
  if (source.status !== 'ready') return { ...empty, status: source.status };
  const { db } = source;
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (after) { conditions.push('updated_at>=?'); params.push(after.updatedAt - 60_000); }
    if (pageAfter) {
      conditions.push('(updated_at>? OR (updated_at=? AND id>?))');
      params.push(pageAfter.updatedAt, pageAfter.updatedAt, pageAfter.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM outputs ${where} ORDER BY updated_at,id LIMIT 2000`).all(...params);
    const changes: OutputChange[] = [];
    let cursor = after;
    let position: OutputPagePosition | undefined;
    let malformedLines = 0;
    for (const raw of rows) {
      const rowPosition = cursorSchema.parse(raw);
      position = { updatedAt: rowPosition.updated_at, id: rowPosition.id };
      cursor = { updatedAt: Math.max(cursor?.updatedAt ?? rowPosition.updated_at, rowPosition.updated_at) };
      const row = rowSchema.safeParse(raw);
      if (!row.success) { malformedLines++; changes.push({ kind: 'remove', id: rowPosition.id }); continue; }
      let value: z.infer<typeof valueSchema>;
      try { const json: unknown = JSON.parse(row.data.value); value = valueSchema.parse(json); }
      catch { malformedLines++; changes.push({ kind: 'remove', id: rowPosition.id }); continue; }
      const record = row.data;
      if (record.state !== 'settled' || value.sink.kind !== 'im'
          || value.receipt?.status !== 'delivered' || !value.output.content.trim()) {
        changes.push({ kind: 'remove', id: record.id }); continue;
      }
      const context = contextSchema.safeParse(value.sink.context);
      const target = context.success ? context.data.target : undefined;
      changes.push({ kind: 'upsert', value: {
        id: record.id, sessionId: record.session_id, turnId: record.turn_id,
        createdAt: record.created_at, updatedAt: record.updated_at,
        text: value.output.content, messageId: value.receipt.messageId,
        chatId: target?.chatId ?? value.sink.chatId,
        rootMessageId: target?.rootMessageId,
      } });
    }
    const present = !!db.prepare('SELECT 1 FROM outputs LIMIT 1').get();
    return { status: present ? 'ready' : 'empty', changes, cursor,
      nextPage: rows.length === 2000 ? position : undefined, hasMore: rows.length === 2000, malformedLines };
  } catch { return { ...empty, status: 'unreadable' }; }
  finally { db.close(); }
}
