import type { PendingAsk } from './ask-types.js';

export type AskOwnerBinding = Pick<PendingAsk,
  'larkAppId' | 'chatId' | 'rootMessageId' | 'sessionId' | 'originKind' | 'deliveryTarget'>;

/** System approvals and private document questions retain their exact responder. */
export function allowsTaskOwnerAnswer(ask: AskOwnerBinding): boolean {
  return !ask.deliveryTarget && (ask.originKind === 'explicit' || ask.originKind === 'host_explicit');
}

/** Resolve from the live host session, never the request body or another app's owner. */
export function createAskOwnerResolver(deps: {
  session: (sessionId: string) => {
    larkAppId: string; chatId: string; rootMessageId: string | null; ownerOpenId?: string;
  } | undefined;
  /** Current permission owner of this app, used only for ownerless bot tasks. */
  botOwner: (appId: string) => string | undefined;
  canOperate: (appId: string, chatId: string, openId: string) => boolean;
  isPeerBot: (appId: string, openId: string) => boolean;
}): (ask: AskOwnerBinding) => string | undefined {
  return ask => {
    if (!allowsTaskOwnerAnswer(ask)) return undefined;
    const session = deps.session(ask.sessionId);
    if (!session || session.larkAppId !== ask.larkAppId || session.chatId !== ask.chatId
      || session.rootMessageId !== ask.rootMessageId) return undefined;
    const owner = session.ownerOpenId ?? deps.botOwner(ask.larkAppId);
    return owner && !deps.isPeerBot(ask.larkAppId, owner)
      && deps.canOperate(ask.larkAppId, ask.chatId, owner) ? owner : undefined;
  };
}
