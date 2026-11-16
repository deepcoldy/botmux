import type { TrustedCaller } from '../types.js';
import type { DaemonSession } from './types.js';
import { getBot } from '../bot-registry.js';
import { sameTrustedPrincipal } from './active-turn-authority.js';

/** The inbound talk gate has already authenticated this caller. Configured
 * groups accept their input as a later turn, regardless of how the session began. */
export function isSerialGroupInput(ds: DaemonSession, caller?: TrustedCaller): boolean {
  if (!caller || caller.requestLarkAppId !== ds.larkAppId
    || caller.source === 'schedule_creator' || ds.adoptedFrom
    || ds.chatType !== 'group') return false;
  return getBot(ds.larkAppId).config.groupSerialInput?.[ds.chatId] === true;
}

/** TraeX RPC cannot start a second native turn while the current one is live.
 * Freeze that transport constraint on ordinary interactive inputs without
 * changing schedule, durable delivery, adopt, explicit control, or XPI policy. */
export function shouldQueueAfterActiveTurn(
  ds: DaemonSession,
  input: {
    turnId?: string;
    dispatchAttempt?: number;
    codexAppSteerable?: true;
    caller?: TrustedCaller;
  },
): boolean {
  if (input.dispatchAttempt === undefined && isSerialGroupInput(ds, input.caller)) return true;

  const bot = getBot(ds.larkAppId);
  const effectiveCliId = ds.session.cliLaunchSnapshot?.cliId ?? ds.session.cliId ?? bot.config.cliId;
  const caller = input.caller;
  if (effectiveCliId !== 'traex'
    || ds.initConfig?.codexRpcInput !== true
    || ds.adoptedFrom
    || input.dispatchAttempt !== undefined
    || !input.turnId?.startsWith('om_')
    || !caller
    || caller.requestLarkAppId !== ds.larkAppId
    || caller.senderType !== 'user'
    || caller.source === 'schedule_creator') return false;

  const active = ds.activeInteractiveTurn;
  return !active
    || sameTrustedPrincipal(active.caller, caller)
    || sameTrustedPrincipal(active.controller, caller);
}

/** Derive the stable task controller from the session owner, never from
 * historical caller fields that may belong to a different principal. */
export function trustedSessionController(ds: DaemonSession): TrustedCaller | undefined {
  const ownerOpenId = ds.ownerOpenId ?? ds.session.ownerOpenId;
  const ownerUnionId = ds.session.ownerUnionId;
  if (!ownerOpenId && !ownerUnionId) return undefined;
  return {
    ...(ownerOpenId ? { requestUserOpenId: ownerOpenId } : {}),
    ...(ownerUnionId ? { requestUserUnionId: ownerUnionId } : {}),
    requestLarkAppId: ds.larkAppId,
    senderType: 'user',
  };
}
