/**
 * S4 角色严格回读（§6）：runCollabRoleVerification + gate roleReady + 队列骨架。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCollabRoleVerification, markGateRoleReady, type RoleVerifyDeps } from '../src/core/collab-role-verify.js';
import { buildInitialCollabGate, writeCollabGate, readCollabGate } from '../src/services/collab-gate-store.js';
import { enqueueCollabChatItem, readCollabChatQueue } from '../src/services/collab-chat-queue-store.js';
import type { SessionGroupCollaborationConfig } from '../src/services/collab-group-config.js';
import type { StrictRoleRead } from '../src/core/role-resolver.js';

let dataDir: string;
const APP = 'cli_creator';
const CHAT = 'oc_chat';

function config(agents: any[] = [{ appId: APP, roleMode: 'no-chat-role' }]): SessionGroupCollaborationConfig {
  return { enabled: true, agents: agents as any, kickoff: agents.map(a => ({ appId: a.appId, trigger: 'immediate' as const })) };
}

function deps(overrides: Partial<RoleVerifyDeps> = {}): RoleVerifyDeps {
  return {
    dataDir,
    now: () => Date.now(),
    readProfile: () => '你好',
    writeRole: () => {},
    readRole: () => ({ kind: 'missing' as const }),
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'collab-role-verify-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('runCollabRoleVerification', () => {
  it('no-chat-role 且本群无覆盖 → 就绪', () => {
    const r = runCollabRoleVerification(APP, CHAT, config(), deps({ readRole: () => ({ kind: 'missing' }) }));
    expect(r.ready).toBe(true);
  });

  it('profile + 非空：写后回读 hash 一致 → 就绪', () => {
    let written = '';
    const r = runCollabRoleVerification(APP, CHAT, config([{ appId: APP, profileId: 'p1' }]), deps({
      readProfile: () => '你好',
      writeRole: (_a, _c, content) => { written = content; },
      readRole: () => ({ kind: 'readable', content: written || '你好' }),
    }));
    expect(r.ready).toBe(true);
    expect(r.records[0].verified).toBe(true);
    expect(r.records[0].expectedSource).toBe('chat');
  });

  it('profile + 非空：回读 hash 不一致 → 冲突（ROLE_CONFLICT）', () => {
    const r = runCollabRoleVerification(APP, CHAT, config([{ appId: APP, profileId: 'p1' }]), deps({
      readProfile: () => '你好',
      readRole: () => ({ kind: 'readable', content: '完全不同' }),
    }));
    expect(r.ready).toBe(false);
    expect(r.conflict).toBeTruthy();
  });

  it('profile + null → S4 失败（不启动）', () => {
    const r = runCollabRoleVerification(APP, CHAT, config([{ appId: APP, profileId: 'p_missing' }]), deps({
      readProfile: () => null,
    }));
    expect(r.ready).toBe(false);
    expect(r.conflict).toContain('条目缺失');
  });

  it('已是期望状态 → 幂等成功（不重复写）', () => {
    let writes = 0;
    const r = runCollabRoleVerification(APP, CHAT, config([{ appId: APP, profileId: 'p1' }]), deps({
      readProfile: () => '你好',
      writeRole: () => { writes++; },
      readRole: () => ({ kind: 'readable', content: '你好' }),
    }));
    expect(r.ready).toBe(true);
    expect(writes).toBe(0); // 已是期望状态，不写
  });
});

describe('gate roleReady + 队列骨架', () => {
  it('markGateRoleReady 置 roleReady=true，revision+1', () => {
    writeCollabGate(dataDir, buildInitialCollabGate({ initId: 'i', configVersion: 'cv', creatorAppId: APP, chatId: CHAT, participantAppIds: [APP] }));
    const g = markGateRoleReady(dataDir, CHAT, APP)!;
    expect(g.participants[APP].roleReady).toBe(true);
    expect(g.revision).toBe(1);
    expect(readCollabGate(dataDir, CHAT)!.participants[APP].roleReady).toBe(true);
  });

  it('队列同 sourceMessageId 去重', () => {
    enqueueCollabChatItem(dataDir, CHAT, { sourceMessageId: 'om_1', targetAppId: APP, routingEvent: {}, deliveryStatus: 'pending', enqueuedAt: 1 });
    const added = enqueueCollabChatItem(dataDir, CHAT, { sourceMessageId: 'om_1', targetAppId: APP, routingEvent: {}, deliveryStatus: 'pending', enqueuedAt: 2 });
    expect(added).toBe(false);
    expect(readCollabChatQueue(dataDir, CHAT).items).toHaveLength(1);
  });
});
