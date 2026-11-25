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
  collabCreatorAdmissionReceiptId,
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
  patchCollabInitEntry,
  placeCollabGroupInit,
  readCollabInitEntry,
  readCollabInitStore,
  type CollabGroupInitEntry,
} from '../services/collab-init-store.js';
import { createChatWithUuid } from '../services/groups-store.js';
import { registerSessionGroup } from '../services/session-groups-store.js';
import { getCollabAdmissionReceipt } from '../services/grant-store.js';
import { forwardMessage } from '../im/lark/client.js';
import { runCollabGroupBirthS1, type CollabS1Deps } from './collab-orchestrator.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { preflightCollabPeer, COLLAB_IPC_DURABLE_TURN_OUTPUT_RECEIPT, declaresDurableTurnOutputReceiptForCli } from './collab-preflight-ipc.js';
import { resolvePairedBackendId } from './remote-cli-ids.js';
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
export interface CollabPeerPreflightContext {
  config: SessionGroupCollaborationConfig;
  initId: string;
  sourceMessageId: string;
  configVersion: string;
  creatorAppId: string;
  dataDir: string;
}

export interface CollabPreflightDeps {
  dataDir: string;
  now: () => number;
  resolveProfile?: CollabValidationDeps['resolveProfile'];
  resolveTeamRole?: CollabValidationDeps['resolveTeamRole'];
  /** 可选：participant 存在性 + 非 apiOnly 判定（默认用 registry 缓存）。 */
  resolveAgent?: CollabValidationDeps['resolveAgent'];
  peerPreflight?: (ctx: CollabPeerPreflightContext) => Promise<{ ok: true } | { ok: false; errors: string[] }>;
}

/** PR-1 生产态：编排未实现前，显式 enabled 一律 fail-closed（见 CollabPreflightDeps 注释）。 */
export const COLLAB_ORCHESTRATION_NOT_IMPLEMENTED = '协作初始化编排尚未实现（PR-2）';

// 测试 seam：覆盖 defaultDeps 的 peerPreflight，让真实 daemon 入口测试能驱动 ready 分支
// （PR-1 内 ready 只用于验证「扣费恰好 1 次」的契约）。
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
    // S2-S5 编排尚未接入生产（startCollabGroupBirth 只跑 S1），若切回真实 preflight 会让
    // 合法 enabled 配置走 ready → 扣费 → S1 后运行链断裂、同 DM busy、永远无法完成
    // （违反铁律2「全链路测试绿后才切回」）。生产 defaultDeps 保持 fail-closed；测试经
    // __testOnly_setCollabPeerPreflight 注入 {ok:true} 验证 ready 分支。
    peerPreflight: __testOnlyPeerPreflight ?? (async () => ({ ok: false, errors: ['协作初始化 S2-S5 编排未接入生产，生产 fail-closed'] })),
  };
}

/**
 * 真实 peer preflight（PR-2b）：对每个非 creator participant 找在线 daemon，发
 * collab.preflight。peer 离线 / 协议不匹配 / 目标 appId 不匹配 / 未声明必需能力 →
 * 未就绪（fail-closed）。含 afterAgentTurn 依赖的 kickoff 目标必须声明
 * durable-turn-output-receipt-v1。
 */
export async function realCollabPeerPreflight(ctx: CollabPeerPreflightContext): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  const requiresDurableReceipt = new Set(
    ctx.config.kickoff
      .filter(k => k.trigger === 'afterAgentTurn')
      .map(k => k.afterAppId as string),
  );
  // R4/P2：creator 若被依赖（peer 的 afterAgentTurn 依赖 creator），也要按**实际运行 backend**
  // 判定 durable-turn-output-receipt-v1——不能只看 creatorCfg.backendType 原始值。用
  // resolvePairedBackendId(cliId, backendType, daemon default) 解析实际配对（本地缺省 + 远程配对）。
  if (requiresDurableReceipt.has(ctx.creatorAppId)) {
    const creatorCfg = getBot(ctx.creatorAppId).config;
    const actualBackend = resolvePairedBackendId(creatorCfg.cliId, creatorCfg.backendType, config.daemon.backendType);
    const creatorCapable = declaresDurableTurnOutputReceiptForCli(creatorCfg.cliId, creatorCfg.backendType, config.daemon.backendType);
    if (!creatorCapable) {
      errors.push(`creator ${ctx.creatorAppId} 被 afterAgentTurn 依赖但未声明 durable-turn-output-receipt-v1（backend=${actualBackend ?? 'unknown'}）`);
    }
  }
  // 只 preflight 非 creator participant（creator 走本地）。
  const peers = ctx.config.agents.filter(a => a.appId !== ctx.creatorAppId);
  for (const agent of peers) {
    const daemon = findOnlineDaemon(agent.appId, ctx.dataDir);
    if (!daemon) {
      errors.push(`peer ${agent.appId} 离线（未就绪）`);
      continue;
    }
    if (daemon.dispatchLaunchIpcProtocol !== 'v1' || !daemon.bootInstanceId) {
      errors.push(`peer ${agent.appId} 未声明 dispatch-launch IPC v1`);
      continue;
    }
    const resp = await preflightCollabPeer(daemon, {
      schemaVersion: 1,
      initId: ctx.initId,
      sourceMessageId: ctx.sourceMessageId,
      configVersion: ctx.configVersion,
      targetLarkAppId: agent.appId,
    });
    if (!resp.ok) {
      errors.push(`peer ${agent.appId} preflight 未就绪：${resp.errorCode} ${resp.message}`);
      continue;
    }
    if (requiresDurableReceipt.has(agent.appId) && !resp.capabilities.includes(COLLAB_IPC_DURABLE_TURN_OUTPUT_RECEIPT)) {
      errors.push(`peer ${agent.appId} 配 afterAgentTurn 但未声明 durable-turn-output-receipt-v1`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
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
  recoveryMode = false,
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

  let placed: Awaited<ReturnType<typeof placeCollabGroupInit>>;
  try {
    placed = await placeCollabGroupInit({
      dataDir,
      creatorAppId,
      dmChatId,
      sourceKey,
      initId,
      sourceMessageId: messageId,
      configVersion,
      configSnapshot: validation.config,
      resolvedProfileEntries: validation.resolvedProfileEntries,
      referencedTeamRoles: validation.referencedTeamRoles,
      sourceSenderOpenId: data?.sender?.sender_id?.open_id,
      sourceSenderUnionId: data?.sender?.sender_id?.union_id,
      creatorAdmissionOperationId,
      createAttempt: COLLAB_CREATE_ATTEMPT_INITIAL,
      now: deps.now(),
    });
  } catch (err) {
    // 损坏或写盘结果未知均 fail-closed；不得把旧账本当空文件覆盖，也不擅自释放未知占位。
    return { kind: 'failed', reason: `协作初始化账本不可用：${String((err as any)?.message ?? err)}`, releasesDmChat: false };
  }

  const recoveryExisting = recoveryMode && placed.kind === 'existing';
  if (placed.kind === 'existing' && !recoveryExisting) {
    return { kind: 'existing', initId: placed.initId, status: placed.status };
  }
  if (recoveryExisting) {
    const current = readCollabInitEntry(dataDir, creatorAppId, placed.initId);
    if (current?.state !== 'running') {
      return { kind: 'existing', initId: placed.initId, status: current?.state ?? 'entry_missing' };
    }
  }
  if (placed.kind === 'busy') return { kind: 'busy', initId: placed.initId };

  // peer preflight（占位后）。reject / 失败一律转 failed 并释放占位，绝不残留 running。
  let peer: { ok: true } | { ok: false; errors: string[] };
  try {
    const peerCtx: CollabPeerPreflightContext = {
      config: validation.config,
      initId,
      sourceMessageId: messageId,
      configVersion,
      creatorAppId,
      dataDir,
    };
    peer = deps.peerPreflight
      ? await deps.peerPreflight(peerCtx)
      : await realCollabPeerPreflight(peerCtx);
  } catch (err) {
    peer = { ok: false, errors: [`peer preflight 异常：${String((err as any)?.message ?? err)}`] };
  }
  if (!peer.ok) {
    if (recoveryExisting) {
      // 恢复失败不转 failed、不释放原任务，更不执行 S1；CAS 防止覆盖并发 cancel。
      await patchCollabInitEntry({
        dataDir, creatorAppId, initId,
        expectedState: 'running',
        mutate: (entry) => {
          entry.state = 'awaiting-input';
          entry.awaiting = { reason: 'PEER_NOT_READY', since: deps.now(), detail: peer.errors };
          entry.updatedAt = deps.now();
          return true;
        },
      });
      return {
        kind: 'existing', initId,
        status: readCollabInitEntry(dataDir, creatorAppId, initId)?.state ?? 'entry_missing',
      };
    }
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

  if (recoveryExisting) {
    return { kind: 'existing', initId, status: 'running' };
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

export interface CollabBirthStartupRecoveryOpts {
  dataDir: string;
  /** 必须只传当前 daemon 自己负责的 appId，避免多 daemon 重放同一账本。 */
  creatorAppIds: readonly string[];
  now?: () => number;
  /** 当前 creator 授权重算，只读且不得扣费；生产由 daemon 显式注入 evaluateTalk。 */
  evaluateCreatorTalk: (entry: CollabGroupInitEntry) => { allowed: boolean; reason?: string };
  preflightDeps?: Partial<CollabPreflightDeps>;
  startDeps?: Partial<CollabS1Deps>;
  startImpl?: typeof startCollabGroupBirth;
  readAdmissionReceipt?: typeof getCollabAdmissionReceipt;
}

export interface CollabBirthStartupRecoveryResult {
  scanned: number;
  resumeAttempts: number;
  awaitingInput: number;
  releasedUncommitted: number;
  errors: Array<{ creatorAppId: string; initId?: string; message: string }>;
}

function recoveryEvent(entry: CollabGroupInitEntry, creatorAppId: string): { data: any; ctx: RoutingContext } {
  const data = {
    sender: { sender_id: { open_id: entry.sourceSenderOpenId, union_id: entry.sourceSenderUnionId }, sender_type: 'user' },
    message: { message_id: entry.sourceMessageId, chat_id: entry.dmChatId, chat_type: 'p2p' },
  };
  const ctx: RoutingContext = {
    larkAppId: creatorAppId,
    chatId: entry.dmChatId,
    messageId: entry.sourceMessageId,
    chatType: 'p2p',
    scope: 'thread',
    anchor: entry.sourceMessageId,
  };
  return { data, ctx };
}

function durableReceiptForRecovery(
  entry: CollabGroupInitEntry,
  creatorAppId: string,
  readReceipt: typeof getCollabAdmissionReceipt,
  now: () => number,
): CreatorAdmissionReceipt | undefined {
  const projected = entry.creatorAdmissionReceipt as CreatorAdmissionReceipt | undefined;
  if (projected?.operationId) return projected;
  const durable = readReceipt(creatorAppId, collabCreatorAdmissionReceiptId(entry.initId));
  if (!durable?.allow) return undefined;
  return {
    operationId: collabCreatorAdmissionOperationId(entry.initId),
    quotaKey: durable.quotaKey,
    used: durable.used,
    chargedAt: Date.parse(durable.chargedAt) || now(),
    allow: true,
    originReason: durable.reason,
    originQuotaKey: durable.quotaKey,
    originChatId: entry.dmChatId,
  };
}

/**
 * 启动只扫描 running：先经现有 preflight 重新求当前 configVersion，再恢复 durable admission
 * 之后的 S1。awaiting-input/failed/cancelled/done 一律不自动推进。无 receipt 且无 chatId 的
 * 占位在扣费+回执同事务语义下不可能已扣费，置 failed 释放 DM；其它不确定形状转人工态。
 */
export async function recoverRunningCollabGroupBirthsOnStartup(
  opts: CollabBirthStartupRecoveryOpts,
): Promise<CollabBirthStartupRecoveryResult> {
  const now = opts.now ?? (() => Date.now());
  const start = opts.startImpl ?? startCollabGroupBirth;
  const readReceipt = opts.readAdmissionReceipt ?? getCollabAdmissionReceipt;
  const result: CollabBirthStartupRecoveryResult = { scanned: 0, resumeAttempts: 0, awaitingInput: 0, releasedUncommitted: 0, errors: [] };
  const markAwaiting = async (creatorAppId: string, entry: CollabGroupInitEntry, reason: string): Promise<void> => {
    const patched = await patchCollabInitEntry({
      dataDir: opts.dataDir, creatorAppId, initId: entry.initId,
      expectedState: 'running',
      mutate: (e) => {
        e.state = 'awaiting-input';
        e.awaiting = { reason, since: now() };
        e.updatedAt = now();
        return true;
      },
    });
    if (patched?.state === 'awaiting-input') result.awaitingInput++;
  };

  for (const creatorAppId of opts.creatorAppIds) {
    let entries: CollabGroupInitEntry[];
    try {
      entries = Object.values(readCollabInitStore(opts.dataDir, creatorAppId).entries)
        .filter(entry => entry.state === 'running');
    } catch (err) {
      result.errors.push({ creatorAppId, message: String((err as any)?.message ?? err) });
      continue;
    }
    for (const entry of entries) {
      result.scanned++;
      try {
        if (!entry.sourceSenderOpenId) {
          await markAwaiting(creatorAppId, entry, 'RECOVERY_IDENTITY_MISSING');
          continue;
        }
        const { data, ctx } = recoveryEvent(entry, creatorAppId);
        const preflight = await preflightCollabGroupBirth(data, ctx, {
          ...opts.preflightDeps,
          dataDir: opts.dataDir,
          now,
        }, true);
        if (preflight.kind !== 'existing') {
          // 配置被关闭或变得非法同样属于冻结版本变化，不得恢复旧快照。
          await markAwaiting(creatorAppId, entry, 'CONFIG_CHANGED');
          continue;
        }
        const fresh = readCollabInitEntry(opts.dataDir, creatorAppId, entry.initId);
        if (!fresh || fresh.state !== 'running') {
          if (fresh?.state === 'awaiting-input') result.awaitingInput++;
          continue;
        }
        if (!opts.evaluateCreatorTalk(fresh).allowed) {
          await markAwaiting(creatorAppId, fresh, 'CREATOR_NOT_AUTHORIZED');
          continue;
        }
        const receipt = durableReceiptForRecovery(fresh, creatorAppId, readReceipt, now);
        if (!receipt) {
          if (fresh.chatId) {
            await markAwaiting(creatorAppId, fresh, 'ADMISSION_RECEIPT_MISSING');
          } else {
            const marked = await patchCollabInitEntry({
              dataDir: opts.dataDir, creatorAppId, initId: fresh.initId,
              expectedState: 'running',
              mutate: (e) => { e.awaiting = { reason: 'ADMISSION_NOT_COMMITTED', since: now() }; return true; },
            });
            if (!marked) continue;
            await markCollabInitTerminal({ dataDir: opts.dataDir, creatorAppId, initId: fresh.initId, dmChatId: fresh.dmChatId, state: 'failed', now: now() });
            result.releasedUncommitted++;
          }
          continue;
        }
        await start(data, ctx, fresh.initId, receipt, { ...opts.startDeps, dataDir: opts.dataDir, now });
        result.resumeAttempts++;
      } catch (err) {
        result.errors.push({ creatorAppId, initId: entry.initId, message: String((err as any)?.message ?? err) });
      }
    }
  }
  return result;
}
