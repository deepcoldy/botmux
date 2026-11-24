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
  __testOnly_resetCollabInitMutexes,
} from '../src/services/collab-init-store.js';
import { collabInitId, collabSourceKey, collabCreatorAdmissionOperationId, type SessionGroupCollaborationConfig } from '../src/services/collab-group-config.js';
import type { ArtifactReadyFacts } from '../src/core/collab-artifact-ready.js';
import { DEFAULT_ARTIFACT_MARKER } from '../src/services/collab-group-config.js';
import type { RoleVerifyDeps } from '../src/core/collab-role-verify.js';

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
    readProfile: () => 'role',
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
    artifactFacts: async () => ({ terminalStatus: 'succeeded', delivered: true, messageId: 'om', content: `${DEFAULT_ARTIFACT_MARKER} https://example.com/x.zip` }),
    ...overrides,
  };
}

async function seedEntry(initId?: string) {
  const sourceKey = collabSourceKey(CREATOR, DM, SRC);
  const id = initId ?? collabInitId(sourceKey);
  await placeCollabGroupInit({
    dataDir, creatorAppId: CREATOR, dmChatId: DM, sourceKey, initId: id, sourceMessageId: SRC,
    configVersion: 'cv', configSnapshot: config(), creatorAdmissionOperationId: collabCreatorAdmissionOperationId(id),
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
});

describe('S3 grants', () => {
  it('peer 离线阻塞可见（ready=false）', async () => {
    const initId = await seedEntry();
    const r = await runS3Grants({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, peers: [{ appId: PEER }], deps: deps({ triggerGrant: async () => ({ ok: false, message: 'peer offline' }) }) });
    expect(r[0].ready).toBe(false);
    expect(r[0].message).toBe('peer offline');
  });
});

describe('S4 roles', () => {
  it('冲突 → awaiting-input(ROLE_CONFLICT)', async () => {
    const initId = await seedEntry();
    // 角色冲突：readable 但内容不同
    const rd = roleDeps({ readProfile: () => '你好', readRole: () => ({ kind: 'readable', content: '不同内容' }) });
    const r = await runS4Roles({ dataDir, creatorAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv', config: config(), peers: [{ appId: PEER }], deps: deps({ roleVerify: rd }) });
    expect(r.allReady).toBe(false);
    expect(r.conflict).toBeTruthy();
    const entry = readCollabInitEntry(dataDir, CREATOR, initId)!;
    expect(entry.state).toBe('awaiting-input');
    expect(entry.awaiting?.reason).toBe('ROLE_CONFLICT');
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
});

describe('reverifyCollabRoleAndConfig', () => {
  it('configVersion 变更 → 拒绝', async () => {
    const initId = await seedEntry();
    const r = reverifyCollabRoleAndConfig({ dataDir, larkAppId: CREATOR, chatId: CHAT, initId, configVersion: 'cv_v2', config: config(), roleVerify: roleDeps() });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('config_version_changed');
  });
});
