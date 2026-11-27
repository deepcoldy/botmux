import { readOncallDeploymentEnv } from '../../services/oncall-deployment-config.js';
import { readOncallPresetOptions } from '../../services/oncall-preset-options.js';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';
import { publicReverseProxyBaseUrl } from '../../platform/binding.js';
import { hostOncallSidebar, oncallSidebarSource } from '../../services/oncall-sidebar-link.js';
import { logger } from '../../utils/logger.js';
import { OncallGroupStore, oncallSourceEnabled, oncallForwardingPending, pendingOncallMessageIds, type OncallGroupSource } from '../../services/oncall-group-store.js';
import { nativeFormPolicyFingerprint, oncallGroupEnabled, oncallPrivateIntakeEnabled, type OncallGroupPolicy, type OncallForwardMode } from '../../services/oncall-group-policy.js';
import { OncallPrivateIntakeStore, privateIntakeDeliveryId } from '../../services/oncall-private-intake.js';
import { coordinationModeIsPrimary } from '../../services/durable-coordination-runtime.js';
import { createOncallGroup, loadOncallGroupTarget, OncallGroupApiError, ONCALL_GROUP_CREATE_TIMEOUT_MS } from '../../services/oncall-group-client.js';
import { getMessageDetail, replyMessage } from './client.js';
import { createNativeOncallLink, readNativeOncallResultCandidates, readOncallChoices, readOncallGroupResult, readOncallWorkflow, validateOncallSelection } from '../../services/oncall-platform.js';
import { botmuxOncallFields, serializeBotmuxOncallForm } from '../../services/oncall-custom-form.js';
import { OncallFormStore, type OncallFormDraft, type OncallNativeSubmissionAttempt } from '../../services/oncall-form-store.js';
import { buildOncallFormCard, ONCALL_FORM_CARD_MAX_BYTES } from './oncall-form-card.js';
import { createHash, randomBytes } from 'node:crypto';
import { withFileLock } from '../../utils/file-lock.js';
import { join } from 'node:path';
import { resolveOncallUsername } from './oncall-identity.js';
import { parseApiMessage } from './message-parser.js';
import { chatAppLink } from './lark-hosts.js';
import type { CardActionData } from './card-handler.js';
import { extractLarkBusinessCode, LARK_CODE_FORWARD_RESTRICTED } from './lark-errors.js';

import { buildOncallGroupColumn } from './oncall-card-actions.js';
export { buildOncallGroupColumn } from './oncall-card-actions.js';

const PRIVATE_ONCALL_DESCRIPTION = '用户通过私聊发起人工 Oncall';

export interface OncallCardContext { appId: string; sessionId?: string; questionId: string; phase: 'first' | 'final'; nativeLink?: string; messageId?: string; privateIntake?: OncallGroupSource['privateIntake'] }

export function stripOncallGroupButton(raw: string): string {
  const card = JSON.parse(raw);
  if (!Array.isArray(card.body?.elements)) return raw;
  card.body.elements = card.body.elements.filter((item: any) => item.element_id !== 'botmux_oncall_group');
  for (const item of card.body.elements) if (Array.isArray(item.columns)) {
    item.columns = item.columns.filter((column: any) => column.element_id !== 'botmux_oncall_group_column');
  }
  return JSON.stringify(card);
}

export function attachOncallGroupButton(raw: string, policy: OncallGroupPolicy | undefined, chatId: string, chatType?: string, context?: OncallCardContext): string {
  let options: Parameters<typeof buildOncallGroupColumn>[0] = {};
  const privateIntake = context?.privateIntake;
  const canShow = (chatType !== 'p2p' || !!privateIntake) && oncallSourceEnabled(policy, { chatId, privateIntake });
  if (context) {
    raw = stripOncallGroupButton(raw);
    const store = new OncallGroupStore(config.session.dataDir);
    const request = store.getRequest({ ...context, chatId, messageId: '', answer: '' });
    if ((chatType === 'p2p' && !privateIntake) || (!canShow && request?.status !== 'succeeded')) return raw;
    const turnNumber = context.sessionId ? store.registerTurn(context.appId, context.sessionId, context.questionId, { chatId }) : 1;
    if (request?.status === 'succeeded' && request.openChatId) options = {
      href: privateIntake ? chatAppLink(request.openChatId, getBot(context.appId).config.brand) : request.inviteLink, joinGroup: true, status: '进入人工 Oncall 群',
      retryForward: request.forwardMode !== 'none' && request.handoffError !== 'restricted_merge'
        && (request.conversationScopePending === true || pendingOncallMessageIds(request).length > 0),
      handoffStatus: request.forwardMode === 'none' ? undefined
        : request.handoffError === 'restricted_merge' ? '对话含受限消息，无法合并转交'
          : request.handoffError === 'waiting_for_bot' ? '等待机器人入群，原对话尚未转交' : undefined,
    };
    else {
      // A migrated entry was already visible on the source group's answer.
      const continuedEntry = privateIntake && context.sessionId?.startsWith('oncall-private-');
      if (!canShow
        || (!continuedEntry && turnNumber < (policy?.button?.minTurns ?? 1))
        || ((policy?.button?.timing ?? 'final') === 'final' && context.phase !== 'final')) return raw;
      if (request && request.status !== 'failed') options = { disabled: true,
        status: request.status === 'pending' ? '正在发起人工 Oncall' : '建群结果待确认' };
      else if (policy?.flowMode === 'classify' && (policy.formDisplay ?? 'native') === 'native' && context.nativeLink) {
        try {
          const page = new URL(new URL(context.nativeLink).searchParams.get('url') ?? '');
          if (page.searchParams.get('tenant') === String(loadOncallGroupTarget(config.session.dataDir, context.appId).tenantId)) options.href = context.nativeLink;
        } catch { /* Rebuild unavailable or outdated links through the original button. */ }
      }
    }
  } else if (!canShow) return raw;
  if ((policy?.flowMode ?? 'direct') === 'direct' && !options.href && !options.joinGroup && !options.disabled) {
    let destination = '使用管理员预设的业务线、区域和问题分类。';
    if (context) {
      try {
        const target = loadOncallGroupTarget(config.session.dataDir, context.appId);
        const presentation = readOncallPresetOptions(config.session.dataDir, context.appId, target);
        const region = presentation?.regions.find(item => item.value === target.region);
        const category = region?.categories.find(item => item.value === String(target.typeId));
        if (presentation && region && category) destination = `业务线：${presentation.tenantName}\n受理区域：${region.label}\n问题分类：${category.label}`;
      } catch { /* Confirmation still explains the consequences when labels are unavailable. */ }
    }
    const handoff = policy?.forwardMode === 'none' ? '不自动转发对话记录' : `转交提交前的当前会话对话及附件（${policy?.forwardMode === 'merge' ? '合并为聊天记录' : '逐条消息'}）`;
    options.confirmText = `${destination}\n对话交接：${handoff}。\n确认后将创建人工群并通知对应值班人员；取消不会发起 Oncall。`;
  }
  const card = JSON.parse(raw);
  const elements = card.body?.elements;
  if (!Array.isArray(elements) || elements.some((item: any) => item.element_id === 'botmux_oncall_group'
    || item.columns?.some((column: any) => column.element_id === 'botmux_oncall_group_column'))) return raw;
  const control = buildOncallGroupColumn(options);
  const chrome = elements.find((item: any) => item.element_id === 'botmux_reply_actions' && Array.isArray(item.columns));
  const footerIndex = elements.findIndex((item: any) => item.element_id === 'botmux_reply_footer');
  if (chrome) chrome.columns.push(control);
  else if (footerIndex >= 0) {
    const footer = elements[footerIndex];
    elements[footerIndex] = { tag: 'column_set', element_id: 'botmux_reply_actions', flex_mode: 'none',
      horizontal_spacing: '8px', vertical_align: 'center', columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [footer] }, control,
      ] };
  } else elements.push({ tag: 'column_set', element_id: 'botmux_oncall_group', flex_mode: 'none',
    horizontal_spacing: '8px', vertical_align: 'center', columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [] }, control,
    ] });
  return JSON.stringify(card);
}

export function recordOncallGroupDelivery(dataDir: string, { card, ...source }: OncallGroupSource & { card: Record<string, any> }): void {
  if (!source.sessionId && !card.body?.elements?.some((item: any) => item.element_id === 'botmux_oncall_group'
    || item.columns?.some((column: any) => column.element_id === 'botmux_oncall_group_column'))) return;
  try {
    const store = new OncallGroupStore(dataDir);
    if (source.sessionId && !oncallSourceEnabled(getBot(source.appId).config.oncallGroup, source) && !store.getRequest(source)) return;
    store.recordSource({ ...source, cardJson: JSON.stringify(card) });
  }
  catch { logger.warn('[oncall-group] Could not index the delivered card; the answer must not be resent'); }
}

/** Feedback readback drops button behaviors. Rebuild from current persisted
 * session state, including cards from earlier turns. */
export function reconcileOncallReplyCard(appId: string, messageId: string, card: Record<string, any>): Record<string, any> {
  const source = new OncallGroupStore(config.session.dataDir).findSource(appId, messageId);
  if (!source) return card;
  const raw = JSON.stringify(card);
  return JSON.parse(attachOncallGroupButton(raw, getBot(appId).config.oncallGroup, source.chatId, 'group', {
    appId, sessionId: source.sessionId, questionId: source.questionId, phase: 'final', nativeLink: source.nativeLink, messageId, privateIntake: source.privateIntake,
  }));
}

/** Cards that already received the invitation as a reply because they cannot be
 * updated. In memory: after a restart one more reply is harmless. */
const oncallInviteReplies = new Set<string>();

export async function handleOncallGroupAction(data: CardActionData, appId: string): Promise<any> {
  const store = new OncallGroupStore(config.session.dataDir);
  let source: OncallGroupSource | undefined;
  try { source = store.findSource(appId, data.context?.open_message_id ?? ''); } catch { /* invalid source is rejected below */ }
  if (source?.privateIntake && (data.context?.open_chat_id !== source.chatId
    || data.operator?.open_id !== source.privateIntake.ownerOpenId)) {
    return oncallError(new Error('仅原提问人可操作这条私聊 Oncall'));
  }
  if (data.action?.value?.action === 'oncall_group_join') {
    if (!source || (data.context?.open_chat_id && data.context.open_chat_id !== source.chatId)
      || !data.operator?.open_id?.startsWith('ou_') || store.getRequest(source)?.status !== 'succeeded') {
      return oncallError(new Error('人工群入口已失效，请从原结果卡进入'));
    }
    const replyKey = JSON.stringify([config.session.dataDir, appId, source.messageId]);
    if (oncallInviteReplies.has(replyKey) && store.getRequest(source)?.inviteLink) {
      return { toast: { type: 'info', content: '入群邀请已回复在本卡下方，请点击该链接进入人工群' } };
    }
    if (source.privateIntake) return { toast: { type: 'info', content: '请从当前私聊结果卡打开人工群' },
      afterAck: () => refreshOncallSessionCard(source) };
    try {
      await prepareOncallGroupInvite(source);
      return {
        toast: { type: 'success', content: '入群邀请已就绪，请再次点击进入人工群' },
        afterAck: async () => {
          // Callback completion can restore the old view if this patch precedes its ACK.
          // A clicked card that can no longer change still has to deliver the link.
          let replyWithLink = !source.cardJson && !source.sessionId;
          try {
            await refreshOncallSessionCard(source, { onExpired: messageId => { if (messageId === source.messageId) replyWithLink = true; } });
          } finally {
            const link = store.getRequest(source)?.inviteLink;
            // The in-flight dedupe ends at ACK, so repeated or concurrent clicks reach here.
            if (replyWithLink && link && !oncallInviteReplies.has(replyKey)) {
              if (oncallInviteReplies.size >= 10_000) oncallInviteReplies.clear();
              oncallInviteReplies.add(replyKey);
              try { await replyMessage(appId, source.messageId, `人工 Oncall 群入群邀请：${link}`, 'text', true); }
              catch (error) { oncallInviteReplies.delete(replyKey); throw error; }
            }
          }
        },
      };
    } catch { return oncallError(new Error('人工群入群邀请暂不可用，请联系管理员将机器人加入人工群并允许分享群')); }
  }
  const bot = getBot(appId).config;
  const policySnapshot = JSON.stringify(bot.oncallGroup);
  if (!source || (source.privateIntake && source.privateIntake.chatId !== source.chatId)
    || (data.context?.open_chat_id && data.context.open_chat_id !== source.chatId)) {
    return oncallError(new Error('找不到原回答卡，请从最新回答卡发起转人工'));
  }
  const groupChatId = source.privateIntake?.groupChatId ?? source.chatId;
  if (!oncallGroupEnabled(bot.oncallGroup, groupChatId)) {
    return { toast: { type: 'info', content: '管理员已关闭本群转人工，请联系管理员确认' } };
  }
  if (!data.operator?.open_id?.startsWith('ou_')) return { toast: { type: 'error', content: '无法确认点击者身份' } };
  const existingRequest = store.getRequest(source);
  if (!source.privateIntake && (oncallPrivateIntakeEnabled(bot.oncallGroup, source.chatId)
    || store.latest(appId, privateOncallSessionId(source, data.operator.open_id)))
    && (!existingRequest || existingRequest.status === 'failed') && data.action?.value?.action === 'oncall_group_create') {
    try { return await continueOncallInPrivate(source, data.operator); }
    catch (error) { return oncallError(error); }
  }
  if (data.action?.value?.action === 'oncall_group_forward') {
    if (!existingRequest || existingRequest.status !== 'succeeded' || existingRequest.operatorOpenId !== data.operator.open_id) {
      return oncallError(new Error('仅原提单人可重试转交对话'));
    }
    if (existingRequest.forwardMode === 'none') return { toast: { type: 'info', content: '本次建群未启用对话交接' } };
    await forwardOncallConversation(source);
    await refreshOncallSessionCard(source).catch(() => {});
    const after = store.getRequest(source);
    if (after?.handoffError === 'restricted_merge') return oncallError(new Error('对话含受限消息，无法合并转交'));
    return after?.conversationScopePending || pendingOncallMessageIds(after).length > 0
      ? oncallError(new Error(after?.forwardingBlocked ? '转发结果未知且已超出去重窗口，请管理员核对，勿重复转发' : '部分对话尚未转交，请检查机器人在 Oncall 群内的权限后重试'))
      : { toast: { type: 'success', content: '对话交接已完成' } };
  }
  if (bot.oncallGroup?.flowMode === 'classify' && (!existingRequest || existingRequest.status === 'failed')) {
    try {
      if (source.privateIntake || ['private_card', 'thread_card'].includes(bot.oncallGroup?.formDisplay ?? 'native')) return await openOncallForm(source, data.operator);
      const targetSnapshot = JSON.stringify(loadOncallGroupTarget(config.session.dataDir, appId));
      const href = await prepareNativeOncallCard(appId, source.chatId, source.questionId);
      if (!href) throw new Error('原生提单入口暂不可用，请检查连接配置');
      const original = source;
      const beforeWrite = () => {
        if (JSON.stringify(getBot(appId).config.oncallGroup) !== policySnapshot
          || JSON.stringify(loadOncallGroupTarget(config.session.dataDir, appId)) !== targetSnapshot) throw new Error('配置已变更，请重新打开入口');
        const current = store.findSource(appId, original.messageId);
        if (!current || current.questionId !== original.questionId || current.chatId !== original.chatId) throw new Error('原回答卡已失效');
        const request = store.getRequest(current);
        if (request && request.status !== 'failed') throw new Error('此会话已有请求，请从原回答卡继续');
      };
      return { toast: { type: 'info', content: '请点击原回答卡的转人工按钮打开飞书侧栏' }, afterAck: async () => {
        beforeWrite();
        const current = { ...store.findSource(appId, original.messageId)!, nativeLink: href };
        store.recordSource(current);
        await refreshOncallSessionCard(current, { prepareInvite: false, beforeWrite });
      } };
    } catch (error) { return oncallError(error); }
  }
  let text: string;
  try {
    let result = store.getRequest(source);
    if (!result || result.status === 'failed') {
      const deployment = readOncallDeploymentEnv();
      const target = loadOncallGroupTarget(config.session.dataDir, appId, deployment);
      if (!target.typeId || !target.region) throw new Error('直接建群需要配置固定区域和分类');
      const secret = deployment.ONCALL_SERVICE_SECRET?.trim();
      if (!secret) throw new Error('Oncall 服务账号凭据尚未配置，请联系机器人管理员设置 ONCALL_SERVICE_SECRET');
      const username = await resolveOncallUsername(appId, data.operator, target, deployment);
      let message = PRIVATE_ONCALL_DESCRIPTION;
      if (!source.privateIntake) {
        let question = '';
        if (source.questionId.startsWith('om_')) {
          try {
            const detail = await getMessageDetail(appId, source.questionId);
            question = parseApiMessage(detail?.items?.[0] ?? detail ?? {}).content;
          } catch { throw new Error('无法读取原问题，请稍后重试'); }
        }
        message = [`问题：${question.slice(0, 8000)}`, `回答：${source.answer.slice(0, 16000)}`,
          `来源群：${chatAppLink(source.chatId, bot.brand)}\n原消息：${source.questionId}`].join('\n\n');
      }
      if (!oncallSourceEnabled(getBot(appId).config.oncallGroup, source)
        || JSON.stringify(getBot(appId).config.oncallGroup) !== policySnapshot
        || JSON.stringify(loadOncallGroupTarget(config.session.dataDir, appId)) !== JSON.stringify(target)) throw new Error('配置已变更，请重新发起');
      const snapshot = source.sessionId ? await snapshotOncallConversation(source) : undefined;
      if (!oncallSourceEnabled(getBot(appId).config.oncallGroup, source)
        || JSON.stringify(getBot(appId).config.oncallGroup) !== policySnapshot
        || JSON.stringify(loadOncallGroupTarget(config.session.dataDir, appId)) !== JSON.stringify(target)) throw new Error('配置已变更，请重新发起');
      if (store.claim(source, data.operator.open_id, snapshot, { target, username, region: target.region, typeId: target.typeId })) {
        const attemptId = store.getRequest(source)?.attemptId;
        try {
          const created = await createOncallGroup(target, secret, username, message, fetch, undefined, attemptId);
          store.finish(source, { status: 'succeeded', ...created }, attemptId);
          if (source.sessionId) await forwardOncallConversation(source);
        } catch (error) {
          logOncallCreationFailure(error, store.getRequest(source)?.submittedAtMs);
          store.finish(source, { status: error instanceof OncallGroupApiError && !error.uncertain ? 'failed' : 'unknown' }, attemptId);
          if (error instanceof OncallGroupApiError) throw error;
        }
      }
      result = store.getRequest(source);
    }
    if (result?.status === 'succeeded') await prepareOncallGroupInvite(source).catch(() => {});
    const invite = store.getRequest(source)?.inviteLink;
    text = result?.status === 'succeeded' && result.openChatId ? `Oncall 群：${invite ?? chatAppLink(result.openChatId, bot.brand)}`
      : result?.status === 'failed' ? '拉起 Oncall 群失败，可再次点击重试'
        : '建群请求已提交，暂未确认结果，请勿重复创建；若长时间无结果，请联系管理员核对';
  } catch (error) {
    if (source.sessionId) return oncallError(error);
    text = error instanceof Error ? error.message : 'Oncall 建群暂不可用';
  }
  if (source.sessionId) await refreshOncallSessionCard(source).catch(() => logger.warn('[oncall-group] Latest card refresh pending'));
  else {
    if (store.getRequest(source)?.status === 'succeeded') await refreshOncallSessionCard(source).catch(() => {});
    await replyMessage(appId, source.messageId, text, 'text', true);
  }
}

function privateOncallSessionId(source: OncallGroupSource, ownerOpenId: string): string {
  return 'oncall-private-' + createHash('sha256')
    .update(JSON.stringify([source.appId, source.chatId, source.sessionId ?? source.questionId, ownerOpenId])).digest('hex');
}

/** A delivered public card remains a valid entry after switching to private
 * intake. Only a neutral receipt crosses into the DM; the old conversation is
 * never copied, and each clicker has their own persistent handoff session. */
async function continueOncallInPrivate(source: OncallGroupSource, operator: NonNullable<CardActionData['operator']>): Promise<any> {
  if (coordinationModeIsPrimary()) throw new Error('当前部署暂不支持私聊接待，请联系该群管理员');
  const ownerOpenId = operator.open_id!;
  const groups = new OncallGroupStore(config.session.dataDir);
  const sessionId = privateOncallSessionId(source, ownerOpenId);
  const beforeWrite = () => {
    if (!oncallGroupEnabled(getBot(source.appId).config.oncallGroup, source.chatId)) throw new Error('管理员已关闭本群转人工，请联系管理员确认');
  };
  // The source's existing index creates this parent directory. Serialize the
  // receipt and form publication across repeated clicks, cards and processes.
  return withFileLock(join(config.session.dataDir, 'oncall-groups', sessionId), async () => {
    beforeWrite();
    const originalRequest = groups.getRequest(source);
    if (originalRequest && originalRequest.status !== 'failed') {
      return { toast: { type: 'info', content: '本会话已有 Oncall 请求，请从原回答卡继续' },
        afterAck: () => refreshOncallSessionCard(source) };
    }
    let current = groups.latest(source.appId, sessionId);
    if (!current) {
      const anchor = groups.sessionSources(source)[0] ?? source;
      const intakes = new OncallPrivateIntakeStore(config.session.dataDir);
      const delivery = intakes.findDelivery(source.appId, ownerOpenId, anchor.messageId);
      let binding = delivery?.binding;
      const cardJson = JSON.stringify({ schema: '2.0', body: { elements: [
        { tag: 'markdown', content: '请在此私聊继续转人工，建群后按对话交接设置处理本次咨询。' },
      ] } });
      if (!binding) {
        // A provider timeout is retryable only inside its deduplication window.
        if (delivery && Date.now() - delivery.startedAtMs > 55 * 60_000) throw new Error('私聊投递结果尚待核对，请联系管理员，避免重复发送');
        if (!delivery) intakes.beginDelivery(source.appId, ownerOpenId, anchor.messageId);
        const client = await import('./client.js');
        const receipt = await client.sendUserMessageReceipt(source.appId, ownerOpenId, cardJson, 'interactive',
          privateIntakeDeliveryId(source.appId, sessionId), { timeoutMs: 15_000 }, { beforeWrite });
        binding = intakes.record({ appId: source.appId, groupChatId: source.chatId, groupMessageId: anchor.messageId,
          chatId: receipt.chatId ?? '', rootMessageId: receipt.messageId, ownerOpenId, createdAtMs: Date.now() });
      }
      // Rebuild the source from the durable receipt if indexing was interrupted.
      current = { appId: source.appId, sessionId, chatId: binding.chatId, rootId: binding.rootMessageId,
        messageId: binding.rootMessageId, questionId: binding.rootMessageId, answer: '', cardJson, privateIntake: binding };
      groups.recordSource(current);
    }
    // This also settles a crash after source indexing but before delivery finish.
    new OncallPrivateIntakeStore(config.session.dataDir).finishDelivery(current.privateIntake!);
    beforeWrite();
    const request = groups.getRequest(current);
    if (getBot(source.appId).config.oncallGroup?.flowMode !== 'classify' || (request && request.status !== 'failed')) {
      await refreshOncallSessionCard(current);
    } else await openOncallForm(current, operator);
    return { toast: { type: 'info', content: '已在机器人私聊中继续转人工，请打开私聊查看' } };
  });
}

const nativeLinks = new Map<string, Promise<string | undefined>>();
/** A read-only preload, shared by the daemon and CLI final delivery. A platform
 * launch URL is never recorded as a created ticket or a successful handoff. */
export async function prepareNativeOncallCard(appId: string, chatId: string, questionId: string, sessionId?: string): Promise<string | undefined> {
  const bot = getBot(appId).config;
  if (!oncallGroupEnabled(bot.oncallGroup, chatId) || bot.oncallGroup?.flowMode !== 'classify'
    || (bot.oncallGroup.formDisplay ?? 'native') !== 'native') return undefined;
  let target, deployment;
  try {
    deployment = readOncallDeploymentEnv();
    target = loadOncallGroupTarget(config.session.dataDir, appId, deployment);
  } catch { return undefined; }
  const secret = deployment.ONCALL_SERVICE_SECRET?.trim() ?? '';
  if (!secret && sessionId) {
    const prior = new OncallGroupStore(config.session.dataDir).latest(appId, sessionId);
    if (prior?.questionId === questionId && prior.nativeLink) {
      try {
        const page = new URL(new URL(prior.nativeLink).searchParams.get('url') ?? '');
        if (page.searchParams.get('tenant') === String(target.tenantId)) return prior.nativeLink;
      } catch { /* untrusted or outdated cached link */ }
    }
    return undefined;
  }
  const key = JSON.stringify([appId, chatId, questionId, target.endpoint, target.tenantId, createHash('sha256').update(secret).digest('hex')]);
  const existing = nativeLinks.get(key);
  if (existing) return existing;
  const operation = (async () => {
    try {
      const detail = await getMessageDetail(appId, questionId);
      const question = parseApiMessage(detail?.items?.[0] ?? detail ?? {}).content;
      return await createNativeOncallLink(target, secret, '', question, bot.brand);
    } catch {
      nativeLinks.delete(key);
      logger.warn('[oncall-group] Native launch URL is unavailable; credentials and response bodies are not logged');
      return undefined;
    }
  })();
  nativeLinks.set(key, operation);
  if (nativeLinks.size > 512) nativeLinks.delete(nativeLinks.keys().next().value!);
  return operation;
}

function oncallError(error: unknown): any {
  return { toast: { type: 'error', content: error instanceof Error ? error.message : 'Oncall 暂不可用，请重试' } };
}

function logOncallCreationFailure(error: unknown, submittedAtMs = Date.now()): void {
  const reason = error instanceof OncallGroupApiError ? error.reason : 'unknown';
  const status = error instanceof OncallGroupApiError ? error.status : undefined;
  // Never log gateway bodies, user data, or credentials from the original error.
  logger.warn(`[oncall-group] Create outcome reason=${reason} http=${status ?? 'none'} elapsedMs=${Date.now() - submittedAtMs}`);
}

async function openOncallForm(source: OncallGroupSource, operator: NonNullable<CardActionData['operator']>): Promise<any> {
  const ownerOpenId = operator.open_id!;
  const client = await import('./client.js');
  const visibility = source.privateIntake || getBot(source.appId).config.oncallGroup?.formDisplay === 'thread_card' ? 'thread' : 'private';
  const policySnapshot = JSON.stringify(getBot(source.appId).config.oncallGroup);
  // Never fall back to a public card or a DM: visibility is part of the contract.
  const mode = source.privateIntake ? 'p2p' : await client.getChatModeStrict(source.appId, source.chatId);
  if (visibility === 'private' && mode !== 'group') {
    throw new Error('当前话题群不支持仅提单人可见的临时表单，请在设置中选择“飞书原生侧栏”');
  }
  if (visibility === 'thread' && !(source.privateIntake ? mode === 'p2p' : ['group', 'topic'].includes(mode))) throw new Error('当前会话无法展示群内分类卡片');
  const deployment = readOncallDeploymentEnv();
  const target = loadOncallGroupTarget(config.session.dataDir, source.appId, deployment);
  const secret = deployment.ONCALL_SERVICE_SECRET?.trim() ?? '';
  const username = await resolveOncallUsername(source.appId, operator, target, deployment);
  const choices = await readOncallChoices(target, secret, username);
  const region = Object.keys(choices.regions)[0] ?? '';
  const detail = source.privateIntake ? undefined : await getMessageDetail(source.appId, source.questionId);
  const description = source.privateIntake ? '' : parseApiMessage(detail?.items?.[0] ?? detail ?? {}).content;
  const forms = new OncallFormStore(config.session.dataDir);
  const draft = forms.open({ appId: source.appId, ownerOpenId, source, choices,
    region, typeId: choices.regions[region]?.[0]?.id, priority: 'P2', description, targetFingerprint: JSON.stringify(target), visibility });
  await forms.use(source.appId, draft.id, ownerOpenId, async (current, persist) => {
    if (JSON.stringify(getBot(source.appId).config.oncallGroup) !== policySnapshot) throw new Error('转人工配置已变更，请重新打开');
    if (current.targetFingerprint !== JSON.stringify(target)) throw new Error('业务目标已变更，请先取消旧表单后重新打开');
    if ((current.visibility ?? 'private') !== visibility) throw new Error('展示方式已变更，请先取消旧表单后重新打开');
    if (!current.nativeEntry && !current.botmuxFields) await prepareOncallFormSelection(current, username);
    if (JSON.stringify(getBot(source.appId).config.oncallGroup) !== policySnapshot) throw new Error('转人工配置已变更，请重新打开');
    assertOncallFormCurrent(current);
    if (current.messageId) {
      if (visibility === 'thread' || current.nativeEntry) await writeOncallFormDraft(current, persist);
      return;
    }
    if (visibility === 'thread') {
      if (current.publishStartedAtMs && Date.now() - current.publishStartedAtMs > 55 * 60_000) throw new Error('分类卡片投递结果待核对，请管理员处理');
      current.publishStartedAtMs ??= Date.now();
      persist();
      current.messageId = current.nativeFormLink
        ? await replyMessage(source.appId, source.messageId, buildOncallFormCard(current), 'interactive', true, current.id, undefined, { beforeWrite: () => assertOncallFormCurrent(current) })
        : await replyMessage(source.appId, source.messageId, buildOncallFormCard(current), 'interactive', true, current.id);
    } else {
      if (current.nativeFormLink) persist();
      current.messageId = current.nativeFormLink
        ? await client.sendEphemeralCard(source.appId, source.chatId, ownerOpenId, buildOncallFormCard(current), { beforeWrite: () => assertOncallFormCurrent(current) })
        : await client.sendEphemeralCard(source.appId, source.chatId, ownerOpenId, buildOncallFormCard(current));
    }
  });
  return { toast: { type: 'info', content: visibility === 'thread' ? '请在分类卡上发起人工 Oncall，仅你可操作' : '表单已展示，仅你可见' } };
}

function recordNativeSubmissionAttempt(draft: OncallFormDraft, href: string, attempt: OncallNativeSubmissionAttempt, publicBase: string | null): string {
  const attempts = draft.nativeSubmission?.attempts ?? [];
  const duplicate = attempts.find(item => item.sourceLocation === attempt.sourceLocation
    && item.username === attempt.username && item.typeId === attempt.typeId && item.region === attempt.region
    && item.policyFingerprint === attempt.policyFingerprint && item.forwardMode === attempt.forwardMode);
  if (duplicate?.sidebarLink) return duplicate.sidebarLink.href;
  const token = randomBytes(16).toString('hex');
  const hostedHref = publicBase ? hostOncallSidebar(href, publicBase, draft, token) : href;
  const hosted = hostedHref !== href;
  const issued = { ...(duplicate ?? attempt), sidebarLink: { token, href, ...(hosted ? { hostedHref } : {}) },
    ...(hosted ? { hostedSourceLocation: oncallSidebarSource(new URL(attempt.sourceLocation)) } : {}) };
  // Persist the original selection and its capability before exposing the card.
  draft.nativeSubmission = { ...draft.nativeSubmission,
    attempts: duplicate ? attempts.map(item => item === duplicate ? issued : item) : [...attempts, issued] };
  return href;
}

/** Keep a selection's marker stable on re-render and distinct across routes or policy changes. */
function nativeSelectionMarker(draft: OncallFormDraft, typeId: number, username: string, policy: string, publicBase: string | null): string {
  const selection = JSON.stringify([draft.region, typeId, draft.priority, username, policy, publicBase]);
  return `${draft.id}.${createHash('sha256').update(selection).digest('hex').slice(0, 24)}`;
}

function selectedBotmuxForm(policy: OncallGroupPolicy | undefined, draft: OncallFormDraft, workflow: unknown[] | undefined) {
  if (policy?.customFormMode !== 'botmux') return {};
  if (draft.priority === 'P0') return { reason: 'P0 自定义表单统一在 Oncall 侧栏填写。' };
  let reason: string | undefined;
  const fields = botmuxOncallFields(workflow, detail => { reason = detail; });
  if (fields && Buffer.byteLength(buildOncallFormCard({ ...draft, botmuxFields: fields, nativeEntry: undefined }), 'utf8') > ONCALL_FORM_CARD_MAX_BYTES) {
    return { reason: '表单选项较多，超出分类卡容量，需要在 Oncall 侧栏填写。' };
  }
  return { fields, reason };
}

/** Resolve the fields or sidebar link for the currently selected category. */
async function prepareOncallFormSelection(draft: OncallFormDraft, username = draft.oncallUsername,
  loadUsername?: () => Promise<string>): Promise<void> {
  const category = draft.choices.regions[draft.region]?.find(item => item.id === draft.typeId);
  if (!category || category.type_action !== 'create_chat') {
    delete draft.nativeFormLink;
    delete draft.botmuxFields;
    delete draft.nativeFormReason;
    return;
  }
  const deployment = readOncallDeploymentEnv();
  const target = loadOncallGroupTarget(config.session.dataDir, draft.appId, deployment);
  const secret = deployment.ONCALL_SERVICE_SECRET?.trim() ?? '';
  const bot = getBot(draft.appId).config;
  const policySnapshot = JSON.stringify(bot.oncallGroup);
  const policyFingerprint = nativeFormPolicyFingerprint(bot.oncallGroup)!;
  const publicBase = publicReverseProxyBaseUrl();
  let nativeFormLink: string | undefined;
  const workflow = await readOncallWorkflow(target, secret, category);
  const { fields, reason } = selectedBotmuxForm(bot.oncallGroup, draft, workflow);
  const requiresNative = (workflow === undefined || workflow.length > 0) && !fields;
  if (requiresNative) {
    username = username ?? await loadUsername?.();
    if (!username) throw new Error('无法确认 Oncall 提单人，请重新打开表单');
    nativeFormLink = await createNativeOncallLink(target, secret, '', draft.description, getBot(draft.appId).config.brand, fetch,
      { region: draft.region, typeId: category.id, priority: draft.priority, formId: nativeSelectionMarker(draft, category.id, username, policyFingerprint, publicBase) });
  }
  if (JSON.stringify(getBot(draft.appId).config.oncallGroup) !== policySnapshot
    || JSON.stringify(loadOncallGroupTarget(config.session.dataDir, draft.appId)) !== JSON.stringify(target)) throw new Error('配置已变更，请重新打开表单');
  if (fields) draft.botmuxFields = fields;
  else delete draft.botmuxFields;
  if (requiresNative && reason) draft.nativeFormReason = reason;
  else delete draft.nativeFormReason;
  if (username) draft.oncallUsername = username;
  if (nativeFormLink && username) {
    draft.nativeFormLink = recordNativeSubmissionAttempt(draft, nativeFormLink, {
      sourceLocation: new URL(nativeFormLink).searchParams.get('url')!.slice(0, 200), username,
      preparedAtMs: Date.now(), policyFingerprint, forwardMode: bot.oncallGroup?.forwardMode ?? 'individual',
      typeId: category.id, region: draft.region,
    }, publicBase);
  } else delete draft.nativeFormLink;
}

function classifiedCardPolicy(policy: OncallGroupPolicy | undefined, draft: OncallFormDraft): boolean {
  return oncallSourceEnabled(policy, draft.source) && (draft.source.privateIntake
    ? draft.visibility === 'thread' && draft.ownerOpenId === draft.source.privateIntake.ownerOpenId
    : policy?.flowMode === 'classify' && policy.formDisplay === (draft.visibility === 'thread' ? 'thread_card' : 'private_card'));
}

async function closeOncallForm(draft: OncallFormDraft, outcome: 'created' | 'failed' | 'cancelled', owns: () => boolean = () => true): Promise<void> {
  const messageId = draft.messageId;
  if (!messageId) return;
  const client = await import('./client.js');
  const created = outcome === 'created';
  if (!owns()) return;
  if (draft.visibility !== 'thread') {
    if (!created) await client.deleteEphemeralCard(draft.appId, messageId);
    else if (!await client.deleteEphemeralCard(draft.appId, messageId, { acceptWithdrawn: true })) {
      throw new Error('分类表单收起失败，请重试');
    }
    return;
  }
  const replaceWithStatus = (content: string) => client.updateMessage(draft.appId, messageId, JSON.stringify({
    schema: '2.0', body: { elements: [{ tag: 'markdown', element_id: 'botmux_oncall_form_state', content }] },
  }));
  if (created) {
    // Keep the result card as the sole group entry. Confirm that it was
    // refreshed before withdrawing the now-obsolete classification form.
    await refreshOncallSessionCard(draft.source, { beforeWrite: () => {
      if (!owns()) throw new Error('Oncall form cleanup stopped');
    } });
    if (!owns()) return;
    const retired = await client.deleteMessage(draft.appId, messageId, {
      acceptWithdrawn: true,
      onRecallExpired: async () => {
        if (!owns()) return;
        try {
          await replaceWithStatus('已发起人工 Oncall，请从原回答卡进入。');
        } catch (error) {
          // Once both write windows have expired no retry can ever retire the
          // immutable form. Settle the durable cleanup instead of retrying
          // forever; a concurrently withdrawn form is already retired too.
          const unchangeable = oncallCardUnchangeable(error);
          if (unchangeable === 'expired') {
            logger.warn(`[oncall-group] Classification form ${messageId} is immutable after recall/edit expiry; settling cleanup`);
            return;
          }
          if (unchangeable === 'gone') return;
          throw error;
        }
      },
    });
    if (!retired) throw new Error('分类表单收起失败，请重试');
    return;
  }
  try {
    await replaceWithStatus(outcome === 'failed' ? '本次发起失败，请从原回答卡重新发起'
      : draft.nativeEntry || draft.nativeFormLink ? '已收起本次表单入口；平台已提交的工单不受影响' : '已取消本次转人工');
  } catch (error) {
    // A concurrently retired or immutable form needs no further cleanup. In
    // particular, do not keep PATCHing a form whose early withdrawal succeeded.
    const unchangeable = oncallCardUnchangeable(error);
    if (unchangeable) {
      logger.warn(`[oncall-group] Classification form ${messageId} is ${unchangeable}; settling ${outcome} cleanup`);
      return;
    }
    throw error;
  }
}

function assertOncallFormCurrent(latest: OncallFormDraft): void {
  const groups = new OncallGroupStore(config.session.dataDir);
  const policy = getBot(latest.appId).config.oncallGroup;
  const currentRequest = groups.getRequest(latest.source);
  if (!classifiedCardPolicy(policy, latest)
    || (latest.targetFingerprint && latest.targetFingerprint !== JSON.stringify(loadOncallGroupTarget(config.session.dataDir, latest.appId)))
    || (latest.nativeEntry && latest.nativeEntry.policyFingerprint !== nativeFormPolicyFingerprint(policy))
    || (currentRequest && currentRequest.status !== 'failed')) {
    throw new Error('表单配置或请求状态已变更，请重新打开入口');
  }
}

/** Called only while the draft lock is held, including every SDK retry. */
async function writeOncallFormDraft(latest: OncallFormDraft, persist: () => void, owns: () => boolean = () => true): Promise<void> {
  const store = new OncallGroupStore(config.session.dataDir);
  const request = store.getRequest(latest.source);
  if (latest.closed) {
    const formRequest = request?.creation?.formId === latest.id ? request : undefined;
    const submittedForm = formRequest?.status === 'succeeded' || formRequest?.status === 'failed' ? formRequest : undefined;
    if (submittedForm && submittedForm.formClosePending === false) return;
    const outcome = formRequest?.status === 'failed' ? 'failed' : request?.status === 'succeeded' ? 'created' : 'cancelled';
    await closeOncallForm(latest, outcome, owns);
    if (submittedForm?.formClosePending && owns()) {
      store.finish(latest.source, { status: submittedForm.status, formClosePending: false }, submittedForm.attemptId);
    }
    return;
  }
  const beforeWrite = () => assertOncallFormCurrent(latest);
  beforeWrite();
  const client = await import('./client.js');
  const card = buildOncallFormCard(latest);
  if (latest.visibility === 'thread') {
    if (!latest.messageId) throw new Error('分类卡片尚未发布');
    await client.updateMessage(latest.appId, latest.messageId, card, { beforeWrite });
  } else {
    const priorId = latest.messageId;
    latest.messageId = await client.sendEphemeralCard(latest.appId, latest.source.chatId, latest.ownerOpenId, card, { beforeWrite });
    persist();
    if (priorId) await client.deleteEphemeralCard(latest.appId, priorId);
  }
}

/** A late ACK reads the current draft; it never replays a captured card. */
export async function refreshOncallFormCard(appId: string, draftId: string, owner: string): Promise<void> {
  await new OncallFormStore(config.session.dataDir).use(appId, draftId, owner, writeOncallFormDraft, { allowClosed: true });
}

export async function handleOncallFormAction(data: CardActionData, appId: string): Promise<any> {
  const owner = data.operator?.open_id;
  const value = data.action?.value as any;
  if (!owner?.startsWith('ou_') || typeof value?.draftId !== 'string') return oncallError(new Error('无法确认表单身份'));
  try {
    const forms = new OncallFormStore(config.session.dataDir);
    return await forms.use(appId, value.draftId, owner, async (draft, persist) => {
      const bot = getBot(appId).config;
      const store = new OncallGroupStore(config.session.dataDir);
      const source = draft.source;
      if (source.privateIntake && (data.context?.open_chat_id !== source.chatId
        || data.context?.open_message_id !== draft.messageId || owner !== source.privateIntake.ownerOpenId)) throw new Error('私聊表单来源不匹配');
      if (data.context?.open_chat_id && data.context.open_chat_id !== source.chatId) throw new Error('表单来源不匹配');
      if (data.context?.open_message_id && data.context.open_message_id !== draft.messageId) throw new Error('请使用最新的分类卡片');
      if (draft.closed) {
        if (draft.visibility !== 'thread') throw new Error('此表单已失效');
        const request = store.getRequest(source);
        if (request?.creation?.formId === draft.id && request.status !== 'succeeded') {
          return { toast: { type: 'info', content: request.status === 'failed'
            ? '本次发起失败，请从原回答卡重新发起' : '请求已受理，请从原回答卡查看进度' } };
        }
        const created = request?.status === 'succeeded';
        return { toast: { type: 'info', content: created ? '此会话已有人工群' : '本次转人工已取消' },
          afterAck: () => refreshOncallFormCard(appId, draft.id, owner) };
      }
      const client = await import('./client.js');
      if (value.action === 'oncall_group_form_cancel') {
        const request = store.getRequest(source);
        if (request && request.status !== 'failed') return { toast: { type: 'info', content: '建群请求已提交，请从原回答卡查看结果，勿重复创建' } };
        draft.closed = true;
        delete draft.nativeSubmission;
        persist();
        if (draft.visibility !== 'thread') await closeOncallForm(draft, 'cancelled');
        return { toast: { type: 'info', content: draft.nativeEntry || draft.nativeFormLink ? '已收起本次入口，平台工单不受影响' : '已取消，尚未提交工单' },
          ...(draft.visibility === 'thread' ? { afterAck: () => refreshOncallFormCard(appId, draft.id, owner) } : {}) };
      }
      if (value.version !== draft.version) {
        if ((draft.visibility === 'thread' || draft.botmuxFields) && Number.isSafeInteger(value.version)
          && value.version < draft.version && draft.messageId) {
          return { toast: { type: 'info', content: '已恢复当前分类选择，请基于最新卡片继续' },
            afterAck: () => refreshOncallFormCard(appId, draft.id, owner) };
        }
        throw new Error('请使用最新的分类卡片');
      }
      if (!classifiedCardPolicy(bot.oncallGroup, draft)) throw new Error('转人工配置已变更，请重新打开入口');
      if (draft.targetFingerprint && draft.targetFingerprint !== JSON.stringify(loadOncallGroupTarget(config.session.dataDir, appId))) {
        throw new Error('业务目标已变更，请取消旧表单后重新打开');
      }
      const old = store.getRequest(source);
      if (old && old.status !== 'failed') {
        await refreshOncallSessionCard(source);
        return { toast: { type: 'info', content: old.status === 'succeeded' ? '此会话已有人工群，请从结果卡进入' : '已有请求待确认，请勿重复提交' } };
      }
      if (draft.nativeEntry) return { toast: { type: 'info', content: '此分类已转由平台表单填写，请从当前卡片继续' },
        afterAck: () => refreshOncallFormCard(appId, draft.id, owner) };
      const previousDraft = { ...draft };
      const action = value.action;
      const botmuxSubmit = action === 'oncall_group_form_botmux_submit';
      const option = typeof data.action?.option === 'string' ? data.action.option : undefined;
      if (action === 'oncall_group_form_region') {
        if (typeof option !== 'string' || !Object.hasOwn(draft.choices.regions, option)) throw new Error('问题区域已失效，请重新加载');
        draft.region = option;
        draft.typeId = draft.choices.regions[option][0]?.id;
      } else if (action === 'oncall_group_form_category') {
        const category = draft.choices.regions[draft.region]?.find(item => String(item.id) === option);
        if (!category || category.type_action !== 'create_chat') throw new Error('此分类不是人工提单渠道，请使用原生侧栏');
        draft.typeId = category.id;
      } else if (action === 'oncall_group_form_priority') {
        if (!['P2', 'P1', 'P0'].includes(option ?? '')) throw new Error('问题等级无效');
        draft.priority = option as OncallFormDraft['priority'];
      } else if (action === 'oncall_group_form_submit' || botmuxSubmit) {
        const deployment = readOncallDeploymentEnv();
        const target = loadOncallGroupTarget(config.session.dataDir, appId, deployment);
        const secret = deployment.ONCALL_SERVICE_SECRET?.trim() ?? '';
        const username = await resolveOncallUsername(appId, data.operator, target, deployment);
        if (!draft.typeId || !draft.region) throw new Error('请完成问题区域和分类选择');
        const selection = await validateOncallSelection(target, secret, username, draft.region, draft.typeId);
        // Selection may have loaded while another process claimed this question.
        const currentPolicy = getBot(appId).config.oncallGroup;
        const currentPolicySnapshot = JSON.stringify(currentPolicy);
        if (!classifiedCardPolicy(currentPolicy, draft)
          || JSON.stringify(loadOncallGroupTarget(config.session.dataDir, appId)) !== JSON.stringify(target)) throw new Error('配置已变更，请重新打开表单');
        const { fields, reason } = selectedBotmuxForm(currentPolicy, draft, selection.workflow);
        let description = source.privateIntake ? PRIVATE_ONCALL_DESCRIPTION : draft.description;
        let workflowConfig: string | undefined;
        if (botmuxSubmit) {
          if ((!source.privateIntake && !fields) || (source.privateIntake && selection.requiresNativeForm && !fields)
            || JSON.stringify(fields) !== JSON.stringify(draft.botmuxFields)) {
            await prepareOncallFormSelection(draft, username);
            draft.version++;
            persist();
            return { toast: { type: 'warning', content: '表单配置已变更，请按当前卡片重新提交' },
              afterAck: () => refreshOncallFormCard(appId, draft.id, owner) };
          }
          if (source.privateIntake) {
            // Older cards offered a separate summary. Honor it when supplied.
            const summary = data.action?.form_value?.oncall_private_summary;
            if (typeof summary === 'string' && summary.trim()) description = summary.trim();
          }
          if (fields) workflowConfig = serializeBotmuxOncallForm(fields, data.action?.form_value);
        } else if (fields) {
          const request = store.getRequest(source);
          if (request && request.status !== 'failed') {
            return { toast: { type: 'info', content: '此会话已有请求，请从结果卡继续' } };
          }
          draft.botmuxFields = fields;
          delete draft.nativeFormLink;
          delete draft.nativeFormReason;
          draft.version++;
          persist();
          return { toast: { type: 'info', content: '请在当前卡片补充信息后提交' },
            afterAck: () => refreshOncallFormCard(appId, draft.id, owner) };
        } else if (selection.requiresNativeForm) {
          const policyFingerprint = nativeFormPolicyFingerprint(currentPolicy)!;
          const publicBase = publicReverseProxyBaseUrl();
          const nativeLink = await createNativeOncallLink(target, secret, '', draft.description, bot.brand, fetch,
            { region: draft.region, typeId: selection.id, priority: draft.priority, formId: nativeSelectionMarker(draft, selection.id, username, policyFingerprint, publicBase) });
          if (JSON.stringify(getBot(appId).config.oncallGroup) !== currentPolicySnapshot
            || JSON.stringify(loadOncallGroupTarget(config.session.dataDir, appId)) !== JSON.stringify(target)) throw new Error('配置已变更，请重新打开表单');
          const concurrentRequest = store.getRequest(source);
          if (concurrentRequest && concurrentRequest.status !== 'failed') {
            return { toast: { type: 'info', content: '此会话已有请求，请从结果卡继续' } };
          }
          draft.oncallUsername = username;
          const href = recordNativeSubmissionAttempt(draft, nativeLink, {
            sourceLocation: new URL(nativeLink).searchParams.get('url')!.slice(0, 200), username,
            preparedAtMs: Date.now(), policyFingerprint, forwardMode: currentPolicy?.forwardMode ?? 'individual',
            typeId: selection.id, region: draft.region,
          }, publicBase);
          draft.nativeEntry = { href, categoryName: selection.name, policyFingerprint };
          if (reason) draft.nativeFormReason = reason;
          else delete draft.nativeFormReason;
          draft.targetFingerprint = JSON.stringify(target);
          draft.version++;
          persist();
          return { toast: { type: 'info', content: '请从当前分类卡打开人工 Oncall 表单，补充信息并提交' },
            afterAck: () => refreshOncallFormCard(appId, draft.id, owner) };
        }
        const withdrawAfterAck = botmuxSubmit || !!source.privateIntake;
        const snapshot = await snapshotOncallConversation(source);
        if (JSON.stringify(getBot(appId).config.oncallGroup) !== currentPolicySnapshot
          || JSON.stringify(loadOncallGroupTarget(config.session.dataDir, appId)) !== JSON.stringify(target)) throw new Error('配置已变更，请重新打开表单');
        if (!store.claim(source, owner, snapshot, { target, username, region: draft.region, typeId: draft.typeId, formId: draft.id })) {
          return { toast: { type: 'info', content: '此会话已有请求，请勿重复提交' } };
        }
        const attemptId = store.getRequest(source)?.attemptId;
        const creation = createOncallGroup(target, secret, username, description, fetch,
          { region: draft.region, typeId: selection.id, priority: draft.priority, workflowConfig }, attemptId)
          .then(result => {
            if (store.getRequest(source)?.status !== 'succeeded') {
              store.finish(source, { status: 'succeeded', ...result, formClosePending: true }, attemptId);
            }
          }, error => {
            // Persist the platform outcome even if the post-ACK UI work cannot run.
            const request = store.getRequest(source);
            logOncallCreationFailure(error, request?.submittedAtMs);
            if (request?.status !== 'succeeded') store.finish(source, {
              status: error instanceof OncallGroupApiError && !error.uncertain ? 'failed' : 'unknown',
              ...(withdrawAfterAck ? { cardRefreshPending: true, formClosePending: true } : {}),
            }, attemptId);
            throw error;
          });
        const finishSubmission = async (current: OncallFormDraft, save: () => void, withdrawal?: Promise<boolean>) => {
          try {
            await creation;
            current.closed = true;
            save();
            await refreshOncallSessionCard(source).catch(() => {});
            await forwardOncallConversation(source);
            await refreshOncallSessionCard(source).catch(() => {});
            if (withdrawal && await withdrawal) {
              store.finish(source, { status: 'succeeded', formClosePending: false }, attemptId);
            } else if (withdrawal || current.visibility !== 'thread') await writeOncallFormDraft(current, save);
            const request = store.getRequest(source);
            const noForward = request?.forwardMode === 'none';
            const complete = !!request && (noForward || (!request.conversationScopePending && request.handoffError !== 'restricted_merge' && pendingOncallMessageIds(request).length === 0));
            return { toast: { type: complete ? 'success' : 'warning', content: noForward ? '人工 Oncall 已发起，未自动转交对话'
              : request?.handoffError === 'restricted_merge' ? 'Oncall 群已创建，对话含受限消息，无法合并转交'
                : complete ? '人工 Oncall 已发起，对话交接已完成' : 'Oncall 群已创建，部分对话尚待转交，请查看最新回复卡' },
              ...(!withdrawal && current.visibility === 'thread' ? { afterAck: () => refreshOncallFormCard(appId, current.id, owner) } : {}) };
          } catch (error) {
            await refreshOncallSessionCard(source).catch(() => {});
            throw error;
          } finally {
            if (await withdrawal) {
              const settled = store.getRequest(source);
              if (settled && settled.attemptId === attemptId && settled.status === 'failed' && settled.formClosePending) {
                store.finish(source, { status: 'failed', formClosePending: false }, attemptId);
              }
            }
          }
        };
        if (!withdrawAfterAck) return await finishSubmission(draft, persist);
        // Start the durable attempt now. Wait for the callback ACK before touching the form.
        void creation.catch(() => {}); // finishSubmission handles the result.
        return { toast: { type: 'info', content: '已受理，请从原回答卡查看进度' },
          afterAck: () => forms.use(appId, draft.id, owner, async (current, save) => {
            const request = store.getRequest(source);
            if (request?.attemptId !== attemptId || (request?.status === 'succeeded' && request.formClosePending === false)) return;
            if (request?.status === 'failed') {
              await refreshOncallSessionCard(source, { prepareInvite: false }).catch(() => {});
              return;
            }
            // A rejection while recall is in flight must permit reopening a new draft.
            current.closed = true;
            save();
            const messageId = current.messageId;
            const withdrawal = (async () => {
              if (!messageId) return false;
              return current.visibility === 'thread'
                ? client.deleteMessage(appId, messageId, { acceptWithdrawn: true })
                : client.deleteEphemeralCard(appId, messageId, { acceptWithdrawn: true });
            })().catch(() => false);
            // The reply card is still available to report progress or trigger a retry.
            const pendingCard = refreshOncallSessionCard(source, { prepareInvite: false }).catch(() => {});
            try { await finishSubmission(current, save, withdrawal); }
            finally { await pendingCard; }
          }, { allowClosed: true, allowExpired: true }) };
      // Previously delivered forms still have a back button. Refresh them into the linked layout.
      } else if (action !== 'oncall_group_form_back' || !draft.botmuxFields) throw new Error('未知表单操作');
      try {
        await prepareOncallFormSelection(draft, draft.oncallUsername, async () => {
          const deployment = readOncallDeploymentEnv();
          const target = loadOncallGroupTarget(config.session.dataDir, appId, deployment);
          return resolveOncallUsername(appId, data.operator, target, deployment);
        });
      }
      catch (error) { for (const key of Object.keys(draft)) delete (draft as any)[key]; Object.assign(draft, previousDraft); throw error; }
      // Ephemeral cards cannot be PATCHed. Publish the replacement first and
      // then retire the old card; version checks reject every stale callback.
      const priorId = draft.messageId;
      draft.version++;
      if (draft.visibility === 'thread') {
        persist();
        // Lark applies callback completion after PATCH and can restore the old card.
        // Persist first; the dispatcher publishes this card after acknowledging.
        return { toast: { type: 'info', content: '已更新分类选择' },
          afterAck: () => refreshOncallFormCard(appId, draft.id, owner) };
      }
      try {
        if (draft.nativeFormLink) persist();
        draft.messageId = draft.nativeFormLink
          ? await client.sendEphemeralCard(appId, source.chatId, owner, buildOncallFormCard(draft), { beforeWrite: () => assertOncallFormCurrent(draft) })
          : await client.sendEphemeralCard(appId, source.chatId, owner, buildOncallFormCard(draft));
      }
      catch (error) {
        const submission = draft.nativeSubmission;
        for (const key of Object.keys(draft)) delete (draft as any)[key];
        Object.assign(draft, previousDraft);
        // A transport failure can follow actual delivery. Keep the exact
        // issued URL valid even when the editable selection rolls back.
        if (submission) draft.nativeSubmission = submission;
        throw error;
      }
      if (priorId) await client.deleteEphemeralCard(appId, priorId);
      return { toast: { type: 'info', content: '已保存选择，仅你可见' } };
    }, { allowClosed: true });
  } catch (error) { return oncallError(error); }
}

/** One permanent invitation per created group; failures never recreate a ticket. */
export async function prepareOncallGroupInvite(source: OncallGroupSource, beforeWrite?: () => void): Promise<void> {
  const groups = new OncallGroupStore(config.session.dataDir);
  await withFileLock(join(config.session.dataDir, 'oncall-groups', `invite-${groups.handoffKey(source)}`), async () => {
    const request = groups.getRequest(source);
    if (request?.status !== 'succeeded' || !request.openChatId || (source.privateIntake && !request.pendingOriginReplyTo)) return;
    beforeWrite?.();
    const { getChatInviteLink } = await import('./client.js');
    const inviteLink = request.inviteLink ?? await getChatInviteLink(source.appId, request.openChatId);
    if (!request.inviteLink) groups.finish(source, { status: 'succeeded', inviteLink }, request.attemptId);
    if (!request.pendingOriginReplyTo) return;
    const card = JSON.stringify({ schema: '2.0', body: { elements: [
      { tag: 'div', text: { tag: 'plain_text', content: '人工 Oncall 群已创建' } },
      { tag: 'column_set', columns: [buildOncallGroupColumn({ href: inviteLink, status: '进入人工 Oncall 群', joinGroup: true })] },
    ] } });
    try {
      beforeWrite?.();
      await replyMessage(source.appId, request.pendingOriginReplyTo, card, 'interactive', true,
        privateIntakeDeliveryId(source.appId, `origin-join:${request.openChatId}:${request.pendingOriginReplyTo}`),
        undefined, { beforeWrite });
    } catch (error) {
      if (oncallCardUnchangeable(error) !== 'gone') throw error;
    }
    groups.finish(source, { status: 'succeeded', pendingOriginReplyTo: undefined }, request.attemptId);
  });
}

/** Cards that can never be updated again: withdrawn (also as recorded by the
 * reply-card store, or blocked under the stop topic policy) or past Lark's edit window. */
function oncallCardUnchangeable(error: unknown): 'expired' | 'gone' | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === 'MessageUpdateExpiredError') return 'expired';
  if (error.name === 'MessageWithdrawnError' || error.name === 'ReplyCardWithdrawnError') return 'gone';
  return error.name === 'TopicSendError' && (error as { code?: string }).code === 'TOPIC_SEND_BLOCKED' ? 'gone' : undefined;
}

export async function refreshOncallSessionCard(source: OncallGroupSource, options: {
  /** The reconcile loop prepares invitations itself, under its own backoff. */
  prepareInvite?: boolean;
  /** Called for each card that is past Lark's edit window. */
  onExpired?: (messageId: string) => void;
  beforeWrite?: () => void;
} = {}): Promise<void> {
  const started = performance.now();
  const groups = new OncallGroupStore(config.session.dataDir);
  if (options.prepareInvite !== false) {
    await prepareOncallGroupInvite(source, options.beforeWrite).catch(() => logger.warn('[oncall-group] Native group invitation is unavailable; retrying with the existing group'));
  }
  const beforeRefresh = groups.getRequest(source);
  const { TurnReplyCardStore } = await import('../../services/turn-reply-card.js');
  const client = await import('./client.js');
  const cards = new TurnReplyCardStore(config.session.dataDir);
  const failures: unknown[] = [];
  const carriers = groups.sessionSources(source);
  for (const carrier of carriers) {
    const key = carrier.sessionId ? { larkAppId: carrier.appId, sessionId: carrier.sessionId,
      turnId: carrier.questionId, dispatchAttempt: carrier.dispatchAttempt } : undefined;
    const context: OncallCardContext = { appId: carrier.appId, sessionId: carrier.sessionId,
      questionId: carrier.questionId, phase: 'final', nativeLink: carrier.nativeLink, messageId: carrier.messageId, privateIntake: carrier.privateIntake };
    const compose = (raw: string) => attachOncallGroupButton(raw, getBot(carrier.appId).config.oncallGroup, carrier.chatId, 'group', context);
    const patch = (id: string, card: string) => options.beforeWrite
      ? client.updateMessage(carrier.appId, id, card, { beforeWrite: options.beforeWrite }) : client.updateMessage(carrier.appId, id, card);
    const record = key ? cards.read(key) : undefined;
    try {
      if (key && record?.messageId === carrier.messageId) {
        const { buildTurnReplyCard, replyCardPresentation } = await import('./turn-reply-card.js');
        await cards.update(key, { kind: 'refresh' }, {
          beforeEffect: () => {
            options.beforeWrite?.();
            const current = groups.findSource(carrier.appId, carrier.messageId);
            if (current?.chatId !== carrier.chatId || current.questionId !== carrier.questionId) throw new Error('Reply card question changed');
          },
          send: async () => { throw new Error('An Oncall refresh cannot create a reply card'); },
          patch,
          isWithdrawn: () => false,
          render: state => compose(buildTurnReplyCard(state, { ...replyCardPresentation(getBot(carrier.appId).config, carrier.chatId), canStop: false })),
        });
      } else if (carrier.cardJson) {
        // Legacy cards do not have the turn store's serialized render-and-patch.
        const raw = carrier.cardJson;
        const cardKey = createHash('sha256').update(JSON.stringify([carrier.appId, carrier.messageId])).digest('hex');
        const lock = join(config.session.dataDir, 'oncall-groups', `card-${cardKey}`);
        await withFileLock(lock, async () => {
          options.beforeWrite?.();
          await patch(carrier.messageId, compose(raw));
        });
      }
    } catch (error) {
      const unchangeable = oncallCardUnchangeable(error);
      if (!unchangeable) failures.push(error);
      else if (unchangeable === 'expired') options.onExpired?.(carrier.messageId);
    }
  }
  if (failures.length) throw new AggregateError(failures, '部分结果卡的人工入口更新失败，将重试');
  if (beforeRefresh && (beforeRefresh.status === 'succeeded' || beforeRefresh.cardRefreshPending)) {
    groups.markCardsRefreshed(source, beforeRefresh, carriers.map(item => item.messageId));
    if (beforeRefresh.attemptId && beforeRefresh.cardRefreshPending && groups.getRequest(source)?.cardRefreshPending === false) {
      logger.info(`[oncall-group] Card refresh settled attempt=${beforeRefresh.attemptId} elapsedMs=${Math.round(performance.now() - started)}`);
    }
  }
}

/** Read the consultation's original container before claiming: a partial or failed scan
 * must not silently produce a ticket with an incomplete conversation. */
export async function snapshotOncallConversation(source: OncallGroupSource, options: { cutoffMs?: number; forwardMode?: OncallForwardMode } = {}): Promise<{ messageIds: string[]; cutoffMs: number; forwardMode: OncallForwardMode }> {
  const cutoffMs = options.cutoffMs ?? Date.now();
  const forwardMode = options.forwardMode ?? getBot(source.appId).config.oncallGroup?.forwardMode ?? 'individual';
  if (forwardMode === 'none') return { messageIds: [], cutoffMs, forwardMode };
  const client = await import('./client.js');
  const store = new OncallGroupStore(config.session.dataDir);
  const known = store.messageIds(source);
  const otherSessions = store.otherSessionScope(source);
  const excluded = otherSessions.messages;
  let messages: any[];
  let verifiedThread = false;
  const rootId = source.privateIntake?.rootMessageId ?? source.rootId;
  if (rootId?.startsWith('om_')) {
    const thread = await client.listThreadMessagesWithContext(source.appId, source.chatId, rootId, 0);
    messages = thread.messages;
    verifiedThread = thread.verifiedThread;
    if (source.privateIntake) {
      // A quoted DM can belong to the consultation without appearing in its Lark thread.
      const listed = new Set(messages.map(item => item.message_id));
      for (const id of known.filter(id => !listed.has(id))) {
        const detail = await client.getMessageDetail(source.appId, id, { userCardContent: false });
        const item = detail?.items?.find((row: any) => row.message_id === id && row.chat_id === source.chatId);
        if (!item) throw new Error('本次私聊的消息暂不可读取，请稍后重试');
        messages.push(item);
      }
    }
  } else {
    const firstId = known[0] ?? source.questionId;
    messages = await client.listChatMessagesUntil(source.appId, source.chatId, { stopAfter: item => item.message_id === firstId });
    if (!messages.some(item => item.message_id === firstId)) throw new Error('无法读取本次问题，请重试');
  }
  const first = messages.find(item => item.message_id === (known[0] ?? source.questionId));
  if (!first || !Number.isFinite(Number(first.create_time))) throw new Error('无法确定当前会话的开始位置，请重试');
  // A new session may reuse the topic container after a reset. Its first
  // registered message bounds the preceding session, even if clicked later.
  const nextSessionStart = verifiedThread ? Math.min(...messages.filter(item => otherSessions.starts.has(item.message_id) && Number(item.create_time) > Number(first.create_time)).map(item => Number(item.create_time))) : Infinity;
  const formMessageIds = new OncallFormStore(config.session.dataDir).publishedMessageIds(source);
  const members = new Set(known);
  messages = messages.filter(item => !item.deleted && !formMessageIds.has(item.message_id) && !isOncallFormMessage(item) && Number.isFinite(Number(item.create_time))
    && Number(item.create_time) >= Number(first.create_time) && Number(item.create_time) <= cutoffMs && Number(item.create_time) < nextSessionStart)
    .sort((a, b) => Number(a.create_time) - Number(b.create_time));
  messages = messages.filter(item => {
    if (!known.includes(item.message_id) && (excluded.has(item.message_id) || excluded.has(item.parent_id))) {
      excluded.add(item.message_id);
      return false;
    }
    if (verifiedThread || members.has(item.message_id) || members.has(item.parent_id) || members.has(item.root_id)) {
      members.add(item.message_id);
      return true;
    }
    return false;
  });
  const messageIds = [...new Set(messages.map(item => item.message_id).filter(id => typeof id === 'string' && /^om_[a-zA-Z0-9]+$/.test(id)))];
  if (!messageIds.includes(source.questionId) || !messageIds.includes(source.messageId)) throw new Error('原问题或回复卡暂不可读取，请稍后重试');
  if (source.privateIntake && source.sessionId?.startsWith('oncall-private-')) {
    return { messageIds: messageIds.filter(id => id !== rootId), cutoffMs, forwardMode };
  }
  return { messageIds, cutoffMs, forwardMode };
}

function isOncallFormMessage(message: any): boolean {
  if (message.msg_type !== 'interactive') return false;
  const walk = (value: any): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (value.element_id === 'botmux_oncall_form_state' || String(value.value?.action ?? '').startsWith('oncall_group_form_')) return true;
    return Object.values(value).some(item => typeof item === 'object' && walk(item));
  };
  try { return walk(JSON.parse(message.body?.content ?? '')); }
  catch { return false; }
}

export async function forwardOncallConversation(source: OncallGroupSource, owns: () => boolean = () => true): Promise<void> {
  const mayForward = () => owns() && oncallSourceEnabled(getBot(source.appId).config.oncallGroup, source);
  const store = new OncallGroupStore(config.session.dataDir);
  const key = store.handoffKey(source);
  await withFileLock(join(config.session.dataDir, 'oncall-groups', `handoff-${key}`), async () => {
    let request = store.getRequest(source);
    if (!mayForward()) return;
    if (request?.status !== 'succeeded' || !request.openChatId || request.forwardMode === 'none' || request.handoffError === 'restricted_merge') return;
    const targetChatId = request.openChatId;
    if (request.conversationScopePending) {
      // Repair the short-lived per-question format without losing receipts or
      // including messages posted after the original handoff was submitted.
      if (!Number.isFinite(request.submittedAtMs)) throw new Error('无法确认原交接时间，请管理员核对');
      const original = store.findSource(source.appId, request.sourceMessageId ?? '') ?? source;
      const snapshot = await snapshotOncallConversation(original, { cutoffMs: request.submittedAtMs, forwardMode: request.forwardMode ?? 'individual' });
      request = { ...request, messageIdsSnapshot: [...new Set([...snapshot.messageIds, ...(request.messageIdsSnapshot ?? [])])], conversationScopePending: false };
      store.finish(source, request, request.attemptId);
    }
    const { forwardMessage, mergeForwardMessages, isBotInChat } = await import('./client.js');
    if (!await isBotInChat(source.appId, targetChatId)) {
      store.finish(source, { ...request, handoffError: 'waiting_for_bot' }, request.attemptId);
      return;
    }
    if (request.handoffError) {
      request = { ...request, handoffError: undefined };
      store.finish(source, request, request.attemptId);
    }
    const forwardStarted = performance.now();
    const forwardedBefore = request.forwarded?.length ?? 0;
    while (true) {
      if (!mayForward()) return;
      const remaining = pendingOncallMessageIds(request);
      if (!remaining.length) break;
      const priorBatch = request.forwarding?.messageIds ?? (request.forwarding ? [request.forwarding.messageId] : undefined);
      // An expanded legacy snapshot must first resolve the old uncertain
      // batch with its original identity, before sending newly found messages.
      const batch: string[] = priorBatch?.length && priorBatch.every(id => remaining.includes(id))
        ? priorBatch : request.forwardMode === 'merge' ? remaining.slice(0, 100) : remaining.slice(0, 1);
      if (request.forwarding && (JSON.stringify(priorBatch) !== JSON.stringify(batch)
        || Date.now() - request.forwarding.startedAtMs >= 55 * 60_000)) {
        store.finish(source, { ...request, forwardingBlocked: true }, request.attemptId);
        break;
      }
      request = { ...request, forwarding: request.forwarding ?? { messageId: batch[0], messageIds: batch, startedAtMs: Date.now() } };
      store.finish(source, request, request.attemptId);
      // Preserve the existing individual UUID across upgrades and retries.
      const identity = request.forwardMode === 'merge' ? ['merge', batch] : batch[0];
      const uuid = createHash('sha256').update(JSON.stringify([request.attemptId, identity])).digest('hex').slice(0, 32);
      try {
        const result: { messageId: string; invalidMessageIds: string[] } = request.forwardMode === 'merge'
          ? await mergeForwardMessages(source.appId, batch, targetChatId, uuid)
          : { messageId: await forwardMessage(source.appId, batch[0], targetChatId, uuid), invalidMessageIds: [] };
        const valid: string[] = batch.filter(id => !result.invalidMessageIds.includes(id));
        request = { ...request, forwarded: [...(request.forwarded ?? []), ...valid],
          forwardedMessageIds: { ...request.forwardedMessageIds, ...Object.fromEntries(valid.map(id => [id, result.messageId])) },
          forwarding: undefined, forwardingBlocked: false };
        store.finish(source, request, request.attemptId);
        if (valid.length !== batch.length) break;
      } catch (error) {
        const code = extractLarkBusinessCode(error);
        if (code === LARK_CODE_FORWARD_RESTRICTED) {
          // A rejected single original is known not to have been delivered.
          // A rejected merge does not identify which original is restricted.
          request = { ...request, forwarding: undefined, forwardingBlocked: false,
            ...(batch.length === 1 ? { restrictedMessageIds: [...(request.restrictedMessageIds ?? []), batch[0]] }
              : { handoffError: 'restricted_merge' }) };
          store.finish(source, request, request.attemptId);
          if (batch.length === 1) continue;
        }
        logger.warn(`[oncall-group] Original conversation forwarding incomplete (code=${code ?? 'unknown'}); group binding is retained`);
        break;
      }
    }
    const delivered = (request.forwarded?.length ?? 0) - forwardedBefore;
    if (request.attemptId && delivered > 0 && !oncallForwardingPending(request)) {
      logger.info(`[oncall-group] Conversation delivery settled attempt=${request.attemptId} elapsedMs=${Math.round(performance.now() - forwardStarted)}`);
    }
  }, { maxWaitMs: 60_000 });
}

const ONCALL_HANDOFF_WINDOW_MS = 24 * 60 * 60_000;
const ONCALL_REPAIR_RETRY_MAX_MS = 30 * 60_000;
/** A late bot join gives no other signal in a no-forwarding handoff. */
const ONCALL_ACTIVE_REPAIR_RETRY_MAX_MS = 2 * 60_000;
interface OncallRepairRetry { failures: number; nextAtMs: number; state: string }
/** Per app, per created group: the request state at the last failed repair and
 * when the same state may be retried. In memory, so a restart retries once. */
const oncallRepairRetries = new Map<string, Map<string, OncallRepairRetry>>();

async function reconcileOncallCreation(source: OncallGroupSource, owns: () => boolean): Promise<void> {
  const store = new OncallGroupStore(config.session.dataDir);
  await withFileLock(join(config.session.dataDir, 'oncall-groups', `creation-${store.handoffKey(source)}`), async () => {
    const request = store.getRequest(source);
    if (!request?.creation || !request.attemptId || !['pending', 'unknown'].includes(request.status)) return;
    // Let the ordinary callback finish first. Only a stranded pending claim needs lookup.
    if (request.status === 'pending' && Date.now() - (request.submittedAtMs ?? 0) < ONCALL_GROUP_CREATE_TIMEOUT_MS + 5_000) return;
    const allowed = () => owns() && oncallSourceEnabled(getBot(source.appId).config.oncallGroup, source)
      && JSON.stringify(loadOncallGroupTarget(config.session.dataDir, source.appId)) === JSON.stringify(request.creation!.target);
    if (!allowed()) return;
    const secret = readOncallDeploymentEnv().ONCALL_SERVICE_SECRET?.trim() ?? '';
    const result = await readOncallGroupResult(request.creation, secret, request.attemptId);
    if (!result || !allowed()) return;
    const current = store.getRequest(source);
    if (current?.attemptId !== request.attemptId || !['pending', 'unknown'].includes(current.status)
      || JSON.stringify(current.creation) !== JSON.stringify(request.creation)) return;
    store.finish(source, { status: 'succeeded', ...result, formClosePending: !!request.creation.formId }, request.attemptId);
  }, { maxWaitMs: 1000 });
}

async function closeRecoveredOncallForm(source: OncallGroupSource, owns: () => boolean): Promise<void> {
  const store = new OncallGroupStore(config.session.dataDir);
  const request = store.getRequest(source);
  if (!request?.formClosePending || !request.creation?.formId || !request.operatorOpenId) return;
  // Interaction expiry must not discard cleanup owed by an already submitted request.
  await new OncallFormStore(config.session.dataDir).use(source.appId, request.creation.formId, request.operatorOpenId, async (draft, persist) => {
    const current = store.getRequest(source);
    if (!owns() || !current || current.attemptId !== request.attemptId
      || (current.status !== 'succeeded' && current.status !== 'failed') || !current.formClosePending) return;
    if (draft.source.chatId !== source.chatId || draft.source.sessionId !== source.sessionId
      || draft.source.questionId !== current.questionId || draft.source.messageId !== current.sourceMessageId) throw new Error('恢复请求与分类表单不匹配');
    draft.closed = true;
    persist();
    await writeOncallFormDraft(draft, persist, owns);
  }, { allowClosed: true, allowExpired: true });
}

const nativeSubmissionChecks = new Map<string, number>();
const ONCALL_RECOVERY_TICK_MS = 5_000;
const NATIVE_ONCALL_FAST_WINDOW_MS = 2 * 60_000;

function isRecentHostedSubmission(attempts: OncallNativeSubmissionAttempt[], now: number): boolean {
  const last = attempts.at(-1);
  return !!last && now - last.preparedAtMs < NATIVE_ONCALL_FAST_WINDOW_MS && attempts.every(item => item.hostedSourceLocation);
}

/** Recover platform submissions into the same durable handoff used by ordinary categories. */
export async function reconcileNativeOncallSubmissions(appId: string, owns: () => boolean = () => true,
  scan?: 'recent-hosted' | 'regular'): Promise<void> {
  const forms = new OncallFormStore(config.session.dataDir);
  const groups = new OncallGroupStore(config.session.dataDir);
  const pending = forms.pendingNativeSubmissions(appId);
  const keys = new Set(pending.map(draft => JSON.stringify([config.session.dataDir, appId, draft.id])));
  for (const key of nativeSubmissionChecks.keys()) {
    const parts = JSON.parse(key);
    if (parts[0] === config.session.dataDir && parts[1] === appId && !keys.has(key)
      && nativeSubmissionChecks.get(key) !== Infinity) nativeSubmissionChecks.delete(key);
  }
  for (const candidate of pending) {
    if (!owns()) return;
    if (scan) {
      const policy = nativeFormPolicyFingerprint(getBot(appId).config.oncallGroup);
      const eligible = candidate.nativeSubmission?.attempts.filter(item => item.policyFingerprint === policy) ?? [];
      if (isRecentHostedSubmission(eligible, Date.now()) !== (scan === 'recent-hosted')) continue;
    }
    const key = JSON.stringify([config.session.dataDir, appId, candidate.id]);
    if (Date.now() < (nativeSubmissionChecks.get(key) ?? 0)) continue;
    // An overlapping tick must not queue behind the lock and bypass backoff.
    nativeSubmissionChecks.set(key, Infinity);
    let retryAt: number | undefined;
    try {
      await forms.use(appId, candidate.id, candidate.ownerOpenId, async (draft, persist) => {
        const submission = draft.nativeSubmission;
        if (!submission?.attempts.length || submission.completed) return;
        const target = loadOncallGroupTarget(config.session.dataDir, appId);
        const assertCurrent = (attempt?: OncallNativeSubmissionAttempt) => {
          const policy = getBot(appId).config.oncallGroup;
          if (!owns() || !classifiedCardPolicy(policy, draft)
            || (attempt && nativeFormPolicyFingerprint(policy) !== attempt.policyFingerprint)
            || JSON.stringify(loadOncallGroupTarget(config.session.dataDir, appId)) !== draft.targetFingerprint) {
            throw new Error('原生提单配置已变化，暂不关联或转交');
          }
        };
        assertCurrent();
        const policyFingerprint = nativeFormPolicyFingerprint(getBot(appId).config.oncallGroup);
        const eligibleAttempts = submission.attempts.filter(item => item.policyFingerprint === policyFingerprint);
        if (!eligibleAttempts.length) throw new Error('原生提单配置已变化，暂不关联或转交');
        const request = groups.getRequest(draft.source);
        let completionAttempt = eligibleAttempts.at(-1)!;
        if (!request || request.status === 'failed') {
          // Cancellation atomically removes nativeSubmission. A closed candidate
          // was retired automatically and may still own an unresolved native ticket.
          const lookupStartedAt = Date.now();
          const lookupStarted = performance.now();
          if (isRecentHostedSubmission(eligibleAttempts, lookupStartedAt)) {
            retryAt = lookupStartedAt + ONCALL_RECOVERY_TICK_MS;
          }
          const secret = readOncallDeploymentEnv().ONCALL_SERVICE_SECRET?.trim() ?? '';
          const candidates = await readNativeOncallResultCandidates(target, secret, eligibleAttempts, fetch, {
            checkpoint: submission.scan,
            save: checkpoint => {
              assertCurrent(completionAttempt);
              submission.scan = checkpoint;
              persist();
            },
          });
          if (!candidates.length) return;
          const lookupMs = Math.round(performance.now() - lookupStarted);
          const valid = candidates.filter(({ attempt, result }) => result.handoffAtMs >= Math.floor(attempt.preparedAtMs / 1000) * 1000
            && result.handoffAtMs <= Date.now());
          if (!valid.length) throw new Error('提单时间与原生表单不匹配');
          // Candidates share the one verified platform order. Prefer the latest
          // published selection whose preparation window contains the handoff.
          const chosen = valid.sort((a, b) => b.attempt.preparedAtMs - a.attempt.preparedAtMs)[0]!;
          completionAttempt = chosen.attempt;
          assertCurrent(chosen.attempt);
          const snapshot = await snapshotOncallConversation(draft.source, {
            cutoffMs: chosen.result.handoffAtMs, forwardMode: chosen.attempt.forwardMode,
          });
          assertCurrent(chosen.attempt);
          const { flowId, openChatId } = chosen.result;
          if (!groups.adoptNativeGroup(draft.source, draft.ownerOpenId, { flowId, openChatId }, snapshot)) return;
          const attemptId = groups.getRequest(draft.source)?.attemptId;
          logger.info(`[oncall-group] Native group matched attempt=${attemptId} sinceHandoffMs=${Date.now() - chosen.result.handoffAtMs} lookupMs=${lookupMs} snapshotMs=${Math.round(performance.now() - lookupStarted) - lookupMs}`);
        } else if (request.status !== 'succeeded') return;
        // Adoption is atomic. If PATCH/withdraw fails, the next pass retires the
        // form from the existing request; it never creates or reclaims a ticket.
        draft.closed = true;
        delete submission.scan;
        persist();
        assertCurrent(completionAttempt);
        await writeOncallFormDraft(draft, persist, owns);
        assertCurrent(completionAttempt);
        submission.completed = true;
        persist();
      }, { allowClosed: true });
    } catch {
      retryAt = Date.now() + 60_000;
      logger.warn('[oncall-group] Native submission reconciliation will retry; no new ticket is created');
    } finally {
      nativeSubmissionChecks.set(key, retryAt ?? Date.now() + 15_000);
    }
  }
}

export async function retryPendingOncallHandoffs(appId: string, owns: () => boolean = () => true): Promise<void> {
  const store = new OncallGroupStore(config.session.dataDir);
  const pending = store.pendingHandoffs(appId);
  const retries = oncallRepairRetries.get(appId) ?? new Map<string, OncallRepairRetry>();
  oncallRepairRetries.set(appId, retries);
  const pendingKeys = new Set(pending.map(source => store.handoffKey(source)));
  for (const key of retries.keys()) if (!pendingKeys.has(key)) retries.delete(key);
  for (const source of pending) {
    if (!owns()) return;
    const key = store.handoffKey(source);
    let before = JSON.stringify(store.getRequest(source));
    const handoffOpen = Date.now() - (store.getRequest(source)?.submittedAtMs ?? 0) < ONCALL_HANDOFF_WINDOW_MS;
    // A lasting invitation failure (no share permission, bot left the group) or,
    // for old groups, a lasting card failure must not repeat every cycle. Any
    // change to the request (bot joined, receipt, a click repaired the invite)
    // retries at once. Forwarding inside the handoff window keeps its 5 s cycle.
    const retry = retries.get(key);
    let waiting = !!retry && retry.state === before && Date.now() < retry.nextAtMs;
    const request = store.getRequest(source);
    if (request?.status !== 'succeeded') {
      if (waiting) continue;
      // An overlapping tick must not start a second lookup while this one awaits I/O.
      retries.set(key, { failures: 0, state: before, nextAtMs: Infinity });
      let failed = false;
      if (request?.cardRefreshPending) {
        try {
          await refreshOncallSessionCard(source, { prepareInvite: false, beforeWrite: () => {
            if (!owns()) throw new Error('Oncall handoff recovery stopped');
          } });
        } catch {
          failed = true;
          logger.warn('[oncall-group] Pending result card will retry');
        }
      }
      if (request?.status !== 'failed') {
        try { await reconcileOncallCreation(source, owns); }
        catch { failed = true; logger.warn('[oncall-group] Create result reconciliation will retry; no new group is created'); }
      }
      if (store.getRequest(source)?.status !== 'succeeded') {
        const current = store.getRequest(source);
        if (current?.status === 'failed' && current.formClosePending && owns()) {
          try { await closeRecoveredOncallForm(source, owns); }
          catch { failed = true; logger.warn('[oncall-group] Failed form cleanup will retry'); }
        }
        retries.set(key, { failures: 0, state: JSON.stringify(store.getRequest(source)), nextAtMs: Date.now() + (failed ? 60_000 : 15_000) });
        continue;
      }
      retries.delete(key);
      before = JSON.stringify(store.getRequest(source));
      waiting = false;
    }
    if (!owns()) return;
    if (waiting && !handoffOpen) continue;
    let inviteFailed = false;
    let refreshFailed = false;
    try {
      if (!waiting) await prepareOncallGroupInvite(source, () => {
        if (!owns()) throw new Error('Oncall handoff recovery stopped');
      }).catch(() => { inviteFailed = true; });
      if (!owns()) return;
      // Backfill old invite buttons without re-opening the expired handoff window,
      // and check membership only when conversation forwarding is still owed.
      const current = store.getRequest(source);
      if (handoffOpen && current && oncallForwardingPending(current)) {
        await forwardOncallConversation(source, () => owns() && oncallSourceEnabled(getBot(appId).config.oncallGroup, source));
      }
      if (JSON.stringify(store.getRequest(source)) !== before || store.getRequest(source)?.cardRefreshPending) {
        await refreshOncallSessionCard(source, { prepareInvite: false, beforeWrite: () => {
          if (!owns()) throw new Error('Oncall handoff recovery stopped');
        } }).catch(error => { refreshFailed = true; throw error; });
      }
      if (owns()) await closeRecoveredOncallForm(source, owns).catch(error => { refreshFailed = true; throw error; });
    } catch {
      logger.warn('[oncall-group] Handoff reconciliation will retry; no new group is created');
    }
    if (inviteFailed || (refreshFailed && !handoffOpen)) {
      const failures = (retry?.failures ?? 0) + 1;
      const maxWaitMs = handoffOpen && oncallSourceEnabled(getBot(appId).config.oncallGroup, source)
        ? ONCALL_ACTIVE_REPAIR_RETRY_MAX_MS : ONCALL_REPAIR_RETRY_MAX_MS;
      retries.set(key, { failures, state: JSON.stringify(store.getRequest(source)),
        nextAtMs: Date.now() + Math.min(maxWaitMs, 5_000 * 2 ** failures) });
    } else if (!waiting) retries.delete(key);
  }
}

/** Slow platform lookups must not hold up work for already confirmed groups. */
export function startOncallHandoffRecovery(appId: string): () => void {
  let stopped = false;
  const owns = () => !stopped;
  const schedule = (recover: typeof retryPendingOncallHandoffs, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      try {
        await recover(appId, owns);
      } catch {
        logger.warn(`[oncall-group] ${label} failed; retry remains scheduled`);
      } finally {
        if (!stopped) {
          timer = setTimeout(() => { void tick(); }, ONCALL_RECOVERY_TICK_MS);
          timer.unref?.();
        }
      }
    };
    void tick();
    return () => clearTimeout(timer);
  };
  const stopRecent = schedule((app, ownsScan) => reconcileNativeOncallSubmissions(app, ownsScan, 'recent-hosted'),
    'Recent native submission recovery');
  const stopNative = schedule((app, ownsScan) => reconcileNativeOncallSubmissions(app, ownsScan, 'regular'),
    'Native submission recovery');
  const stopHandoffs = schedule(retryPendingOncallHandoffs, 'Handoff recovery');
  return () => {
    stopped = true;
    stopRecent();
    stopNative();
    stopHandoffs();
  };
}
