import type { DaemonSession } from './types.js';
import type { PendingRepoSetup } from '../types.js';
import * as sessionStore from '../services/session-store.js';

export function stagePendingRepoSetup(
  ds: DaemonSession,
  args: Pick<PendingRepoSetup, 'mode'> & Partial<Pick<PendingRepoSetup, 'baseDir' | 'turnId'>>,
): void {
  const prior = {
    queued: ds.session.queued,
    queuedPrompt: ds.session.queuedPrompt,
    queuedCodexAppText: ds.session.queuedCodexAppText,
    queuedCodexAppMessageContext: ds.session.queuedCodexAppMessageContext,
    pendingRepoSetup: ds.session.pendingRepoSetup,
  };
  const setup: PendingRepoSetup = {
    mode: args.mode,
    prompt: ds.pendingPrompt ?? '',
    ...(ds.pendingRawInput ? { rawInput: ds.pendingRawInput } : {}),
    ...(args.turnId ? { turnId: args.turnId } : {}),
    ...(args.baseDir ? { baseDir: args.baseDir } : {}),
    ...(ds.pendingCodexAppText !== undefined ? { codexAppText: ds.pendingCodexAppText } : {}),
    ...(ds.pendingCodexAppApplicationContext
      ? { codexAppApplicationContext: ds.pendingCodexAppApplicationContext }
      : {}),
    ...(ds.pendingCodexAppMessageContext
      ? { codexAppMessageContext: ds.pendingCodexAppMessageContext }
      : {}),
    ...(ds.pendingAttachments?.length
      ? { attachments: ds.pendingAttachments.map(attachment => ({ ...attachment })) }
      : {}),
    ...(ds.pendingMentions?.length
      ? { mentions: ds.pendingMentions.map(mention => ({ ...mention })) }
      : {}),
    ...(ds.pendingSubstituteTrigger
      ? { substituteTrigger: structuredClone(ds.pendingSubstituteTrigger) }
      : {}),
    ...(ds.pendingSender ? { sender: { ...ds.pendingSender } } : {}),
  };
  ds.session.queued = true;
  ds.session.queuedPrompt = setup.prompt;
  ds.session.queuedCodexAppText = setup.codexAppText;
  ds.session.queuedCodexAppMessageContext = setup.codexAppMessageContext;
  ds.session.pendingRepoSetup = setup;
  try {
    sessionStore.updateSession(ds.session);
  } catch (err) {
    ds.session.queued = prior.queued;
    ds.session.queuedPrompt = prior.queuedPrompt;
    ds.session.queuedCodexAppText = prior.queuedCodexAppText;
    ds.session.queuedCodexAppMessageContext = prior.queuedCodexAppMessageContext;
    ds.session.pendingRepoSetup = prior.pendingRepoSetup;
    throw err;
  }
}

export function persistPendingRepoCardMessageId(ds: DaemonSession, messageId: string): void {
  const setup = ds.session.pendingRepoSetup;
  if (!setup) return;
  const prior = setup.repoCardMessageId;
  setup.repoCardMessageId = messageId;
  try {
    sessionStore.updateSession(ds.session);
  } catch (err) {
    setup.repoCardMessageId = prior;
    throw err;
  }
}

export function restorePendingRepoRuntime(ds: DaemonSession): boolean {
  const setup = ds.session.pendingRepoSetup;
  if (!setup || ds.session.queuedActivationPending) return false;
  ds.pendingRepo = true;
  ds.pendingPrompt = setup.prompt;
  ds.pendingRawInput = setup.rawInput;
  ds.pendingCodexAppText = setup.codexAppText;
  ds.pendingCodexAppApplicationContext = setup.codexAppApplicationContext;
  ds.pendingCodexAppMessageContext = setup.codexAppMessageContext;
  ds.pendingAttachments = setup.attachments?.map(attachment => ({ ...attachment }));
  ds.pendingMentions = setup.mentions?.map(mention => ({ ...mention }));
  ds.pendingSubstituteTrigger = setup.substituteTrigger
    ? structuredClone(setup.substituteTrigger)
    : undefined;
  ds.pendingSender = setup.sender ? { ...setup.sender } : undefined;
  ds.repoCardMessageId = setup.repoCardMessageId;
  ds.initialStartPending = false;
  return true;
}
