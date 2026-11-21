import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFeedbackExtensionConfig, saveFeedbackExtensionConfig } from '../services/feedback-extension-config.js';
import { buildFeedbackSurface, validateFeedbackTemplate } from '../services/feedback-template.js';
import { resolveFeedbackPolicyForDelivery } from '../services/feedback-policy-resolver.js';
import { resolveFeedbackPresentation, normalizeFeedbackPresentation } from '../services/feedback-presentation.js';
import { loadBotConfigs, getBotOpenId } from '../bot-registry.js';
import { getMessageDetail } from '../im/lark/client.js';
import { stampBotmuxCallbackMarkers } from '../im/lark/callback-button-marker.js';
import { canonicalJson } from '../utils/canonical-input-hash.js';
import { FeedbackExtensionStore } from '../services/feedback-extension-store.js';

export function authorizeFeedbackExtensionChange(
  permissions: { hostAdmin: boolean; manager: boolean; csrf: boolean }, kind: 'hooks' | 'presentation',
): void {
  if (!permissions.csrf || !permissions.manager || (kind === 'hooks' && !permissions.hostAdmin)) throw new Error('feedback_extension_forbidden');
}
export async function handleFeedbackExtensionApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: {
  dataDir: string; hostAdmin: boolean; manager: boolean; csrf: boolean;
}): Promise<void> {
  const respond = (status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  };
  if (!deps.manager) return respond(403, { error: 'feedback_extension_forbidden' });
  try {
    const config = await readFeedbackExtensionConfig(deps.dataDir);
    if (req.method === 'GET') {
      if (url.pathname === '/api/feedback/extensions/executions') {
        const appId = url.searchParams.get('appId') ?? '';
        if (!loadBotConfigs().some(bot => bot.larkAppId === appId)) throw new Error('feedback_bot_not_found');
        const store = await FeedbackExtensionStore.open(deps.dataDir);
        try {
          return respond(200, { items: store.jobsForApp(appId).map(job => ({
            id: job.id, kind: job.kind, status: job.status, result: job.result ?? null,
          })) });
        } finally { store.close(); }
      }
      if (url.pathname !== '/api/feedback/extensions') return respond(404, { error: 'not_found' });
      const presentations = { ...Object.fromEntries(loadBotConfigs().filter(bot => bot.feedbackPresentation)
        .map(bot => [bot.larkAppId, bot.feedbackPresentation])), ...config.presentations };
      return respond(200, { ...config, presentations, hostAdmin: deps.hostAdmin,
        hooks: deps.hostAdmin ? config.hooks : config.hooks.map(hook => ({ id: hook.id, enabled: hook.enabled, allowedBotAppIds: hook.allowedBotAppIds, allowedChatIds: hook.allowedChatIds, allowedActionIds: hook.allowedActionIds })) });
    }
    if (req.method !== 'POST') return respond(405, { error: 'method_not_allowed' });
    if (!deps.csrf) return respond(403, { error: 'feedback_extension_forbidden' });
    let raw = '';
    for await (const chunk of req) {
      raw += String(chunk);
      if (Buffer.byteLength(raw) > 65536) throw new Error('feedback_extension_request_too_large');
    }
    const body = JSON.parse(raw || '{}') as Record<string, any>;
    if (url.pathname === '/api/feedback/extensions/reconcile-surface') {
      authorizeFeedbackExtensionChange(deps, 'hooks');
      if (body.confirmed !== true || typeof body.messageId !== 'string' || !/^om_[A-Za-z0-9_-]+$/.test(body.messageId)
        || typeof body.jobId !== 'string' || typeof body.evidence !== 'string') throw new Error('feedback_reconciliation_invalid');
      const store = await FeedbackExtensionStore.open(deps.dataDir);
      try {
        const job = store.job(body.jobId);
        if (job?.kind !== 'surface' || job.status !== 'unknown') return respond(409, { error: 'feedback_surface_not_unknown' });
        const appId = String(job.payload.appId);
        const detail = await getMessageDetail(appId, body.messageId, { userCardContent: false });
        const message = detail?.items?.[0] ?? detail;
        const botOpenId = getBotOpenId(appId);
        if (!botOpenId || message?.sender?.id !== botOpenId || message?.chat_id !== job.payload.chatId
          || message?.parent_id !== job.payload.subjectId || typeof message?.body?.content !== 'string') throw new Error('feedback_surface_receipt_unverified');
        const card = JSON.parse(message.body.content);
        if (canonicalJson(card) !== canonicalJson(JSON.parse(stampBotmuxCallbackMarkers(JSON.stringify(job.payload.card))))) throw new Error('feedback_surface_content_unverified');
        const changed = store.reconcileSurfaceReceipt(body.jobId, body.messageId, 'dashboard:host-admin', body.evidence);
        return respond(changed ? 200 : 409, { changed });
      } finally { store.close(); }
    }
    if (url.pathname === '/api/feedback/extensions/reconcile') {
      authorizeFeedbackExtensionChange(deps, 'hooks');
      if (body.confirmed !== true || !['succeeded', 'failed_before_effect'].includes(body.outcome)
        || typeof body.evidence !== 'string' || typeof body.jobId !== 'string') throw new Error('feedback_reconciliation_invalid');
      const store = await FeedbackExtensionStore.open(deps.dataDir);
      try {
        const changed = store.reconcileUnknown(body.jobId, body.outcome, 'dashboard:host-admin', body.evidence);
        return respond(changed ? 200 : 409, { changed });
      } finally { store.close(); }
    }
    if (url.pathname === '/api/feedback/extensions/preview') {
      const bot = loadBotConfigs().find(item => item.larkAppId === body.appId);
      if (!bot) throw new Error('feedback_bot_not_found');
      const policy = resolveFeedbackPolicyForDelivery({ dataDir: deps.dataDir, bot, larkAppId: body.appId, chatId: body.chatId });
      if (!policy) throw new Error('feedback_policy_disabled');
      const presentation = resolveFeedbackPresentation(normalizeFeedbackPresentation(body.presentation ?? config.presentations[body.appId] ?? bot.feedbackPresentation),
        { botAppId: body.appId, chatId: body.chatId ?? '', sourceMessageId: body.sourceMessageId ?? '', round: body.round ?? 1 });
      const template = validateFeedbackTemplate(body.template ?? (body.templates ?? config.templates).find((item: { id: string }) => item.id === presentation.templateId));
      const card = buildFeedbackSurface({ template, policy, preview: true, round: body.round ?? 1,
        answerUrl: 'https://example.com/answer', state: body.state ?? {}, status: body.status ?? '',
        actions: config.actions.filter(action => presentation.actionIds.includes(action.id)) });
      return respond(200, { card, presentation, version: config.version, buttons: policy.buttons });
    }
    const kind = url.pathname === '/api/feedback/extensions/hooks' ? 'hooks' : 'presentation';
    authorizeFeedbackExtensionChange(deps, kind);
    if (url.pathname === '/api/feedback/extensions/subscriptions') {
      const updated = await saveFeedbackExtensionConfig(deps.dataDir, body.expectedVersion, { ...config, subscriptions: body.subscriptions }, 'dashboard:manager');
      return respond(200, { version: updated.version, subscriptions: updated.subscriptions });
    }
    if (kind === 'hooks') {
      const hooks = body.hooks;
      if (!Array.isArray(hooks)) throw new Error('feedback_hook_list_invalid');
      const extensionStore = await FeedbackExtensionStore.open(deps.dataDir);
      try {
        const unsettled = extensionStore.unsettledHookIds();
        if (unsettled.some(id => !hooks.some(hook => hook.id === id))) throw new Error('feedback_hook_unsettled');
      } finally { extensionStore.close(); }
      const enabling = hooks.some(hook => hook.enabled && JSON.stringify(hook) !== JSON.stringify(config.hooks.find(old => old.id === hook.id)));
      if (enabling && body.confirmed !== true) throw new Error('feedback_hook_enable_confirmation_required');
      const updated = await saveFeedbackExtensionConfig(deps.dataDir, body.expectedVersion, { ...config, hooks, actions: body.actions ?? config.actions, subscriptions: body.subscriptions ?? config.subscriptions }, 'dashboard:host-admin');
      return respond(200, updated);
    }
    if (url.pathname !== '/api/feedback/extensions/presentation') return respond(404, { error: 'not_found' });
    if (!loadBotConfigs().some(item => item.larkAppId === body.appId)) throw new Error('feedback_bot_not_found');
    const templates = body.templates ?? config.templates;
    const presentations = { ...config.presentations, [body.appId]: normalizeFeedbackPresentation(body.presentation) };
    const updated = await saveFeedbackExtensionConfig(deps.dataDir, body.expectedVersion, { ...config, templates, presentations,
      actions: body.actions ?? config.actions }, 'dashboard:manager');
    return respond(200, { version: updated.version, templates: updated.templates, presentation: updated.presentations[body.appId] });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'feedback_extension_failed';
    respond(message.includes('conflict') ? 409 : message.includes('forbidden') ? 403 : 400, { error: message });
  }
}
