import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../utils/file-lock.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../im/lark/turn-reply-card-size.js';
import type { AskResult, PendingAsk } from '../core/ask-types.js';

export type ReplyCardMode = 'legacy' | 'unified';
/** Retain quiet delivery only for persisted turns accepted by older versions. */
export type TurnReplyCardMode = ReplyCardMode | 'final-only';
export class ReplyCardWithdrawnError extends Error {
  constructor() { super('Reply card was withdrawn; automatic recreation is disabled'); this.name = 'ReplyCardWithdrawnError'; }
}
export function normalizeReplyCardMode(value: unknown): ReplyCardMode {
  return value === 'unified' || value === 'final-only' ? 'unified' : 'legacy';
}

export interface TurnReplyCardKey {
  larkAppId: string;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
}

export type ReplyCardPhase = 'queued' | 'working' | 'waiting' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'ambiguous';
export interface ReplyCardTool { id: string; name: string; subject: string; completed?: boolean; result?: string }
export type ReplyCardActivity =
  | { kind: 'thinking' | 'progress'; id: string; text: string }
  | { kind: 'tool' | 'ask'; id: string };
export interface ReplyCardAsk { ask: PendingAsk; result?: AskResult; confirmEmptyArmed?: boolean; runtimeInvalidated?: boolean }
export interface TurnReplyCardRecord extends TurnReplyCardKey {
  version: 1;
  mode: Exclude<TurnReplyCardMode, 'legacy'>;
  chatId: string;
  rootId: string;
  phase: ReplyCardPhase;
  createdAtMs: number;
  updatedAtMs?: number;
  startedAtMs?: number;
  durationMs?: number;
  completedAtMs?: number;
  progress: string[];
  tools: ReplyCardTool[];
  /** Ordered by receipt; source IDs keep cumulative CLI snapshots idempotent. */
  activity?: ReplyCardActivity[];
  asks?: ReplyCardAsk[];
  finalCard?: string;
  finalText?: string;
  finalSource?: 'explicit' | 'bridge';
  feedback?: { policy: import('./feedback-policy.js').FeedbackPolicy; requesterSubjectId?: string };
  finalDelivered?: boolean;
  messageId?: string;
  pendingCreate?: { content: string; atMs: number };
  lastCard?: string;
  withdrawn?: boolean;
  disconnected?: boolean;
  overflowMessageId?: string;
  usage?: import('../im/lark/md-card.js').CardUsageSnapshot;
}

export type TurnReplyCardEvent =
  | { kind: 'start' }
  | { kind: 'tools'; tools: ReplyCardTool[]; activity?: ReplyCardActivity[] }
  | { kind: 'ask'; entry: ReplyCardAsk }
  | { kind: 'progress'; text: string }
  | { kind: 'final'; text: string; card: string; source: 'explicit' | 'bridge'; feedback?: TurnReplyCardRecord['feedback'] }
  | { kind: 'phase'; phase: 'working' | 'waiting' | 'stopping' }
  | { kind: 'terminal'; phase: 'completed' | 'failed' | 'cancelled' | 'ambiguous'; durationMs?: number; completedAtMs?: number; disconnected?: boolean; orphanAskIds?: string[] }
  | { kind: 'refresh' };

export function replyCardIsTerminal(record: Pick<TurnReplyCardRecord, 'phase'>): boolean {
  return ['completed', 'failed', 'cancelled', 'ambiguous'].includes(record.phase);
}

export interface TurnReplyCardTransport {
  render(record: TurnReplyCardRecord): string;
  send(content: string, uuid: string): Promise<string>;
  patch(messageId: string, content: string): Promise<void>;
  beforeEffect(): void | Promise<void>;
  isWithdrawn(error: unknown): boolean;
  /** A full answer that does not fit is delivered once as a native file. */
  sendOverflow?(text: string, uuid: string): Promise<string>;
  forceVisible?: boolean;
  /** Card callback ACK may restore the pre-click view despite an earlier PATCH. */
  forcePatch?: boolean;
  usage?: import('../im/lark/md-card.js').CardUsageSnapshot;
}

/** One durable publisher shared by the daemon and short-lived `botmux send`
 * processes. The lock covers provider calls, so a late progress PATCH cannot
 * overtake the final answer. This store never participates in status-card recall. */
export class TurnReplyCardStore {
  readonly directory: string;
  constructor(dataDir: string) { this.directory = join(dataDir, 'turn-reply-cards'); }

  id(key: TurnReplyCardKey): string {
    return createHash('sha256').update(JSON.stringify([
      key.larkAppId, key.sessionId, key.turnId, key.dispatchAttempt ?? null,
    ])).digest('hex').slice(0, 32);
  }

  private path(key: TurnReplyCardKey): string { return join(this.directory, `${this.id(key)}.json`); }

  read(key: TurnReplyCardKey): TurnReplyCardRecord | undefined {
    const path = this.path(key);
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (lstatSync(this.directory).isSymbolicLink() || stat.isSymbolicLink() || !stat.isFile()) throw new Error('Unsafe reply-card record');
    const record = JSON.parse(readFileSync(path, 'utf8')) as TurnReplyCardRecord;
    if (record.version !== 1 || this.id(record) !== this.id(key)
      || !['unified', 'final-only'].includes(record.mode)
      || !Array.isArray(record.progress) || !Array.isArray(record.tools)) {
      throw new Error('Invalid reply-card record');
    }
    return record;
  }

  private write(key: TurnReplyCardKey, record: TurnReplyCardRecord): void {
    atomicWriteFileSync(this.path(key), JSON.stringify(record), {
      mode: 0o600, followTargetSymlink: false, durable: true,
    });
  }

  async prepare(key: TurnReplyCardKey, input: Pick<TurnReplyCardRecord, 'mode' | 'chatId' | 'rootId'>): Promise<TurnReplyCardRecord> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Unsafe reply-card directory');
    return withFileLock(this.path(key), async () => {
      const existing = this.read(key);
      if (existing) {
        if (existing.chatId !== input.chatId || existing.rootId !== input.rootId) throw new Error('Reply-card destination changed');
        return existing;
      }
      const record: TurnReplyCardRecord = {
        ...key, ...input, version: 1, phase: 'queued', createdAtMs: Date.now(), progress: [], tools: [],
      };
      this.write(key, record);
      return record;
    }, { maxWaitMs: 60_000 });
  }

  /** Admission reservation contains no network I/O. It must exist before the
   * worker receives input, including a CLI that sends before its ready event. */
  prepareSync(key: TurnReplyCardKey, input: Pick<TurnReplyCardRecord, 'mode' | 'chatId' | 'rootId'>): TurnReplyCardRecord {
    const existing = this.read(key);
    if (existing) {
      if (existing.chatId !== input.chatId || existing.rootId !== input.rootId) throw new Error('Reply-card destination changed');
      return existing;
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Unsafe reply-card directory');
    return withFileLockSync(this.path(key), () => {
      const current = this.read(key);
      if (current) {
        if (current.chatId !== input.chatId || current.rootId !== input.rootId) throw new Error('Reply-card destination changed');
        return current;
      }
      const record: TurnReplyCardRecord = {
        ...key, ...input, version: 1, phase: 'queued', createdAtMs: Date.now(), progress: [], tools: [],
      };
      this.write(key, record);
      return record;
    });
  }

  async update(key: TurnReplyCardKey, inputEvent: TurnReplyCardEvent | (() => TurnReplyCardEvent), io: TurnReplyCardTransport): Promise<{
    messageId?: string; delivered: boolean; card?: string; record: TurnReplyCardRecord;
  }> {
    return withFileLock(this.path(key), async () => {
      const record = this.read(key);
      if (!record) throw new Error('Reply-card turn was not prepared by the daemon');
      await io.beforeEffect();
      const event = typeof inputEvent === 'function' ? inputEvent() : inputEvent;
      if (record.withdrawn) throw new ReplyCardWithdrawnError();
      const terminal = replyCardIsTerminal(record) && !record.disconnected;
      record.updatedAtMs = Date.now();
      if (io.usage) record.usage = io.usage;
      if (event.kind === 'progress' && (terminal || record.finalDelivered)) {
        throw new Error('This turn has finished; progress was not delivered');
      }
      if ((event.kind === 'final' && record.finalDelivered)
        || (terminal && ['tools', 'phase', 'start'].includes(event.kind))) {
        if (event.kind === 'final' && event.source === 'explicit' && record.finalText !== event.text) {
          throw new Error('This turn already delivered a different final answer');
        }
        return { messageId: record.messageId, delivered: !!record.messageId, card: record.lastCard, record };
      }
      record.activity ??= [
        ...record.progress.map((text, i) => ({ kind: 'progress' as const, id: `progress:${i}`, text })),
        ...record.tools.map(tool => ({ kind: 'tool' as const, id: tool.id })),
      ];
      const priorOverflowText = record.overflowMessageId ? record.finalText ?? record.progress.join('\n\n') : undefined;
      if (event.kind === 'ask') {
        record.asks ??= [];
        const prior = record.asks.find(item => item.ask.askId === event.entry.ask.askId);
        if (!prior && (terminal || record.finalDelivered) && !event.entry.result) throw new Error('Cannot ask after turn completion');
        if (prior) {
          // A late initial send/toggle cannot resurrect a resolved question.
          if (!prior.result || (prior.runtimeInvalidated && event.entry.result)) {
            Object.assign(prior, event.entry);
            delete prior.runtimeInvalidated;
          }
        } else {
          record.asks.push(event.entry);
          record.activity.push({ kind: 'ask', id: event.entry.ask.askId });
        }
      } else if (event.kind === 'final') {
        // The first explicit final is authoritative. Transcript fallback and
        // command retries may acknowledge it, but must not replace it.
        if (!record.finalDelivered && (record.finalSource !== 'explicit' || event.source === 'explicit')) {
          record.finalCard = event.card;
          record.finalText = event.text;
          record.finalSource = event.source;
          record.feedback = event.feedback;
        }
      } else if (event.kind === 'terminal') {
        for (const entry of record.asks ?? []) {
          if (!entry.result && (!event.disconnected || event.orphanAskIds?.includes(entry.ask.askId))) {
            entry.result = { kind: 'invalidated', reason: 'Task no longer awaiting this answer', selected: null, by: null, comment: null, timedOut: false };
            // A broker answer accepted before this terminal edge may still be
            // waiting for the publish lock; its confirmed result wins later.
            entry.runtimeInvalidated = true;
          }
        }
        // A persisted terminal phase does not prove its provider PATCH was
        // acknowledged. Keep rendering it on retry without changing its facts.
        if (!terminal) {
          record.phase = record.phase === 'stopping' && event.phase === 'completed' ? 'cancelled' : event.phase;
          record.durationMs = event.durationMs;
          record.completedAtMs = event.completedAtMs;
          record.disconnected = event.disconnected;
        }
      } else if (!terminal) {
        if (event.kind === 'tools') {
          record.tools = event.tools;
          const incoming = event.activity ?? event.tools.map(tool => ({ kind: 'tool' as const, id: tool.id }));
          const ids = new Set(record.activity.map(item => `${item.kind}:${item.id}`));
          for (const item of incoming) {
            if (!ids.has(`${item.kind}:${item.id}`)) record.activity.push(item);
          }
        } else if (event.kind === 'start' && !record.finalDelivered) {
          record.phase = 'working';
          record.startedAtMs ??= Date.now();
        } else if (event.kind === 'progress' && event.text.trim() && record.progress.at(-1) !== event.text) {
          record.progress.push(event.text);
          record.activity.push({ kind: 'progress', id: `progress:${record.progress.length - 1}`, text: event.text });
        } else if (event.kind === 'phase' && record.phase !== 'stopping') {
          record.phase = event.phase;
        }
      }
      const overflowText = record.finalText ?? record.progress.join('\n\n');
      // A late final (or a corrected, still-undelivered final) must not keep
      // pointing at an attachment containing the previous progress/answer.
      if (record.overflowMessageId && overflowText !== priorOverflowText) delete record.overflowMessageId;
      this.write(key, record);
      const visible = record.mode === 'unified' || io.forceVisible || !!record.finalCard || terminal || event.kind === 'terminal';
      if (!visible) return { delivered: false, record };

      let card = io.render(record);
      const completeRecordNeedsFile = replyCardIsTerminal(record) && !record.disconnected && !record.finalCard
        && Buffer.byteLength(record.progress.join('\n\n'), 'utf8') > 6000;
      if (turnReplyCardRequestBytes(card, record.chatId) > TURN_REPLY_CARD_MAX_BYTES || completeRecordNeedsFile) {
        if (!io.sendOverflow) throw new Error('Reply exceeds card size limit');
        if (!record.overflowMessageId) {
          await io.beforeEffect();
          // Same content retries share a UUID; different content must not be
          // deduplicated by Feishu to the previously uploaded attachment.
          const digest = createHash('sha256').update(JSON.stringify([this.id(key), overflowText])).digest('hex').slice(0, 32);
          record.overflowMessageId = await io.sendOverflow(overflowText, `brf_${digest}`);
          this.write(key, record);
        }
        card = io.render(record);
        if (turnReplyCardRequestBytes(card, record.chatId) > TURN_REPLY_CARD_MAX_BYTES) throw new Error('Reply-card summary exceeds size limit');
      }

      try {
        if (!record.messageId) {
          // Reuse the exact first POST body and provider UUID after an unknown
          // send result. Beyond Feishu's dedupe window we fail rather than mint
          // a second message whose predecessor may already be visible.
          record.pendingCreate ??= { content: card, atMs: Date.now() };
          if (Date.now() - record.pendingCreate.atMs > 4 * 60_000) {
            throw new Error('Reply-card send result is unknown; automatic resend window expired');
          }
          this.write(key, record);
          await io.beforeEffect();
          record.messageId = await io.send(record.pendingCreate.content, `brc_${this.id(key)}`);
          if (!record.messageId) throw new Error('Missing reply-card message ID');
          record.lastCard = record.pendingCreate.content;
          delete record.pendingCreate;
          this.write(key, record);
        }
        if (record.lastCard !== card || io.forcePatch) {
          await io.beforeEffect();
          await io.patch(record.messageId, card);
          record.lastCard = card;
        }
        if (record.finalCard && !(event.kind === 'terminal' && event.disconnected)) record.finalDelivered = true;
        this.write(key, record);
        return { messageId: record.messageId, delivered: true, card, record };
      } catch (error) {
        if (record.messageId && io.isWithdrawn(error)) {
          record.withdrawn = true;
          this.write(key, record);
          throw new ReplyCardWithdrawnError();
        }
        throw error;
      }
    }, { maxWaitMs: 60_000 });
  }
}
