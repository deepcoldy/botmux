/**
 * Platform-team trust store: the centralized botmux platform's view of the
 * teams THIS machine belongs to — teammate bot union_ids + team group chats
 * (机器人大厅 etc.), pushed by the platform over the tunnel control channel
 * (`team-sync`, see platform repo tunnel/protocol).
 *
 * This is the PLATFORM counterpart of the legacy federation trust stores
 * ([[team-bots-store]] / [[team-groups-store]]): both feed the same auth gate
 * (isTrustedTeamBotSender / canOperate / evaluateTalk), so 平台团队 and 旧版
 * hub/spoke 团队 are equally "team mode" — neither needs /grant.
 *
 * Semantics differ from the learned store on purpose:
 * - Entries are AUTHORITATIVE roster state, not passively learned — they are
 *   replaced wholesale on every sync and follow team membership. No 30d expiry:
 *   a bot removed from the team disappears on the next sync instead of aging out.
 * - The version compare is declarative: the daemon reports `rev` (see
 *   getPlatformTeamSyncRev) on register/heartbeat; the platform pushes the full
 *   payload whenever its authoritative rev differs. Missed pushes self-heal on
 *   the next heartbeat; a lost/corrupt local file self-heals the same way.
 *
 * Group chats are additionally mirrored into [[team-groups-store]] under the
 * `platform:<teamId>` teamId prefix (replace-by-prefix, never touching legacy
 * federation entries). Auth consumers do NOT treat that mirror as a chat-wide
 * trust root: first contact in a platform group only counts for bots on THAT
 * team ({@link isTeamGroupChatFor}), and teammate learning into the
 * machine-wide team-bots.json is limited to legacy groups
 * ({@link isLegacyTeamGroupChat}) — platform bot identity comes from the roster.
 *
 * Storage: `{dataDir}/platform-team-sync.json`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { listTeamGroups, replaceTeamGroupsByPrefix } from './team-groups-store.js';

/** teamId prefix used when mirroring platform team groups into team-groups.json. */
export const PLATFORM_TEAM_PREFIX = 'platform:';

export interface PlatformTeamBot {
  appId: string;
  unionId?: string;
  name?: string;
  /** 外部机器人：不跑在 botmux 上的飞书机器人，由团队成员在平台登记担保（平台下发
   *  `external: true`，旧平台没有该字段）。appId / unionId 都是成员手填的：
   *  同队信任要求飞书盖章的发送方 appId 与这里精确配对，绝不触发同机信任腿，
   *  也不能让本机 bot 被当成该团队成员；未验证的 union 不作 non-human 证据。 */
  external?: boolean;
}

export interface PlatformTeamSyncTeam {
  teamId: string;
  teamName: string;
  /** Team-assembled group chats (机器人大厅 first) — trusted like 拉群 groups. */
  groupChatIds: string[];
  bots: PlatformTeamBot[];
  /** Team members' (people's) union_ids — the human talk-免grant leg: a member
   *  is trusted to TALK (never operate) to any bot on the SAME team, in any chat
   *  they share with it (not scoped to this team's group chats). */
  memberUnionIds: string[];
}

export interface PlatformTeamSyncPayload {
  rev: string;
  teams: PlatformTeamSyncTeam[];
}

interface FileShape extends PlatformTeamSyncPayload {
  /** 只接受能理解 external 语义的新快照。旧 daemon 会把 external 抹掉后再落盘，
   *  缺版本的文件不能继续作为授权依据，也不能拿旧 rev 阻止平台重推。 */
  schemaVersion?: 1;
  updatedAt: number;
}

const PLATFORM_TEAM_SYNC_SCHEMA_VERSION = 1 as const;

function filePath(dataDir: string): string {
  return join(dataDir, 'platform-team-sync.json');
}

function readFile(dataDir: string, includeLegacyForRouting = false): FileShape | null {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return null;
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object'
      // includeLegacyForRouting 只允许大厅识别等“宁可吞掉也不误路由”的元数据读取；
      // 授权、身份与 rev 上报走默认分支，缺版本一律无效。
      && (includeLegacyForRouting || parsed.schemaVersion === PLATFORM_TEAM_SYNC_SCHEMA_VERSION)
      && typeof parsed.rev === 'string' && Array.isArray(parsed.teams)) {
      return parsed as FileShape;
    }
  } catch { /* corrupt — fall through to null (rev mismatch → platform re-pushes) */ }
  return null;
}

/** Sanitize one team entry from an untrusted tunnel payload. Null → drop. */
function sanitizeTeam(raw: unknown): PlatformTeamSyncTeam | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const teamId = typeof t.teamId === 'string' ? t.teamId.trim() : '';
  if (!teamId) return null;
  const teamName = typeof t.teamName === 'string' ? t.teamName : teamId;
  const groupChatIds = Array.isArray(t.groupChatIds)
    ? t.groupChatIds.filter((c): c is string => typeof c === 'string' && !!c.trim())
    : [];
  const bots: PlatformTeamBot[] = [];
  if (Array.isArray(t.bots)) {
    for (const b of t.bots) {
      if (!b || typeof b !== 'object') continue;
      const appId = typeof (b as Record<string, unknown>).appId === 'string' ? String((b as Record<string, unknown>).appId).trim() : '';
      if (!appId) continue;
      const unionId = typeof (b as Record<string, unknown>).unionId === 'string' ? String((b as Record<string, unknown>).unionId).trim() : '';
      const name = typeof (b as Record<string, unknown>).name === 'string' ? String((b as Record<string, unknown>).name) : undefined;
      const external = (b as Record<string, unknown>).external === true;
      bots.push({
        appId,
        unionId: unionId || undefined,
        name,
        ...(external ? { external: true } : {}),
      });
    }
  }
  const memberUnionIds = Array.isArray(t.memberUnionIds)
    ? t.memberUnionIds.filter((u): u is string => typeof u === 'string' && !!u.trim()).map((u) => u.trim())
    : [];
  return { teamId, teamName, groupChatIds, bots, memberUnionIds };
}

/**
 * Apply a platform `team-sync` push: persist the payload (full-replace — it is
 * the platform's complete view of THIS machine's teams) and mirror the group
 * chats into team-groups.json under the platform prefix. Teams absent from the
 * payload (machine left the team / team deleted) drop out of both stores.
 */
export function applyPlatformTeamSync(
  dataDir: string,
  payload: { rev?: unknown; teams?: unknown },
  now: number = Date.now(),
): PlatformTeamSyncPayload | null {
  const rev = typeof payload?.rev === 'string' ? payload.rev.trim() : '';
  if (!rev) return null;
  const teams = (Array.isArray(payload?.teams) ? payload.teams : [])
    .map(sanitizeTeam)
    .filter((t): t is PlatformTeamSyncTeam => !!t);
  const shape: FileShape = { rev, teams, schemaVersion: PLATFORM_TEAM_SYNC_SCHEMA_VERSION, updatedAt: now };
  // 镜像先写、带 rev 的快照最后提交：镜像失败时 heartbeat 仍上报旧 rev，平台必须重推。
  // 反向失败（镜像新、快照旧）同样安全——团队群授权以快照为准，下一轮全量替换会收敛。
  replaceTeamGroupsByPrefix(
    dataDir,
    PLATFORM_TEAM_PREFIX,
    teams.flatMap(t => t.groupChatIds.map(chatId => ({ teamId: `${PLATFORM_TEAM_PREFIX}${t.teamId}`, chatId }))),
    now,
  );
  atomicWriteFileSync(filePath(dataDir), JSON.stringify(shape, null, 2) + '\n');
  return { rev, teams };
}

/** The rev of the last applied team-sync ('' when none) — reported on
 *  register/heartbeat so the platform knows whether to re-push. */
export function getPlatformTeamSyncRev(dataDir: string): string {
  return readFile(dataDir)?.rev ?? '';
}

/** All platform teams this machine belongs to (last applied sync). */
export function listPlatformTeams(dataDir: string): PlatformTeamSyncTeam[] {
  return readFile(dataDir)?.teams ?? [];
}

/** 该 chat 是否是某个平台团队的机器人大厅。大厅是身份登记回声室：bot 发的消息
 *  只用于学习（union_id / cross-ref / recordTeamBot），绝不当任务路由。
 *  只认 groupChatIds[0]（协议语义：大厅 first）——后续若下发普通团队协作群，
 *  它们不是大厅，bot 互 @ 必须正常路由（Codex review 收窄）。 */
export function isPlatformHallChat(dataDir: string, chatId: string | undefined): boolean {
  const id = (chatId ?? '').trim();
  if (!id) return false;
  const data = readFile(dataDir, true);
  if (!data) return false;
  for (const t of data.teams) if (t.groupChatIds[0] === id) return true;
  return false;
}

/** Is `unionId` a bot in ANY platform team this machine belongs to?
 *
 *  Identity evidence only ("this union_id is a botmux bot"), NOT authorization.
 *  External entries are excluded: their appId and unionId are both member-supplied,
 *  so the union is not authoritative non-human evidence (it may name a person or
 *  a different app). The roster is per MACHINE (every team the machine's owner is in), so a hit
 *  says nothing about whether the RECEIVING bot shares a team with the sender.
 *  Auth gates must use {@link isPlatformTeamBotTrustedBy}. */
export function isPlatformTeamBot(dataDir: string, unionId: string | undefined): boolean {
  const id = (unionId ?? '').trim();
  if (!id) return false;
  const data = readFile(dataDir);
  if (!data) return false;
  for (const t of data.teams) {
    for (const b of t.bots) if (!b.external && b.unionId === id) return true;
  }
  return false;
}

/**
 * Should the RECEIVING bot `receiverAppId` trust the platform-roster bot
 * `unionId` (talk + operate, no /grant)? The auth gates' platform-mode
 * predicate. Two ways in, both anchored on a roster entry whose union_id the
 * caller has locked to a Feishu-stamped bot sender:
 *
 *  1. SAME TEAM — some team lists both the sender and the receiver in `bots`
 *     (same anchor as {@link isPlatformTeamMember} for people). For an external
 *     sender this additionally requires the Lark-stamped `senderAppId` to equal
 *     the roster appId: a hand-filled union alone may name a human or another app.
 *  2. SAME MACHINE — the sender's roster `appId` is configured on this machine
 *     (`isLocalApp`, i.e. in this deployment's bots.json), whatever its team.
 *     No owner check and `trustSameOwnerBots` does not apply here (unchanged
 *     from before this leg was narrowed): any bot in this bots.json counts.
 *     The owner-scoped sibling leg is isTrustedSameOwnerSiblingBot.
 *
 * What it no longer accepts: a bot on ANOTHER machine whose only link is that
 * this machine's owner is also in the sender's team. The roster is pushed per
 * machine with every team the owner belongs to, so "in any team on this
 * machine" let a remote bot from team A drive a bot that only belongs to team B.
 */
export function isPlatformTeamBotTrustedBy(
  dataDir: string,
  receiverAppId: string | undefined,
  unionId: string | undefined,
  isLocalApp: (appId: string) => boolean,
  /** 飞书事件盖章的 bot sender app_id。external 条目必须用它与 roster appId 配对；
   *  真人卡片 / Dashboard 等没有该证据的调用方不得传入，因而不会命中 external。 */
  senderAppId?: string,
): boolean {
  const id = (unionId ?? '').trim();
  const receiver = (receiverAppId ?? '').trim();
  const senderApp = (senderAppId ?? '').trim();
  if (!id) return false;
  const data = readFile(dataDir);
  if (!data) return false;
  let senderAppIds: string[] | undefined;
  for (const t of data.teams) {
    const sender = t.bots.find((b) => b.unionId === id && (!b.external || (!!senderApp && b.appId === senderApp)));
    if (!sender) continue;
    if (receiver && hasTeamBotmuxBot(t, receiver)) return true;
    // 外部机器人不跑在任何机器上：同机腿只认 botmux bot 条目。
    if (!sender.external) (senderAppIds ??= []).push(sender.appId);
  }
  return !!senderAppIds && senderAppIds.some((appId) => isLocalApp(appId));
}

/** `appId` 作为 botmux bot（非外部条目）在团队 `t` 的 roster 里。判定「接收 bot 是否
 *  在这个团队」只能看这类条目：外部条目的 appId 是成员手填的。 */
function hasTeamBotmuxBot(t: PlatformTeamSyncTeam, appId: string): boolean {
  return t.bots.some((b) => b.appId === appId && !b.external);
}

/**
 * Is `chatId` a team-assembled group whose bots the RECEIVING bot may trust on
 * first contact (the chat-dimension leg of isTrustedTeamBotSender)?
 *
 *  - Legacy federation 拉群 groups (team-groups.json entries WITHOUT the
 *    `platform:` prefix): unchanged — the chat itself is the trust root.
 *  - Platform team groups: only when the receiver is on THAT team. The mirror
 *    holds every team the machine's owner is in, so a bot that was added to
 *    another team's group must not treat that team's bots as its own teammates.
 */
export function isTeamGroupChatFor(
  dataDir: string,
  receiverAppId: string | undefined,
  chatId: string | undefined,
): boolean {
  const id = (chatId ?? '').trim();
  if (!id) return false;
  if (isLegacyTeamGroupChat(dataDir, id)) return true;
  const receiver = (receiverAppId ?? '').trim();
  if (!receiver) return false;
  const data = readFile(dataDir);
  if (!data) return false;
  return data.teams.some((t) => t.groupChatIds.includes(id) && hasTeamBotmuxBot(t, receiver));
}

/**
 * Legacy federation team group only (team-groups.json entry without the
 * `platform:` prefix). Gate for LEARNING teammate union_ids into the
 * machine-wide team-bots.json: platform bot identity is already authoritative
 * in the platform roster, and learning it from a platform group would hand a
 * bot of team A machine-wide trust (isTeamBot) on bots that are only in team B.
 */
export function isLegacyTeamGroupChat(dataDir: string, chatId: string | undefined): boolean {
  const id = (chatId ?? '').trim();
  if (!id) return false;
  return listTeamGroups(dataDir).some((b) => b.chatId === id && !b.teamId.startsWith(PLATFORM_TEAM_PREFIX));
}

/** Is `unionId` a HUMAN member of a platform team that THIS bot (`botAppId`)
 *  also belongs to? The talk-免grant leg for people: a teammate is trusted to
 *  TALK to a bot on their own team without /grant, in ANY chat they share —
 *  not just platform-拉群 groups. The scope anchor is TEAM CO-MEMBERSHIP
 *  (bot ∈ team.bots ∧ sender ∈ team.memberUnionIds on the SAME team), not the
 *  chat: this is what lets a手动/原生 invite 群 work at parity with拉群 groups
 *  (those 群 never enter groupChatIds; keying on the chat left them 要 /grant).
 *
 *  Cross-team leakage stays impossible because both predicates must hold on the
 *  SAME team, and the bot only ever sees teams it is itself opted into (platform
 *  team-sync is pushed per member machine; a bot not in team T never appears in
 *  T.bots, so T's members can't reach it here). TALK only — operate stays
 *  allowedUsers-gated; the caller must never route this predicate into canOperate. */
export function isPlatformTeamMember(
  dataDir: string,
  botAppId: string | undefined,
  unionId: string | undefined,
): boolean {
  const appId = (botAppId ?? '').trim();
  const uid = (unionId ?? '').trim();
  if (!appId || !uid) return false;
  const data = readFile(dataDir);
  if (!data) return false;
  for (const t of data.teams) {
    if (t.memberUnionIds.includes(uid) && hasTeamBotmuxBot(t, appId)) return true;
  }
  return false;
}
