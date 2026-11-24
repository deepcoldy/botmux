/**
 * collab per-chat gate 准入（PR-3b-1 §8.1/§8.3）：checkCollabGateAdmission + 命令豁免白名单。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkCollabGateAdmission, collabCommandExempt } from '../src/core/collab-gate-admission.js';
import { classifySlash } from '../src/core/command-router.js';
import { buildInitialCollabGate, writeCollabGate, patchCollabGate } from '../src/services/collab-gate-store.js';
import { readCollabChatQueue } from '../src/services/collab-chat-queue-store.js';
import { placeCollabGroupInit, __testOnly_resetCollabInitMutexes } from '../src/services/collab-init-store.js';
import { collabInitId, collabSourceKey, collabCreatorAdmissionOperationId, type SessionGroupCollaborationConfig } from '../src/services/collab-group-config.js';
import type { CollabGateFile } from '../src/services/collab-group-config.js';
import type { TalkEvaluation } from '../src/im/lark/event-dispatcher.js';
import type { SlashRouteDecision } from '../src/core/command-router.js';

let dataDir: string;
const APP = 'cli_target';
const CHAT = 'oc_chat';
const CREATOR = 'cli_creator';

const allowedTalk: TalkEvaluation = { allowed: true, reason: 'chatGrant', quotaKey: 'chat:oc_chat:ou_u' } as TalkEvaluation;
const deniedTalk: TalkEvaluation = { allowed: false, reason: 'none' } as TalkEvaluation;

function gate(overrides: Partial<CollabGateFile> = {}): CollabGateFile {
  return {
    ...buildInitialCollabGate({ initId: 'i'.repeat(64), configVersion: 'cv', creatorAppId: CREATOR, chatId: CHAT, participantAppIds: [APP] }),
    ...overrides,
  };
}

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'collab-gate-admission-')); __testOnly_resetCollabInitMutexes(); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); __testOnly_resetCollabInitMutexes(); });

describe('checkCollabGateAdmission', () => {
  it('无 gate → not-collab', () => {
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk });
    expect(r.kind).toBe('not-collab');
  });

  it('本 bot 非 participant → not-collab', () => {
    const g = gate({ participants: { cli_other: { roleReady: false, kickoffState: 'pending', acceptingUserTasks: false } } });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g });
    expect(r.kind).toBe('not-collab');
  });

  it('acceptingUserTasks=true → open', () => {
    const g = gate({ phase: 'active', participants: { [APP]: { roleReady: true, kickoffState: 'started', acceptingUserTasks: true } } });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g });
    expect(r.kind).toBe('open');
  });

  it('未授权 → reject(not_allowed)', () => {
    const g = gate({ phase: 'initializing' });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: deniedTalk, gate: g });
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toBe('not_allowed');
  });

  it('initializing + gatePolicy=queue → queue（入队去重）', () => {
    const g = gate({ phase: 'initializing' });
    const enqueued: string[] = [];
    const enqueueImpl = (_d: string, _c: string, item: any) => { enqueued.push(item.sourceMessageId); return true; };
    const opts = { dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g, sourceMessageId: 'om_1', routingEvent: { text: 'hi' }, enqueueImpl, queuePositionImpl: () => 0 };
    const r1 = checkCollabGateAdmission(opts);
    expect(r1.kind).toBe('queue');
    expect(enqueued).toEqual(['om_1']);
  });

  it('initializing + gatePolicy=reject → reject', () => {
    const g = gate({ phase: 'initializing' });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g, config: { enabled: true, agents: [], kickoff: [], gatePolicy: 'reject' } as any });
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toBe('gate_not_open');
  });

  it('awaiting-input → awaiting-input', () => {
    const g = gate({ phase: 'awaiting-input' });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g });
    expect(r.kind).toBe('awaiting-input');
  });

  it('failed → awaiting-input（不新增排队）', () => {
    const g = gate({ phase: 'failed' });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g });
    expect(r.kind).toBe('awaiting-input');
  });

  it('cancelled → cancelled', () => {
    const g = gate({ phase: 'cancelled' });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g });
    expect(r.kind).toBe('cancelled');
  });
});

describe('collabCommandExempt 白名单（F1）', () => {
  it('special 豁免；sessionless 无副作用命令豁免', () => {
    expect(collabCommandExempt({ kind: 'special', cmd: '/sessions', content: '', handler: 'sessions' })).toBe(true);
    expect(collabCommandExempt({ kind: 'daemon', cmd: '/status', content: '', sessionPolicy: 'sessionless' })).toBe(true);
    expect(collabCommandExempt({ kind: 'daemon', cmd: '/models', content: '', sessionPolicy: 'sessionless' })).toBe(true);
  });

  it('forward 一律不豁免（含 bot_gated）', () => {
    expect(collabCommandExempt({ kind: 'forward', reason: 'bot_gated' })).toBe(false);
    expect(collabCommandExempt({ kind: 'forward', reason: 'unknown_slash', cmd: '/foo' })).toBe(false);
    expect(collabCommandExempt({ kind: 'forward', reason: 'no_slash' })).toBe(false);
    expect(collabCommandExempt({ kind: 'forward', reason: 'discussion' })).toBe(false);
  });

  it('sessionless 副作用命令不豁免（/resume /group /g /watch-comment）', () => {
    expect(collabCommandExempt({ kind: 'daemon', cmd: '/resume', content: '', sessionPolicy: 'sessionless' })).toBe(false);
    expect(collabCommandExempt({ kind: 'daemon', cmd: '/group', content: '', sessionPolicy: 'sessionless' })).toBe(false);
    expect(collabCommandExempt({ kind: 'daemon', cmd: '/g', content: '', sessionPolicy: 'sessionless' })).toBe(false);
    expect(collabCommandExempt({ kind: 'daemon', cmd: '/watch-comment', content: '', sessionPolicy: 'sessionless' })).toBe(false);
  });

  it('passthrough / delegated_turn / daemon(precreate|existing) 不豁免', () => {
    expect(collabCommandExempt({ kind: 'passthrough', cmd: '/goal', content: '', delivery: 'cold_start' })).toBe(false);
    expect(collabCommandExempt({ kind: 'delegated_turn', cmd: '/adopt', content: '', sessionPolicy: 'precreate' })).toBe(false);
    expect(collabCommandExempt({ kind: 'daemon', cmd: '/close', content: '', sessionPolicy: 'existing' })).toBe(false);
    expect(collabCommandExempt({ kind: 'daemon', cmd: '/t', content: '', sessionPolicy: 'precreate' })).toBe(false);
  });
});

describe('F1：真实 classifySlash → gate 用例', () => {
  const input = {
    cliId: 'claude-code',
    context: 'new-topic' as const,
    phase: 'none' as const,
    passthrough: new Set<string>(),
    coldStartPassthrough: new Set<string>(),
    senderIsBot: false,
    acceptSlashFromBots: false,
  };

  it('/resume 经 classifySlash 判定为 daemon(sessionless) 但副作用 → 不豁免', () => {
    const d = classifySlash({ ...input, text: '/resume' });
    expect(d.kind).toBe('daemon');
    if (d.kind === 'daemon') expect(d.sessionPolicy).toBe('sessionless');
    expect(collabCommandExempt(d)).toBe(false); // /resume 会重附 CLI
  });

  it('bot_gated（senderIsBot + acceptSlashFromBots=false + /models）→ forward(bot_gated) 不豁免', () => {
    const d = classifySlash({ ...input, text: '/models', senderIsBot: true, acceptSlashFromBots: false });
    expect(d.kind).toBe('forward');
    if (d.kind === 'forward') expect(d.reason).toBe('bot_gated');
    expect(collabCommandExempt(d)).toBe(false);
  });

  it('/models（真人）→ daemon(sessionless) 豁免', () => {
    const d = classifySlash({ ...input, text: '/models' });
    expect(d.kind).toBe('daemon');
    if (d.kind === 'daemon') expect(d.sessionPolicy).toBe('sessionless');
    expect(collabCommandExempt(d)).toBe(true);
  });

  it('/compact 是 passthrough（会注入 CLI）→ 不豁免，thread 命令 gate 会拦', () => {
    const d = classifySlash({ ...input, text: '/compact', passthrough: new Set(['/compact']) });
    expect(d.kind).toBe('passthrough');
    expect(collabCommandExempt(d)).toBe(false);
  });
});

describe('F2/F4：授权顺序与阶段优先级', () => {
  it('F2：cancelled 阶段即使 acceptingUserTasks=true 也返回 cancelled', () => {
    const g = gate({ phase: 'cancelled', participants: { [APP]: { roleReady: true, kickoffState: 'started', acceptingUserTasks: true } } });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g });
    expect(r.kind).toBe('cancelled');
  });

  it('F2：failed 阶段即使 acceptingUserTasks=true 也返回 awaiting-input', () => {
    const g = gate({ phase: 'failed', participants: { [APP]: { roleReady: true, kickoffState: 'started', acceptingUserTasks: true } } });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g });
    expect(r.kind).toBe('awaiting-input');
  });

  it('F4：denied talk + exempt 命令 → 仍 reject(not_allowed)（未授权不豁免）', () => {
    const g = gate({ phase: 'initializing' });
    const r = checkCollabGateAdmission({
      dataDir, chatId: CHAT, botAppId: APP, talk: deniedTalk, gate: g,
      slashDecision: { kind: 'special', cmd: '/sessions', content: '', handler: 'sessions' },
    });
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toBe('not_allowed');
  });

  it('F1：gatePolicy 从冻结 configSnapshot 读（creator reject + peer 无 config）', async () => {
    const initId = collabInitId(collabSourceKey(CREATOR, 'oc_dm', 'om_src'));
    // seed creator 的 collab-group-init entry，configSnapshot 里 gatePolicy=reject
    const rejectConfig: SessionGroupCollaborationConfig = { enabled: true, agents: [{ appId: APP, roleMode: 'no-chat-role' }], kickoff: [{ appId: APP, trigger: 'immediate' }], gatePolicy: 'reject' };
    await placeCollabGroupInit({
      dataDir, creatorAppId: CREATOR, dmChatId: 'oc_dm', sourceKey: collabSourceKey(CREATOR, 'oc_dm', 'om_src'), initId,
      sourceMessageId: 'om_src', configVersion: 'cv', configSnapshot: rejectConfig,
      creatorAdmissionOperationId: collabCreatorAdmissionOperationId(initId), createAttempt: 0, now: Date.now(),
    });
    const g = gate({ phase: 'initializing', creatorAppId: CREATOR, initId });
    // 不传 config（peer 无 collaboration 配置），应从冻结快照读 gatePolicy=reject。
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g, sourceMessageId: 'om_1', routingEvent: { content: 'hi' } });
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toBe('gate_not_open');
  });
});

describe('F3：queue 位置/去重/缺失 sourceMessageId', () => {
  it('queue 无 sourceMessageId → 不返回 queue（reject）', () => {
    const g = gate({ phase: 'initializing' });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g });
    expect(r.kind).toBe('reject');
  });

  it('同 (targetAppId, sourceMessageId) 重复投递返回原位置', () => {
    const g = gate({ phase: 'initializing' });
    const enqueued: string[] = [];
    const enqueueImpl = (_d: string, _c: string, item: any) => { enqueued.push(item.sourceMessageId); return true; };
    const queuePositionImpl = (_d: string, _c: string, _target: string, smid: string) => (enqueued.indexOf(smid) + 1) || 0;
    const opts = { dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g, sourceMessageId: 'om_1', routingEvent: { text: 'hi' }, enqueueImpl, queuePositionImpl };
    const r1 = checkCollabGateAdmission(opts);
    expect(r1.kind).toBe('queue');
    // 已入队后 positionImpl 返回 1，重复投递返回原位置
    const r2 = checkCollabGateAdmission(opts);
    expect(r2.kind).toBe('queue');
    if (r2.kind === 'queue') expect(r2.position).toBe(1);
    expect(enqueued).toEqual(['om_1']); // 只入队一次
  });

  it('enqueue 失败（返回 false）→ 不宣称成功', () => {
    const g = gate({ phase: 'initializing' });
    const r = checkCollabGateAdmission({
      dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g,
      sourceMessageId: 'om_1',
      routingEvent: { text: 'hi' },
      enqueueImpl: () => false,
      queuePositionImpl: () => 0,
    });
    expect(r.kind).toBe('reject');
  });

  it('R1：缺 routingEvent → reject（不返回 queue）', () => {
    const g = gate({ phase: 'initializing' });
    const r = checkCollabGateAdmission({
      dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g,
      sourceMessageId: 'om_1',
      enqueueImpl: () => true,
      queuePositionImpl: () => 0,
      // 不传 routingEvent
    });
    expect(r.kind).toBe('reject');
  });
});

describe('R1/R2：真实 store 持久化契约', () => {
  it('R1：真实 enqueueCollabChatItem 持久化 routingEvent 可回读', () => {
    const g = gate({ phase: 'initializing' });
    // 用真实 store（不注入 enqueueImpl/queuePositionImpl）
    const r = checkCollabGateAdmission({
      dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g,
      sourceMessageId: 'om_1',
      routingEvent: { text: 'hello', sender: 'ou_u' },
    });
    expect(r.kind).toBe('queue');
    const q = readCollabChatQueue(dataDir, CHAT, APP);
    expect(q.items).toHaveLength(1);
    expect(q.items[0].routingEvent).toEqual({ text: 'hello', sender: 'ou_u' }); // 可序列化回读
  });

  it('N1：两个 target 各自独立队列文件，各留一条记录互不影响', () => {
    const g = gate({ phase: 'initializing', participants: { cli_a: { roleReady: false, kickoffState: 'pending', acceptingUserTasks: false }, cli_b: { roleReady: false, kickoffState: 'pending', acceptingUserTasks: false } } });
    const rA = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: 'cli_a', talk: allowedTalk, gate: g, sourceMessageId: 'om_shared', routingEvent: { text: 'a' } });
    const rB = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: 'cli_b', talk: allowedTalk, gate: g, sourceMessageId: 'om_shared', routingEvent: { text: 'b' } });
    expect(rA.kind).toBe('queue');
    expect(rB.kind).toBe('queue');
    // 各自独立文件
    const qa = readCollabChatQueue(dataDir, CHAT, 'cli_a');
    const qb = readCollabChatQueue(dataDir, CHAT, 'cli_b');
    expect(qa.items).toHaveLength(1);
    expect(qb.items).toHaveLength(1);
    expect(qa.items[0].targetAppId).toBe('cli_a');
    expect(qb.items[0].targetAppId).toBe('cli_b');
  });

  it('N1：同 target 同 source 幂等，不同 target 同 source 各自保留', () => {
    const g = gate({ phase: 'initializing', participants: { cli_a: { roleReady: false, kickoffState: 'pending', acceptingUserTasks: false }, cli_b: { roleReady: false, kickoffState: 'pending', acceptingUserTasks: false } } });
    checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: 'cli_a', talk: allowedTalk, gate: g, sourceMessageId: 'om_1', routingEvent: { text: 'a' } });
    checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: 'cli_b', talk: allowedTalk, gate: g, sourceMessageId: 'om_1', routingEvent: { text: 'b' } });
    // 同 target 同 source 重投幂等（不新增）
    checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: 'cli_a', talk: allowedTalk, gate: g, sourceMessageId: 'om_1', routingEvent: { text: 'a' } });
    expect(readCollabChatQueue(dataDir, CHAT, 'cli_a').items).toHaveLength(1);
    expect(readCollabChatQueue(dataDir, CHAT, 'cli_b').items).toHaveLength(1);
  });
});
