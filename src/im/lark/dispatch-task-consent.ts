import { dispatchTaskDecisionDirectory } from '../../services/project-authority-paths.js';
import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import type { CardActionData } from './card-handler.js';
import { createDispatchReportBinding, verifyDispatchReportBinding, type DispatchReportBindingPayload } from '../../core/dispatch-report-binding.js';
import { updateDispatchRegistry } from '../../core/dispatch-registry.js';

export const TASK_CONSENT_ACTION = 'dispatch_task_bytedcli';
const registryPath = (dataDir: string) => join(dataDir, 'orchestrate-dispatch.json');

type TaskDecision = 'approved' | 'denied';
type EffectiveBinding = Omit<DispatchReportBindingPayload, 'taskOwner'> & {
  taskOwner?: NonNullable<DispatchReportBindingPayload['taskOwner']> & { decision?: TaskDecision };
};

function decisionPath(dir: string, root: string) {
  if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(root)) throw new Error('invalid dispatch root');
  return join(dispatchTaskDecisionDirectory(dir), root + '.json');
}
function decisionSignature(secret: string, root: string, card: string, decision: TaskDecision) {
  return createHmac('sha256', secret).update(JSON.stringify(['botmux.task-consent.v1', root, card, decision])).digest('base64url');
}
async function readJson(path: string) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readTaskBinding(dataDir: string, secret: string, root: string): Promise<EffectiveBinding | null> {
  const entries = await readJson(registryPath(dataDir));
  const binding = verifyDispatchReportBinding(secret, root, entries?.[root]?.reportBinding);
  if (!binding?.taskOwner?.consentMessageId) return binding;
  // The public routing record can be replayed. The actual decision, including
  // terminal revocation, lives outside every worker's filesystem grants.
  const record = await readJson(decisionPath(dataDir, root));
  const decision = record?.cardId === binding.taskOwner.consentMessageId
    && (record.decision === 'approved' || record.decision === 'denied')
    && record.signature === decisionSignature(secret, root, record.cardId, record.decision) ? record.decision : undefined;
  return { ...binding, taskOwner: { ...binding.taskOwner, decision } };
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
  const current = await readTaskBinding(dataDir, secret, v.root);
  const owner = current?.taskOwner;
  if (!owner?.consentMessageId || current?.attachment || current?.targetLarkAppId !== appId
      || owner.openId !== click.operator?.open_id || current.targetChatId !== click.context?.open_chat_id
      || owner.consentMessageId !== click.context?.open_message_id) return false;
  await mkdir(dispatchTaskDecisionDirectory(dataDir), { recursive: true, mode: 0o700 });
  let accepted = false;
  await updateDispatchRegistry(decisionPath(dataDir, v.root), record => {
    const decision = v.choice === 'approve' ? 'approved' : 'denied';
    if ((record.cardId && record.cardId !== owner.consentMessageId)
        || (record.decision === 'denied' && decision === 'approved')) return;
    record.cardId = owner.consentMessageId;
    record.decision = decision;
    record.signature = decisionSignature(secret, v.root, owner.consentMessageId!, decision);
    accepted = true;
  });
  return accepted;
}

/** Persist the exact provider prompt on the host-signed task. Other replicas,
 * subsequent human turns and restarts all read the same user decision. */
export async function confirmDispatchTask(input: {
  dataDir: string; secret: string; binding: DispatchReportBindingPayload;
  targetName?: string;
  send: (text: string, uuid: string) => Promise<string>;
  checkOrigin: () => Promise<void>;
}): Promise<string> {
  const { binding } = input;
  const owner = binding.taskOwner!;
  let messageId = owner.consentMessageId;
  if (!messageId) {
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
      owner.receivingAppId, text])).digest('hex').slice(0, 32);
    const sent = await input.send(card, uuid);
    await updateDispatchRegistry(join(input.dataDir, 'orchestrate-dispatch.json'), registry => {
      const entry = registry[binding.dispatchRoot] as { reportBinding?: unknown } | undefined;
      const current = verifyDispatchReportBinding(input.secret, binding.dispatchRoot, entry?.reportBinding);
      if (!entry || !current || !current.taskOwner || current.attachment
          || current.targetSessionId !== binding.targetSessionId || current.targetChatId !== binding.targetChatId
          || current.targetLarkAppId !== binding.targetLarkAppId || current.issuedAt !== binding.issuedAt
          || current.taskOwner.openId !== owner.openId || current.taskOwner.receivingAppId !== owner.receivingAppId
          || current.taskOwner.receivingChatId !== owner.receivingChatId) throw new Error('dispatch_task_changed');
      if (current.taskOwner.consentMessageId && current.taskOwner.consentMessageId !== sent) throw new Error('dispatch_consent_race');
      entry.reportBinding = createDispatchReportBinding(input.secret, {
        ...current, taskOwner: { ...current.taskOwner, consentMessageId: sent },
      });
      messageId = sent;
    });
  }
  if (!messageId) throw new Error('dispatch_consent_unavailable');
  const deadline = Date.now() + 90_000;
  do {
    await input.checkOrigin();
    const current = await readTaskBinding(input.dataDir, input.secret, binding.dispatchRoot);
    if (!current || current.attachment || current.targetSessionId !== binding.targetSessionId
        || current.taskOwner?.consentMessageId !== messageId) throw new Error('dispatch_task_changed');
    if (current.taskOwner.decision === 'approved') return messageId;
    if (current.taskOwner.decision === 'denied') throw new Error('task_consent_denied');
    await delay(3000);
  } while (Date.now() < deadline);
  throw new Error('task_consent_pending');
}
