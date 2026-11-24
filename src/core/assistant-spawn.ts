/**
 * 个人助理模式：某个 chat 的会话归谁（spawn 前判定）。所有建会话的路径——普通消息、话题回复、
 * 定时任务、会议接收——都用它，保证同一 chat 得到同一个 owner 与 cwd；查不到 owner 时由调用方
 * 拒绝服务，绝不退回共享目录。设计见 docs/design/2026-11-20-assistant-mode.md。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { getBot, type BotConfig } from '../bot-registry.js';
import { botHomePath } from '../adapters/cli/read-isolation.js';
import { getSessionGroup } from '../services/session-groups-store.js';
import { getAssistantOwner } from '../services/assistant-owner-store.js';
import { assistantUserHome, assistantWorkDir, resolveAssistantOwnerOpenId } from './assistant-mode.js';
import { logger } from '../utils/logger.js';

export type AssistantSpawn =
  | { kind: 'off' }
  | { kind: 'owner'; openId: string; workDir: string }
  | { kind: 'unclaimed' };

export function resolveAssistantSpawn(
  larkAppId: string,
  chatId: string,
  chatType: 'group' | 'p2p',
  senderOpenId: string | undefined,
): AssistantSpawn {
  let cfg: BotConfig;
  try { cfg = getBot(larkAppId).config; } catch { return { kind: 'off' }; }
  if (cfg.assistantMode !== true) return { kind: 'off' };
  const owner = resolveAssistantOwnerOpenId({
    chatType,
    senderOpenId,
    sessionGroupOwnerOpenId: chatType === 'group' ? getSessionGroup(chatId)?.ownerOpenId : undefined,
    stored: chatType === 'group' ? getAssistantOwner(config.session.dataDir, larkAppId, chatId) : undefined,
  });
  if (!owner) return { kind: 'unclaimed' };
  const workDir = assistantWorkDir(assistantUserHome(botHomePath(dirname(config.session.dataDir), larkAppId), owner));
  try { mkdirSync(workDir, { recursive: true, mode: 0o700 }); } catch (e) {
    logger.warn(`[assistant-mode:${larkAppId}] cannot create ${workDir}: ${(e as Error).message}`);
  }
  return { kind: 'owner', openId: owner, workDir };
}

/** 个人助理模式下谁能让任务投到某个 chat：只有该 chat 的主人本人。模式关着不限；群还没认领则
 *  谁都不行。按**目标** chat 判定——来源会话的主人能建，不代表能把任务投进别人的助理群。 */
export function assistantScheduleCreatorAllowed(
  larkAppId: string,
  chatId: string,
  chatType: 'group' | 'p2p',
  openId: string | undefined,
): boolean {
  const spawn = resolveAssistantSpawn(larkAppId, chatId, chatType, openId);
  if (spawn.kind === 'off') return true;
  return spawn.kind === 'owner' && !!openId && spawn.openId === openId;
}

/** 助理模式开着、且 `openId` 正是该 chat 当前的主人。主人在自己的 chat 里建定时任务不需要
 *  bot 级 scheduleCreateByTalkers 开关——按对话用户任务的规则（ownerAccess:'talk'）收着。 */
export function isAssistantOwnerOfChat(
  larkAppId: string,
  chatId: string,
  chatType: 'group' | 'p2p',
  openId: string | undefined,
): boolean {
  if (!openId) return false;
  const spawn = resolveAssistantSpawn(larkAppId, chatId, chatType, openId);
  return spawn.kind === 'owner' && spawn.openId === openId;
}

/** 一个已存在的会话还能不能按当前归属继续用（恢复 / 话题延续）：模式关着不管；模式开着时
 *  会话的 owner 必须正是当前解析出的 owner。 */
export function assistantSessionStillOwned(
  session: { larkAppId?: string; chatId: string; chatType?: 'group' | 'p2p'; assistantOwnerOpenId?: string },
  larkAppId: string,
  senderOpenId: string | undefined,
): boolean {
  const spawn = resolveAssistantSpawn(larkAppId, session.chatId, session.chatType === 'p2p' ? 'p2p' : 'group', senderOpenId);
  if (spawn.kind === 'off') return true;
  return spawn.kind === 'owner' && session.assistantOwnerOpenId === spawn.openId;
}

export type AssistantAdmission =
  | { kind: 'allow' }
  | { kind: 'adopt'; openId: string; workDir: string }
  | { kind: 'reject'; have?: string; expected?: string };

/** worker 起之前的归属判定（助理模式开着时调用）：
 *  - 会话主人正是当前解析出的主人 → allow；
 *  - 还没跑过 CLI 的新会话、没记主人 → adopt：认领给当前主人，cwd 改到主人 work/（各条建会话路径
 *    不必各自记得填主人）；
 *  - 其余（开模式前跑过的存量会话、主人已变、群未认领）→ reject。 */
export function decideAssistantAdmission(
  larkAppId: string,
  s: {
    chatId: string; chatType: 'group' | 'p2p'; ownerOpenId?: string; assistantOwnerOpenId?: string; everRan: boolean;
    /** 会话的沙盒形态已冻结、但没冻结「不放 Bot 密钥」（开模式前就冻结了）——这种会话不能起。 */
    sandboxFrozenWithoutWithhold: boolean;
  },
): AssistantAdmission {
  const spawn = resolveAssistantSpawn(larkAppId, s.chatId, s.chatType, s.ownerOpenId);
  if (spawn.kind === 'off') return { kind: 'allow' };
  const expected = spawn.kind === 'owner' ? spawn.openId : undefined;
  if (s.sandboxFrozenWithoutWithhold) {
    return { kind: 'reject', ...(s.assistantOwnerOpenId ? { have: s.assistantOwnerOpenId } : {}), ...(expected ? { expected } : {}) };
  }
  if (s.assistantOwnerOpenId) {
    return s.assistantOwnerOpenId === expected
      ? { kind: 'allow' }
      : { kind: 'reject', have: s.assistantOwnerOpenId, ...(expected ? { expected } : {}) };
  }
  if (spawn.kind === 'owner' && !s.everRan) return { kind: 'adopt', openId: spawn.openId, workDir: spawn.workDir };
  return { kind: 'reject', ...(expected ? { expected } : {}) };
}

/** 已经存在（尤其已经有 live worker）的会话能不能再收输入。这里绝不 adopt：
 * 没记 owner 的现存 worker 可能是开模式前的共享会话，不能因为它还没留下 history
 * 就把新主人的输入交给它。所有 queued / promotion / IPC 实际投递点共用这一判定。 */
export function decideAssistantLiveInputAdmission(
  larkAppId: string,
  s: {
    chatId: string; chatType: 'group' | 'p2p'; ownerOpenId?: string; assistantOwnerOpenId?: string;
    sandboxWithholdBotSecret?: boolean;
  },
): AssistantAdmission {
  return decideAssistantAdmission(larkAppId, {
    chatId: s.chatId,
    chatType: s.chatType,
    ownerOpenId: s.ownerOpenId,
    assistantOwnerOpenId: s.assistantOwnerOpenId,
    everRan: true,
    sandboxFrozenWithoutWithhold: s.sandboxWithholdBotSecret !== true,
  });
}
