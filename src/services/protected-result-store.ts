import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export interface ProtectedResultContext {
  appId: string;
  pluginId: string;
  sessionId: string;
  turnId: string;
  ownerUnionId: string;
  chatId: string;
  rootMessageId?: string;
  responseKind?: 'final' | 'auxiliary';
}
export interface ProtectedResultRecord {
  context: ProtectedResultContext;
  deliveryId: string;
  payloadDigest: string;
  status: 'pending' | 'delivered' | 'unknown' | 'aborted';
  messages: Array<{ messageId: string; kind: 'primary' | 'attachment' }>;
  resources: string[];
  acknowledgedTurns: string[];
  updatedAt: number;
}
interface ChatIndex {
  version: 1;
  chatId: string;
  deliveries: Record<string, ProtectedResultRecord>;
}
const MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,200}$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,200}$/;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_DELIVERIES = 2_000;
export const PROTECTED_RESULT_PLACEHOLDER = '[受保护的查询结果：仅可查询脱敏投递状态]';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function validateContext(context: ProtectedResultContext): void {
  if (!CHAT_ID.test(context.chatId) || !MESSAGE_ID.test(context.turnId)
    || !/^cli_[A-Za-z0-9_-]{1,100}$/.test(context.appId)
    || !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(context.pluginId)
    || !/^[A-Za-z0-9._-]{1,200}$/.test(context.sessionId)
    || !/^on_[A-Za-z0-9_-]{1,200}$/.test(context.ownerUnionId)
    || context.rootMessageId !== undefined && !MESSAGE_ID.test(context.rootMessageId)
    || context.responseKind !== undefined && !['final', 'auxiliary'].includes(context.responseKind)) {
    throw new Error('protected_result_invalid_context');
  }
}
function deliveryKey(context: ProtectedResultContext, deliveryId: string): string {
  validateContext(context);
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(deliveryId)) throw new Error('protected_result_invalid_delivery_id');
  return digest(JSON.stringify([context.appId, context.pluginId, context.sessionId,
    context.ownerUnionId, context.chatId, context.rootMessageId ?? '', deliveryId]));
}

/** Host-private provenance, shared across applications. Protection does not
 * expire with artifact retention: the provider message may still exist. A
 * pending/unknown write fences reads until reconciled; a timeout never opens it. */
export class ProtectedResultStore {
  private readonly root: string;
  constructor(dataDir: string, private readonly options: {
    now?: () => number;
    persist?: (path: string, content: string) => void;
  } = {}) {
    this.root = join(dataDir, 'protected-results-v1');
  }
  private path(chatId: string): string {
    if (!CHAT_ID.test(chatId)) throw new Error('protected_result_invalid_chat');
    return join(this.root, `${digest(chatId)}.json`);
  }
  private readPath(path: string): ChatIndex | undefined {
    let raw: string;
    try {
      const root = lstatSync(this.root);
      if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0
        || process.getuid && root.uid !== process.getuid()) throw new Error('protected_result_untrusted_store');
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INDEX_BYTES
        || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) {
        throw new Error('protected_result_untrusted_index');
      }
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const value = JSON.parse(raw) as ChatIndex;
    if (value.version !== 1 || !CHAT_ID.test(value.chatId)
      || !value.deliveries || typeof value.deliveries !== 'object' || Array.isArray(value.deliveries)
      || Object.keys(value.deliveries).length > MAX_DELIVERIES) throw new Error('protected_result_invalid_index');
    for (const [key, record] of Object.entries(value.deliveries)) {
      validateContext(record.context);
      if (record.context.chatId !== value.chatId || deliveryKey(record.context, record.deliveryId) !== key
        || !/^[a-f0-9]{64}$/.test(record.payloadDigest)
        || !['pending', 'delivered', 'unknown', 'aborted'].includes(record.status)
        || !Number.isFinite(record.updatedAt) || !Array.isArray(record.messages) || record.messages.length > 9
        || record.messages.some(message => !MESSAGE_ID.test(message.messageId)
          || !['primary', 'attachment'].includes(message.kind))
        || !Array.isArray(record.resources) || record.resources.length > 8
        || !Array.isArray(record.acknowledgedTurns) || record.acknowledgedTurns.length > 256
        || record.acknowledgedTurns.some(turn => !MESSAGE_ID.test(turn))
        || record.resources.some(resource => typeof resource !== 'string' || !/^[A-Za-z0-9_-]{1,300}$/.test(resource))) {
        throw new Error('protected_result_invalid_index');
      }
    }
    return value;
  }
  private mutate<T>(chatId: string, work: (index: ChatIndex) => T): T {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const root = lstatSync(this.root);
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0
      || process.getuid && root.uid !== process.getuid()) throw new Error('protected_result_untrusted_store');
    const path = this.path(chatId);
    return withFileLockSync(path, () => {
      const index = this.readPath(path) ?? { version: 1, chatId, deliveries: {} };
      const result = work(index);
      const content = JSON.stringify(index);
      if (Buffer.byteLength(content) > MAX_INDEX_BYTES) throw new Error('protected_result_index_full');
      if (this.options.persist) this.options.persist(path, content);
      else atomicWriteFileSync(path, content, { mode: 0o600, durable: true, followTargetSymlink: false });
      return result;
    }, { maxWaitMs: 2_000 });
  }
  begin(context: ProtectedResultContext, deliveryId: string, payloadDigest: string): { created: boolean; record: ProtectedResultRecord } {
    const key = deliveryKey(context, deliveryId);
    if (!/^[a-f0-9]{64}$/.test(payloadDigest)) throw new Error('protected_result_invalid_digest');
    return this.mutate(context.chatId, index => {
      const previous = index.deliveries[key];
      if (previous) {
        if (previous.payloadDigest !== payloadDigest
          || (previous.context.responseKind ?? 'final') !== (context.responseKind ?? 'final')) {
          throw new Error('protected_result_delivery_conflict');
        }
        if (previous.status === 'delivered' && !previous.acknowledgedTurns.includes(context.turnId)) {
          if (previous.acknowledgedTurns.length >= 256) throw new Error('protected_result_delivery_full');
          previous.acknowledgedTurns.push(context.turnId);
        }
        return { created: false, record: structuredClone(previous) };
      }
      if (Object.keys(index.deliveries).length >= MAX_DELIVERIES) throw new Error('protected_result_index_full');
      const record: ProtectedResultRecord = { context: { ...context }, deliveryId, payloadDigest,
        status: 'pending', messages: [], resources: [], acknowledgedTurns: [context.turnId], updatedAt: this.options.now?.() ?? Date.now() };
      index.deliveries[key] = record;
      return { created: true, record: structuredClone(record) };
    });
  }
  update(context: ProtectedResultContext, deliveryId: string, change: {
    message?: ProtectedResultRecord['messages'][number]; resource?: string; status?: ProtectedResultRecord['status'];
  }): void {
    const key = deliveryKey(context, deliveryId);
    this.mutate(context.chatId, index => {
      const record = index.deliveries[key];
      if (!record) throw new Error('protected_result_delivery_missing');
      if (change.status && !['pending', 'delivered', 'unknown', 'aborted'].includes(change.status)) {
        throw new Error('protected_result_invalid_status');
      }
      if (change.message) {
        if (!MESSAGE_ID.test(change.message.messageId) || !['primary', 'attachment'].includes(change.message.kind)) {
          throw new Error('protected_result_invalid_message');
        }
        const previous = record.messages.find(message => message.messageId === change.message!.messageId);
        if (!previous && record.status === 'delivered') throw new Error('protected_result_already_complete');
        if (previous && previous.kind !== change.message.kind) throw new Error('protected_result_message_conflict');
        if (!previous) record.messages.push({ ...change.message });
      }
      if (change.resource && !record.resources.includes(change.resource)) {
        if (record.status === 'delivered') throw new Error('protected_result_already_complete');
        if (!/^[A-Za-z0-9_-]{1,300}$/.test(change.resource)) throw new Error('protected_result_invalid_resource');
        record.resources.push(change.resource);
      }
      if (record.messages.length > 9 || record.resources.length > 8) throw new Error('protected_result_delivery_full');
      // A late failure cannot downgrade a confirmed completion.
      if (change.status && record.status !== 'delivered') record.status = change.status;
      if (change.status === 'delivered' && !record.messages.some(message => message.kind === 'primary')) {
        throw new Error('protected_result_primary_missing');
      }
      record.updatedAt = this.options.now?.() ?? Date.now();
    });
  }
  private indices(): ChatIndex[] {
    let names: string[];
    try {
      const root = lstatSync(this.root);
      if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0
        || process.getuid && root.uid !== process.getuid()) throw new Error('protected_result_untrusted_store');
      names = readdirSync(this.root);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .flatMap(name => { const value = this.readPath(join(this.root, name)); return value ? [value] : []; });
  }
  hasProtection(): boolean { return this.indices().some(index => Object.keys(index.deliveries).length > 0); }
  sessionHasProtection(appId: string, sessionId: string): boolean {
    return this.indices().some(index => Object.values(index.deliveries).some(record =>
      record.context.appId === appId && record.context.sessionId === sessionId && record.status !== 'aborted'));
  }
  completedFinal(appId: string, sessionId: string, turnId: string): string[] | undefined {
    const record = this.indices().flatMap(index => Object.values(index.deliveries)).find(record =>
      record.context.appId === appId && record.context.sessionId === sessionId && record.acknowledgedTurns.includes(turnId)
      && record.context.responseKind !== 'auxiliary'
      && record.status === 'delivered' && record.messages.some(message => message.kind === 'primary'));
    return record ? [...record.messages].sort((a, b) => Number(b.kind === 'primary') - Number(a.kind === 'primary'))
      .map(message => message.messageId) : undefined;
  }
  isProtected(messageId: string, chatId?: string): boolean {
    const indices = this.indices();
    return indices.some(index => Object.values(index.deliveries).some(record =>
      record.messages.some(message => message.messageId === messageId)
      || ['pending', 'unknown'].includes(record.status) && (!chatId || index.chatId === chatId)));
  }
  assertResourceReadable(messageId: string, resource: string, chatId?: string): void {
    if (this.isProtected(messageId, chatId) || this.indices().some(index =>
      Object.values(index.deliveries).some(record => record.resources.includes(resource)))) {
      throw new Error('protected_result_resource_read_denied');
    }
  }
  /** No card body, resource key, filename or raw structured content survives. */
  redactMessage(raw: any, fallbackChatId?: string): any {
    const messageId = raw?.message_id;
    const chatId = raw?.chat_id ?? fallbackChatId;
    const opaqueForward = raw?.msg_type === 'merge_forward' && this.hasProtection();
    const body = typeof raw?.body?.content === 'string' ? raw.body.content : '';
    const protectedResource = this.indices().some(index => Object.values(index.deliveries)
      .some(record => record.resources.some(resource => body.includes(resource))));
    if (!opaqueForward && !protectedResource && !this.isProtected(messageId, chatId)) return raw;
    return {
      message_id: messageId, ...(chatId ? { chat_id: chatId } : {}),
      ...(raw.root_id ? { root_id: raw.root_id } : {}),
      ...(raw.parent_id ? { parent_id: raw.parent_id } : {}),
      ...(raw.thread_id ? { thread_id: raw.thread_id } : {}),
      ...(typeof raw.deleted === 'boolean' ? { deleted: raw.deleted } : {}),
      create_time: raw.create_time, sender: raw.sender, msg_type: 'text',
      body: { content: JSON.stringify({ text: PROTECTED_RESULT_PLACEHOLDER }) },
    };
  }
  status(context: ProtectedResultContext, deliveryId: string) {
    const key = deliveryKey(context, deliveryId);
    const index = this.readPath(this.path(context.chatId));
    const record = index?.deliveries[key];
    if (!record) return { status: 'not_found' as const };
    return {
      status: record.status, deliveryId: record.deliveryId, chatId: record.context.chatId,
      ...(record.context.rootMessageId ? { rootMessageId: record.context.rootMessageId } : {}),
      messageIds: record.messages.map(message => message.messageId),
      attachmentCount: record.messages.filter(message => message.kind === 'attachment').length,
    };
  }
  statusForCaller(caller: Pick<ProtectedResultContext, 'appId' | 'sessionId' | 'ownerUnionId' | 'chatId'>,
    pluginId: string, deliveryId: string) {
    const index = this.readPath(this.path(caller.chatId));
    const matches = Object.values(index?.deliveries ?? {}).filter(record =>
      record.context.appId === caller.appId && record.context.sessionId === caller.sessionId
      && record.context.ownerUnionId === caller.ownerUnionId && record.context.pluginId === pluginId
      && record.deliveryId === deliveryId);
    if (matches.length !== 1) return { status: 'not_found' as const };
    return this.status(matches[0].context, deliveryId);
  }
}
