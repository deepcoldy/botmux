/** Test-only writer for frozen v2 archive/replay fixtures. */
import { existsSync, mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import {
  INLINE_PAYLOAD_MAX_BYTES,
  isPayloadRef,
  parseEvent,
  type WorkflowEvent,
} from '../../src/workflows/events/schema.js';

export type FrozenV2EventDraft =
  Omit<WorkflowEvent, 'eventId' | 'schemaVersion' | 'timestamp'> & { timestamp?: number };

/**
 * Minimal deterministic event fixture writer. It intentionally omits all
 * locking/runtime behavior: production v2 execution is retired, while tests
 * still need authentic envelopes for read-only replay and archive verification.
 */
export class FrozenV2EventLog {
  readonly runId: string;
  readonly runDir: string;
  readonly eventsFile: string;
  readonly blobDir: string;

  constructor(runId: string, baseDir: string) {
    this.runId = runId;
    this.runDir = join(baseDir, runId);
    this.eventsFile = join(this.runDir, 'events.ndjson');
    this.blobDir = join(this.runDir, 'blobs');
    mkdirSync(this.blobDir, { recursive: true });
  }

  async append(draft: FrozenV2EventDraft): Promise<WorkflowEvent> {
    const prior = await this.readAll();
    if (!isPayloadRef(draft.payload)) {
      const bytes = Buffer.byteLength(JSON.stringify(draft.payload), 'utf-8');
      if (bytes > INLINE_PAYLOAD_MAX_BYTES) {
        throw new Error(
          `FrozenV2EventLog(${this.runId}).append: inline payload (${bytes} bytes) exceeds ` +
          `INLINE_PAYLOAD_MAX_BYTES (${INLINE_PAYLOAD_MAX_BYTES})`,
        );
      }
    }
    const candidate: Record<string, unknown> = {
      eventId: `${this.runId}-${prior.length + 1}`,
      runId: this.runId,
      timestamp: draft.timestamp ?? Date.now(),
      type: draft.type,
      schemaVersion: 1,
      actor: draft.actor,
      payload: draft.payload,
    };
    if ('payloadHash' in draft && draft.payloadHash !== undefined) {
      candidate.payloadHash = draft.payloadHash;
    }
    const parsed = parseEvent(candidate);
    await fs.appendFile(this.eventsFile, `${JSON.stringify(parsed)}\n`, 'utf-8');
    return parsed;
  }

  async readAll(): Promise<WorkflowEvent[]> {
    if (!existsSync(this.eventsFile)) return [];
    const raw = await fs.readFile(this.eventsFile, 'utf-8');
    return raw.split('\n').filter(Boolean).map((line) => parseEvent(JSON.parse(line!)));
  }

  async currentSeq(): Promise<number> {
    return (await this.readAll()).length;
  }
}
