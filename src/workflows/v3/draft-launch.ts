/**
 * 拉群开始 (design 2026-11-03 workflow-dashboard-orchestration §4.5, D4):
 * the pure half — group name and marker, extra-member parsing, which step a
 * launch record is at, and the collaborator contract the daemon fills in.
 * The steps themselves run in draft-service.ts under the draft lock.
 *
 * Host-neutral: no Lark, no daemon registry. The orchestrating bot's daemon
 * supplies {@link DraftLaunchDeps} (core/workflow-draft-daemon.ts).
 */

import type { V3BotEligibilityProbe } from './node-executor-mode.js';
import type { WorkflowDraftLaunch } from './draft-store.js';

/** Same cap as the other group-creating paths (issue-claim-flow, command-handler). */
export const LAUNCH_GROUP_NAME_MAX = 50;

/**
 * The marker at the end of the group name: the run id's last segment, the 8
 * random hex characters `mintV3RunId` appends. Never the first 8 characters:
 * those are the goal slug and date (`run-2611…` for every Chinese goal of a
 * month), so matching on them would recover another draft's group.
 */
export function launchMarker(runId: string): string | undefined {
  const match = /-([0-9a-f]{8})$/.exec(runId);
  return match ? `#${match[1]}` : undefined;
}

/**
 * `<title> #<marker>`: the title is cut, the marker never — Feishu cuts long
 * names from the end, which would eat exactly the half that recovery matches.
 */
export function launchGroupName(title: string, marker: string): string {
  const room = LAUNCH_GROUP_NAME_MAX - marker.length - 1;
  const trimmed = title.replace(/\s+/g, ' ').trim() || '工作流';
  const chars = Array.from(trimmed);
  const head = chars.length > room ? `${chars.slice(0, Math.max(0, room - 1)).join('')}…` : trimmed;
  return `${head} ${marker}`;
}

/** Whether a group name carries `marker` as its final token. */
export function groupNameHasMarker(name: string | undefined, marker: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  return trimmed === marker || trimmed.endsWith(` ${marker}`);
}

const EMAIL_RE = /^[^\s@<>"']{1,128}@[^\s@<>"']{1,128}\.[^\s@<>"']{1,64}$/;
const UNION_ID_RE = /^on_[A-Za-z0-9_-]{1,128}$/;

export type ExtraMembersParse =
  | { ok: true; members: string[]; emails: string[]; unionIds: string[] }
  | { ok: false; message: string };

/**
 * Extra members (§4.5): a full email or a union_id. An open_id is refused —
 * it is app-scoped and nothing here can tell which app issued it (CLAUDE.md
 * 飞书 owner 身份边界); the main bot resolves emails in its own app.
 */
export function parseLaunchExtraMembers(raw: unknown, max: number): ExtraMembersParse {
  if (raw === undefined) return { ok: true, members: [], emails: [], unionIds: [] };
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) {
    return { ok: false, message: 'extraMembers 必须是字符串数组（邮箱或 union_id）' };
  }
  const members = [...new Set((raw as string[]).map((item) => item.trim()).filter(Boolean))];
  if (members.length > max) return { ok: false, message: `额外成员最多 ${max} 个` };
  const emails: string[] = [];
  const unionIds: string[] = [];
  for (const member of members) {
    if (UNION_ID_RE.test(member)) unionIds.push(member);
    else if (EMAIL_RE.test(member)) emails.push(member.toLowerCase());
    else if (member.startsWith('ou_')) return { ok: false, message: `不接受 open_id（${member}）：它只对签发它的应用有效，请填邮箱或 union_id` };
    else return { ok: false, message: `无法识别的成员：${member}（请填完整邮箱或 union_id）` };
  }
  return { ok: true, members, emails, unionIds };
}

export type LaunchStep = 'group' | 'join' | 'root' | 'migrate' | 'check' | 'grant' | 'commit' | 'start' | 'done';

/**
 * The next step of a launch record (§4.5 断点续做), from what it recorded —
 * never from a stored cursor, so a crash between an external effect and its
 * record replays only that step. Steps 5–6 hold for the flow revision they
 * ran at: a flow changed since (a bot swapped, re-orchestrated) checks again.
 */
export function nextLaunchStep(
  launch: WorkflowDraftLaunch,
  current: { flowRevision: number; targets: readonly string[] },
): LaunchStep {
  if (launch.start) return 'done';
  if (launch.commit) return 'start';
  if (!launch.chat) return 'group';
  if (launch.chat.initiator !== 'joined') return 'join';
  if (!launch.root) return 'root';
  if (!launch.migrate) return 'migrate';
  if (!launch.check || !launch.check.ok || launch.check.flowRevision !== current.flowRevision) return 'check';
  const grants = launch.grants ?? {};
  const wanted = new Set(current.targets);
  const complete = (appId: string) => !!grants[appId]?.mainSide && !!grants[appId]?.peerSide;
  if ([...wanted].some((appId) => !complete(appId)) || Object.keys(grants).some((appId) => !wanted.has(appId))) return 'grant';
  return 'commit';
}

// ─── Collaborators ────────────────────────────────────────────────────────

/** The root card of the main topic (§4.5 第 3 步, E6). */
export interface LaunchRootCardView {
  runId: string;
  title: string;
  initiatorOpenId: string;
  nodeCount: number;
  /** 「这次启动已放弃」. */
  abandoned?: boolean;
}

/** The progress message after the clarify session moved in (§4.5 第 4 步, E7). */
export interface LaunchSummaryView {
  runId: string;
  title: string;
  goal: string;
  /** The confirmed spec's requirement and node goals. */
  requirement?: string;
  nodes: Array<{ id: string; goal: string }>;
  /** The clarify session could not be moved in, and why. */
  sessionNote?: string;
}

export interface LaunchCreateGroupInput {
  name: string;
  /** Executing bots other than the main bot. */
  botAppIds: string[];
  /** One of the two owner channels (§4.5 第 2 步), never both. */
  owner: { channel: 'union_id'; unionId: string } | { channel: 'open_id'; openId: string };
  /** Extra members: open_ids in the main bot's app (resolved there) and union_ids. */
  extraOpenIds: string[];
  extraUnionIds: string[];
  /** Fired synchronously with the chat id as soon as it exists. */
  onChatCreated: (chatId: string) => void;
}

export interface LaunchCreateGroupResult {
  chatId: string;
  shareLink?: string;
  /** Non-fatal problems (rejected extra members / bots). */
  warnings: string[];
  /** Feishu added the initiator to the group. */
  initiatorJoined: boolean;
  /** Set when the initiator joined but could not be made owner. */
  ownerTransferError?: string;
}

/** The initiator into an existing group (and made owner), by the same one
 *  channel the launch uses. Idempotent. */
export type LaunchJoinInitiatorResult = { joined: boolean; ownerTransferError?: string; error?: string };

export type LaunchBindResult =
  | { ok: true }
  /** `unavailable`: the session is gone for good (closed / not active) —
   *  the launch goes on without it; otherwise retry later (e.g. busy). */
  | { ok: false; error: string; unavailable: boolean };

export type LaunchStartResult =
  | { ok: true }
  | { ok: false; status: number; error: string; detail?: string };

/** Everything 拉群开始 does outside this host (Lark, sessions, grants, the
 *  run driver). The daemon supplies them; tests use fakes. */
export interface DraftLaunchDeps {
  /** emails → open_ids in the main bot's app. Unresolved / transient are
   *  told apart; nothing else is ever used as an open_id. */
  resolveEmails(emails: string[]): Promise<
    | { ok: true; openIds: Map<string, string> }
    | { ok: false; retryable: boolean; message: string }
  >;
  /** Topic group, main bot as creator, no kickoff of any kind. */
  createGroup(input: LaunchCreateGroupInput): Promise<LaunchCreateGroupResult>;
  /** The chats the main bot is in (name + id). */
  listChats(): Promise<Array<{ chatId: string; name?: string }>>;
  /** Add the initiator to `chatId` and make them owner (the join step:
   *  after a refused invite, or for a group recovered by its marker). */
  joinInitiator(chatId: string, owner: LaunchCreateGroupInput['owner']): Promise<LaunchJoinInitiatorResult>;
  /** Invite bots that are not in the chat yet (「重试拉人」). */
  addBots(chatId: string, botAppIds: string[]): Promise<void>;
  /** Post the root card; `uuid` deduplicates a resend after a crash. */
  postRootCard(chatId: string, view: LaunchRootCardView, uuid: string): Promise<string>;
  updateRootCard(messageId: string, view: LaunchRootCardView): Promise<void>;
  postSummary(rootMessageId: string, view: LaunchSummaryView, uuid: string): Promise<string>;
  /** Move the clarify session into the main topic (headless bind). */
  bindSession(input: { sessionId: string; headlessId?: string; chatId: string; rootMessageId: string; title: string }): Promise<LaunchBindResult>;
  /** Live §6.1 facts for `chatId` — read only here; grants go through
   *  {@link grant}. */
  probe(chatId: string): V3BotEligibilityProbe;
  /** Talk-only grant on `receiver` for `subject` in `chatId`; returns the
   *  subject's open_id in the receiver's namespace. */
  grant(chatId: string, receiver: string, subject: string): Promise<{ subjectOpenId: string }>;
  /** Remove `subjectOpenId` (receiver's namespace) from `receiver`'s grants
   *  in `chatId`; needs no membership. */
  revoke(chatId: string, receiver: string, subjectOpenId: string): Promise<void>;
  /** The same start path as `botmux workflow start` (idempotent). */
  startRun(runId: string): Promise<LaunchStartResult>;
}
