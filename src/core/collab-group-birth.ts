/**
 * 私聊专属群协作初始化入口拆分（design 2026-11-20-dm-collab-group-design §5.2/§5.3）。
 *
 * PR-1 交付：
 *   - `preflightCollabGroupBirth` 阶段 1 完整实现（creator 扣费前、无副作用结构校验 +
 *     原子占位 + peer preflight seam），返回 discriminated union；
 *   - `startCollabGroupBirth` 阶段 3 签名 + `SessionGroupBirthResult` discriminated
 *     union（S1–S5 编排本体留 PR-2，本单只给占位语义）。
 *
 * 铁律 1（fail-closed）：显式 enabled 时，结构或 peer 预检失败一律返回 `failed`，**不**
 * 回退 legacy；只有未启用协作才走 legacy。
 */
import { config } from '../config.js';
import { getBot } from '../bot-registry.js';
import { readRoleProfileEntry } from '../services/role-profile-store.js';
import { resolveTeamRoleFile } from '../core/role-resolver.js';
import {
  buildCollabConfigVersion,
  collabCreatorAdmissionOperationId,
  collabInitId,
  collabSourceKey,
  COLLAB_CREATE_ATTEMPT_INITIAL,
  validateSessionGroupCollaborationConfig,
  type CollabValidationDeps,
  type SessionGroupCollaborationConfig,
} from '../services/collab-group-config.js';
import { loadBotConfigsCached } from '../bot-registry.js';
import {
  markCollabInitTerminal,
  placeCollabGroupInit,
} from '../services/collab-init-store.js';
import type { RoutingContext } from '../im/lark/event-dispatcher.js';

export type CollabPreflightResult =
  | { kind: 'legacy' }
  | { kind: 'failed'; reason: string; releasesDmChat: boolean }
  | { kind: 'existing'; initId: string; status: string }
  | { kind: 'busy'; initId: string }
  | {
      kind: 'ready';
      initId: string;
      creatorAdmissionOperationId: string;
      configVersion: string;
      config: SessionGroupCollaborationConfig;
    };

export type SessionGroupBirthResult =
  | { kind: 'legacy'; ctx: RoutingContext | null }
  | { kind: 'collab-handled'; initId: string; chatId?: string; status: string };

/**
 * 阶段 1 的可注入依赖（测试用假时钟 + 临时 dataDir + 假 peer preflight）。
 *
 * `peerPreflight` 是 §4.2 peer preflight 的 seam。**PR-1 生产默认返回「未就绪」**：
 * 真实编排（S1–S5）尚未实现，显式 enabled 的合法配置必须 fail-closed 于 preflight
 * 阶段（返回 failed、不扣费、不占位），**不得**走到 ready → 扣费 → startCollabGroupBirth
 * 占位返回 collab-handled(running) 而永久锁死同 DM。等 PR-2 接入真实 peer preflight
 * + S1–S5 编排后，生产才返回 ok；测试通过注入 `{ok:true}` 验证 ready 分支本身。
 */
export interface CollabPreflightDeps {
  dataDir: string;
  now: () => number;
  resolveProfile?: CollabValidationDeps['resolveProfile'];
  resolveTeamRole?: CollabValidationDeps['resolveTeamRole'];
  /** 可选：participant 存在性 + 非 apiOnly 判定（默认用 registry 缓存）。 */
  resolveAgent?: CollabValidationDeps['resolveAgent'];
  peerPreflight?: (config: SessionGroupCollaborationConfig) => Promise<{ ok: true } | { ok: false; errors: string[] }>;
}

/** PR-1 生产态：编排未实现前，显式 enabled 一律 fail-closed（见 CollabPreflightDeps 注释）。 */
export const COLLAB_ORCHESTRATION_NOT_IMPLEMENTED = '协作初始化编排尚未实现（PR-2）';

function defaultDeps(dataDir: string, creatorAppId: string): CollabPreflightDeps {
  return {
    dataDir,
    now: () => Date.now(),
    resolveProfile: (profileId: string, appId: string) => readRoleProfileEntry(dataDir, profileId, appId),
    resolveTeamRole: (appId: string) => resolveTeamRoleFile(appId),
    resolveAgent: (appId: string) => {
      const found = loadBotConfigsCached().find(c => c.larkAppId === appId);
      return found ? { exists: true, apiOnly: found.apiOnly === true } : undefined;
    },
    peerPreflight: async () => ({ ok: false, errors: [COLLAB_ORCHESTRATION_NOT_IMPLEMENTED] }),
  };
}

/**
 * 阶段 1：creator 扣费之前。
 *
 * 顺序（§5.2）：
 *   1. 未启用协作 → `legacy`（行为与 master 逐字节一致）；
 *   2. 结构校验（含 Profile 解析）失败 → `failed`（无副作用，无占位）；
 *   3. per-app mutex 内 source/DM 判重 + 原子占位 → `existing` / `busy` / 继续；
 *   4. 占位成功后 peer preflight → 失败则释放 activeByDmChat 并 `failed`，否则 `ready`。
 */
export async function preflightCollabGroupBirth(
  data: any,
  ctx: RoutingContext,
  depsOverride?: Partial<CollabPreflightDeps>,
): Promise<CollabPreflightResult> {
  const { larkAppId: creatorAppId, chatId: dmChatId, messageId } = ctx;
  const botCfg = getBot(creatorAppId).config;
  const sg = botCfg.sessionGroup;
  const collaboration = sg?.collaboration;
  // 显式 enabled 但结构非法：parse 阶段保留原样并标记 disabledReason → fail-closed。
  if (sg?.collaborationDisabledReason) {
    return { kind: 'failed', reason: sg.collaborationDisabledReason, releasesDmChat: false };
  }
  if (!collaboration || collaboration.enabled !== true) {
    return { kind: 'legacy' };
  }

  const dataDir = depsOverride?.dataDir ?? config.session.dataDir;
  const deps = { ...defaultDeps(dataDir, creatorAppId), ...depsOverride };

  // 结构 + 身份校验（含 Profile 内容解析 + creator 恰好一行 + 存在性 + 非 apiOnly），全程无副作用。
  const validation = validateSessionGroupCollaborationConfig(collaboration, {
    dataDir,
    resolveProfile: deps.resolveProfile!,
    resolveTeamRole: deps.resolveTeamRole!,
    creatorAppId,
    resolveAgent: deps.resolveAgent,
  });
  if (!validation.ok) {
    return { kind: 'failed', reason: validation.errors.join('；'), releasesDmChat: false };
  }

  const sourceKey = collabSourceKey(creatorAppId, dmChatId, messageId);
  const initId = collabInitId(sourceKey);
  const configVersion = buildCollabConfigVersion({
    collaboration: validation.config,
    resolvedProfileEntries: validation.resolvedProfileEntries,
    referencedTeamRoles: validation.referencedTeamRoles,
  });
  const creatorAdmissionOperationId = collabCreatorAdmissionOperationId(initId);

  const placed = await placeCollabGroupInit({
    dataDir,
    creatorAppId,
    dmChatId,
    sourceKey,
    initId,
    sourceMessageId: messageId,
    configVersion,
    configSnapshot: validation.config,
    creatorAdmissionOperationId,
    createAttempt: COLLAB_CREATE_ATTEMPT_INITIAL,
    now: deps.now(),
  });

  if (placed.kind === 'existing') return { kind: 'existing', initId: placed.initId, status: placed.status };
  if (placed.kind === 'busy') return { kind: 'busy', initId: placed.initId };

  // peer preflight（占位后）。reject / 失败一律转 failed 并释放占位，绝不残留 running。
  let peer: { ok: true } | { ok: false; errors: string[] };
  try {
    peer = await (deps.peerPreflight ?? (async () => ({ ok: false as const, errors: [COLLAB_ORCHESTRATION_NOT_IMPLEMENTED] })))(validation.config);
  } catch (err) {
    peer = { ok: false, errors: [`peer preflight 异常：${String((err as any)?.message ?? err)}`] };
  }
  if (!peer.ok) {
    await markCollabInitTerminal({
      dataDir,
      creatorAppId,
      initId,
      dmChatId,
      state: 'failed',
      now: deps.now(),
    });
    return { kind: 'failed', reason: peer.errors.join('；'), releasesDmChat: true };
  }

  return {
    kind: 'ready',
    initId,
    creatorAdmissionOperationId,
    configVersion,
    config: validation.config,
  };
}

/**
 * 阶段 3：建群编排入口（S1–S5 本体留 PR-2，本单只给签名与占位语义）。
 *
 * 调用方收到 `collab-handled` 后不得递归 `handleNewTopic`、不落 DM thread；
 * `legacy` 才继续现有 `maybeBirthSessionGroup` 路径。creator 是否 immediate /
 * afterAgentTurn 完全由 S5 决定（PR-3）。
 */
export async function startCollabGroupBirth(
  _data: any,
  _ctx: RoutingContext,
  initId: string,
  _creatorAdmissionReceipt: unknown,
): Promise<SessionGroupBirthResult> {
  // PR-2 占位：真实编排（createUuid 建群、邀请、授权、角色、kickoff）尚未实现。
  // 显式 enabled 的 bot 在 PR-1 不会走到这里被静默吞掉——daemon 接缝在 PR-1 仍把
  // preflight 判定为 ready 的回合标记为 collab-handled，等待 PR-2 编排落地。
  return { kind: 'collab-handled', initId, status: 'running' };
}

/**
 * 释放一次 preflight 已占位但后续失败（如扣费被拒）的初始化：置 failed 并释放
 * activeByDmChat，避免同 DM 被永久 busy 锁死。sourceIndex 永久保留（同 source 重投
 * 仍 existing）。用于 daemon 接缝里「ready 之后扣费被拒」的清理路径。
 */
export async function releaseCollabGroupBirth(opts: {
  dataDir: string;
  creatorAppId: string;
  initId: string;
  dmChatId: string;
  now: () => number;
}): Promise<void> {
  await markCollabInitTerminal({
    dataDir: opts.dataDir,
    creatorAppId: opts.creatorAppId,
    initId: opts.initId,
    dmChatId: opts.dmChatId,
    state: 'failed',
    now: opts.now(),
  });
}
