import type { OncallForwardMode } from './oncall-group-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export interface OncallGroupSource {
  appId: string;
  chatId: string;
  messageId: string;
  questionId: string;
  answer: string;
  sessionId?: string;
  rootId?: string;
  turnNumber?: number;
  acceptedAtMs?: number;
  cardJson?: string;
  nativeLink?: string;
  dispatchAttempt?: number;
}

export interface OncallGroupRequest {
  status: 'pending' | 'succeeded' | 'failed' | 'unknown';
  questionId?: string;
  sourceMessageId?: string;
  cardRefreshPending?: boolean;
  conversationScopePending?: boolean;
  flowId?: string;
  openChatId?: string;
  inviteLink?: string;
  submittedAtMs?: number;
  operatorOpenId?: string;
  forwarded?: string[];
  restrictedMessageIds?: string[];
  forwardMode?: OncallForwardMode;
  forwardedMessageIds?: Record<string, string>;
  attemptId?: string;
  messageIdsSnapshot?: string[];
  forwarding?: { messageId: string; messageIds?: string[]; startedAtMs: number };
  forwardingBlocked?: boolean;
  handoffError?: 'waiting_for_bot' | 'restricted_merge';
}

interface SessionEntry {
  appId?: string;
  sessionId?: string;
  chatId?: string;
  rootId?: string;
  turns: string[];
  messages?: string[];
  latest?: OncallGroupSource;
}

interface QuestionEntry { sources: OncallGroupSource[] }

export function pendingOncallMessageIds(request: OncallGroupRequest | undefined): string[] {
  return request?.messageIdsSnapshot?.filter(id => !request.forwarded?.includes(id) && !request.restrictedMessageIds?.includes(id)) ?? [];
}

/** Conversation forwarding that the 24-hour handoff window still owes. */
export function oncallForwardingPending(request: OncallGroupRequest): boolean {
  return request.handoffError !== 'restricted_merge'
    && (!!request.conversationScopePending || (request.forwardMode !== 'none' && !request.forwardingBlocked
      && pendingOncallMessageIds(request).length > 0));
}

function cardState(request: OncallGroupRequest): string {
  return JSON.stringify([request.status, request.openChatId, request.inviteLink, request.handoffError, request.conversationScopePending,
    request.restrictedMessageIds, pendingOncallMessageIds(request)]);
}

function digest(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function read<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; }
  catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error; }
}

export class OncallGroupStore {
  constructor(private readonly dataDir: string) {}

  private path(kind: string, ids: string[]): string {
    return join(this.dataDir, 'oncall-groups', kind, `${digest(ids)}.json`);
  }

  private write(file: string, value: unknown): void {
    atomicWriteFileSync(file, JSON.stringify(value), { mode: 0o600, durable: true });
  }

  recordSource(source: OncallGroupSource): void {
    const file = this.path('messages', [source.appId, source.messageId]);
    mkdirSync(join(this.dataDir, 'oncall-groups', 'messages'), { recursive: true, mode: 0o700 });
    withFileLockSync(file, () => {
      const previous = read<OncallGroupSource>(file);
      if (previous?.sessionId && source.sessionId && previous.sessionId !== source.sessionId) throw new Error('Oncall source session changed');
      if (previous && (previous.chatId !== source.chatId || previous.questionId !== source.questionId)) throw new Error('Oncall source question changed');
      // Non-final card updates re-index the same message without answer text.
      const recorded = previous ? { ...previous, ...Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)),
        answer: source.answer || previous.answer } as OncallGroupSource : source;
      const questionFile = this.path('questions', [source.appId, source.chatId, source.questionId]);
      mkdirSync(join(this.dataDir, 'oncall-groups', 'questions'), { recursive: true, mode: 0o700 });
      withFileLockSync(questionFile, () => {
        const sources = this.questionSources(source).filter(item => item.messageId !== source.messageId);
        sources.push(recorded);
        this.write(questionFile, { sources });
        this.markCardRefreshPending(source);
      });
      // Keep session publication order independent of the secondary question index.
      // All turns in this session share one handoff request.
      if (source.sessionId) this.session(source.appId, source.sessionId, state => {
        Object.assign(state, { appId: source.appId, sessionId: source.sessionId, chatId: source.chatId, ...(source.rootId ? { rootId: source.rootId } : {}) });
        state.messages ??= [];
        if (!state.messages.includes(source.messageId)) state.messages.push(source.messageId);
        const number = source.turnNumber ?? state.turns.indexOf(source.questionId) + 1;
        const latestNumber = state.latest?.turnNumber ?? 0;
        const newerPublication = state.messages.indexOf(source.messageId) >= state.messages.indexOf(state.latest?.messageId ?? '');
        if (!state.latest || number > latestNumber || (number === latestNumber && newerPublication)) {
          state.latest = { ...recorded, turnNumber: number };
        }
      });
      this.write(file, recorded);
    });
  }

  private session<T>(appId: string, sessionId: string, change: (state: SessionEntry) => T): T {
    const file = this.path('sessions', [appId, sessionId]);
    mkdirSync(join(this.dataDir, 'oncall-groups', 'sessions'), { recursive: true, mode: 0o700 });
    return withFileLockSync(file, () => {
      const state = read<SessionEntry>(file) ?? { turns: [] };
      const previous = JSON.stringify(state);
      const result = change(state);
      if (JSON.stringify(state) !== previous) this.write(file, state);
      return result;
    });
  }

  registerTurn(appId: string, sessionId: string, turnId: string, scope?: { chatId: string; rootId?: string }): number {
    return this.session(appId, sessionId, state => {
      if (scope) Object.assign(state, { appId, sessionId, ...scope });
      let index = state.turns.indexOf(turnId);
      if (index < 0) { index = state.turns.length; state.turns.push(turnId); }
      return index + 1;
    });
  }

  latest(appId: string, sessionId: string): OncallGroupSource | undefined {
    return read<SessionEntry>(this.path('sessions', [appId, sessionId]))?.latest;
  }

  pendingHandoffs(appId: string): OncallGroupSource[] {
    const sources = new Map<string, OncallGroupSource>();
    const legacyFiles = new Map<string, Set<string>>();
    for (const kind of ['questions', 'messages', 'sessions']) {
      let files: string[];
      try { files = readdirSync(join(this.dataDir, 'oncall-groups', kind)); }
      catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
      for (const file of files.filter(file => file.endsWith('.json'))) {
        const entry = read<OncallGroupSource & SessionEntry & QuestionEntry>(join(this.dataDir, 'oncall-groups', kind, file));
        const candidates = kind === 'questions' ? entry?.sources ?? [] : kind === 'sessions' ? entry?.latest ? [entry.latest] : [] : entry ? [entry] : [];
        for (const source of candidates) if (source.appId === appId && source.questionId && source.chatId) {
          const key = this.requestStatePath(source);
          sources.set(key, source);
          if (source.sessionId) legacyFiles.set(key, (legacyFiles.get(key) ?? new Set()).add(this.path('requests', [appId, source.chatId, source.questionId])));
        }
      }
    }
    let requests: Set<string>;
    try { requests = new Set(readdirSync(join(this.dataDir, 'oncall-groups', 'requests')).map(name => join(this.dataDir, 'oncall-groups', 'requests', name))); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; requests = new Set(); }
    // Expanding a whole session is only needed when one of its questions has an old request to adopt.
    return [...sources].filter(([key, source]) => {
      const request = read<OncallGroupRequest>(key)
        ?? ([...legacyFiles.get(key) ?? []].some(file => requests.has(file)) ? this.legacyRequest(source) : undefined);
      return request?.status === 'succeeded'
        && (((!request.inviteLink || request.cardRefreshPending) && !!request.openChatId)
          || (Date.now() - (request.submittedAtMs ?? 0) < 24 * 60 * 60_000
            && (!!request.cardRefreshPending || oncallForwardingPending(request))));
    }).map(([, source]) => source);
  }

  isLatest(source: OncallGroupSource): boolean {
    return !source.sessionId || this.latest(source.appId, source.sessionId)?.messageId === source.messageId;
  }

  questionSources(source: OncallGroupSource): OncallGroupSource[] {
    const question = read<QuestionEntry>(this.path('questions', [source.appId, source.chatId, source.questionId]));
    if (question) {
      const sources = question.sources.filter(item => item.appId === source.appId && item.chatId === source.chatId && item.questionId === source.questionId);
      return sources.some(item => item.messageId === source.messageId) ? sources : [...sources, source];
    }
    const state = source.sessionId ? read<SessionEntry>(this.path('sessions', [source.appId, source.sessionId])) : undefined;
    const sources = new Map<string, OncallGroupSource>();
    for (const id of [...(state?.messages ?? []), source.messageId]) {
      const candidate = this.findSource(source.appId, id);
      if (candidate?.chatId === source.chatId && candidate.questionId === source.questionId) sources.set(id, candidate);
    }
    if (!sources.has(source.messageId)) sources.set(source.messageId, source);
    return [...sources.values()];
  }

  sessionSources(source: OncallGroupSource): OncallGroupSource[] {
    if (!source.sessionId) return this.questionSources(source);
    const sources = new Map<string, OncallGroupSource>();
    const state = read<SessionEntry>(this.path('sessions', [source.appId, source.sessionId]));
    const add = (candidate: OncallGroupSource | undefined) => {
      if (candidate?.appId === source.appId && candidate.chatId === source.chatId && candidate.sessionId === source.sessionId) sources.set(candidate.messageId, candidate);
    };
    for (const id of state?.messages ?? []) add(this.findSource(source.appId, id));
    add(state?.latest);
    // The question index also recovers an interrupted session-index write.
    let files: string[];
    try { files = readdirSync(join(this.dataDir, 'oncall-groups', 'questions')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; files = []; }
    for (const file of files.filter(name => name.endsWith('.json'))) {
      for (const candidate of read<QuestionEntry>(join(this.dataDir, 'oncall-groups', 'questions', file))?.sources ?? []) add(candidate);
    }
    add(source);
    return [...sources.values()];
  }

  messageIds(source: OncallGroupSource): string[] {
    const state = source.sessionId ? read<SessionEntry>(this.path('sessions', [source.appId, source.sessionId])) : undefined;
    const sources = this.sessionSources(source);
    const turns = [...new Set([...(state?.turns ?? []), ...sources.map(item => item.questionId)])];
    return [...new Set(turns.flatMap(turn => [turn, ...sources.filter(item => item.questionId === turn).map(item => item.messageId)]))]
      .filter(id => /^om_[a-zA-Z0-9]+$/.test(id));
  }

  otherSessionScope(source: OncallGroupSource): { messages: Set<string>; starts: Set<string> } {
    const ids = new Set<string>();
    const starts = new Set<string>();
    let files: string[];
    try { files = readdirSync(join(this.dataDir, 'oncall-groups', 'sessions')); }
    catch (error: any) { if (error.code === 'ENOENT') return { messages: ids, starts }; throw error; }
    for (const file of files.filter(name => name.endsWith('.json'))) {
      const entry = read<SessionEntry>(join(this.dataDir, 'oncall-groups', 'sessions', file));
      const scope = entry?.appId ? entry : entry?.latest;
      if (scope?.appId === source.appId && scope.chatId === source.chatId && scope.sessionId !== source.sessionId) {
        if (entry?.turns[0] && scope.rootId === source.rootId) starts.add(entry.turns[0]);
        for (const id of [...(entry?.turns ?? []), ...(entry?.messages ?? [])]) ids.add(id);
      }
    }
    return { messages: ids, starts };
  }

  findSource(appId: string, messageId: string): OncallGroupSource | undefined {
    const indexed = read<OncallGroupSource>(this.path('messages', [appId, messageId]));
    if (indexed) return indexed;
    // Recover an interrupted secondary-index write from question or legacy
    // session records, including a historical card that is no longer latest.
    for (const kind of ['questions', 'sessions']) {
      let files: string[];
      try { files = readdirSync(join(this.dataDir, 'oncall-groups', kind)); }
      catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
      for (const file of files.filter(name => name.endsWith('.json'))) {
        const entry = read<QuestionEntry & SessionEntry>(join(this.dataDir, 'oncall-groups', kind, file));
        const sources = kind === 'questions' ? entry?.sources ?? [] : entry?.latest ? [entry.latest] : [];
        const found = sources.find(item => item.appId === appId && item.messageId === messageId);
        if (found) return found;
      }
    }
    return undefined;
  }

  private requestPath(source: OncallGroupSource): string {
    return source.sessionId ? this.path('session-requests', [source.appId, source.sessionId])
      : this.path('requests', [source.appId, source.chatId, source.questionId]);
  }

  private requestStatePath(source: OncallGroupSource): string {
    return this.requestPath(source);
  }

  handoffKey(source: OncallGroupSource): string {
    return digest([this.requestPath(source)]);
  }

  getRequest(source: OncallGroupSource): OncallGroupRequest | undefined {
    return read(this.requestPath(source)) ?? this.legacyRequest(source);
  }

  private legacyRequest(source: OncallGroupSource): OncallGroupRequest | undefined {
    if (!source.sessionId) return undefined;
    const records = [...new Set(this.sessionSources(source).map(item => item.questionId))]
      .map(id => read<OncallGroupRequest>(this.path('requests', [source.appId, source.chatId, id])))
      .filter((item): item is OncallGroupRequest => !!item && item.status !== 'failed');
    if (!records.length) return undefined;
    if (records.length > 1) {
      const groups = new Set(records.map(item => item.openChatId).filter(Boolean));
      if (groups.size > 1 || records.some(item => item.status !== 'succeeded')) return { status: 'unknown' };
    }
    // Adopt a proven per-question result without creating a second group.
    // Expand the frozen snapshot once, at its original submission time; receipts
    // are preserved so already delivered messages are never sent again.
    const uncertain = records.filter(item => item.forwarding);
    // Distinct uncertain attempts cannot share one UUID. Keep them blocked
    // for reconciliation rather than silently discarding a delivery identity.
    if (uncertain.length > 1) return { status: 'unknown' };
    const chosen = uncertain[0] ?? [...records].sort((a, b) => (b.submittedAtMs ?? 0) - (a.submittedAtMs ?? 0))[0]!;
    if (chosen.status !== 'succeeded' && !chosen.attemptId) return { status: 'unknown' };
    // Records written before conversation forwarding existed never forwarded anything.
    const forwardMode = chosen.forwardMode ?? 'none';
    return { ...chosen, forwardMode,
      ...(records.length > 1 ? {
        submittedAtMs: Math.max(...records.map(item => item.submittedAtMs ?? 0)) || chosen.submittedAtMs,
        messageIdsSnapshot: [...new Set(records.flatMap(item => item.messageIdsSnapshot ?? []))],
        forwarded: [...new Set(records.flatMap(item => item.forwarded ?? []))],
        restrictedMessageIds: [...new Set(records.flatMap(item => item.restrictedMessageIds ?? []))],
        forwardedMessageIds: Object.assign({}, ...records.map(item => item.forwardedMessageIds)),
      } : {}),
      cardRefreshPending: chosen.status === 'succeeded' || chosen.cardRefreshPending,
      conversationScopePending: chosen.status === 'succeeded' && forwardMode !== 'none' };
  }

  claim(source: OncallGroupSource, operatorOpenId?: string, snapshot?: { messageIds: string[]; cutoffMs: number; forwardMode?: OncallForwardMode }): boolean {
    const file = this.requestPath(source);
    mkdirSync(join(this.dataDir, 'oncall-groups', source.sessionId ? 'session-requests' : 'requests'), { recursive: true, mode: 0o700 });
    return withFileLockSync(file, () => {
      const previous = read<OncallGroupRequest>(file) ?? this.legacyRequest(source);
      // A crashed or timed-out request may already have created a group.
      if (previous && previous.status !== 'failed') return false;
      this.write(file, { status: 'pending', questionId: source.questionId, sourceMessageId: source.messageId, ...(source.sessionId ? {
        attemptId: randomUUID(), submittedAtMs: snapshot?.cutoffMs ?? Date.now(), messageIdsSnapshot: snapshot?.forwardMode === 'none' ? [] : snapshot?.messageIds ?? this.messageIds(source), forwardMode: snapshot?.forwardMode ?? 'individual',
      } : {}), ...(operatorOpenId ? { operatorOpenId, submittedAtMs: snapshot?.cutoffMs ?? Date.now() } : {}) });
      return true;
    });
  }

  finish(source: OncallGroupSource, result: OncallGroupRequest, attemptId?: string): void {
    const file = this.requestStatePath(source);
    mkdirSync(join(this.dataDir, 'oncall-groups', source.sessionId ? 'session-requests' : 'requests'), { recursive: true, mode: 0o700 });
    withFileLockSync(file, () => {
      const previous = read<OncallGroupRequest>(file) ?? this.legacyRequest(source);
      if (source.sessionId && (!attemptId || previous?.attemptId !== attemptId)) throw new Error('Oncall request ownership changed');
      if (previous?.status === 'succeeded' && result.status !== 'succeeded') return;
      if (previous?.status === 'unknown' && result.status === 'failed') return;
      if (previous?.openChatId && result.openChatId && previous.openChatId !== result.openChatId) throw new Error('Oncall session is already bound to a different group');
      const next = { ...previous, ...result };
      if (next.status === 'succeeded'
        && (!previous || cardState(previous) !== cardState(next))) next.cardRefreshPending = true;
      mkdirSync(join(this.dataDir, 'oncall-groups', source.sessionId ? 'session-requests' : 'requests'), { recursive: true, mode: 0o700 });
      this.write(file, next);
    });
  }

  private markCardRefreshPending(source: OncallGroupSource): void {
    const file = this.requestStatePath(source);
    if (this.getRequest(source)?.status !== 'succeeded') return;
    mkdirSync(join(this.dataDir, 'oncall-groups', source.sessionId ? 'session-requests' : 'requests'), { recursive: true, mode: 0o700 });
    withFileLockSync(file, () => {
      const current = read<OncallGroupRequest>(file) ?? this.legacyRequest(source);
      if (current?.status === 'succeeded') this.write(file, { ...current, cardRefreshPending: true });
    });
  }

  markCardsRefreshed(source: OncallGroupSource, expected: OncallGroupRequest, messageIds?: string[]): void {
    const publicationFile = source.sessionId ? this.path('sessions', [source.appId, source.sessionId]) : this.path('questions', [source.appId, source.chatId, source.questionId]);
    mkdirSync(join(this.dataDir, 'oncall-groups', source.sessionId ? 'sessions' : 'questions'), { recursive: true, mode: 0o700 });
    const file = this.requestStatePath(source);
    mkdirSync(join(this.dataDir, 'oncall-groups', source.sessionId ? 'session-requests' : 'requests'), { recursive: true, mode: 0o700 });
    withFileLockSync(publicationFile, () => withFileLockSync(file, () => {
      if (messageIds && JSON.stringify([...messageIds].sort()) !== JSON.stringify(this.sessionSources(source).map(item => item.messageId).sort())) return;
      const current = read<OncallGroupRequest>(file) ?? this.legacyRequest(source);
      if (!current || current.attemptId !== expected.attemptId || cardState(current) !== cardState(expected)) return;
      mkdirSync(join(this.dataDir, 'oncall-groups', source.sessionId ? 'session-requests' : 'requests'), { recursive: true, mode: 0o700 });
      this.write(file, { ...current, cardRefreshPending: false });
    }));
  }
}
