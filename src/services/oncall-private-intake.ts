import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export interface OncallPrivateIntake {
  appId: string;
  groupChatId: string;
  groupMessageId: string;
  chatId: string;
  rootMessageId: string;
  ownerOpenId: string;
  createdAtMs: number;
}
interface IntakeThread extends OncallPrivateIntake {
  replyMessageIds?: string[];
}

interface IntakeDelivery {
  groupMessageId: string;
  startedAtMs: number;
  binding?: OncallPrivateIntake;
  finished?: boolean;
}

const RECEIPT_WAIT_MS = 60_000;

function key(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function privateIntakeDeliveryId(appId: string, messageId: string): string {
  return key('oncall-private-intake', appId, messageId).slice(0, 40);
}

export class OncallPrivateIntakeStore {
  constructor(private readonly dataDir: string) {}

  private path(appId: string, chatId: string): string {
    return join(this.dataDir, 'oncall-private-intake', key(appId, chatId) + '.json');
  }

  private deliveryPath(appId: string, ownerOpenId: string): string {
    return this.path(appId, 'owner:' + ownerOpenId);
  }

  private read<T>(path: string): T[] {
    try { return JSON.parse(readFileSync(path, 'utf8')) as T[]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private update<T, R>(file: string, transform: (rows: T[]) => R): R {
    mkdirSync(join(this.dataDir, 'oncall-private-intake'), { recursive: true, mode: 0o700 });
    return withFileLockSync(file, () => {
      const rows = this.read<T>(file);
      const before = JSON.stringify(rows);
      const result = transform(rows);
      const after = JSON.stringify(rows);
      if (after !== before) atomicWriteFileSync(file, after, { mode: 0o600, durable: true });
      return result;
    });
  }

  findDelivery(appId: string, ownerOpenId: string | undefined, groupMessageId: string): IntakeDelivery | undefined {
    if (!ownerOpenId?.startsWith('ou_') || !groupMessageId?.startsWith('om_')) return;
    return this.read<IntakeDelivery>(this.deliveryPath(appId, ownerOpenId))
      .find(item => item.groupMessageId === groupMessageId);
  }

  awaitingReceipt(appId: string, ownerOpenId: string | undefined, messageCreatedAt?: string): boolean {
    if (!ownerOpenId?.startsWith('ou_')) return false;
    const now = Date.now();
    const receivedAt = Number(messageCreatedAt) || now;
    return this.read<IntakeDelivery>(this.deliveryPath(appId, ownerOpenId)).some(item =>
      !item.binding && (now < item.startedAtMs + RECEIPT_WAIT_MS
        || (receivedAt >= item.startedAtMs && receivedAt < item.startedAtMs + RECEIPT_WAIT_MS)));
  }

  beginDelivery(appId: string, ownerOpenId: string, groupMessageId: string): OncallPrivateIntake | undefined {
    return this.update<IntakeDelivery, OncallPrivateIntake | undefined>(this.deliveryPath(appId, ownerOpenId), rows => {
      const existing = rows.find(item => item.groupMessageId === groupMessageId);
      if (existing) {
        if (!existing.finished) existing.startedAtMs = Date.now();
        return existing.binding;
      }
      rows.push({ groupMessageId, startedAtMs: Date.now() });
    });
  }

  record(binding: OncallPrivateIntake): OncallPrivateIntake {
    if (!binding.chatId.startsWith('oc_') || binding.chatId === binding.groupChatId
      || !binding.groupChatId.startsWith('oc_') || !binding.groupMessageId.startsWith('om_')
      || !binding.ownerOpenId.startsWith('ou_') || !binding.rootMessageId.startsWith('om_')) {
      throw new Error('私聊接待缺少可信投递回执');
    }
    const verified = this.update<IntakeThread, OncallPrivateIntake>(this.path(binding.appId, binding.chatId), records => {
      const same = records.find(item => item.rootMessageId === binding.rootMessageId || item.groupMessageId === binding.groupMessageId);
      if (same) {
        if (same.groupChatId !== binding.groupChatId || same.groupMessageId !== binding.groupMessageId
          || same.ownerOpenId !== binding.ownerOpenId) {
          throw new Error('私聊接待归属已变化');
        }
        const { replyMessageIds: _, ...verified } = same;
        return verified;
      }
      records.push(binding);
      return binding;
    });
    this.update<IntakeDelivery, void>(this.deliveryPath(binding.appId, binding.ownerOpenId), rows => {
      const delivery = rows.find(item => item.groupMessageId === binding.groupMessageId);
      if (delivery) delivery.binding = verified;
    });
    return verified;
  }

  finishDelivery(binding: OncallPrivateIntake): void {
    this.update<IntakeDelivery, void>(this.deliveryPath(binding.appId, binding.ownerOpenId), rows => {
      const delivery = rows.find(item => item.groupMessageId === binding.groupMessageId);
      if (delivery?.binding) delivery.finished = true;
    });
  }

  isStarting(binding: OncallPrivateIntake): boolean {
    const delivery = this.findDelivery(binding.appId, binding.ownerOpenId, binding.groupMessageId);
    return !!delivery && !delivery.finished && Date.now() < delivery.startedAtMs + RECEIPT_WAIT_MS;
  }

  recordReply(binding: OncallPrivateIntake, messageId: string): void {
    if (!messageId.startsWith('om_') || messageId === binding.rootMessageId) return;
    this.update<IntakeThread, void>(this.path(binding.appId, binding.chatId), records => {
      const target = records.find(item => item.rootMessageId === binding.rootMessageId
        && item.ownerOpenId === binding.ownerOpenId);
      if (!target) throw new Error('私聊咨询已失去来源绑定');
      if (!target.replyMessageIds?.includes(messageId)) (target.replyMessageIds ??= []).push(messageId);
    });
  }

  find(appId: string, chatId: string, rootMessageId: string | undefined): OncallPrivateIntake | undefined {
    if (!rootMessageId || !chatId.startsWith('oc_')) return;
    const record = this.read<IntakeThread>(this.path(appId, chatId)).find(binding => binding.appId === appId
      && binding.chatId === chatId && (binding.rootMessageId === rootMessageId || binding.replyMessageIds?.includes(rootMessageId)));
    if (record) {
      const { replyMessageIds: _, ...binding } = record;
      return binding;
    }
  }
}
