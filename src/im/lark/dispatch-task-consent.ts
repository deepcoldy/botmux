import { dispatchTaskDecisionDirectory } from '../../services/project-authority-paths.js';
import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import type { CardActionData } from './card-handler.js';
import { createDispatchReportBinding, verifyDispatchReportBinding, type DispatchReportBindingPayload } from '../../core/dispatch-report-binding.js';
import { updateDispatchRegistry } from '../../core/dispatch-registry.js';
import { withFileLock } from '../../utils/file-lock.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { deliverPendingDispatchUser, registerPendingDispatchUser } from '../../core/dispatch-user-delegation.js';

export const TASK_CONSENT_ACTION = 'dispatch_task_bytedcli';
const registryPath = (dataDir: string) => join(dataDir, 'orchestrate-dispatch.json');

type TaskDecision = 'approved' | 'denied';
type StoredTaskDecision = TaskDecision | 'pending';
type CardAvailability = (messageId: string) => Promise<boolean>;
type EffectiveBinding = Omit<DispatchReportBindingPayload, 'taskOwner'> & {
  taskOwner?: NonNullable<DispatchReportBindingPayload['taskOwner']> & { decision?: TaskDecision };
};

function decisionPath(dir: string, root: string) {
  if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(root)) throw new Error('invalid dispatch root');
  return join(dispatchTaskDecisionDirectory(dir), root + '.json');
}
function decisionSignature(secret: string, root: string, card: string, decision: StoredTaskDecision) {
  return createHmac('sha256', secret).update(JSON.stringify(['botmux.task-consent.v1', root, card, decision])).digest('base64url');
}
async function readJson(path: string) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readTaskDecision(dataDir: string, secret: string, root: string) {
  const record = await readJson(decisionPath(dataDir, root));
  return record?.cardId && ['approved', 'denied', 'pending'].includes(record.decision)
    && record.signature === decisionSignature(secret, root, record.cardId, record.decision)
    ? record as { cardId: string; decision: StoredTaskDecision } : undefined;
}

function writeTaskDecision(dataDir: string, secret: string, root: string, cardId: string, decision: StoredTaskDecision) {
  atomicWriteFileSync(decisionPath(dataDir, root), JSON.stringify({
    cardId, decision, signature: decisionSignature(secret, root, cardId, decision),
  }));
}

export async function readTaskBinding(
  dataDir: string, secret: string, root: string, isCardAvailable?: CardAvailability,
): Promise<EffectiveBinding | null> {
  const entries = await readJson(registryPath(dataDir));
  const binding = verifyDispatchReportBinding(secret, root, entries?.[root]?.reportBinding);
  if (!binding?.taskOwner) return binding;
  // The public routing record can be replayed. The actual decision, including
  // terminal revocation, lives outside every worker's filesystem grants.
  let record = await readTaskDecision(dataDir, secret, root);
  const checkCard = !!isCardAvailable && record?.decision === 'approved'
    && record.cardId === binding.taskOwner.consentMessageId;
  const available = !checkCard || await isCardAvailable!(binding.taskOwner.consentMessageId!);
  // Provider lookup can wait while the person revokes or another caller rotates
  // the card. Never publish the decision snapshot taken before that wait.
  if (checkCard) record = await readTaskDecision(dataDir, secret, root);
  // Replaying an older public route cannot undo a host-recorded revocation.
  // Approval belongs to one active card; pending rotation invalidates it.
  const decision = record?.decision === 'denied' ? 'denied'
    : record?.cardId === binding.taskOwner.consentMessageId && record?.decision === 'approved'
      && available ? 'approved' : undefined;
  return { ...binding, taskOwner: { ...binding.taskOwner, decision } };
}

/** Revalidate the exact source task at the signing and provider-write edges. */
export async function assertDispatchTaskApproved(
  input: Parameters<typeof registerPendingDispatchUser>[0] & { isCardAvailable?: CardAvailability },
): Promise<void> {
  const p = input.payload;
  const current = p.rootId ? await readTaskBinding(input.dataDir, input.secret, p.rootId, input.isCardAvailable) : null;
  const owner = current?.taskOwner;
  if (!p.taskConsent || !current || current.attachment
    || current.targetSessionId !== p.sourceSessionId || current.targetLarkAppId !== p.sourceAppId
    || current.targetChatId !== p.taskConsent.sourceChatId || current.targetScope !== 'thread'
    || owner?.openId !== p.authority.openId || p.authority.appId !== p.sourceAppId
    || owner.receivingChatId !== p.chatId || p.targetAppIds.length !== 1
    || owner.receivingAppId !== p.targetAppIds[0]
    || owner.consentMessageId !== p.taskConsent.cardId) throw new Error('dispatch_task_changed');
  if (owner.decision !== 'approved') {
    throw new Error(owner.decision === 'denied' ? 'task_consent_denied' : 'task_consent_pending');
  }
}

export async function deliverApprovedDispatchTask(
  input: Parameters<typeof registerPendingDispatchUser>[0] & {
    send: () => Promise<string>; isCardAvailable?: CardAvailability;
  },
): Promise<string> {
  const root = input.payload.rootId;
  if (!root) throw new Error('dispatch_task_changed');
  await assertDispatchTaskApproved(input);
  // Decision and registration have one order. Do not hold this lock while
  // waiting on provider I/O: a human must still be able to revoke promptly.
  const pending = await withFileLock(decisionPath(input.dataDir, root), async () => {
    await assertDispatchTaskApproved({ ...input, isCardAvailable: undefined });
    return registerPendingDispatchUser(input);
  });
  return deliverPendingDispatchUser({
    ...input,
    send: async () => { await assertDispatchTaskApproved(input); return input.send(); },
  }, pending);
}

/** Adopt a pre-upgrade workstream only after verifying the identity on its
 * first actual kickoff and its platform-observed source human message. */
export async function restoreDispatchTaskOwner(input: {
  dataDir: string; secret: string; binding: DispatchReportBindingPayload;
  owner: NonNullable<DispatchReportBindingPayload['taskOwner']>; sourceRootId: string;
  firstReply: () => Promise<string | undefined>;
  original: (messageId: string) => Promise<import('../../core/dispatch-user-delegation.js').DispatchUserPayload | undefined>;
  sourceMessage: (messageId: string) => Promise<any>;
}) {
  const { binding, owner } = input;
  const kickoff = await input.firstReply();
  if (!kickoff) return;
  const original = await input.original(kickoff);
  if (!original || original.domain !== 'botmux.dispatch-user.v1' || original.messageId !== kickoff
      || original.rootId !== binding.dispatchRoot || original.sourceSessionId !== binding.targetSessionId
      || original.sourceAppId !== binding.targetLarkAppId || original.authority.appId !== original.sourceAppId
      || original.authority.openId !== owner.openId || !original.authority.tools.includes('bytedcli')
      || original.targetAppIds.length !== 1 || original.targetAppIds[0] !== owner.receivingAppId
      || original.chatId !== owner.receivingChatId) return;
  const source = (await input.sourceMessage(original.sourceTurnId))?.items?.[0];
  if (source?.message_id !== original.sourceTurnId || source?.chat_id !== binding.targetChatId
      || (source?.root_id || source?.message_id) !== input.sourceRootId || source?.deleted
      || source?.sender?.sender_type !== 'user' || source.sender.id_type !== 'open_id'
      || source.sender.id !== owner.openId) return;
  await updateDispatchRegistry(registryPath(input.dataDir), entries => {
    const entry = entries[binding.dispatchRoot] as { reportBinding?: unknown } | undefined;
    const current = verifyDispatchReportBinding(input.secret, binding.dispatchRoot, entry?.reportBinding);
    if (!entry || !current || current.attachment || current.taskOwner || JSON.stringify(current) !== JSON.stringify(binding)) return;
    entry.reportBinding = createDispatchReportBinding(input.secret, { ...current, taskOwner: owner });
  });
  return readTaskBinding(input.dataDir, input.secret, binding.dispatchRoot);
}

export async function answerDispatchTaskConsent(dataDir: string, secret: string, appId: string, click: CardActionData) {
  const v = click.action?.value;
  if (v?.action !== TASK_CONSENT_ACTION || !/^om_[A-Za-z0-9_-]{1,128}$/.test(v.root || '')
      || (v.choice !== 'approve' && v.choice !== 'deny')) return false;
  await mkdir(dispatchTaskDecisionDirectory(dataDir), { recursive: true, mode: 0o700 });
  return withFileLock(decisionPath(dataDir, v.root), async () => {
    const current = await readTaskBinding(dataDir, secret, v.root);
    const owner = current?.taskOwner;
    if (!owner?.consentMessageId || current?.attachment || current?.targetLarkAppId !== appId
        || owner.openId !== click.operator?.open_id || current.targetChatId !== click.context?.open_chat_id
        || owner.consentMessageId !== click.context?.open_message_id) return false;
    const record = await readTaskDecision(dataDir, secret, v.root);
    const decision = v.choice === 'approve' ? 'approved' : 'denied';
    if ((record?.cardId && record.cardId !== owner.consentMessageId
        && !(decision === 'denied' && record.cardId === 'replacement:' + owner.consentMessageId))
        || (record?.decision === 'denied' && decision === 'approved')) return false;
    writeTaskDecision(dataDir, secret, v.root, owner.consentMessageId, decision);
    return true;
  });
}

/** Persist the exact provider prompt on the host-signed task. Other replicas,
 * subsequent human turns and restarts all read the same user decision. */
export async function confirmDispatchTask(input: {
  dataDir: string; secret: string; binding: DispatchReportBindingPayload;
  targetName?: string;
  send: (text: string, uuid: string) => Promise<string>;
  checkOrigin: () => Promise<void>;
  /** False only for a definitively unavailable original card; lookup errors throw. */
  isCardAvailable?: CardAvailability;
}): Promise<string> {
  const { binding } = input;
  const owner = binding.taskOwner!;
  const sameTask = (current: EffectiveBinding | null) => !!current && !current.attachment && !!current.taskOwner
    && current.targetSessionId === binding.targetSessionId && current.targetChatId === binding.targetChatId
    && current.targetLarkAppId === binding.targetLarkAppId && current.issuedAt === binding.issuedAt
    && current.taskOwner.openId === owner.openId && current.taskOwner.receivingAppId === owner.receivingAppId
    && current.taskOwner.receivingChatId === owner.receivingChatId;
  const ensureCard = async (): Promise<string> => {
    let current = await readTaskBinding(input.dataDir, input.secret, binding.dispatchRoot);
    if (!sameTask(current)) throw new Error('dispatch_task_changed');
    if (current!.taskOwner!.decision === 'denied') throw new Error('task_consent_denied');
    const previous = current!.taskOwner!.consentMessageId;
    // A half-finished rotation (process exit, failed card send, registry
    // write failure) leaves a pending decision whose card differs from the
    // routed one. When the old card becomes readable again, the early return
    // would strand the task: neither card accepts a callback and no replacement
    // is ever sent. Finish the rotation instead.
    const inflight = await readTaskDecision(input.dataDir, input.secret, binding.dispatchRoot);
    if (previous && (!inflight || inflight.cardId === previous)
        && (!input.isCardAvailable || await input.isCardAvailable(previous))) return previous;
    await mkdir(dispatchTaskDecisionDirectory(input.dataDir), { recursive: true, mode: 0o700 });
    const changed = await withFileLock(decisionPath(input.dataDir, binding.dispatchRoot), async () => {
      current = await readTaskBinding(input.dataDir, input.secret, binding.dispatchRoot);
      if (!sameTask(current)) throw new Error('dispatch_task_changed');
      if (current!.taskOwner!.decision === 'denied') throw new Error('task_consent_denied');
      if (current!.taskOwner!.consentMessageId !== previous) return true;
      // Invalidate the old approval before network I/O. A crash or a failed
      // route update then stays pending, never silently reusing the old card.
      const record = await readTaskDecision(input.dataDir, input.secret, binding.dispatchRoot);
      if (previous && (!record || record.cardId === previous)) {
        writeTaskDecision(input.dataDir, input.secret, binding.dispatchRoot, 'replacement:' + previous, 'pending');
      }
      return false;
    });
    if (changed) return ensureCard();
    await input.checkOrigin();
    const text = '是否授权本任务使用你的通用 bytedcli？\n接单机器人 ' + (input.targetName || owner.receivingAppId)
      + '（' + owner.receivingAppId + '）。\n任务：' + binding.sourceName
      + '\n授权范围包括你有权执行的 ByteCloud 读写操作，以及你在原话题对同一任务的后续派单。'
      + '只有发起人能在本消息授权；之后可在这里撤销后续派单。';
    const plain = (content: string) => ({ tag: 'plain_text', content });
    const button = (choice: string, label: string) => ({
      tag: 'button', text: plain(label), value: { action: TASK_CONSENT_ACTION, root: binding.dispatchRoot, choice },
    });
    const card = JSON.stringify({ header: { title: plain('授权本次跨群派单') }, elements: [
      { tag: 'div', text: plain(text) },
      { tag: 'action', actions: [button('approve', '授权本任务'), button('deny', '拒绝或撤销')] },
    ] });
    const uuid = createHash('sha256').update(JSON.stringify(['dispatch-consent', binding.dispatchRoot, owner.openId,
      owner.receivingAppId, text, previous ?? null])).digest('hex').slice(0, 32);
    const sent = await input.send(card, uuid);
    if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(sent)) throw new Error('dispatch_consent_unavailable');
    await input.checkOrigin();
    await withFileLock(decisionPath(input.dataDir, binding.dispatchRoot), async () => {
      current = await readTaskBinding(input.dataDir, input.secret, binding.dispatchRoot);
      if (!sameTask(current)) throw new Error('dispatch_task_changed');
      if (current!.taskOwner!.decision === 'denied') throw new Error('task_consent_denied');
      if (current!.taskOwner!.consentMessageId === sent) return;
      if (current!.taskOwner!.consentMessageId !== previous) throw new Error('dispatch_consent_race');
      // Host card identity is written first. Half completion cannot make the
      // public old card regain approval or permit an old callback to approve.
      writeTaskDecision(input.dataDir, input.secret, binding.dispatchRoot, sent, 'pending');
      await updateDispatchRegistry(registryPath(input.dataDir), registry => {
        const entry = registry[binding.dispatchRoot] as { reportBinding?: unknown } | undefined;
        const latest = verifyDispatchReportBinding(input.secret, binding.dispatchRoot, entry?.reportBinding);
        if (!entry || !sameTask(latest) || latest?.taskOwner?.consentMessageId !== previous) {
          throw new Error('dispatch_consent_race');
        }
        entry.reportBinding = createDispatchReportBinding(input.secret, {
          ...latest!, taskOwner: { ...latest!.taskOwner!, consentMessageId: sent },
        });
      });
    });
    if (!sent) throw new Error('dispatch_consent_unavailable');
    return sent;
  };
  let messageId = await ensureCard();
  const deadline = Date.now() + 90_000;
  do {
    await input.checkOrigin();
    const current = await readTaskBinding(input.dataDir, input.secret, binding.dispatchRoot);
    if (!sameTask(current)) throw new Error('dispatch_task_changed');
    if (current!.taskOwner!.decision === 'denied') throw new Error('task_consent_denied');
    if (current!.taskOwner!.consentMessageId !== messageId
      || input.isCardAvailable && !await input.isCardAvailable(messageId)) {
      messageId = await ensureCard();
      continue;
    }
    // The card lookup above can wait while the original callback revokes.
    // Re-read the host decision after it before returning an approval.
    const settled = await readTaskBinding(input.dataDir, input.secret, binding.dispatchRoot);
    if (!sameTask(settled)) throw new Error('dispatch_task_changed');
    if (settled!.taskOwner!.decision === 'denied') throw new Error('task_consent_denied');
    if (settled!.taskOwner!.consentMessageId !== messageId) continue;
    if (settled!.taskOwner!.decision === 'approved') return messageId;
    await delay(3000);
  } while (Date.now() < deadline);
  throw new Error('task_consent_pending');
}
