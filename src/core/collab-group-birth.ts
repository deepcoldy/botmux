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
  type CreatorAdmissionReceipt,
  type SessionGroupCollaborationConfig,
} from '../services/collab-group-config.js';
import { loadBotConfigsCached } from '../bot-registry.js';
import {
  markCollabInitTerminal,
  placeCollabGroupInit,
} from '../services/collab-init-store.js';
import { createChatWithUuid } from '../services/groups-store.js';
import { registerSessionGroup } from '../services/session-groups-store.js';
import { forwardMessage } from '../im/lark/client.js';
import { runCollabGroupBirthS1, type CollabS1Deps } from './collab-orchestrator.js';
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

// 测试 seam：覆盖 defaultDeps 的 peerPreflight，让真实 daemon 入口测试能驱动 ready 分支
// （PR-1 内 ready 只用于验证「扣费恰好 1 次」的契约；生产默认仍 fail-closed）。
let __testOnlyPeerPreflight: CollabPreflightDeps['peerPreflight'] | undefined;
export function __testOnly_setCollabPeerPreflight(fn: CollabPreflightDeps['peerPreflight'] | undefined): void {
  __testOnlyPeerPreflight = fn;
}

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
    peerPreflight: __testOnlyPeerPreflight ?? (async () => ({ ok: false, errors: [COLLAB_ORCHESTRATION_NOT_IMPLEMENTED] })),
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
  // 未启用协作（缺省/非 enabled:true）一律 legacy；标记只在 enabled:true 时才有意义。
  if (!collaboration || collaboration.enabled !== true) {
    return { kind: 'legacy' };
  }
  // 显式 enabled 但结构非法：parse 阶段保留原样并标记 disabledReason → fail-closed。
  // （双保险：仅当 collaboration 存在且 enabled===true 才认标记，旧标记残留不会误判。）
  if (sg?.collaborationDisabledReason) {
    return { kind: 'failed', reason: sg.collaborationDisabledReason, releasesDmChat: false };
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
 * 阶段 3：建群编排入口（PR-2a 落地 S1 create；S2–S5 留 PR-2b/PR-3）。
 *
 * 调用方收到 `collab-handled` 后不得递归 `handleNewTopic`、不落 DM thread；
 * `legacy` 才继续现有 `maybeBirthSessionGroup` 路径。creator 是否 immediate /
 * afterAgentTurn 完全由 S5 决定（PR-3）。
 *
 * `creatorAdmissionReceipt` 已在 daemon 接缝扣费成功后持久化到 entry；恢复路径
 * （entry 已有 receipt）跳过扣费直接进 S1。
 */
export async function startCollabGroupBirth(
  data: any,
  ctx: RoutingContext,
  initId: string,
  creatorAdmissionReceipt: CreatorAdmissionReceipt,
  depsOverride?: Partial<CollabS1Deps>,
): Promise<SessionGroupBirthResult> {
  const dataDir = depsOverride?.dataDir ?? config.session.dataDir;
  const deps: CollabS1Deps = {
    dataDir,
    now: depsOverride?.now ?? (() => Date.now()),
    createChat: depsOverride?.createChat ?? (async (creatorAppId, opts) =>
      createChatWithUuid(creatorAppId, opts)),
    forward: depsOverride?.forward ?? ((larkAppId, messageId, chatId, uuid) =>
      forwardMessage(larkAppId, messageId, chatId, uuid)),
    registerGroup: depsOverride?.registerGroup ?? ((chatId, entry) =>
      registerSessionGroup(chatId, entry)),
  };
  return runCollabGroupBirthS1(data, ctx, initId, creatorAdmissionReceipt, deps);
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
