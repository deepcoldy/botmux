import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { withFileLockSync } from '../../../utils/file-lock.js';
import { parseCaptureAttachments, type CaptureAttachment } from './attachments.js';

export interface InputBinding {
  id: string; revision: number; active: boolean; larkAppId: string; sessionId: string;
  chatId: string; anchor: string; sourceAnchor: string; ownerOpenId: string; pluginId: string;
  requestId: string; providerRef: string; createdAt: string;
  captureAttachments?: boolean;
  inputThreadId?: string;
}
export interface CapturedInput {
  id: string; bindingId: string; sequence: number; messageId: string;
  senderOpenId: string; text: string; receivedAt: string;
  attachments?: CaptureAttachment[];
  threadId?: string;
  delivery: 'pending' | 'acknowledged'; acknowledgedAt?: string;
}
export interface CaptureJournal {
  schemaVersion: 1 | 2 | 3; larkAppId: string; bindings: InputBinding[]; inputs: CapturedInput[];
}
export interface CaptureSnapshot {
  state: CaptureJournal;
  bindingsById: Map<string, InputBinding>;
  threadsByBinding: Map<string, Set<string>>;
  inputCounts: Map<string, number>;
}
export const captureDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Host-owned journal. Full fsync precedes ingress acknowledgement. Revocation
 * retains accepted inputs and tombstones; reads neither expire nor consume. */
export function createInputCaptureStore(dataDir: string, larkAppId: string) {
  const file = join(dataDir, 'input-capture-v1', captureDigest(larkAppId) + '.json');
  const empty = (): CaptureJournal => ({ schemaVersion: 1, larkAppId, bindings: [], inputs: [] });
  const readIndexed = (): CaptureSnapshot => {
    const state: CaptureJournal = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : empty();
    if (![1, 2, 3].includes(state.schemaVersion) || state.larkAppId !== larkAppId
      || !Array.isArray(state.bindings) || !Array.isArray(state.inputs)) throw new Error('input_capture_journal_invalid');
    const bindingsById = new Map<string, InputBinding>();
    const threadsByBinding = new Map<string, Set<string>>();
    for (const b of state.bindings) {
      if (b.larkAppId !== larkAppId || !b.id || bindingsById.has(b.id) || typeof b.active !== 'boolean'
        || !Number.isSafeInteger(b.revision) || b.revision < 1
        || !b.sessionId || !b.chatId || !b.anchor || !b.sourceAnchor || !b.ownerOpenId || !b.pluginId || !b.requestId
        || typeof b.providerRef !== 'string'
        || b.captureAttachments !== undefined && typeof b.captureAttachments !== 'boolean'
        || b.captureAttachments === true && state.schemaVersion < 2
        || b.inputThreadId !== undefined && (typeof b.inputThreadId !== 'string'
          || !/^omt_[A-Za-z0-9_-]{1,196}$/.test(b.inputThreadId) || !/^om_[A-Za-z0-9_-]+$/.test(b.anchor)
          || state.schemaVersion !== 3)) throw new Error('input_capture_journal_invalid');
      bindingsById.set(b.id, b);
      threadsByBinding.set(b.id, new Set(b.inputThreadId ? [b.inputThreadId] : []));
    }
    const events = new Set<string>(); const sequences = new Map<string, number>();
    for (const input of state.inputs) {
      const sequence = (sequences.get(input.bindingId) ?? 0) + 1;
      if (!bindingsById.has(input.bindingId) || !input.id || events.has(input.id) || input.sequence !== sequence
        || !input.messageId || !input.senderOpenId || typeof input.text !== 'string'
        || !['pending', 'acknowledged'].includes(input.delivery)) throw new Error('input_capture_journal_invalid');
      events.add(input.id); sequences.set(input.bindingId, sequence);
      const attachments = parseCaptureAttachments(input.attachments);
      const binding = bindingsById.get(input.bindingId)!;
      if (input.threadId !== undefined && (typeof input.threadId !== 'string'
        || !/^omt_[A-Za-z0-9_-]{1,196}$/.test(input.threadId) || !/^om_[A-Za-z0-9_-]+$/.test(binding.anchor)
        || state.schemaVersion !== 3 || binding.inputThreadId && binding.inputThreadId !== input.threadId)) {
        throw new Error('input_capture_journal_invalid');
      }
      if (input.threadId) threadsByBinding.get(input.bindingId)!.add(input.threadId);
      if (attachments.length && binding.captureAttachments !== true) {
        throw new Error('input_capture_journal_invalid');
      }
    }
    const aliases = new Set<string>();
    for (const binding of state.bindings) {
      const threads = threadsByBinding.get(binding.id)!;
      if (threads.size > 1) throw new Error('input_capture_journal_invalid');
      if (!binding.active || !threads.size) continue;
      const alias = JSON.stringify([binding.chatId, binding.ownerOpenId, [...threads][0]]);
      if (aliases.has(alias)) throw new Error('input_capture_journal_invalid');
      aliases.add(alias);
    }
    return { state, bindingsById, threadsByBinding, inputCounts: sequences };
  };
  return {
    read: () => readIndexed().state,
    readIndexed,
    transact<T>(change: (state: CaptureJournal, snapshot: CaptureSnapshot) => T): T {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      return withFileLockSync(file, () => {
        const snapshot = readIndexed(); const { state } = snapshot; const before = JSON.stringify(state);
        const result = change(state, snapshot);
        if (JSON.stringify(state) !== before) atomicWriteFileSync(file, JSON.stringify(state), {
          durable: true, mode: 0o600, followTargetSymlink: false,
        });
        return structuredClone(result);
      }, { maxWaitMs: 1000 });
    },
  };
}
