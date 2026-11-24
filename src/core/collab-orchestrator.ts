/**
 * S1 create 真实编排（design 2026-11-20-dm-collab-group §10.2）。
 *
 * PR-2a 地基：startCollabGroupBirth 的 S1 本体。顺序（每步先写 operation 再调外部、
 * 成功写 done+receipt，失败/未知写 failed/unknown+error）：
 *   1. create operation（uuid=collabCreateUuid(initId,createAttempt)）→ createChatWithUuid
 *      （botIds=[], userIds=[] 建 creator-only 群）；
 *   2. 落 entry.chatId（与 create done 同次原子写）；
 *   3. registerSessionGroup（ownerOpenId 来自原 DM sender.open_id；origin* 来自 receipt）；
 *   4. 写全关闭 gate（先于任何邀请）；
 *   5. forward operation（独立 uuid，只转一次原始任务）。
 *
 * 关键不变量（R2/R5/R6）：
 *   - 已有有效 durable chatId 时补齐 create operation，**不**再调外部 create；
 *   - create unknown 超窗（COLLAB_CREATE_UUID_WINDOW_MS）进 awaiting-input，禁止自动重建；
 *   - 每步先核对完整 payloadHash（含 origin*），再据 status query/retry/skip；done 也拒绝冲突；
 *   - S1 按 initId 串行（withCollabInitIdMutex），并发重入不重复外部副作用。
 */
import {
  collabCreateUuid,
  collabForwardUuid,
  collabPayloadHash,
  COLLAB_CREATE_UUID_WINDOW_MS,
  type CreatorAdmissionReceipt,
} from '../services/collab-group-config.js';
import {
  patchCollabInitEntry,
  readCollabInitEntry,
  advanceCollabStep,
  markCollabInitTerminal,
  withCollabInitIdMutex,
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

/** 阶段 2：从「本次扣费事实快照」构建不可变 receipt（R3）。 */
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

/**
 * 持久化 creatorAdmissionReceipt 到 entry。返回 true=已 durable 落盘；false=写盘失败。
 * R1：receipt 未确认 durable 前不得进 S1——调用方据此短路。
 */
export async function persistCreatorAdmissionReceipt(opts: {
  dataDir: string;
  creatorAppId: string;
  initId: string;
  receipt: CreatorAdmissionReceipt;
  now: number;
}): Promise<boolean> {
  try {
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
    // 确认确实落盘（读回比对）。
    const readBack = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId);
    return (readBack?.creatorAdmissionReceipt as CreatorAdmissionReceipt | undefined)?.operationId === opts.receipt.operationId;
  } catch {
    return false;
  }
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
 * S1 编排本体（按 initId 串行，可重入）。返回 SessionGroupBirthResult。
 */
export async function runCollabGroupBirthS1(
  data: any,
  ctx: RoutingContext,
  initId: string,
  receipt: CreatorAdmissionReceipt,
  deps: CollabS1Deps,
): Promise<SessionGroupBirthResult> {
  return withCollabInitIdMutex(initId, () => runS1Critical(data, ctx, initId, receipt, deps));
}

async function runS1Critical(
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

  // 冻结请求身份校验：source/owner 必须匹配（R5）。
  if (entry.dmChatId !== ctx.chatId) {
    await failInit(deps, creatorAppId, initId, entry.dmChatId, 'dmChatId mismatch', now);
    return { kind: 'collab-handled', initId, status: 'failed' };
  }
  if (entry.sourceMessageId !== messageId) {
    await failInit(deps, creatorAppId, initId, entry.dmChatId, 'sourceMessageId mismatch', now);
    return { kind: 'collab-handled', initId, status: 'failed' };
  }

  // ── S1.create：建 creator-only 群 ──
  const createUuid = collabCreateUuid(initId, entry.createAttempt);
  const createOpKey = createUuid;
  const createPayloadHash = collabPayloadHash({ initId, createAttempt: entry.createAttempt, name: '' });
  const existingCreate = entry.operations[createOpKey];

  let chatId = entry.chatId;

  if (existingCreate?.status === 'done') {
    // 已 done：跳过外部 create（R2/R5）。若 chatId 尚未落，从 receipt 补齐。
    if (existingCreate.payloadHash !== createPayloadHash) {
      await failInit(deps, creatorAppId, initId, entry.dmChatId, 'create operation payloadHash conflict', now);
      return { kind: 'collab-handled', initId, status: 'failed' };
    }
    if (!chatId) {
      chatId = (existingCreate.receipt as { chatId?: string } | undefined)?.chatId;
      if (chatId) {
        await patchCollabInitEntry({
          dataDir: deps.dataDir, creatorAppId, initId,
          mutate: (e) => { e.chatId = chatId; e.updatedAt = now; return true; },
        });
      }
    }
  } else if (chatId) {
    // 已有有效 durable chatId 但 create op 未 done：崩溃于「落 chatId 后、写 done 前」。
    // 补齐 create operation，**不再调外部 create**（R2）。
    await writeCollabOperation({
      dataDir: deps.dataDir, creatorAppId, initId, opKey: createOpKey, now,
      op: { kind: 'create', status: 'done', uuid: createUuid, firstAttemptAt: existingCreate?.firstAttemptAt ?? now, payloadHash: createPayloadHash, receipt: { chatId } },
    });
    await advanceCollabStep({ dataDir: deps.dataDir, creatorAppId, initId, step: 'create', status: 'done', now });
  } else {
    // 无 chatId 且 op 未 done：需要真正 create。
    if (existingCreate && existingCreate.payloadHash !== createPayloadHash) {
      await failInit(deps, creatorAppId, initId, entry.dmChatId, 'create operation payloadHash conflict', now);
      return { kind: 'collab-handled', initId, status: 'failed' };
    }
    const firstAttemptAt = existingCreate?.firstAttemptAt ?? now;
    if (existingCreate?.status === 'unknown' && firstAttemptAt !== undefined) {
      // unknown 超窗禁止自动重建（R2）：进 awaiting-input('CREATE_UNKNOWN_EXPIRED')。
      if (now - firstAttemptAt > COLLAB_CREATE_UUID_WINDOW_MS) {
        await patchCollabInitEntry({
          dataDir: deps.dataDir, creatorAppId, initId,
          mutate: (e) => { e.state = 'awaiting-input'; e.awaiting = { reason: 'CREATE_UNKNOWN_EXPIRED', since: now }; e.updatedAt = now; return true; },
        });
        return { kind: 'collab-handled', initId, status: 'awaiting_input' };
      }
      // 窗口内：用同 uuid 重试（Lark 返回原 chatId）。
    }
    await writeCollabOperation({
      dataDir: deps.dataDir, creatorAppId, initId, opKey: createOpKey, now,
      op: { kind: 'create', status: 'attempting', uuid: createUuid, firstAttemptAt, payloadHash: createPayloadHash },
    });
    await advanceCollabStep({ dataDir: deps.dataDir, creatorAppId, initId, step: 'create', status: 'running', now });

    let createResult: { chatId: string };
    try {
      createResult = await deps.createChat(creatorAppId, { botIds: [], userIds: [], uuid: createUuid });
    } catch (err) {
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
    // 落 chatId + create done 同次原子写（R2）。
    await patchCollabInitEntry({
      dataDir: deps.dataDir, creatorAppId, initId,
      mutate: (e) => {
        e.chatId = newChatId;
        e.operations[createOpKey] = { kind: 'create', status: 'done', uuid: createUuid, firstAttemptAt, payloadHash: createPayloadHash, receipt: { chatId: newChatId } };
        e.steps.create = { status: 'done', at: now };
        e.updatedAt = now;
        return true;
      },
    });
  }

  if (!chatId) {
    await failInit(deps, creatorAppId, initId, entry.dmChatId, 'no chatId after create', now);
    return { kind: 'collab-handled', initId, status: 'failed' };
  }

  // ── S1.registerSessionGroup：origin* 从 receipt 恢复（铁律 11）──
  const regOpKey = `${collabForwardUuid(initId)}:register`;
  // register hash 含完整登记 payload（含 origin*），R5。
  const regPayloadHash = collabPayloadHash({
    chatId,
    ownerOpenId,
    originReason: receipt.originReason,
    originQuotaKey: receipt.originQuotaKey,
    originChatId: receipt.originChatId,
  });
  const regOp = readCollabInitEntry(deps.dataDir, creatorAppId, initId)?.operations[regOpKey];
  if (regOp?.status === 'done') {
    if (regOp.payloadHash !== regPayloadHash) {
      await failInit(deps, creatorAppId, initId, entry.dmChatId, 'register operation payloadHash conflict', now);
      return { kind: 'collab-handled', initId, status: 'failed' };
    }
  } else {
    if (regOp && regOp.payloadHash !== regPayloadHash) {
      await failInit(deps, creatorAppId, initId, entry.dmChatId, 'register operation payloadHash conflict', now);
      return { kind: 'collab-handled', initId, status: 'failed' };
    }
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
  if (existingForward?.status === 'done') {
    if (existingForward.payloadHash !== forwardPayloadHash) {
      await failInit(deps, creatorAppId, initId, entry.dmChatId, 'forward operation payloadHash conflict', now);
      return { kind: 'collab-handled', initId, status: 'failed' };
    }
  } else {
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
