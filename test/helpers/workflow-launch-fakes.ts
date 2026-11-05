/**
 * Fakes for 拉群开始 (design 2026-11-03 workflow-dashboard-orchestration §4.5,
 * D4): an in-memory Feishu (chats, members, messages with uuid dedup,
 * receiver-scoped grants) behind the DraftLaunchDeps contract, and a run
 * start that goes through the real start preflight + start intent.
 *
 * `hang(op)` makes the next call of `op` never return — after its effect
 * happened where the op has one — which is how a test stands for "the daemon
 * died right here": the service is then rebuilt on the same dir.
 */
import { join } from 'node:path';

import { joinLaunchInitiator, type DraftLaunchDeps, type LaunchRootCardView, type LaunchSummaryView } from '../../src/workflows/v3/draft-launch.js';
import type { V3BotEligibilityProbe } from '../../src/workflows/v3/node-executor-mode.js';
import { preflightV3RunStart } from '../../src/workflows/v3/daemon-run.js';
import { persistV3StartIntent } from '../../src/workflows/v3/start-intent.js';
import { MAIN } from './workflow-draft-fakes.js';

export type LaunchOp =
  | 'resolveEmails' | 'createGroup' | 'joinInitiator' | 'joinOwnerCheck' | 'joinMemberCheck' | 'joinInvite' | 'joinTransfer' | 'listChats' | 'findRootCards' | 'addBots' | 'postRootCard' | 'updateRootCard'
  | 'postSummary' | 'bindSession' | 'grant' | 'revoke' | 'resolveSubject' | 'startRun';

export interface FakeChat {
  chatId: string;
  name: string;
  /** As the chat list reports it (default topic). */
  chatMode?: string;
  members: Set<string>;
  users: string[];
  unionUsers: string[];
  owner?: { channel: 'union_id' | 'open_id'; id: string };
  messages: Array<{ messageId: string; kind: 'root' | 'summary'; view: LaunchRootCardView | LaunchSummaryView; uuid: string; updates: LaunchRootCardView[] }>;
}

/** Bot `subject`'s open_id as `receiver`'s app sees it (app-scoped). */
export const seenBy = (receiver: string, subject: string) => `ou_${receiver}_sees_${subject}`;

export function fakeLaunch(baseDir: string) {
  const chats = new Map<string, FakeChat>();
  const grants = new Map<string, Set<string>>(); // `${chatId}|${receiver}` → subject open_ids
  const calls: Array<{ op: LaunchOp; args: unknown[] }> = [];
  const hangs = new Set<LaunchOp>();
  const failures = new Map<LaunchOp, Error[]>();
  const binds: Array<{ sessionId: string; chatId: string; rootMessageId: string }> = [];
  const starts: string[] = [];
  let online = new Set<string>();
  let unbindable: string | undefined;
  /** Bots that cannot be invited (e.g. app disabled). */
  const uninvitable = new Set<string>();
  /** People (open_id / union_id) Feishu refuses to add. */
  const refusedPeople = new Set<string>();
  /** People who can join but not become owner. */
  const noOwner = new Set<string>();
  /** Feishu behaviours of the join step. */
  const switches = {
    /** A repeated invite of a member answers "not added" (as Feishu does). */
    duplicateInviteFails: true,
    /** An invite that did add the person still lists them as not added. */
    inviteReportsInvalid: false,
    /** The member list cannot be read. */
    memberCheckFails: false,
  };
  /** §5.2 rule 3 answer for the prepared group's main topic. */
  let mainTopic: { available: boolean; why?: string } = { available: true };
  /** Run just before `grant` answers (tamper hooks). */
  let beforeGrantReturn: (() => void) | undefined;
  let n = 0;

  const never = () => new Promise<never>(() => {});
  const hangsBefore = new Set<LaunchOp>();
  async function enter(op: LaunchOp, args: unknown[]): Promise<void> {
    calls.push({ op, args });
    // Died before the call had any effect.
    if (hangsBefore.delete(op)) return never();
    const queued = failures.get(op);
    if (queued?.length) throw queued.shift()!;
  }
  const hangNow = (op: LaunchOp) => {
    if (!hangs.has(op)) return false;
    hangs.delete(op);
    return true;
  };

  const probe = (chatId: string): V3BotEligibilityProbe => ({
    isConfigured: () => true,
    isDaemonOnline: (appId) => online.has(appId),
    inChat: async (appId) => (chats.get(chatId)?.members.has(appId) ? 'yes' : 'no'),
    opensTopicSessions: async () => 'yes',
    ensureGrant: async () => { throw new Error('the launch check must not write grants'); },
  });

  const deps: DraftLaunchDeps = {
    async resolveEmails(emails) {
      await enter('resolveEmails', [emails]);
      return { ok: true, openIds: new Map(emails.filter((email) => !email.startsWith('nobody')).map((email) => [email, `ou_${email.split('@')[0]}`])) };
    },
    async createGroup(input) {
      await enter('createGroup', [input]);
      n += 1;
      const chatId = `oc_chat${n}`;
      const ownerId = input.owner.channel === 'open_id' ? input.owner.openId : input.owner.unionId;
      const joined = !refusedPeople.has(ownerId);
      const owned = joined && !noOwner.has(ownerId);
      chats.set(chatId, {
        chatId,
        name: input.name,
        members: new Set([MAIN, ...input.botAppIds.filter((id) => !uninvitable.has(id))]),
        users: [...(input.owner.channel === 'open_id' && joined ? [input.owner.openId] : []), ...input.extraOpenIds],
        unionUsers: [...(input.owner.channel === 'union_id' && joined ? [input.owner.unionId] : []), ...input.extraUnionIds],
        ...(owned ? { owner: { channel: input.owner.channel, id: ownerId } } : {}),
        messages: [],
      });
      // Died after Feishu built it, before anything was told about it.
      if (hangNow('createGroup')) return never();
      input.onChatCreated(chatId);
      return {
        chatId, shareLink: `https://share/${chatId}`, warnings: [], initiatorJoined: joined,
        ...(joined && !owned ? { ownerTransferError: 'transfer_failed' } : {}),
      };
    },
    async joinInitiator(chatId, owner) {
      await enter('joinInitiator', [chatId, owner]);
      const chat = chats.get(chatId)!;
      const ownerId = owner.channel === 'open_id' ? owner.openId : owner.unionId;
      const list = () => (owner.channel === 'open_id' ? chat.users : chat.unionUsers);
      // The production decision over fake Feishu reads / writes.
      return joinLaunchInitiator(ownerId, {
        owner: async () => {
          calls.push({ op: 'joinOwnerCheck', args: [chatId] });
          // No person owns it yet: the bot does (not the initiator).
          if (!chat.owner) return MAIN;
          return chat.owner.channel === owner.channel ? chat.owner.id : undefined;
        },
        isMember: async () => {
          calls.push({ op: 'joinMemberCheck', args: [chatId] });
          if (switches.memberCheckFails) throw new Error('members api down');
          return list().includes(ownerId);
        },
        invite: async () => {
          calls.push({ op: 'joinInvite', args: [chatId, ownerId] });
          if (refusedPeople.has(ownerId)) return { invalid: true };
          // Feishu answers a repeated invite as "not added".
          if (list().includes(ownerId)) return { invalid: switches.duplicateInviteFails };
          list().push(ownerId);
          return { invalid: switches.inviteReportsInvalid };
        },
        transferOwner: async () => {
          calls.push({ op: 'joinTransfer', args: [chatId, ownerId] });
          if (noOwner.has(ownerId)) return { error: 'transfer_failed' };
          chat.owner = { channel: owner.channel, id: ownerId };
          return {};
        },
      });
    },
    async listChats() {
      await enter('listChats', []);
      // The owner as the main bot's app reports it: the bot itself until the
      // transfer, then the person (their open_id in the main bot's app).
      return [...chats.values()].map((chat) => ({
        chatId: chat.chatId,
        name: chat.name,
        chatMode: chat.chatMode ?? 'topic',
        ownerId: !chat.owner ? MAIN : chat.owner.channel === 'open_id' ? chat.owner.id : `ou_${chat.owner.id.slice(3)}`,
      }));
    },
    isSelfOwner: (ownerId) => ownerId === MAIN,
    async findRootCards(chatId, runId, sinceIso) {
      await enter('findRootCards', [chatId, runId, sinceIso]);
      return (chats.get(chatId)?.messages ?? [])
        .filter((m) => m.kind === 'root' && (m.view as LaunchRootCardView).runId === runId)
        .map((m) => m.messageId);
    },
    async addBots(chatId, botAppIds) {
      await enter('addBots', [chatId, botAppIds]);
      for (const id of botAppIds) if (!uninvitable.has(id)) chats.get(chatId)?.members.add(id);
    },
    async postRootCard(chatId, view, uuid) {
      await enter('postRootCard', [chatId, view, uuid]);
      const chat = chats.get(chatId)!;
      // Feishu's uuid dedup: the same uuid answers with the first message.
      let message = chat.messages.find((m) => m.uuid === uuid);
      if (!message) {
        n += 1;
        message = { messageId: `om_root${n}`, kind: 'root', view, uuid, updates: [] };
        chat.messages.push(message);
      }
      if (hangNow('postRootCard')) return never();
      return message.messageId;
    },
    async updateRootCard(messageId, view) {
      await enter('updateRootCard', [messageId, view]);
      for (const chat of chats.values()) chat.messages.find((m) => m.messageId === messageId)?.updates.push(view);
    },
    async postSummary(rootMessageId, view, uuid) {
      await enter('postSummary', [rootMessageId, view, uuid]);
      const chat = [...chats.values()].find((c) => c.messages.some((m) => m.messageId === rootMessageId))!;
      let message = chat.messages.find((m) => m.uuid === uuid);
      if (!message) {
        n += 1;
        message = { messageId: `om_sum${n}`, kind: 'summary', view, uuid, updates: [] };
        chat.messages.push(message);
      }
      if (hangNow('postSummary')) return never();
      return message.messageId;
    },
    async bindSession(input) {
      await enter('bindSession', [input]);
      if (unbindable === input.sessionId) return { ok: false, error: 'session_not_active', unavailable: true };
      if (!binds.some((b) => b.sessionId === input.sessionId && b.rootMessageId === input.rootMessageId)) {
        binds.push({ sessionId: input.sessionId, chatId: input.chatId, rootMessageId: input.rootMessageId });
      }
      if (hangNow('bindSession')) return never();
      return { ok: true };
    },
    probe,
    async grant(chatId, receiver, subject) {
      await enter('grant', [chatId, receiver, subject]);
      if (!chats.get(chatId)?.members.has(subject) || !chats.get(chatId)?.members.has(receiver)) {
        throw new Error('subject_not_current_chat_bot');
      }
      const key = `${chatId}|${receiver}`;
      if (!grants.has(key)) grants.set(key, new Set());
      grants.get(key)!.add(seenBy(receiver, subject));
      beforeGrantReturn?.();
      if (hangNow('grant')) return never();
      return { subjectOpenId: seenBy(receiver, subject) };
    },
    async revoke(chatId, receiver, subjectOpenId) {
      await enter('revoke', [chatId, receiver, subjectOpenId]);
      grants.get(`${chatId}|${receiver}`)?.delete(subjectOpenId);
    },
    async resolveSubject(chatId, receiver, subjectAppId) {
      await enter('resolveSubject', [chatId, receiver, subjectAppId]);
      // The receiver resolves the subject in its own namespace (live members).
      if (!chats.get(chatId)?.members.has(subjectAppId)) throw new Error('subject_lark_app_not_in_chat');
      return seenBy(receiver, subjectAppId);
    },
    async startRun(runId) {
      await enter('startRun', [runId]);
      // The real start preflight and intent: run.json must be a startable,
      // authorized ad-hoc run bound to this group.
      const runDir = join(baseDir, runId);
      const preflight = preflightV3RunStart(runDir);
      if (!preflight.ok) return { ok: false, status: 409, error: preflight.error, ...(preflight.detail ? { detail: preflight.detail } : {}) };
      if (preflight.context.binding?.larkAppId !== MAIN) return { ok: false, status: 409, error: 'wrong_daemon' };
      persistV3StartIntent(runId, runDir);
      starts.push(runId);
      if (hangNow('startRun')) return never();
      return { ok: true };
    },
    // §5.2 rule 3: the fake's groups always bind a usable main topic; tests
    // flip this to an unavailable reason to exercise the rule-3 refusal.
    mainTopicAvailability: () => mainTopic,
  };

  return {
    deps,
    chats,
    grants,
    calls,
    binds,
    starts,
    count: (op: LaunchOp) => calls.filter((call) => call.op === op).length,
    hang(op: LaunchOp) { hangs.add(op); },
    hangBefore(op: LaunchOp) { hangsBefore.add(op); },
    failNext(op: LaunchOp, error: Error) { failures.set(op, [...(failures.get(op) ?? []), error]); },
    setOnline(next: string[]) { online = new Set(next); },
    setUnbindable(sessionId: string | undefined) { unbindable = sessionId; },
    uninvitable,
    refusedPeople,
    noOwner,
    switches,
    setMainTopic(next: { available: boolean; why?: string }) { mainTopic = next; },
    set beforeGrantReturn(fn: (() => void) | undefined) { beforeGrantReturn = fn; },
    granted: (chatId: string, receiver: string) => [...(grants.get(`${chatId}|${receiver}`) ?? [])].sort(),
    onlyChat(): FakeChat {
      const all = [...chats.values()];
      if (all.length !== 1) throw new Error(`expected exactly one chat, got ${all.length}`);
      return all[0]!;
    },
  };
}
