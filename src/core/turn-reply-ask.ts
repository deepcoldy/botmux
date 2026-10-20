import { config } from '../config.js';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { getBot, normalizeUsageDisplay } from '../bot-registry.js';
import { localeForBot } from '../i18n/index.js';
import { getAskSnapshot } from './ask-broker.js';
import type { AskResult, CreateAskInput, PendingAsk } from './ask-types.js';
import type { DaemonSession } from './types.js';
import { replyCardSandboxBlocked } from './turn-reply-card.js';
import { TurnReplyCardStore, replyCardIsTerminal, type TurnReplyCardTransport } from '../services/turn-reply-card.js';
import { buildTurnReplyCard, replyCardPresentation } from '../im/lark/turn-reply-card.js';
import { MessageWithdrawnError, replyMessage, sendMessage, uploadFile } from '../im/lark/client.js';
import { patchPublishedGroupCard, readGroupContextAuthorOrigin } from '../services/group-context-publication.js';
import type { GroupContextDeliveryBinding } from '../services/group-context-delivery-store.js';

/** Only the authenticated, currently running turn can admit an inline Ask.
 * Large forms retain their standalone presentation without truncating choices. */
export function replyCardAskTarget(
  ds: DaemonSession | undefined,
  input: Pick<CreateAskInput, 'sessionId' | 'larkAppId' | 'chatId' | 'rootMessageId' | 'questions'>,
  origin: { originTurnId?: unknown; originDispatchAttempt?: unknown },
): CreateAskInput['replyCardTarget'] {
  const sameAnchor = ds && ((ds.scope ?? ds.session.scope) === 'chat'
    ? input.rootMessageId === null || input.rootMessageId === ds.chatId
    : input.rootMessageId === ds.session.rootMessageId);
  if (!ds || typeof origin.originTurnId !== 'string' || origin.originTurnId !== ds.replyCardRunningTurnId
    || input.sessionId !== ds.session.sessionId || input.larkAppId !== ds.larkAppId || input.chatId !== ds.chatId
    || !sameAnchor
    || input.questions.reduce((sum, q) => sum + q.options.length, 0) > 16
    || Buffer.byteLength(JSON.stringify(input.questions), 'utf8') > 3000) return undefined;
  if (replyCardSandboxBlocked(ds)) return undefined;
  const dispatchAttempt = typeof origin.originDispatchAttempt === 'number' ? origin.originDispatchAttempt : undefined;
  const target = { turnId: origin.originTurnId, dispatchAttempt };
  const record = new TurnReplyCardStore(config.session.dataDir).read({
    larkAppId: input.larkAppId, sessionId: input.sessionId, ...target,
  });
  if (!record || record.mode !== 'unified' || record.withdrawn || replyCardIsTerminal(record) || record.finalDelivered) return undefined;
  const groupContextAuthorOrigin = readGroupContextAuthorOrigin({
    appId: ds.larkAppId, chatId: ds.chatId, sessionId: ds.session.sessionId, turnId: target.turnId,
    nativeSessionId: ds.session.cliSessionId, workerGeneration: ds.session.workerGeneration,
    cliId: ds.session.cliLaunchSnapshot?.cliId ?? ds.session.cliId ?? getBot(ds.larkAppId).config.cliId,
  });
  return groupContextAuthorOrigin ? { ...target, groupContextAuthorOrigin } : target;
}

export function replyCardAskCanAct(ask: PendingAsk, messageId: string | undefined): boolean {
  if (!ask.replyCardTarget || !messageId) return false;
  const record = new TurnReplyCardStore(config.session.dataDir).read({
    larkAppId: ask.larkAppId, sessionId: ask.sessionId, ...ask.replyCardTarget,
  });
  return !!record && !record.withdrawn && record.messageId === messageId
    && (!replyCardIsTerminal(record) || record.disconnected === true)
    && record.asks?.some(entry => entry.ask.askId === ask.askId && entry.ask.nonce === ask.nonce) === true;
}

/** Re-read broker state inside the same lock used by CLI/worker publishers.
 * Never return raw card JSON in a callback: it could overwrite a newer reply. */
export async function publishReplyCardAsk(ask: PendingAsk, result?: AskResult, confirmEmptyArmed = false, forcePatch = false): Promise<string> {
  if (!ask.replyCardTarget) throw new Error('Missing reply-card Ask target');
  const store = new TurnReplyCardStore(config.session.dataDir);
  const key = { larkAppId: ask.larkAppId, sessionId: ask.sessionId, ...ask.replyCardTarget };
  let groupContextAuthorOrigin: GroupContextDeliveryBinding | undefined;
  const beforeEffect = () => {
    const record = store.read(key);
    if (!record || record.chatId !== ask.chatId || getBot(ask.larkAppId).config.apiOnly) throw new Error('Ask reply-card destination unavailable');
  };
  const transport: TurnReplyCardTransport = {
    forcePatch,
    beforeEffect,
    send: (body, uuid) => ask.rootMessageId?.startsWith('om_')
      ? replyMessage(ask.larkAppId, ask.rootMessageId, body, 'interactive', true, uuid, undefined,
          groupContextAuthorOrigin ? { groupContextAuthorOrigin } : undefined)
      : sendMessage(ask.larkAppId, ask.chatId, body, 'interactive', uuid, undefined,
          groupContextAuthorOrigin ? { groupContextAuthorOrigin } : undefined),
    patch: (messageId, body) => patchPublishedGroupCard(ask.larkAppId, ask.chatId, messageId, body, ask.rootMessageId ?? undefined, groupContextAuthorOrigin),
    isWithdrawn: error => error instanceof MessageWithdrawnError,
    sendOverflow: async (text, uuid) => {
      const path = join(store.directory, `${store.id(key)}-reply.md`);
      atomicWriteFileSync(path, text, { mode: 0o600, followTargetSymlink: false });
      const fileKey = await uploadFile(ask.larkAppId, path);
      beforeEffect();
      const content = JSON.stringify({ file_key: fileKey });
      return ask.rootMessageId?.startsWith('om_')
        ? replyMessage(ask.larkAppId, ask.rootMessageId, content, 'file', true, uuid)
        : sendMessage(ask.larkAppId, ask.chatId, content, 'file', uuid);
    },
    render: record => {
      const cfg = getBot(ask.larkAppId).config;
      return buildTurnReplyCard(record, {
        ...replyCardPresentation(cfg, ask.chatId), locale: localeForBot(ask.larkAppId),
        canStop: replyCardPresentation(cfg, ask.chatId).canStop && cfg.codexRpcInput !== true,
        showLiveUsage: normalizeUsageDisplay(cfg) === 'streaming',
      });
    },
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const delivered = await store.update(key, () => {
        const latest = getAskSnapshot(ask.askId) ?? ask;
        const record = store.read(key);
        // Only a new authored question carries native coverage. User answers,
        // toggles and recovered terminal cards remain independent revisions.
        groupContextAuthorOrigin = !latest.cardMessageId && !latest.settled && !latest.result && !result
          && !confirmEmptyArmed && !forcePatch && record && !record.finalCard && !replyCardIsTerminal(record)
          ? latest.replyCardTarget?.groupContextAuthorOrigin : undefined;
        return { kind: 'ask', entry: { ask: latest, result: latest.result ?? result,
          confirmEmptyArmed: confirmEmptyArmed && !!latest.selections?.every(keys => keys.length === 0) } };
      }, transport);
      if (!delivered.messageId) throw new Error('Ask reply card was not delivered');
      return delivered.messageId;
    } catch (error) {
      if (attempt >= 2 || store.read(key)?.withdrawn) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 800 : 2000));
    }
  }
}
