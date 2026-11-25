/**
 * S2-S5 编排本体（PR-3b-2）：invite/grants/roles/kickoff 依赖启动。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runS2Invites,
  runS3Grants,
  runS4Roles,
  runS5Kickoff,
  reverifyCollabRoleAndConfig,
  type S2S5Deps,
} from '../src/core/collab-orchestrator-s2s5.js';
import {
  placeCollabGroupInit,
  readCollabInitEntry,
  patchCollabInitEntry,
  __testOnly_resetCollabInitMutexes,
} from '../src/services/collab-init-store.js';
import { collabInitId, collabSourceKey, collabCreatorAdmissionOperationId, type SessionGroupCollaborationConfig } from '../src/services/collab-group-config.js';
import type { ArtifactReadyFacts } from '../src/core/collab-artifact-ready.js';
import { DEFAULT_ARTIFACT_MARKER } from '../src/services/collab-group-config.js';
import type { RoleVerifyDeps } from '../src/core/collab-role-verify.js';
import { buildInitialCollabGate, readCollabGate, writeCollabGate } from '../src/services/collab-gate-store.js';

let dataDir: string;
let clock = 0;
const now = () => ++clock;
const CREATOR = 'cli_creator';
const PEER = 'cli_peer';
const CHAT = 'oc_chat';
const DM = 'oc_dm';
const SRC = 'om_src';

function config(kickoff: any[] = [{ appId: CREATOR, trigger: 'immediate' as const }]): SessionGroupCollaborationConfig {
  return {
    enabled: true,
    agents: [{ appId: CREATOR, roleMode: 'no-chat-role' }, { appId: PEER, roleMode: 'no-chat-role' }],
    kickoff,
  };
}

function roleDeps(overrides: Partial<RoleVerifyDeps> = {}): RoleVerifyDeps {
  return {
    dataDir,
    now,
    readTeamRole: () => null,
    writeRole: () => {},
    deleteRole: () => {},
    readRole: () => ({ kind: 'missing' as const }),
    ...overrides,
  };
}

function deps(overrides: Partial<S2S5Deps> = {}): S2S5Deps {
  return {
    dataDir,
    now,
    listMembers: async () => [CREATOR],
    addBotToChat: async () => {},
    triggerGrant: async () => ({ ok: true }),
    roleVerify: roleDeps(),
    kickoffPrepare: async () => ({ ok: true }),
    kickoffStart: async () => ({ ok: true, sessionId: 's', turnId: 't', acceptedAt: '2026-01-01T00:00:00Z' }),
    artifactFacts: async () => ({ terminalStatus: 'succeeded', delivered: true, messageId: 'om', content: `${DEFAULT_ARTIFACT_MARKER} https://example.com/x.zip`, sessionId: 'sess_up', turnId: 'turn_up', contentHash: 'hash_up' }),
    ...overrides,
  };
}

async function seedEntry(initId?: string) {
  const sourceKey = collabSourceKey(CREATOR, DM, SRC);
  const id = initId ?? collabInitId(sourceKey);
  await placeCollabGroupInit({
    dataDir, creatorAppId: CREATOR, dmChatId: DM, sourceKey, initId: id, sourceMessageId: SRC,
    configVersion: 'cv', configSnapshot: config(), creatorAdmissionOperationId: collabCreatorAdmissionOperationId(id),
    resolvedProfileEntries: { [CREATOR]: 'role', [PEER]: 'role', cli_b: 'role', cli_c: 'role', cli_p1: 'role', cli_p2: 'role' },
    referencedTeamRoles: { [CREATOR]: null, [PEER]: null, cli_b: null, cli_c: null, cli_p1: null, cli_p2: null },
    sourceSenderOpenId: 'ou_owner',
    createAttempt: 0, now: now(),
  });
  return id;
}

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'collab-s2s5-')); clock = 0; __testOnly_resetCollabInitMutexes(); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); __testOnly_resetCollabInitMutexes(); });

describe('S2 invite', () => {
  it('缺员重发 + done 不重复', async () => {
    const initId = await seedEntry();
    const calls: string[] = [];
    const d = deps({ listMembers: async () => [CREATOR], addBotToChat: async (_a, _c, bot) => { calls.push(bot); } });
    await runS2Invites({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, peers: [{ appId: PEER }], deps: d });
    expect(calls).toEqual([PEER]);
    // 二次执行 done 不重复
    await runS2Invites({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, peers: [{ appId: PEER }], deps: d });
    expect(calls).toEqual([PEER]);
    const entry = readCollabInitEntry(dataDir, CREATOR, initId)!;
    expect(entry.operations[`invite:${PEER}`].status).toBe('done');
  });

  it('N1：首 peer 邀请中取消 → 第二 peer 不调用 addBotToChat', async () => {
    const initId = await seedEntry();
    const calls: string[] = [];
    const d = deps({
      listMembers: async () => [CREATOR], // 两个 peer 都缺员
      addBotToChat: async (_a, _c, bot) => {
        calls.push(bot);
        if (bot === 'cli_b') {
          // B 邀请中写 cancelled
          await patchCollabInitEntry({ dataDir, creatorAppId: CREATOR, initId, mutate: (e) => { e.state = 'cancelled'; return true; } });
        }
      },
    });
    await runS2Invites({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, peers: [{ appId: 'cli_b' }, { appId: 'cli_c' }], deps: d });
    expect(calls).toEqual(['cli_b']); // C 不再调用
  });
  it('并发同 initId 重入 → invite 外部调用只发生一次', async () => {
    const initId = await seedEntry();
    let calls = 0;
    let release!: () => void;
    const blocker = new Promise<void>(r => { release = r; });
    let markStarted!: () => void;
    const firstStarted = new Promise<void>(r => { markStarted = r; });
    const d = deps({
      listMembers: async () => [CREATOR],
      addBotToChat: async () => { calls++; markStarted(); await blocker; },
    });
    const first = runS2Invites({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, peers: [{ appId: PEER }], deps: d });
    await firstStarted;
    const second = runS2Invites({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, peers: [{ appId: PEER }], deps: d });
    try {
      await new Promise(r => setTimeout(r, 0));
      expect(calls).toBe(1);
    } finally {
      release();
    }
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });
});

describe('S3 grants', () => {
  it('peer 离线阻塞可见（ready=false）', async () => {
    const initId = await seedEntry();
    const r = await runS3Grants({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, peers: [{ appId: PEER }], deps: deps({ triggerGrant: async () => ({ ok: false, message: 'peer offline' }) }) });
    expect(r[0].ready).toBe(false);
    expect(r[0].message).toBe('peer offline');
  });
  it('并发同 initId 重入 → grant 外部调用只发生一次', async () => {
    const initId = await seedEntry();
    let calls = 0;
    let release!: () => void;
    const blocker = new Promise<void>(r => { release = r; });
    let markStarted!: () => void;
    const firstStarted = new Promise<void>(r => { markStarted = r; });
    const d = deps({
      triggerGrant: async () => { calls++; markStarted(); await blocker; return { ok: true }; },
    });
    const first = runS3Grants({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, peers: [{ appId: PEER }], deps: d });
    await firstStarted;
    const second = runS3Grants({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, peers: [{ appId: PEER }], deps: d });
    try {
      await new Promise(r => setTimeout(r, 0));
      expect(calls).toBe(1);
    } finally {
      release();
    }
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });
});

describe('S4 roles', () => {
  it('冲突 → awaiting-input(ROLE_CONFLICT)', async () => {
    const initId = await seedEntry();
    // 角色冲突：readable 但内容不同
    const rd = roleDeps({ readRole: () => ({ kind: 'readable', content: '不同内容' }) });
    const r = await runS4Roles({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: config(), peers: [{ appId: PEER }], deps: deps({ roleVerify: rd }) });
    expect(r.allReady).toBe(false);
    expect(r.conflict).toBeTruthy();
    const entry = readCollabInitEntry(dataDir, CREATOR, initId)!;
    expect(entry.state).toBe('awaiting-input');
    expect(entry.awaiting?.reason).toBe('ROLE_CONFLICT');
  });
  it('取消落在首个 role operation 写入窗口 → 不写第二 peer，不推进 gate', async () => {
    const initId = await seedEntry();
    const cfg: SessionGroupCollaborationConfig = {
      enabled: true,
      roleProfileId: 'profile',
      agents: [CREATOR, 'cli_p1', 'cli_p2'].map(appId => ({ appId, roleMode: 'profile' })),
      kickoff: [CREATOR, 'cli_p1', 'cli_p2'].map(appId => ({ appId, trigger: 'immediate' })),
    };
    writeCollabGate(dataDir, buildInitialCollabGate({
      initId, configVersion: 'cv', creatorAppId: CREATOR, chatId: CHAT,
      participantAppIds: [CREATOR, 'cli_p1', 'cli_p2'],
    }));
    const files = new Map<string, string>();
    const writes: string[] = [];
    const rd = roleDeps({
      writeRole: (appId, _chat, content) => { writes.push(appId); files.set(appId, content); },
      readRole: (appId) => files.has(appId) ? { kind: 'readable', content: files.get(appId)! } : { kind: 'missing' },
    });
    const cancelled = Promise.resolve().then(() => patchCollabInitEntry({
      dataDir, creatorAppId: CREATOR, initId,
      mutate: (e) => { e.state = 'cancelled'; return true; },
    }));
    const r = await runS4Roles({
      dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg,
      peers: [{ appId: 'cli_p1' }, { appId: 'cli_p2' }], deps: deps({ roleVerify: rd }),
    });
    await cancelled;
    expect(r.allReady).toBe(false);
    expect(r.conflict).toBe('cancelled');
    expect(writes).toEqual(['cli_p1']);
    const gate = readCollabGate(dataDir, CHAT)!;
    expect(gate.participants.cli_p1.roleReady).toBe(false);
    expect(gate.participants.cli_p2.roleReady).toBe(false);
  });
});

describe('S5 kickoff 依赖启动', () => {
  it('afterAgentTurn 五条件缺一不启动（terminal 非 succeeded）', async () => {
    const initId = await seedEntry();
    const cfg = config([
      { appId: CREATOR, trigger: 'immediate' },
      { appId: PEER, trigger: 'afterAgentTurn', afterAppId: CREATOR, artifact: { type: 'marked-url', hosts: ['example.com'] } },
    ]);
    const starts: string[] = [];
    const d = deps({ kickoffStart: async (appId) => { starts.push(appId); return { ok: true, sessionId: 's', turnId: 't', acceptedAt: '2026-01-01T00:00:00Z' }; }, artifactFacts: async () => ({ terminalStatus: 'failed', delivered: false, messageId: '', content: '' } as ArtifactReadyFacts) });
    const r = await runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d });
    expect(r.done).toBe(false);
    expect(r.awaitingInput).toContain('artifact not ready');
    // PEER（afterAgentTurn）不应启动
    expect(starts).not.toContain(PEER);
  });

  it('immediate 按拓扑序启动 creator', async () => {
    const initId = await seedEntry();
    const cfg = config([{ appId: CREATOR, trigger: 'immediate' }]);
    const starts: string[] = [];
    const d = deps({ kickoffStart: async (appId) => { starts.push(appId); return { ok: true, sessionId: 's', turnId: 't', acceptedAt: '2026-01-01T00:00:00Z' }; } });
    const r = await runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d });
    expect(r.done).toBe(true);
    expect(starts).toContain(CREATOR);
  });

  it('R2：artifact 缺三元组/hash → 拒绝启动下一跳', async () => {
    const initId = await seedEntry();
    const cfg = config([
      { appId: CREATOR, trigger: 'immediate' },
      { appId: PEER, trigger: 'afterAgentTurn', afterAppId: CREATOR, artifact: { type: 'marked-url', hosts: ['example.com'] } },
    ]);
    const starts: string[] = [];
    const d = deps({ kickoffStart: async (appId) => { starts.push(appId); return { ok: true, sessionId: 's', turnId: 't', acceptedAt: '2026-01-01T00:00:00Z' }; }, artifactFacts: async () => ({ terminalStatus: 'succeeded', delivered: true, messageId: 'om', content: `${DEFAULT_ARTIFACT_MARKER} https://example.com/x.zip` }) }); // 缺 sessionId/turnId/contentHash
    const r = await runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d });
    expect(r.done).toBe(false);
    expect(r.awaitingInput).toContain('proof incomplete');
    expect(starts).not.toContain(PEER);
  });

  it('R1：await 之后取消（cancelled）不推进外部副作用', async () => {
    const initId = await seedEntry();
    const cfg = config([{ appId: CREATOR, trigger: 'immediate' }]);
    const starts: string[] = [];
    // prepare 等待中写 cancelled
    const d = deps({
      kickoffStart: async (appId) => { starts.push(appId); return { ok: true, sessionId: 's', turnId: 't', acceptedAt: '2026-01-01T00:00:00Z' }; },
      kickoffPrepare: async () => {
        await patchCollabInitEntry({ dataDir, creatorAppId: CREATOR, initId, mutate: (e) => { e.state = 'cancelled'; return true; } });
        return { ok: true };
      },
    });
    const r = await runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d });
    expect(r.done).toBe(false);
    expect(starts).toEqual([]); // 取消后不 start
  });

  it('F2：NO_MARKER（成功但无 marker）→ awaiting-input（人工推进）', async () => {
    const initId = await seedEntry();
    const cfg = config([
      { appId: CREATOR, trigger: 'immediate' },
      { appId: PEER, trigger: 'afterAgentTurn', afterAppId: CREATOR, artifact: { type: 'marked-url', hosts: ['example.com'] } },
    ]);
    const starts: string[] = [];
    const d = deps({
      kickoffStart: async (appId) => { starts.push(appId); return { ok: true, sessionId: 's', turnId: 't', acceptedAt: '2026-01-01T00:00:00Z' }; },
      artifactFacts: async () => ({ terminalStatus: 'succeeded', delivered: true, messageId: 'om', content: 'no marker here', sessionId: 's', turnId: 't', contentHash: 'h' }),
    });
    const r = await runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d });
    expect(r.done).toBe(false);
    expect(r.awaitingInput).toContain('NO_MARKER');
    const entry = readCollabInitEntry(dataDir, CREATOR, initId)!;
    expect(entry.state).toBe('awaiting-input');
    // 常规重入仍被 guard 阻止（不自动继续）
    const r2 = await runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d });
    expect(r2.done).toBe(false);
    expect(starts).not.toContain(PEER);
  });

  it('N2 回归：terminal failed 写 awaiting-input（不保持 running）', async () => {
    const initId = await seedEntry();
    const cfg = config([
      { appId: CREATOR, trigger: 'immediate' },
      { appId: PEER, trigger: 'afterAgentTurn', afterAppId: CREATOR, artifact: { type: 'marked-url', hosts: ['example.com'] } },
    ]);
    const d = deps({ artifactFacts: async () => ({ terminalStatus: 'failed', delivered: false, messageId: '', content: '', sessionId: 's', turnId: 't', contentHash: 'h' }) });
    await runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d });
    const entry = readCollabInitEntry(dataDir, CREATOR, initId)!;
    expect(entry.state).toBe('awaiting-input');
    expect(entry.awaiting?.reason).toBe('ARTIFACT_FAILED');
  });
});

describe('reverifyCollabRoleAndConfig', () => {
  it('configVersion 变更 → 拒绝', async () => {
    const initId = await seedEntry();
    const r = reverifyCollabRoleAndConfig({ dataDir, larkAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv_v2', config: config(), roleVerify: roleDeps() });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('config_version_changed');
  });

  it('F1：awaiting-input / cancelled state → 拒绝', async () => {
    const initId = await seedEntry();
    const { patchCollabInitEntry } = await import('../src/services/collab-init-store.js');
    await patchCollabInitEntry({ dataDir, creatorAppId: CREATOR, initId, mutate: (e) => { e.state = 'awaiting-input'; e.awaiting = { reason: 'ROLE_CONFLICT', since: now() }; return true; } });
    const r = reverifyCollabRoleAndConfig({ dataDir, larkAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: config(), roleVerify: roleDeps() });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('awaiting_input');
  });
});

describe('F3：S5 幂等 + mutex', () => {
  it('重入 query 不重复 start（done 短路）', async () => {
    const initId = await seedEntry();
    const starts: string[] = [];
    const d = deps({ kickoffStart: async (appId) => { starts.push(appId); return { ok: true, sessionId: 's', turnId: 't', acceptedAt: '2026-01-01T00:00:00Z' }; } });
    const cfg = config([{ appId: CREATOR, trigger: 'immediate' }]);
    await runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d });
    await runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d });
    expect(starts).toEqual([CREATOR]); // 不重复 start
    const entry = readCollabInitEntry(dataDir, CREATOR, initId)!;
    expect(entry.operations[`kickoff:${CREATOR}`].status).toBe('done');
    expect(entry.steps.kickoff.status).toBe('done');
  });

  it('并发两执行者 → start 只一次（mutex 串行）', async () => {
    const initId = await seedEntry();
    const starts: string[] = [];
    // slow kickoffStart 制造并发窗口
    const slowStart = async (appId: string) => { await new Promise(r => setTimeout(r, 10)); starts.push(appId); return { ok: true, sessionId: 's', turnId: 't', acceptedAt: '2026-01-01T00:00:00Z' }; };
    const d = deps({ kickoffStart: slowStart });
    const cfg = config([{ appId: CREATOR, trigger: 'immediate' }]);
    const [r1, r2] = await Promise.all([
      runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d }),
      runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d }),
    ]);
    expect(r1.done).toBe(true);
    expect(r2.done).toBe(true);
    expect(starts).toEqual([CREATOR]); // start 只一次
  });
});

describe('F4：真拓扑序', () => {
  it('A→B→C 配置数组乱序（A immediate, C after B, B after A）仍按 A,B,C 启动', async () => {
    const initId = await seedEntry();
    const starts: string[] = [];
    const d = deps({ kickoffStart: async (appId) => { starts.push(appId); return { ok: true, sessionId: 's', turnId: 't', acceptedAt: '2026-01-01T00:00:00Z' }; } });
    // creator=CREATOR 是 A（immediate）；B=cli_b after A；C=cli_c after B。kickoff 数组故意乱序 [A, C, B]。
    const cfg: SessionGroupCollaborationConfig = {
      enabled: true,
      agents: [{ appId: CREATOR, roleMode: 'no-chat-role' }, { appId: 'cli_b', roleMode: 'no-chat-role' }, { appId: 'cli_c', roleMode: 'no-chat-role' }],
      kickoff: [
        { appId: CREATOR, trigger: 'immediate' },
        { appId: 'cli_c', trigger: 'afterAgentTurn', afterAppId: 'cli_b', artifact: { type: 'marked-url', hosts: ['example.com'] } },
        { appId: 'cli_b', trigger: 'afterAgentTurn', afterAppId: CREATOR, artifact: { type: 'marked-url', hosts: ['example.com'] } },
      ],
    };
    const r = await runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d });
    expect(r.done).toBe(true);
    // 拓扑序：CREATOR(A) → cli_b(B) → cli_c(C)，即便数组是 [A,C,B]
    expect(starts.indexOf(CREATOR)).toBeLessThan(starts.indexOf('cli_b'));
    expect(starts.indexOf('cli_b')).toBeLessThan(starts.indexOf('cli_c'));
  });

  it('pending 分支不饿死独立 immediate，且 pending since 不被其它分支重置', async () => {
    const initId = await seedEntry();
    const A = CREATOR, B = 'cli_b', C = 'cli_c';
    const cfg: SessionGroupCollaborationConfig = {
      enabled: true,
      agents: [A, B, C].map(appId => ({ appId, roleMode: 'no-chat-role' })),
      kickoff: [
        { appId: A, trigger: 'immediate' },
        { appId: B, trigger: 'afterAgentTurn', afterAppId: A, artifact: { type: 'marked-url', hosts: ['example.com'] } },
        { appId: C, trigger: 'immediate' },
      ],
    };
    const starts: string[] = [];
    let facts: ArtifactReadyFacts & { sessionId?: string; turnId?: string; contentHash?: string } = {
      terminalStatus: 'reconciling', delivered: false, content: '',
    };
    const d = deps({
      kickoffStart: async appId => {
        starts.push(appId);
        return { ok: true, sessionId: `s_${appId}`, turnId: `t_${appId}`, acceptedAt: '2026-01-01T00:00:00Z' };
      },
      artifactFacts: async () => facts,
    });
    const first = await runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d });
    expect(first.done).toBe(false);
    expect(starts).toEqual([A, C]);
    expect(readCollabInitEntry(dataDir, CREATOR, initId)!.steps.kickoff.status).toBe('pending');
    const since = readCollabInitEntry(dataDir, CREATOR, initId)!.kickoffPending?.[B]?.since;
    expect(typeof since).toBe('number');

    const second = await runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d });
    expect(second.done).toBe(false);
    expect(starts).toEqual([A, C]);
    expect(readCollabInitEntry(dataDir, CREATOR, initId)!.kickoffPending?.[B]?.since).toBe(since);

    facts = {
      terminalStatus: 'succeeded', delivered: true, messageId: 'om_artifact',
      content: `${DEFAULT_ARTIFACT_MARKER} https://example.com/result.zip`,
      sessionId: `s_${A}`, turnId: `t_${A}`, contentHash: 'artifact_hash',
    };
    const third = await runS5Kickoff({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: cfg, deps: d });
    expect(third.done).toBe(true);
    expect(starts).toEqual([A, C, B]);
    expect(readCollabInitEntry(dataDir, CREATOR, initId)!.steps.kickoff.status).toBe('done');
  });
});
