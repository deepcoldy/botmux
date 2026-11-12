import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../utils/file-lock.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../im/lark/turn-reply-card-size.js';
import { omitReplyCardImages } from '../im/lark/md-card.js';
import { replyWithImageFallback } from '../im/lark/card-image-fallback.js';
import type { AskResult, PendingAsk } from '../core/ask-types.js';

export type ReplyCardMode = 'legacy' | 'unified';
/** CLI capability only; session and transport exclusions remain runtime gates. */
export function supportsUnifiedReplyCardCli(cliId: string | undefined): boolean {
  return cliId !== undefined && ['claude-code', 'codex', 'grok', 'traex', 'pi', 'kimi'].includes(cliId);
}
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

export type ReplyCardPhase = 'queued' | 'working' | 'waiting' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'ambiguous' | 'superseded';
export interface ReplyCardTool { id: string; name: string; subject: string; completed?: boolean; result?: string }
export type ReplyCardActivity =
  | { kind: 'thinking' | 'progress'; id: string; text: string }
  | { kind: 'tool' | 'ask'; id: string };
export interface ReplyCardAsk { ask: PendingAsk; result?: AskResult; confirmEmptyArmed?: boolean; runtimeInvalidated?: boolean }
export interface TurnReplyCardRecord extends TurnReplyCardKey {
  version: 1;
  mode: Exclude<TurnReplyCardMode, 'legacy'>;
  /** Frozen at admission; native thinking must precede the first answer POST. */
  nativeCot?: boolean;
  /** Durable release: retries/recovery never create another thinking display. */
  nativeCotReady?: boolean;
  /** Set with nativeCotReady: the native thinking display really exists, so it
   * (not an early answer card) carries passive progress. Absent → card fallback.
   * Cleared for good once the daemon sees that display retired mid-turn. */
  nativeCotVisible?: boolean;
  /** That hand-back happened: the card owns progress for the rest of the turn,
   * so native thinking is not resumed if the channel is switched on again. */
  nativeCotHandedBack?: boolean;
  /** This turn's final went out as a separate message in the same chat (for
   * example to notify others), so a completed turn needs no summary card. */
  externalFinal?: boolean;
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
  /** Persist a provider-confirmed image rejection across publishers/retries. */
  omitImages?: boolean;
  messageId?: string;
  pendingCreate?: { content: string; atMs: number };
  lastCard?: string;
  /** Exact PATCH awaiting provider acknowledgement; replay never creates a card. */
  pendingPatch?: { content: string; final: boolean };
  /** State changed but its rendered update has not been acknowledged yet. */
  publishPending?: boolean;
  /** Preserve a recovery's final visibility decision across partial writes. */
  recoveryHideFinal?: boolean;
  withdrawn?: boolean;
  disconnected?: boolean;
  /** Capture expiry closed only the display, without proving native failure. */
  displayRetired?: boolean;
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
  | { kind: 'terminal'; phase: 'completed' | 'failed' | 'cancelled' | 'ambiguous' | 'superseded'; notice?: string; durationMs?: number; completedAtMs?: number; disconnected?: boolean; orphanAskIds?: string[] }
  | { kind: 'display_retired'; notice: string }
  | { kind: 'refresh' }
  | { kind: 'recover'; beforeMs?: number; orphanAskIds?: string[] };

export function replyCardIsTerminal(record: Pick<TurnReplyCardRecord, 'phase'>): boolean {
  return ['completed', 'failed', 'cancelled', 'ambiguous', 'superseded'].includes(record.phase);
}

export interface TurnReplyCardTransport {
  render(record: TurnReplyCardRecord): string;
  send(content: string, uuid: string): Promise<string>;
  patch(messageId: string, content: string): Promise<void>;
  beforeEffect(): void | Promise<void>;
  /** Runs under the publication lock, before the first answer POST. Resolves
   * true only when the native thinking display is live for this turn. */
  beforeCreate?(): void | boolean | Promise<void | boolean>;
  /** Daemon only (it owns the display state): whether native thinking still
   * carries this turn. A retired display hands progress back to the card. */
  nativeThinkingLive?(): boolean;
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

  async prepare(key: TurnReplyCardKey, input: Pick<TurnReplyCardRecord, 'mode' | 'chatId' | 'rootId' | 'nativeCot'>): Promise<TurnReplyCardRecord> {
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
  prepareSync(key: TurnReplyCardKey, input: Pick<TurnReplyCardRecord, 'mode' | 'chatId' | 'rootId' | 'nativeCot'>): TurnReplyCardRecord {
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

  /** Record that this turn's final was delivered as a separate message in the
   * card's chat. Persistence only: no provider I/O, no card creation. A turn
   * without a reply-card record, a different destination or an answer already
   * on the card is left untouched. Returns whether the record was marked. */
  async noteExternalFinal(key: TurnReplyCardKey, chatId: string): Promise<boolean> {
    if (!this.read(key)) return false;
    return withFileLock(this.path(key), async () => {
      const record = this.read(key);
      if (!record || record.chatId !== chatId || record.finalCard || record.withdrawn) return false;
      if (record.externalFinal) return true;
      record.externalFinal = true;
      this.write(key, record);
      return true;
    }, { maxWaitMs: 8_000 });
  }

  async update(key: TurnReplyCardKey, inputEvent: TurnReplyCardEvent | (() => TurnReplyCardEvent), io: TurnReplyCardTransport): Promise<{
    messageId?: string; delivered: boolean; card?: string; record: TurnReplyCardRecord;
  }> {
    return withFileLock(this.path(key), async () => {
      const record = this.read(key);
      if (!record) throw new Error('Reply-card turn was not prepared by the daemon');
      await io.beforeEffect();
      let event = typeof inputEvent === 'function' ? inputEvent() : inputEvent;
      const recovering = event.kind === 'recover';
      let hideUndeliveredFinal = false;
      if (record.withdrawn && event.kind === 'recover') return { messageId: record.messageId, delivered: false, record };
      if (record.withdrawn) throw new ReplyCardWithdrawnError();
      if (event.kind === 'recover') {
        // Selection must happen after acquiring the same lock as live writers.
        if (!record.messageId || (event.beforeMs !== undefined && (record.updatedAtMs ?? record.createdAtMs) >= event.beforeMs)
          || (replyCardIsTerminal(record) && record.phase !== 'ambiguous' && !record.pendingPatch && !record.publishPending)) {
          return { messageId: record.messageId, delivered: false, record };
        }
        if (replyCardIsTerminal(record) && record.pendingPatch) {
          await this.retryPendingPatchLocked(key, record, io);
          return { messageId: record.messageId, delivered: true, card: record.lastCard, record };
        }
        hideUndeliveredFinal = record.recoveryHideFinal ?? (!replyCardIsTerminal(record) || !!record.disconnected || !record.publishPending);
        event = !hideUndeliveredFinal
          ? { kind: 'refresh' }
          : { kind: 'terminal', phase: 'ambiguous', disconnected: true, orphanAskIds: event.orphanAskIds };
      }
      const displayRetirement = event.kind === 'display_retired';
      if (event.kind === 'display_retired') {
        if (!replyCardIsTerminal(record) || record.displayRetired) record.displayRetired = true;
        event = { kind: 'terminal', phase: record.finalDelivered ? 'completed' : 'ambiguous',
          ...(record.finalDelivered ? {} : { notice: event.notice }) };
      }
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
          if (record.displayRetired && record.phase === 'ambiguous') {
            record.phase = 'completed';
            delete record.disconnected;
          }
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
        if (!terminal || (record.displayRetired && (!displayRetirement || record.finalDelivered))) {
          // Publish a retirement notice with its terminal edge under one lock.
          // A duplicate retirement must never append progress after completion
          // or turn an already-delivered answer into a missing-output warning.
          if (!record.finalDelivered && event.notice?.trim() && record.progress.at(-1) !== event.notice) {
            record.progress.push(event.notice);
            record.activity.push({ kind: 'progress', id: `progress:${record.progress.length - 1}`, text: event.notice });
          }
          record.phase = record.phase === 'stopping' && event.phase === 'completed' ? 'cancelled' : event.phase;
          record.durationMs = event.durationMs;
          record.completedAtMs = event.completedAtMs;
          record.disconnected = event.disconnected;
          if (!displayRetirement && !recovering) delete record.displayRetired;
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
      if (record.omitImages && record.finalCard) record.finalCard = omitReplyCardImages(record.finalCard);
      // A pending payload belongs to the previous revision; never replay it
      // after newer state is persisted but rendering/attachment delivery fails.
      delete record.pendingPatch;
      record.publishPending = true;
      if (recovering) record.recoveryHideFinal = hideUndeliveredFinal;
      else delete record.recoveryHideFinal;
      this.write(key, record);
      // Retire an unshown merged turn under the publication lock. A delayed
      // start must not resurrect it, while an unknown POST still needs its
      // original UUID replayed and the resulting card patched to superseded.
      if (record.phase === 'superseded' && !record.messageId && !record.pendingCreate && !record.finalCard) {
        return { delivered: false, record };
      }
      const visible = record.mode === 'unified' || io.forceVisible || !!record.finalCard || terminal || event.kind === 'terminal';
      if (!visible) return { delivered: false, record };

      if (!record.messageId && record.nativeCot && !record.nativeCotReady) {
        if (!io.beforeCreate) throw new Error('Native thinking publication requires its ordering barrier');
        const nativeVisible = await io.beforeCreate();
        await io.beforeEffect();
        record.nativeCotReady = true;
        if (nativeVisible === true) record.nativeCotVisible = true;
        this.write(key, record);
      }

      const render = () => {
        const visibleRecord = hideUndeliveredFinal && !record.finalDelivered ? { ...record, finalCard: undefined } : record;
        const body = io.render(visibleRecord.displayRetired && visibleRecord.finalCard && visibleRecord.phase === 'ambiguous'
          ? { ...visibleRecord, phase: 'completed' } : visibleRecord);
        return record.omitImages ? omitReplyCardImages(body) : body;
      };
      // The display can retire before this turn ends (a newer turn replaced
      // it, a push failed, the channel was switched off, or a restart lost it).
      // Persist the hand-back so CLI senders, which cannot see the daemon's
      // display state, publish progress on the card again. Once the turn has
      // ended there is no progress left to hand back.
      if (record.nativeCotVisible && !replyCardIsTerminal(record) && io.nativeThinkingLive && !io.nativeThinkingLive()) {
        delete record.nativeCotVisible;
        record.nativeCotHandedBack = true;
        this.write(key, record);
      }
      let card = render();
      // A live native thinking display already carries passive progress. An
      // answer card is needed for a final, an error, an actionable Ask/Oncall
      // control, or a completed turn whose final did not go out separately.
      // Without a confirmed display the card keeps its fallback role. An
      // existing card and an uncertain POST keep their publication protocol.
      if (record.nativeCot && record.nativeCotVisible && !record.messageId && !record.pendingCreate && !record.finalCard
        && !io.forceVisible && !['failed', 'cancelled', 'ambiguous'].includes(record.phase)
        && !(record.asks ?? []).some(entry => !entry.result && !entry.ask.settled)) {
        if (record.phase === 'completed') {
          if (record.externalFinal) return { delivered: false, record };
        } else {
          const elements = JSON.parse(card).body?.elements ?? [];
          const hasOncallControl = elements.some((element: any) => element.element_id === 'botmux_oncall_group'
            || element.columns?.some((column: any) => column.element_id === 'botmux_oncall_group_column'));
          if (!hasOncallControl) return { delivered: false, record };
        }
      }
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
        card = render();
        if (turnReplyCardRequestBytes(card, record.chatId) > TURN_REPLY_CARD_MAX_BYTES) throw new Error('Reply-card summary exceeds size limit');
      }

      const imageFallback = { omitImages: record.omitImages === true };
      const publish = <T>(content: string, effect: (body: string) => Promise<T>): Promise<T> =>
        replyWithImageFallback(content, 'interactive', async body => {
          if (imageFallback.omitImages && !record.omitImages) {
            // Only a definitive rejection permits changing a pending POST.
            // Persist the downgrade before retrying: an unknown fallback result
            // must replay the same body/UUID, including after process recovery.
            record.omitImages = true;
            if (record.finalCard) record.finalCard = omitReplyCardImages(record.finalCard);
            if (record.pendingCreate) record.pendingCreate.content = omitReplyCardImages(record.pendingCreate.content);
            if (record.pendingPatch) record.pendingPatch.content = omitReplyCardImages(record.pendingPatch.content);
            card = omitReplyCardImages(card);
            this.write(key, record);
          }
          await io.beforeEffect();
          return effect(body);
        }, imageFallback);

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
          record.messageId = await publish(record.pendingCreate.content, body => io.send(body, `brc_${this.id(key)}`));
          if (!record.messageId) throw new Error('Missing reply-card message ID');
          record.lastCard = record.pendingCreate.content;
          delete record.pendingCreate;
          this.write(key, record);
        }
        if (record.lastCard !== card || io.forcePatch) {
          const messageId = record.messageId;
          record.pendingPatch = { content: card, final: !!record.finalCard && !(event.kind === 'terminal' && event.disconnected) };
          this.write(key, record);
          await publish(card, body => io.patch(messageId, body));
          record.lastCard = card;
        }
        delete record.pendingPatch;
        delete record.publishPending;
        delete record.recoveryHideFinal;
        if (record.finalCard && !(event.kind === 'terminal' && event.disconnected)) {
          record.finalDelivered = true;
          if (record.displayRetired && record.phase === 'ambiguous') {
            record.phase = 'completed';
            delete record.disconnected;
          }
        }
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

  /** The caller holds the publication lock; replay never uploads or creates. */
  private async retryPendingPatchLocked(key: TurnReplyCardKey, record: TurnReplyCardRecord, io: Pick<TurnReplyCardTransport, 'beforeEffect' | 'patch' | 'isWithdrawn'>): Promise<void> {
    const pending = record.pendingPatch!;
    const imageFallback = { omitImages: record.omitImages === true };
    try {
      await replyWithImageFallback(pending.content, 'interactive', async content => {
        if (imageFallback.omitImages && !record.omitImages) {
          record.omitImages = true;
          if (record.finalCard) record.finalCard = omitReplyCardImages(record.finalCard);
          pending.content = content;
          this.write(key, record);
        }
        await io.beforeEffect();
        await io.patch(record.messageId!, content);
      }, imageFallback);
      record.lastCard = pending.content;
      if (pending.final) {
        record.finalDelivered = true;
        if (record.displayRetired && record.phase === 'ambiguous') {
          record.phase = 'completed';
          delete record.disconnected;
        }
      }
      delete record.pendingPatch;
      delete record.publishPending;
      delete record.recoveryHideFinal;
      record.updatedAtMs = Date.now();
      this.write(key, record);
    } catch (error) {
      if (io.isWithdrawn(error)) {
        record.withdrawn = true;
        this.write(key, record);
        throw new ReplyCardWithdrawnError();
      }
      throw error;
    }
  }
}
