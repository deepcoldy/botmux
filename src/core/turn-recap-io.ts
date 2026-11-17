/** Production wiring for core/turn-recap-state.ts. */
import { randomUUID } from 'node:crypto';
import { getBot } from '../bot-registry.js';
import { localeForBot } from '../i18n/index.js';
import {
  getMessageDetail,
  insertCardElements,
  replaceCardElement,
  resolveCardKitId,
} from '../im/lark/client.js';
import { messageCardContent } from '../im/lark/message-card-content.js';
import { TURN_RECAP_ELEMENT_ID } from '../im/lark/turn-recap-card.js';
import { replyCardPresentation } from '../im/lark/turn-reply-card.js';
import { hostRequiresCredentialIsolation } from '../services/session-group-title.js';
import { recapModelPrompt } from '../services/turn-recap.js';
import { RECAP_MODEL_TIMEOUT_MS } from '../services/turn-recap-runner.js';
import type { WorkerToDaemon } from '../types.js';
import { logger } from '../utils/logger.js';
import { replyCardSandboxBlocked } from './turn-reply-card.js';
import { recapReported, type RecapCardInput, type RecapIo } from './turn-recap-state.js';
import type { DaemonSession } from './types.js';

function botConfig(ds: DaemonSession) {
  try { return getBot(ds.larkAppId).config; } catch { return undefined; }
}

function recapLocale(ds: DaemonSession): 'zh' | 'en' {
  return localeForBot(ds.larkAppId) === 'en' ? 'en' : 'zh';
}

/** What the panel and the optional model recap know about a turn that just
 * ended: what the worker reported for it (core/turn-recap-state.ts keeps that
 * until the next turn starts, so a repeated terminal reads the same). */
export function recapInputFor(ds: DaemonSession, turnId: string): RecapCardInput {
  const reported = recapReported(ds, turnId);
  if (!reported) return { facts: { files: [], commands: 0 } };
  const modelPrompt = recapModelPrompt({
    ...(ds.lastCliInputTurnId === turnId && ds.lastUserPrompt ? { userPrompt: ds.lastUserPrompt } : {}),
    turn: reported,
    locale: recapLocale(ds),
  });
  return { facts: reported.facts, ...(modelPrompt ? { modelPrompt } : {}) };
}

interface PendingRecap {
  ds: DaemonSession;
  settle(text: string | undefined): void;
}

const pendingRecaps = new Map<string, PendingRecap>();

/** Asks the session's worker for one model recap (it runs the CLI's own
 * print mode, see services/turn-recap-runner.ts). */
function requestWorkerRecap(ds: DaemonSession, prompt: string): Promise<string | undefined> {
  const worker = ds.worker;
  if (!worker?.connected) return Promise.resolve(undefined);
  const requestId = randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => entry.settle(undefined), RECAP_MODEL_TIMEOUT_MS + 30_000);
    timer.unref?.();
    const entry: PendingRecap = {
      ds,
      settle(text) {
        clearTimeout(timer);
        pendingRecaps.delete(requestId);
        resolve(text);
      },
    };
    pendingRecaps.set(requestId, entry);
    try {
      worker.send({ type: 'recap_request', requestId, prompt });
    } catch {
      entry.settle(undefined);
    }
  });
}

/** A worker's answer to a recap request. Every call is logged with what it cost. */
export function noteRecapResult(ds: DaemonSession, msg: Extract<WorkerToDaemon, { type: 'recap_result' }>): void {
  const entry = pendingRecaps.get(msg.requestId);
  if (!entry || entry.ds !== ds) return;
  const sid = ds.session.sessionId.slice(0, 8);
  const usage = [
    msg.costUsd !== undefined ? `$${msg.costUsd.toFixed(5)}` : undefined,
    msg.inputTokens !== undefined ? `${msg.inputTokens} input tokens` : undefined,
    msg.outputTokens !== undefined ? `${msg.outputTokens} output tokens` : undefined,
  ].filter(Boolean).join(', ');
  if (msg.text) logger.info(`[recap] ${sid}: model recap written${usage ? ` (${usage})` : ''}`);
  else logger.info(`[recap] ${sid}: no model recap: ${msg.error ?? 'empty answer'}`);
  entry.settle(msg.text);
}

export const turnRecapIo: RecapIo = {
  enabled: ds => botConfig(ds)?.replyCardRecap === true,
  // A sandboxed or read-isolated session's transcript stays out of any call
  // made outside its sandbox, and on a host that confines every local CLI's
  // credentials no unconfined call is made at all (as for /g titles).
  modelEnabled: ds => {
    const cfg = botConfig(ds);
    if (cfg?.replyCardRecapModel !== true || replyCardSandboxBlocked(ds)) return false;
    try { return !hostRequiresCredentialIsolation(cfg.plugins); } catch { return false; }
  },
  // A chat that hides a turn's activity (/cot off, or the bot's switch) sees
  // no file names or commands here either.
  showFacts: ds => {
    const cfg = botConfig(ds);
    return !!cfg && replyCardPresentation(cfg, ds.chatId).showProcess;
  },
  locale: recapLocale,
  async readCard(ds, messageId) {
    return messageCardContent(await getMessageDetail(ds.larkAppId, messageId, { userCardContent: true }), ds.chatId);
  },
  cardId: (ds, messageId) => resolveCardKitId(ds.larkAppId, messageId),
  insert: (ds, cardId, messageId, placement, element, sequence, uuid) =>
    insertCardElements(ds.larkAppId, cardId, placement, [element], sequence, uuid, messageId),
  replace: (ds, cardId, messageId, element, sequence, uuid) =>
    replaceCardElement(ds.larkAppId, cardId, TURN_RECAP_ELEMENT_ID, element, sequence, uuid, messageId),
  modelRecap: requestWorkerRecap,
  setTimer(run, ms) {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  now: () => Date.now(),
  warn: message => logger.warn(message),
};
