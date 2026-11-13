import type { Session } from '../types.js';
import type { GroupCollaborationModeConfig } from './group-collaboration-mode-store.js';
import { peerAnswersTopicWithoutMention, type GroupMentionModeConfig } from './chat-reply-mode-store.js';

/**
 * Who should take an un-@ human reply inside a topic that ANOTHER bot imported
 * (`/relay` / `/adopt` / `/fork` / `bind`), seen from the bot that received it.
 */
export interface ImportedTopicHandoff {
  sourceLarkAppId: string;
  /** Whether the importing bot answers un-@ replies in its topic itself.
   *  'unknown' when only its signed chat default (readable solely inside its
   *  own daemon) decides — callers must neither fold nor assume silence. */
  sourceAnswersWithoutMention: boolean | 'unknown';
  /** This bot may fold the reply into its chat-scope session as the project
   *  coordinator: the importing bot requires @ and no third bot already
   *  continues this root without @ (which would make it a double reply). */
  coordinatorMayFold: boolean;
}

/**
 * `sessionsAtRoot`: active sessions anchored at `rootId` across all bots (the
 * cross-bot session-store lookup). Only another bot's imported thread-scope
 * session counts; worker dispatch topics (no `projectImportSource`) and this
 * bot's own sessions keep the regular routing.
 *
 * `chatScopeSessions` (all bots' active chat-scope sessions in `chatId`) and
 * `groupMode` are read lazily, only when the answer depends on them.
 */
export function resolveImportedTopicHandoff(input: {
  rootId: string;
  chatId: string;
  larkAppId: string;
  sessionsAtRoot: readonly Session[];
  chatScopeSessions: () => readonly Session[];
  peerConfig: (larkAppId: string) => GroupMentionModeConfig | undefined;
  groupMode: () => Pick<GroupCollaborationModeConfig, 'mode' | 'coordinatorAppId'> | undefined;
}): ImportedTopicHandoff | null {
  const { rootId, chatId, larkAppId } = input;
  const isOtherBot = (s: Session): s is Session & { larkAppId: string } =>
    s.status === 'active' && s.chatId === chatId && !!s.larkAppId && s.larkAppId !== larkAppId;
  const imported = input.sessionsAtRoot.find(s =>
    isOtherBot(s)
    && s.scope === 'thread'
    && s.rootMessageId === rootId
    && !!s.projectImportSource);
  if (!imported?.larkAppId) return null;
  const sourceLarkAppId = imported.larkAppId;
  const sourceAnswersWithoutMention = peerAnswersTopicWithoutMention(input.peerConfig(sourceLarkAppId), chatId);
  const handoff = { sourceLarkAppId, sourceAnswersWithoutMention, coordinatorMayFold: false };
  if (sourceAnswersWithoutMention !== false) return handoff;
  const groupMode = input.groupMode();
  if (groupMode?.mode !== 'project' || groupMode.coordinatorAppId !== larkAppId) return handoff;

  // A third bot that already continues this root (its own thread session here,
  // or a shared-topic alias after an explicit @ in the topic) keeps the reply;
  // the coordinator folding in as well would answer twice. 'unknown' counts as
  // answering: staying quiet is the safe side. (The importing bot's own session
  // is harmless here: it is known to require @.)
  const continuing = new Set<string>();
  for (const s of input.sessionsAtRoot) {
    if (isOtherBot(s) && s.scope !== 'chat' && s.rootMessageId === rootId) {
      continuing.add(s.larkAppId);
    }
  }
  for (const s of input.chatScopeSessions()) {
    if (isOtherBot(s) && s.scope === 'chat' && s.replyThreadAliases?.[rootId]) continuing.add(s.larkAppId);
  }
  handoff.coordinatorMayFold = ![...continuing].some(appId =>
    peerAnswersTopicWithoutMention(input.peerConfig(appId), chatId) !== false);
  return handoff;
}
