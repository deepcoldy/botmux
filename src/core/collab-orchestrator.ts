/**
 * S1 create 真实编排（design 2026-11-20-dm-collab-group §10.2）。
 *
 * PR-2a 地基：startCollabGroupBirth 的 S1 本体。顺序（每步先写 operation 再调外部、
 * 成功写 done+receipt，失败/未知写 failed/unknown+error）：
 *   1. create operation（uuid=collabCreateUuid(initId,createAttempt)）→ createChatWithUuid
 *      （botIds=[], userIds=[] 建 creator-only 群）；
 *   2. 落 entry.chatId；
 *   3. registerSessionGroup（ownerOpenId 来自原 DM sender.open_id；origin* 来自 receipt）；
 *   4. 写全关闭 gate（先于任何邀请）；
 *   5. forward operation（独立 uuid，只转一次原始任务）。
 *
 * 重入判 payloadHash 一致才继续同 op。creatorAdmissionReceipt 已持久化 → 跳过扣费
 * 直接进 S1。S1 在途被取消时，迟到 create 成功仍记录 chatId+gate（铁律 3，PR-2b 接
 * 取消代际，此处保证外部结果不被丢弃）。
 *
 * 依赖注入（deps）使测试能用真实 store + 可控飞书假实现 + 假时钟驱动。
 */
import {
  collabCreateUuid,
  collabForwardUuid,
  collabPayloadHash,
  type CreatorAdmissionReceipt,
} from '../services/collab-group-config.js';
import {
  patchCollabInitEntry,
  readCollabInitEntry,
  advanceCollabStep,
  markCollabInitTerminal,
  writeCollabOperation,
} from '../services/collab-init-store.js';
import {
  buildInitialCollabGate,
  readCollabGate,
  writeCollabGate,
} from '../services/collab-gate-store.js';
import type { RoutingContext } from '../im/lark/event-dispatcher.js';
import type { SessionGroupBirthResult } from './collab-group-birth.js';

export interface CollabS1CreateChatOpts {
  name?: string;
  botIds: string[];
  userIds?: string[];
  chatMode?: 'group' | 'topic';
  uuid: string;
}

export interface CollabS1Deps {
  dataDir: string;
  now: () => number;
  /** 可控飞书建群假实现（测试记录 params.uuid / botIds / userIds）。 */
  createChat: (creatorAppId: string, opts: CollabS1CreateChatOpts) => Promise<{ chatId: string; invalidBotIds: string[]; invalidUserIds: string[] }>;
  /** 可控飞书转发假实现。 */
  forward: (larkAppId: string, messageId: string, chatId: string, uuid?: string) => Promise<string>;
  /** 会话群登记（真实 registerSessionGroup 或替身）。 */
  registerGroup: (chatId: string, entry: {
    ownerOpenId: string;
    lastSessionId: string;
    originReason?: string;
    originQuotaKey?: string;
    originChatId?: string;
  }) => void;
}

/** 阶段 2：从 evaluateTalk 判定 + 扣费结果构建持久 receipt。 */
export function buildCreatorAdmissionReceipt(opts: {
  operationId: string;
  talk: { allowed: boolean; reason: string; quotaKey?: string };
  used: number;
  chargedAt: number;
  originChatId: string;
}): CreatorAdmissionReceipt {
  return {
    operationId: opts.operationId,
    quotaKey: opts.talk.quotaKey,
    used: opts.used,
    chargedAt: opts.chargedAt,
    allow: true,
    originReason: opts.talk.reason,
    originQuotaKey: opts.talk.quotaKey,
    originChatId: opts.originChatId,
  };
}

/** 持久化 creatorAdmissionReceipt 到 entry（幂等键 creatorAdmissionOperationId）。 */
export async function persistCreatorAdmissionReceipt(opts: {
  dataDir: string;
  creatorAppId: string;
  initId: string;
  receipt: CreatorAdmissionReceipt;
  now: number;
}): Promise<void> {
  await patchCollabInitEntry({
    dataDir: opts.dataDir,
    creatorAppId: opts.creatorAppId,
    initId: opts.initId,
    mutate: (entry) => {
      entry.creatorAdmissionReceipt = opts.receipt;
      entry.updatedAt = opts.now;
      return true;
    },
  });
}

/** 释放 activeByDmChat + 置 failed + 写 awaiting 原因。 */
async function failInit(
  deps: CollabS1Deps,
  creatorAppId: string,
  initId: string,
  dmChatId: string,
  reason: string,
  now: number,
): Promise<void> {
  await patchCollabInitEntry({
    dataDir: deps.dataDir, creatorAppId, initId,
    mutate: (entry) => { entry.awaiting = { reason, since: now }; entry.updatedAt = now; return true; },
  });
  await markCollabInitTerminal({ dataDir: deps.dataDir, creatorAppId, initId, dmChatId, state: 'failed', now });
}

/**
 * S1 编排本体。可重入：已完成的 op 不再重复执行（payloadHash 一致才继续）。
 * 返回 SessionGroupBirthResult（collab-handled 或失败落 failed）。
 */
export async function runCollabGroupBirthS1(
  data: any,
  ctx: RoutingContext,
  initId: string,
  receipt: CreatorAdmissionReceipt,
  deps: CollabS1Deps,
): Promise<SessionGroupBirthResult> {
  const { larkAppId: creatorAppId, messageId } = ctx;
  const now = deps.now();
  const entry = readCollabInitEntry(deps.dataDir, creatorAppId, initId);
  if (!entry) {
    return { kind: 'collab-handled', initId, status: 'entry_missing' };
  }

  const ownerOpenId: string | undefined = data?.sender?.sender_id?.open_id;
  if (!ownerOpenId) {
    await failInit(deps, creatorAppId, initId, entry.dmChatId, 'missing sender open_id', now);
    return { kind: 'collab-handled', initId, status: 'failed' };
  }

  // ── S1.create：建 creator-only 群 ──
  const createUuid = collabCreateUuid(initId, entry.createAttempt);
  const createOpKey = createUuid;
  const createPayloadHash = collabPayloadHash({ initId, createAttempt: entry.createAttempt, name: '' });
  const existingCreate = entry.operations[createOpKey];

  let chatId = entry.chatId;
  if (existingCreate?.status !== 'done') {
    if (existingCreate && existingCreate.payloadHash !== createPayloadHash) {
      await failInit(deps, creatorAppId, initId, entry.dmChatId, 'create operation payloadHash conflict', now);
      return { kind: 'collab-handled', initId, status: 'failed' };
    }
    const firstAttemptAt = existingCreate?.firstAttemptAt ?? now;
    await writeCollabOperation({
      dataDir: deps.dataDir, creatorAppId, initId, opKey: createOpKey, now,
      op: { kind: 'create', status: 'attempting', uuid: createUuid, firstAttemptAt, payloadHash: createPayloadHash },
    });
    await advanceCollabStep({ dataDir: deps.dataDir, creatorAppId, initId, step: 'create', status: 'running', now });

    let createResult: { chatId: string };
    try {
      createResult = await deps.createChat(creatorAppId, { botIds: [], userIds: [], uuid: createUuid });
    } catch (err) {
      // 结果未知/失败：记录 unknown，保留可恢复状态（PR-2b 对账）。
      await writeCollabOperation({
        dataDir: deps.dataDir, creatorAppId, initId, opKey: createOpKey, now,
        op: { kind: 'create', status: 'unknown', uuid: createUuid, firstAttemptAt, payloadHash: createPayloadHash, error: String((err as any)?.message ?? err) },
      });
      return { kind: 'collab-handled', initId, status: 'create_unknown' };
    }
    const newChatId = createResult.chatId;
    if (!newChatId) {
      await writeCollabOperation({
        dataDir: deps.dataDir, creatorAppId, initId, opKey: createOpKey, now,
        op: { kind: 'create', status: 'failed', uuid: createUuid, firstAttemptAt, payloadHash: createPayloadHash, error: 'chat.create returned no chatId' },
      });
      await failInit(deps, creatorAppId, initId, entry.dmChatId, 'chat.create returned no chatId', now);
      return { kind: 'collab-handled', initId, status: 'failed' };
    }
    chatId = newChatId;
    // 落 chatId（迟到 create 成功也记录，铁律 3）。
    await patchCollabInitEntry({
      dataDir: deps.dataDir, creatorAppId, initId,
      mutate: (e) => { e.chatId = newChatId; e.updatedAt = now; return true; },
    });
    await writeCollabOperation({
      dataDir: deps.dataDir, creatorAppId, initId, opKey: createOpKey, now,
      op: { kind: 'create', status: 'done', uuid: createUuid, firstAttemptAt, payloadHash: createPayloadHash, receipt: { chatId: newChatId } },
    });
    await advanceCollabStep({ dataDir: deps.dataDir, creatorAppId, initId, step: 'create', status: 'done', now });
  } else if (!chatId) {
    // create 已 done 但 chatId 尚未落（崩溃于落 chatId 前）：从 receipt 恢复。
    chatId = (existingCreate.receipt as { chatId?: string } | undefined)?.chatId;
    if (chatId) {
      await patchCollabInitEntry({
        dataDir: deps.dataDir, creatorAppId, initId,
        mutate: (e) => { e.chatId = chatId; e.updatedAt = now; return true; },
      });
    }
  }
  if (!chatId) {
    await failInit(deps, creatorAppId, initId, entry.dmChatId, 'no chatId after create', now);
    return { kind: 'collab-handled', initId, status: 'failed' };
  }

  // ── S1.registerSessionGroup：origin* 从 receipt 恢复（铁律 11）──
  // 幂等：同 chatId 覆盖写，但用 operation 记录避免重复（可重入）。
  const regOpKey = `${collabForwardUuid(initId)}:register`;
  const regPayloadHash = collabPayloadHash({ chatId, ownerOpenId });
  const regOp = readCollabInitEntry(deps.dataDir, creatorAppId, initId)?.operations[regOpKey];
  if (regOp?.status !== 'done') {
    await writeCollabOperation({
      dataDir: deps.dataDir, creatorAppId, initId, opKey: regOpKey, now,
      op: { kind: 'admission', status: 'attempting', payloadHash: regPayloadHash, firstAttemptAt: regOp?.firstAttemptAt ?? now },
    });
    deps.registerGroup(chatId, {
      ownerOpenId,
      lastSessionId: '',
      originReason: receipt.originReason,
      originQuotaKey: receipt.originQuotaKey,
      originChatId: receipt.originChatId,
    });
    await writeCollabOperation({
      dataDir: deps.dataDir, creatorAppId, initId, opKey: regOpKey, now,
      op: { kind: 'admission', status: 'done', payloadHash: regPayloadHash, receipt: { chatId } },
    });
  }

  // ── S1.gate：写全关闭 gate（先于任何邀请）──
  if (!readCollabGate(deps.dataDir, chatId)) {
    const gate = buildInitialCollabGate({
      initId,
      configVersion: entry.configVersion,
      creatorAppId,
      chatId,
      participantAppIds: entry.configSnapshot.agents.map(a => a.appId),
    });
    writeCollabGate(deps.dataDir, gate);
  }

  // ── S1.forward：独立 operation，只转一次原始任务 ──
  const forwardUuid = collabForwardUuid(initId);
  const forwardPayloadHash = collabPayloadHash({ initId, sourceMessageId: messageId, chatId });
  const existingForward = readCollabInitEntry(deps.dataDir, creatorAppId, initId)?.operations[forwardUuid];
  if (existingForward?.status !== 'done') {
    if (existingForward && existingForward.payloadHash !== forwardPayloadHash) {
      await failInit(deps, creatorAppId, initId, entry.dmChatId, 'forward operation payloadHash conflict', now);
      return { kind: 'collab-handled', initId, status: 'failed' };
    }
    await writeCollabOperation({
      dataDir: deps.dataDir, creatorAppId, initId, opKey: forwardUuid, now,
      op: { kind: 'forward', status: 'attempting', uuid: forwardUuid, firstAttemptAt: existingForward?.firstAttemptAt ?? now, payloadHash: forwardPayloadHash },
    });
    try {
      const forwardedId = await deps.forward(creatorAppId, messageId, chatId, forwardUuid);
      await writeCollabOperation({
        dataDir: deps.dataDir, creatorAppId, initId, opKey: forwardUuid, now,
        op: { kind: 'forward', status: 'done', uuid: forwardUuid, firstAttemptAt: existingForward?.firstAttemptAt ?? now, payloadHash: forwardPayloadHash, receipt: { messageId: forwardedId } },
      });
    } catch (err) {
      await writeCollabOperation({
        dataDir: deps.dataDir, creatorAppId, initId, opKey: forwardUuid, now,
        op: { kind: 'forward', status: 'unknown', uuid: forwardUuid, firstAttemptAt: existingForward?.firstAttemptAt ?? now, payloadHash: forwardPayloadHash, error: String((err as any)?.message ?? err) },
      });
    }
  }

  return { kind: 'collab-handled', initId, chatId, status: 'running' };
}
