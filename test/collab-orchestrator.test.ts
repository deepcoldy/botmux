/**
 * PR-2a 地基契约测试：createChatWithUuid 原语 + S1 create 编排 + 阶段2 receipt +
 * gate store + init-store patch 原语。用真实 store + 可控飞书假实现 + 假时钟。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCollabGroupBirthS1, buildCreatorAdmissionReceipt, persistCreatorAdmissionReceipt, type CollabS1Deps, type CollabS1CreateChatOpts } from '../src/core/collab-orchestrator.js';
import {
  placeCollabGroupInit,
  patchCollabInitEntry,
  readCollabInitEntry,
  readCollabInitStore,
  __testOnly_resetCollabInitMutexes,
} from '../src/services/collab-init-store.js';
import {
  collabCreateUuid,
  collabForwardUuid,
  collabCreatorAdmissionOperationId,
  collabInitId,
  collabPayloadHash,
  collabSourceKey,
  COLLAB_CREATE_ATTEMPT_INITIAL,
  type SessionGroupCollaborationConfig,
} from '../src/services/collab-group-config.js';
import { readCollabGate } from '../src/services/collab-gate-store.js';
import { collabGateFilePath } from '../src/services/collab-group-config.js';
import { createChatWithUuid, createChat } from '../src/services/groups-store.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';

// ─── groups-store 可控飞书假实现：记录 chat.create 调用 ───
const chatCreateCalls: Array<{ data: Record<string, unknown>; params: Record<string, unknown> }> = [];
let chatCreateImpl: (data: Record<string, unknown>, params: Record<string, unknown>) => Promise<any> = async () => ({
  code: 0,
  data: { chat_id: 'oc_fake_chat' },
});

vi.mock('../src/bot-registry.js', () => {
  const getBotClient = () => ({
    im: { v1: { chat: { create: async ({ data, params }: any) => {
      chatCreateCalls.push({ data, params });
      return chatCreateImpl(data, params);
    } } } },
  });
  return { getBotClient, getBot: () => ({ config: {} }), loadBotConfigsCached: () => [] };
});

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

import { vi } from 'vitest';

let tempDir: string;
let clock = 0;
const now = () => ++clock;

const APP = 'cli_creator';
const DM = 'oc_dm';
const SRC = 'om_source';
const OWNER = 'ou_owner';

function snapshotConfig(): SessionGroupCollaborationConfig {
  return {
    enabled: true,
    agents: [{ appId: 'cli_creator', roleMode: 'no-chat-role' }, { appId: 'cli_builder', roleMode: 'no-chat-role' }],
    kickoff: [
      { appId: 'cli_creator', trigger: 'immediate' },
      { appId: 'cli_builder', trigger: 'afterAgentTurn', afterAppId: 'cli_creator', artifact: { type: 'marked-url', hosts: ['example.com'] } },
    ],
  };
}

function ctx(messageId: string): RoutingContext {
  return { chatId: DM, messageId, chatType: 'p2p', scope: 'thread', anchor: messageId, larkAppId: APP };
}

function data(messageId: string): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: { message_id: messageId, chat_id: DM, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
  };
}

function receipt(opts: Partial<Record<string, unknown>> = {}): any {
  return {
    operationId: collabCreatorAdmissionOperationId(collabInitId(collabSourceKey(APP, DM, SRC))),
    quotaKey: 'chat:oc_dm:ou_owner',
    used: 1,
    chargedAt: now(),
    allow: true,
    originReason: 'chatGrant',
    originQuotaKey: 'chat:oc_dm:ou_owner',
    originChatId: DM,
    ...opts,
  };
}

const registeredGroups: Array<{ chatId: string; entry: any }> = [];
const forwarded: Array<{ appId: string; messageId: string; chatId: string; uuid?: string }> = [];

function deps(overrides: Partial<CollabS1Deps> = {}): CollabS1Deps {
  return {
    dataDir: tempDir,
    now,
    createChat: async (_appId, opts) => {
      chatCreateCalls.push({ data: { bot_id_list: opts.botIds, user_id_list: opts.userIds, chat_mode: opts.chatMode }, params: { uuid: opts.uuid } });
      return { chatId: 'oc_created', invalidBotIds: [], invalidUserIds: [] };
    },
    forward: async (appId, messageId, chatId, uuid) => {
      forwarded.push({ appId, messageId, chatId, uuid });
      return 'om_forwarded';
    },
    registerGroup: (chatId, entry) => { registeredGroups.push({ chatId, entry }); },
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'collab-orchestrator-'));
  clock = 0;
  __testOnly_resetCollabInitMutexes();
  chatCreateCalls.length = 0;
  registeredGroups.length = 0;
  forwarded.length = 0;
  chatCreateImpl = async () => ({ code: 0, data: { chat_id: 'oc_fake_chat' } });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  __testOnly_resetCollabInitMutexes();
});

async function seedEntry(): Promise<{ initId: string; sourceKey: string }> {
  const sourceKey = collabSourceKey(APP, DM, SRC);
  const initId = collabInitId(sourceKey);
  await placeCollabGroupInit({
    dataDir: tempDir, creatorAppId: APP, dmChatId: DM, sourceKey, initId,
    sourceMessageId: SRC, configVersion: 'cv', configSnapshot: snapshotConfig(),
    creatorAdmissionOperationId: collabCreatorAdmissionOperationId(initId),
    createAttempt: COLLAB_CREATE_ATTEMPT_INITIAL, now: now(),
  });
  return { initId, sourceKey };
}

describe('createChatWithUuid 原语', () => {
  it('uuid 透传进 params.uuid（非 data），botIds/userIds 空列表不带字段', async () => {
    const r = await createChatWithUuid(APP, { botIds: [], userIds: [], uuid: 'uuid-123' });
    expect(r.chatId).toBe('oc_fake_chat');
    expect(chatCreateCalls).toHaveLength(1);
    const { data, params } = chatCreateCalls[0];
    expect(params.uuid).toBe('uuid-123');
    expect(data.uuid).toBeUndefined(); // uuid 不在 data
    expect(data.bot_id_list).toBeUndefined(); // 空列表不带字段
    expect(data.user_id_list).toBeUndefined();
  });

  it('过滤 creator bot：botIds 含 creator 时剔除', async () => {
    await createChatWithUuid(APP, { botIds: [APP, 'cli_other'], userIds: [], uuid: 'u' });
    expect(chatCreateCalls[0].data.bot_id_list).toEqual(['cli_other']);
  });

  it('createChat 保留原签名，不生成 uuid', async () => {
    await createChat(APP, { botIds: [], userIds: [] });
    expect(chatCreateCalls[0].params.uuid).toBeUndefined();
  });
});

describe('S1 create 编排', () => {
  it('顺序：create(uuid)→落 chatId→registerSessionGroup(origin*)→gate→forward；botIds/userIds empty', async () => {
    const { initId } = await seedEntry();
    const r = await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), deps());

    expect(r.kind).toBe('collab-handled');
    if (r.kind === 'collab-handled') expect(r.chatId).toBe('oc_created');

    // create：botIds/userIds empty，uuid 透传
    expect(chatCreateCalls).toHaveLength(1);
    expect(chatCreateCalls[0].params.uuid).toBe(collabCreateUuid(initId, COLLAB_CREATE_ATTEMPT_INITIAL));
    expect(chatCreateCalls[0].data.bot_id_list).toEqual([]);
    expect(chatCreateCalls[0].data.user_id_list).toEqual([]);

    // entry.chatId 已落
    const entry = readCollabInitEntry(tempDir, APP, initId)!;
    expect(entry.chatId).toBe('oc_created');

    // registerSessionGroup origin* 从 receipt 恢复
    expect(registeredGroups).toHaveLength(1);
    expect(registeredGroups[0].chatId).toBe('oc_created');
    expect(registeredGroups[0].entry.ownerOpenId).toBe(OWNER);
    expect(registeredGroups[0].entry.originReason).toBe('chatGrant');
    expect(registeredGroups[0].entry.originQuotaKey).toBe('chat:oc_dm:ou_owner');
    expect(registeredGroups[0].entry.originChatId).toBe(DM);

    // gate 已写且全关闭
    const gate = readCollabGate(tempDir, 'oc_created')!;
    expect(gate.phase).toBe('initializing');
    expect(gate.participants['cli_creator'].roleReady).toBe(false);
    expect(gate.participants['cli_builder'].acceptingUserTasks).toBe(false);

    // forward 只转一次
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].chatId).toBe('oc_created');

    // create operation done + receipt
    expect(entry.operations[collabCreateUuid(initId, 0)].status).toBe('done');
  });

  it('gate 写盘先于 forward（拦截 forward 前 gate 已存在）', async () => {
    const { initId } = await seedEntry();
    const order: string[] = [];
    const d = deps({
      registerGroup: (chatId, entry) => { registeredGroups.push({ chatId, entry }); order.push('register'); },
      forward: async (appId, messageId, chatId, uuid) => {
        // forward 前断言 gate 已存在
        expect(readCollabGate(tempDir, chatId)).toBeTruthy();
        order.push('forward');
        return 'om_forwarded';
      },
    });
    await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), d);
    expect(order).toEqual(['register', 'forward']);
  });

  it('可重入：create 已 done 时不再二次 createChat（不重复建群）', async () => {
    const { initId } = await seedEntry();
    await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), deps());
    const createCallsAfterFirst = chatCreateCalls.length;
    // 二次重入（模拟崩溃恢复）
    await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), deps());
    expect(chatCreateCalls.length).toBe(createCallsAfterFirst); // 不二次建群
    expect(registeredGroups).toHaveLength(1); // 不重复 register
    expect(forwarded).toHaveLength(1); // 不重复 forward
  });

  it('create result unknown → 记 unknown，不落 chatId、不进后续', async () => {
    const { initId } = await seedEntry();
    const r = await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), deps({
      createChat: async () => { throw new Error('network timeout'); },
    }));
    expect(r.kind).toBe('collab-handled');
    if (r.kind === 'collab-handled') expect(r.status).toBe('create_unknown');
    const entry = readCollabInitEntry(tempDir, APP, initId)!;
    expect(entry.chatId).toBeUndefined();
    expect(entry.operations[collabCreateUuid(initId, 0)].status).toBe('unknown');
    expect(registeredGroups).toHaveLength(0);
    expect(readCollabGate(tempDir, 'oc_created')).toBeUndefined();
  });

  it('forward unknown 59min 内用同 uuid 重试并落 done', async () => {
    const { initId } = await seedEntry();
    let calls = 0;
    const d = deps({
      forward: async (appId, messageId, chatId, uuid) => {
        calls++;
        forwarded.push({ appId, messageId, chatId, uuid });
        if (calls === 1) throw new Error('timeout');
        return 'om_forwarded_retry';
      },
    });
    await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), d);
    clock = 59 * 60 * 1000;
    await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), d);
    expect(calls).toBe(2);
    expect(forwarded[0].uuid).toBe(forwarded[1].uuid);
    const entry = readCollabInitEntry(tempDir, APP, initId)!;
    expect(entry.operations[collabForwardUuid(initId)].status).toBe('done');
    expect(entry.state).toBe('running');
  });

  it('forward unknown 61min → MESSAGE_UNKNOWN_EXPIRED，不自动再转发', async () => {
    const { initId } = await seedEntry();
    let calls = 0;
    const d = deps({
      forward: async () => { calls++; throw new Error('timeout'); },
    });
    await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), d);
    expect(readCollabInitEntry(tempDir, APP, initId)!.chatId).toBe('oc_created');
    clock = 61 * 60 * 1000;
    const resumed = await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), d);
    expect(calls).toBe(1);
    expect(resumed.kind).toBe('collab-handled');
    if (resumed.kind === 'collab-handled') expect(resumed.status).toBe('awaiting_input');
    const entry = readCollabInitEntry(tempDir, APP, initId)!;
    expect(entry.state).toBe('awaiting-input');
    expect(entry.awaiting?.reason).toBe('MESSAGE_UNKNOWN_EXPIRED');
    expect(entry.operations[collabForwardUuid(initId)].status).toBe('unknown');
  });

  it('取消时已有第二个 S1 排在 mutex 后 → 不再 forward，迟到结果只留审计', async () => {
    const { initId } = await seedEntry();
    let release!: () => void;
    const blocker = new Promise<void>(r => { release = r; });
    let markStarted!: () => void;
    const firstStarted = new Promise<void>(r => { markStarted = r; });
    let calls = 0;
    const d = deps({
      forward: async () => {
        calls++;
        markStarted();
        await blocker;
        return 'om_late_forward';
      },
    });
    const first = runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), d);
    await firstStarted;
    const second = runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), d);
    await patchCollabInitEntry({
      dataDir: tempDir, creatorAppId: APP, initId,
      mutate: (entry) => { entry.state = 'cancelled'; entry.cancelReason = 'human cancel'; return true; },
    });
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    const entry = readCollabInitEntry(tempDir, APP, initId)!;
    expect(entry.state).toBe('cancelled');
    expect(entry.operations[collabForwardUuid(initId)].status).toBe('done');
    expect(readCollabGate(tempDir, 'oc_created')?.phase).toBe('cancelled');
  });

  it('creatorAdmissionReceipt 持久化后崩溃重投不二次扣费（persist→已存在短路）', async () => {
    const { initId } = await seedEntry();
    const rec = receipt();
    await persistCreatorAdmissionReceipt({ dataDir: tempDir, creatorAppId: APP, initId, receipt: rec, now: now() });
    // 恢复路径：entry 已有 receipt → 跳过扣费直接进 S1（此处由调用方保证，本测试验证 receipt 已持久）
    const entry = readCollabInitEntry(tempDir, APP, initId)!;
    expect(entry.creatorAdmissionReceipt).toBeTruthy();
    expect((entry.creatorAdmissionReceipt as any).operationId).toBe(rec.operationId);
  });
});

describe('gate store', () => {
  it('write/read/patch，patch revision+1', async () => {
    const gate = { schemaVersion: 1, initId: 'i', configVersion: 'cv', creatorAppId: APP, chatId: 'oc_g', phase: 'initializing' as const, participants: { a: { roleReady: false, kickoffState: 'pending' as const, acceptingUserTasks: false } }, revision: 0 };
    const { writeCollabGate, patchCollabGate } = await import('../src/services/collab-gate-store.js');
    writeCollabGate(tempDir, gate);
    expect(existsSync(collabGateFilePath(tempDir, 'oc_g'))).toBe(true);
    const read = readCollabGate(tempDir, 'oc_g')!;
    expect(read.revision).toBe(0);
    const patched = patchCollabGate(tempDir, 'oc_g', g => ({ ...g, phase: 'active' }));
    expect(patched!.revision).toBe(1);
    expect(readCollabGate(tempDir, 'oc_g')!.phase).toBe('active');
    // 0600
    const { statSync } = await import('node:fs');
    const mode = statSync(collabGateFilePath(tempDir, 'oc_g')).mode & 0o777;
    expect(mode === 0o600 || mode === 0o400).toBe(true);
  });
});

describe('init-store patch 原语', () => {
  it('advanceCollabStep / writeCollabOperation 同文件原子写且可读回', async () => {
    const { initId } = await seedEntry();
    const { advanceCollabStep, writeCollabOperation } = await import('../src/services/collab-init-store.js');
    await advanceCollabStep({ dataDir: tempDir, creatorAppId: APP, initId, step: 'create', status: 'running', now: now() });
    await writeCollabOperation({ dataDir: tempDir, creatorAppId: APP, initId, opKey: 'op1', now: now(), op: { kind: 'create', status: 'attempting', payloadHash: 'h1' } });
    const entry = readCollabInitEntry(tempDir, APP, initId)!;
    expect(entry.steps.create.status).toBe('running');
    expect(entry.operations['op1'].status).toBe('attempting');
  });
});

// ─── R1/R2/R5/R6 缺陷修复用例 ───

describe('R1：receipt 落盘失败不进 S1', () => {
  it('persistCreatorAdmissionReceipt 返回 false 时（模拟写盘失败）不进 S1', async () => {
    const { initId } = await seedEntry();
    // 直接 mock patch 失败：把 init-store 的 writeStore 触发异常。这里用不存在的 dataDir 模拟。
    const rec = receipt();
    const ok = await persistCreatorAdmissionReceipt({ dataDir: '/nonexistent/dir', creatorAppId: APP, initId, receipt: rec, now: now() });
    expect(ok).toBe(false);
    // 此时不应进 S1（由 daemon 短路，此处验证 persist 的返回语义）
  });

  it('persist 成功返回 true 且读回一致', async () => {
    const { initId } = await seedEntry();
    const rec = receipt();
    const ok = await persistCreatorAdmissionReceipt({ dataDir: tempDir, creatorAppId: APP, initId, receipt: rec, now: now() });
    expect(ok).toBe(true);
  });
});

describe('R2：chatId 已落但 create op 未 done → 补齐不二次 create', () => {
  it('预置 chatId + create op=attempting + 时钟 10h1m → 不二次 create，直接补齐 done', async () => {
    const { initId } = await seedEntry();
    // 预置 chatId 且 create op 状态为 attempting（崩溃于「落 chatId 后、写 done 前」）
    const createUuid = collabCreateUuid(initId, 0);
    await patchCollabInitEntryForTest(tempDir, APP, initId, (e) => {
      e.chatId = 'oc_preset';
      e.operations[createUuid] = { kind: 'create', status: 'attempting', uuid: createUuid, firstAttemptAt: 1, payloadHash: collabPayloadHash({ initId, createAttempt: 0, name: '' }) };
      return true;
    });
    // 时钟拨到 10h+1m（超窗）
    clock = 10 * 60 * 60 * 1000 + 60 * 1000;
    const beforeCalls = chatCreateCalls.length;
    const r = await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), deps());
    expect(r.kind).toBe('collab-handled');
    // 不二次 create（chatId 已存在短路）
    expect(chatCreateCalls.length).toBe(beforeCalls);
    const entry = readCollabInitEntry(tempDir, APP, initId)!;
    expect(entry.operations[createUuid].status).toBe('done');
    expect(entry.chatId).toBe('oc_preset');
  });

  it('create unknown 超窗 → awaiting-input(CREATE_UNKNOWN_EXPIRED) 不自动重建', async () => {
    const { initId } = await seedEntry();
    const createUuid = collabCreateUuid(initId, 0);
    await patchCollabInitEntryForTest(tempDir, APP, initId, (e) => {
      e.operations[createUuid] = { kind: 'create', status: 'unknown', uuid: createUuid, firstAttemptAt: 1, payloadHash: collabPayloadHash({ initId, createAttempt: 0, name: '' }), error: 'timeout' };
      return true;
    });
    clock = 10 * 60 * 60 * 1000 + 60 * 1000;
    const beforeCalls = chatCreateCalls.length;
    const r = await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), deps());
    expect(r.kind).toBe('collab-handled');
    if (r.kind === 'collab-handled') expect(r.status).toBe('awaiting_input');
    expect(chatCreateCalls.length).toBe(beforeCalls); // 不自动重建
    const entry = readCollabInitEntry(tempDir, APP, initId)!;
    expect(entry.state).toBe('awaiting-input');
    expect(entry.awaiting?.reason).toBe('CREATE_UNKNOWN_EXPIRED');
  });

  it('F3：create op=attempting 崩溃超窗 → awaiting-input，不自动重建', async () => {
    const { initId } = await seedEntry();
    const createUuid = collabCreateUuid(initId, 0);
    // attempting 已落盘、firstAttemptAt 存在、无 chatId
    await patchCollabInitEntryForTest(tempDir, APP, initId, (e) => {
      e.operations[createUuid] = { kind: 'create', status: 'attempting', uuid: createUuid, firstAttemptAt: 1, payloadHash: collabPayloadHash({ initId, createAttempt: 0, name: '' }) };
      return true;
    });
    clock = 10 * 60 * 60 * 1000 + 60 * 1000;
    const beforeCalls = chatCreateCalls.length;
    const r = await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), deps());
    expect(r.kind).toBe('collab-handled');
    if (r.kind === 'collab-handled') expect(r.status).toBe('awaiting_input');
    expect(chatCreateCalls.length).toBe(beforeCalls); // 不自动重建
    const entry = readCollabInitEntry(tempDir, APP, initId)!;
    expect(entry.state).toBe('awaiting-input');
    expect(entry.awaiting?.reason).toBe('CREATE_UNKNOWN_EXPIRED');
  });

  it('F4：已有 chatId 但 op 未 done 且 hash 冲突 → failed（补账前核对 payloadHash）', async () => {
    const { initId } = await seedEntry();
    const createUuid = collabCreateUuid(initId, 0);
    // 预置 chatId + create op=attempting 但 payloadHash 故意写错（冲突）
    await patchCollabInitEntryForTest(tempDir, APP, initId, (e) => {
      e.chatId = 'oc_preset';
      e.operations[createUuid] = { kind: 'create', status: 'attempting', uuid: createUuid, firstAttemptAt: 1, payloadHash: 'WRONG_HASH' };
      return true;
    });
    const r = await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), deps());
    expect(r.kind).toBe('collab-handled');
    if (r.kind === 'collab-handled') expect(r.status).toBe('failed');
    const entry = readCollabInitEntry(tempDir, APP, initId)!;
    expect(entry.state).toBe('failed');
    // 不补账成 done（hash 冲突拒绝）
    expect(entry.operations[createUuid].status).toBe('attempting');
  });
});

describe('R5：payloadHash 判重完整（含 origin*，done 也拒绝冲突）', () => {
  it('register done 但换 owner/source/receipt 再调 → 报冲突', async () => {
    const { initId } = await seedEntry();
    await runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), deps());
    // 换 owner/receipt 再调（同 initId，但冻结身份变了）
    const badData = {
      sender: { sender_id: { open_id: 'ou_other_owner' }, sender_type: 'user' },
      message: { message_id: SRC, chat_id: DM, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
    };
    const r = await runCollabGroupBirthS1(badData, ctx(SRC), initId, receipt({ originReason: 'none', originQuotaKey: undefined }), deps());
    expect(r.kind).toBe('collab-handled');
    if (r.kind === 'collab-handled') expect(r.status).toBe('failed'); // register conflict → failed
    const entry = readCollabInitEntry(tempDir, APP, initId)!;
    expect(entry.state).toBe('failed');
  });

  it('sourceMessageId mismatch → failed（冻结请求身份校验）', async () => {
    const { initId } = await seedEntry();
    const badCtx = { ...ctx('om_different_source'), chatId: DM };
    const r = await runCollabGroupBirthS1(data('om_different_source'), badCtx, initId, receipt(), deps());
    expect(r.kind).toBe('collab-handled');
    if (r.kind === 'collab-handled') expect(r.status).toBe('failed');
  });
});

describe('R6：S1 并发重入无重复外部副作用', () => {
  it('并发两执行者 → create/register/forward 各一次', async () => {
    const { initId } = await seedEntry();
    // createChat 带一个真实异步延迟，制造并发窗口；mutex 串行化后第二个执行者读已 done 的
    // operation 而跳过，外部副作用各一次。
    const slowCreate = async (_appId: string, opts: CollabS1CreateChatOpts) => {
      await new Promise(r => setTimeout(r, 10));
      chatCreateCalls.push({ data: { bot_id_list: opts.botIds, user_id_list: opts.userIds, chat_mode: opts.chatMode }, params: { uuid: opts.uuid } });
      return { chatId: 'oc_created', invalidBotIds: [], invalidUserIds: [] };
    };
    const d = deps({ createChat: slowCreate });
    const [r1, r2] = await Promise.all([
      runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), d),
      runCollabGroupBirthS1(data(SRC), ctx(SRC), initId, receipt(), d),
    ]);
    expect(r1.kind).toBe('collab-handled');
    expect(r2.kind).toBe('collab-handled');
    expect(chatCreateCalls).toHaveLength(1); // create 只一次
    expect(registeredGroups).toHaveLength(1); // register 只一次
    expect(forwarded).toHaveLength(1); // forward 只一次
  });
});

// 测试 helper：直接 patch entry
async function patchCollabInitEntryForTest(
  dataDir: string, creatorAppId: string, initId: string,
  mutate: (e: any) => boolean,
): Promise<void> {
  const { patchCollabInitEntry } = await import('../src/services/collab-init-store.js');
  await patchCollabInitEntry({ dataDir, creatorAppId, initId, mutate });
}
