import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { containsLarkAtTag } from './send-policy.js';
import type { VcMeetingImTurnOrigin } from '../types.js';

export type SummaryShareResult =
  | { ok: true; messageId: string; chatId: string; replay: boolean }
  | { ok: false; errorCode: string };
interface ShareReceipt {
  key: string; hash: string; chatId: string; state: 'pending' | 'sent'; messageId?: string;
}

/** One explicit human turn authorizes one destination and one content hash.
 * Claim is durable BEFORE Lark I/O. Unknown writes never automatically resend:
 * the operator must reconcile the target before making a new human request.
 * No meeting text or capability is stored in this receipt. */
export async function shareVcMeetingSummary(input: {
  dataDir: string;
  origin: VcMeetingImTurnOrigin;
  content: string;
  assertAuthority: () => void;
  checkAccess: (chatId: string) => Promise<void>;
  send: (chatId: string, content: string, uuid: string) => Promise<string>;
}): Promise<SummaryShareResult> {
  input.assertAuthority();
  const { origin } = input;
  const chatId = origin.summaryShareTargetChatId;
  if (!chatId || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(chatId)
    || !origin.larkMessageId.startsWith('om_') || !origin.replyTargetSenderOpenId) {
    return { ok: false, errorCode: 'human_share_authorization_required' };
  }
  const content = input.content.trim();
  if (!content || content.length > 30000 || containsLarkAtTag(content)) {
    return { ok: false, errorCode: 'invalid_summary_content' };
  }
  const key = createHash('sha256').update(JSON.stringify([
    origin.agentAppId, origin.receiverSessionId, origin.listenerAppId, origin.meetingId,
    origin.memberId, origin.memberEpoch, origin.larkMessageId, origin.replyTargetSenderOpenId,
  ])).digest('hex');
  const hash = createHash('sha256').update(JSON.stringify([chatId, content])).digest('hex');
  const dir = join(input.dataDir, 'vc-meeting-summary-shares');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${key}.json`);
  const read = (): ShareReceipt | undefined => {
    if (!existsSync(path)) return undefined;
    const record = JSON.parse(readFileSync(path, 'utf8')) as ShareReceipt;
    if (record.key !== key || typeof record.hash !== 'string' || typeof record.chatId !== 'string'
      || (record.state !== 'pending' && record.state !== 'sent')
      || (record.state === 'sent' && (!record.messageId || typeof record.messageId !== 'string'))) {
      throw new Error('invalid_summary_share_receipt');
    }
    return record;
  };
  const replay = (record: ShareReceipt): SummaryShareResult => {
    if (record.hash !== hash) return { ok: false, errorCode: 'summary_share_content_conflict' };
    return record.state === 'sent'
      ? { ok: true, chatId, messageId: record.messageId!, replay: true }
      : { ok: false, errorCode: 'summary_share_result_unknown_check_target_before_retry' };
  };
  const previous = withFileLockSync(path, read);
  if (previous) return replay(previous);
  await input.checkAccess(chatId);
  input.assertAuthority();
  const claimed = withFileLockSync(path, () => {
    const prior = read();
    if (prior) return prior;
    atomicWriteFileSync(path, JSON.stringify({ key, hash, chatId, state: 'pending' }),
      { mode: 0o600, durable: true, followTargetSymlink: false });
    return undefined;
  });
  if (claimed) return replay(claimed);
  try {
    input.assertAuthority();
    const messageId = await input.send(chatId, content, `vcs_${key.slice(0, 40)}`);
    if (!messageId) throw new Error('missing_message_id');
    withFileLockSync(path, () => {
      const record = read();
      if (!record || record.hash !== hash || record.state !== 'pending') throw new Error('share_receipt_changed');
      atomicWriteFileSync(path, JSON.stringify({ ...record, state: 'sent', messageId }),
        { mode: 0o600, durable: true, followTargetSymlink: false });
    });
    return { ok: true, messageId, chatId, replay: false };
  } catch {
    return { ok: false, errorCode: 'summary_share_result_unknown_check_target_before_retry' };
  }
}
