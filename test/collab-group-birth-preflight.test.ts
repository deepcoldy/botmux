/**
 * preflightCollabGroupBirth 阶段 1（design §5.2）契约测试。
 *
 * 直接驱动 preflight + 注入 deps（临时 dataDir + 假时钟 + 假 peer preflight），
 * 并 mock bot-registry 让 bot 带 collaboration 配置。覆盖：
 *   - 关闭协作 → legacy 且无 store 写入；
 *   - enabled 结构失败 → failed，不占位；
 *   - 同 sourceKey 重投 → existing 同 initId；
 *   - 同 DM 不同 source → busy；
 *   - peer 失败 → failed 且释放 activeByDmChat（fail-closed）；
 *   - ready 时带 creatorAdmissionOperationId。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
let clock = 0;
const now = () => ++clock;

// config.js 会拉入 zod / voice 等大依赖图，直接 mock 掉，避免无关模块加载。
vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return tempDir; } } },
}));

vi.mock('../src/bot-registry.js', () => {
  const configs = new Map<string, any>();
  return {
    getBot: (appId: string) => ({ config: configs.get(appId) ?? { sessionGroup: undefined } }),
    loadBotConfigsCached: () => [],
    __testOnly_setBotConfig: (appId: string, cfg: any) => { configs.set(appId, cfg); },
  };
});

// 直接 import（避免 config.js 的 SESSION_DATA_DIR 依赖）——preflight 用 deps.dataDir。
import { __testOnly_setBotConfig } from '../src/bot-registry.js';
import { preflightCollabGroupBirth, startCollabGroupBirth, releaseCollabGroupBirth } from '../src/core/collab-group-birth.js';
import { readCollabInitStore, __testOnly_resetCollabInitMutexes } from '../src/services/collab-init-store.js';
import { collabInitId, collabSourceKey } from '../src/services/collab-group-config.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';

const APP = 'cli_creator';
const DM = 'oc_dm';

function ctx(messageId: string): RoutingContext {
  return {
    chatId: DM,
    messageId,
    chatType: 'p2p',
    scope: 'thread',
    anchor: messageId,
    larkAppId: APP,
  };
}

function data(messageId: string): any {
  return {
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: { message_id: messageId, chat_id: DM, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
  };
}

function collabEnabledConfig(): any {
  return {
    sessionGroup: {
      collaboration: {
        enabled: true,
        agents: [{ appId: 'cli_creator', roleMode: 'no-chat-role' }],
        kickoff: [{ appId: 'cli_creator', trigger: 'immediate' }],
      },
    },
  };
}

function deps() {
  return {
    dataDir: tempDir,
    now,
    resolveProfile: () => 'role-content',
    resolveTeamRole: () => null,
    resolveAgent: (appId: string) => ({ exists: true, apiOnly: false }),
    peerPreflight: async () => ({ ok: true as const }),
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'collab-preflight-'));
  clock = 0;
  __testOnly_resetCollabInitMutexes();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  __testOnly_resetCollabInitMutexes();
});

describe('preflightCollabGroupBirth', () => {
  it('默认关闭 → legacy 且无 collab store 写入', async () => {
    __testOnly_setBotConfig(APP, { sessionGroup: undefined });
    const r = await preflightCollabGroupBirth(data('om_1'), ctx('om_1'), deps());
    expect(r.kind).toBe('legacy');
    expect(readCollabInitStore(tempDir, APP).entries).toEqual({});
  });

  it('enabled 但结构失败 → failed，不占位不建群', async () => {
    __testOnly_setBotConfig(APP, {
      sessionGroup: { collaboration: { enabled: true, agents: [], kickoff: [] } },
    });
    const r = await preflightCollabGroupBirth(data('om_1'), ctx('om_1'), deps());
    expect(r.kind).toBe('failed');
    expect(readCollabInitStore(tempDir, APP).entries).toEqual({});
  });

  it('同 sourceKey 重投 → existing 同 initId（config v1→v2 不建第二请求）', async () => {
    __testOnly_setBotConfig(APP, collabEnabledConfig());
    const sourceKey = collabSourceKey(APP, DM, 'om_1');
    const initId = collabInitId(sourceKey);

    const first = await preflightCollabGroupBirth(data('om_1'), ctx('om_1'), deps());
    expect(first.kind).toBe('ready');

    // config v2（不同内容）也重投同一 source → existing 同 initId
    __testOnly_setBotConfig(APP, {
      sessionGroup: {
        collaboration: {
          enabled: true,
          agents: [{ appId: 'cli_creator', roleMode: 'no-chat-role' }],
          kickoff: [{ appId: 'cli_creator', trigger: 'immediate', prompt: 'v2' }],
        },
      },
    });
    const second = await preflightCollabGroupBirth(data('om_1'), ctx('om_1'), deps());
    expect(second.kind).toBe('existing');
    if (second.kind === 'existing') expect(second.initId).toBe(initId);
    // 只有一个 entry，一个请求
    expect(Object.keys(readCollabInitStore(tempDir, APP).entries)).toHaveLength(1);
  });

  it('同 DM 不同 source → busy', async () => {
    __testOnly_setBotConfig(APP, collabEnabledConfig());
    const first = await preflightCollabGroupBirth(data('om_1'), ctx('om_1'), deps());
    expect(first.kind).toBe('ready');
    const second = await preflightCollabGroupBirth(data('om_2'), ctx('om_2'), deps());
    expect(second.kind).toBe('busy');
  });

  it('peer 失败 → failed 且释放 activeByDmChat（fail-closed，不 fallback legacy）', async () => {
    __testOnly_setBotConfig(APP, collabEnabledConfig());
    const r = await preflightCollabGroupBirth(data('om_1'), ctx('om_1'), {
      ...deps(),
      peerPreflight: async () => ({ ok: false, errors: ['target 未声明 durable-turn-output-receipt-v1'] }),
    });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.releasesDmChat).toBe(true);
    // activeByDmChat 已释放，entry 保留为 failed
    const store = readCollabInitStore(tempDir, APP);
    expect(store.activeByDmChat[DM]).toBeUndefined();
    const entry = Object.values(store.entries)[0];
    expect(entry.state).toBe('failed');
  });

  it('ready 时带 creatorAdmissionOperationId + configVersion', async () => {
    __testOnly_setBotConfig(APP, collabEnabledConfig());
    const r = await preflightCollabGroupBirth(data('om_1'), ctx('om_1'), deps());
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.initId).toBe(collabInitId(collabSourceKey(APP, DM, 'om_1')));
    expect(r.creatorAdmissionOperationId).toBeTruthy();
    expect(r.configVersion).toBeTruthy();
    expect(r.config.enabled).toBe(true);
  });

  it('peer 失败场景：afterAgentTurn 但目标未声明 durable-turn-output-receipt-v1 → failed', async () => {
    __testOnly_setBotConfig(APP, {
      sessionGroup: {
        collaboration: {
          enabled: true,
          agents: [{ appId: 'cli_creator', roleMode: 'no-chat-role' }, { appId: 'cli_builder', roleMode: 'no-chat-role' }],
          kickoff: [
            { appId: 'cli_creator', trigger: 'immediate' },
            { appId: 'cli_builder', trigger: 'afterAgentTurn', afterAppId: 'cli_creator', artifact: { type: 'marked-url', hosts: ['example.com'] } },
          ],
        },
      },
    });
    const r = await preflightCollabGroupBirth(data('om_1'), ctx('om_1'), {
      ...deps(),
      peerPreflight: async () => ({ ok: false, errors: ['peer 未声明 durable-turn-output-receipt-v1'] }),
    });
    expect(r.kind).toBe('failed');
  });

  it('startCollabGroupBirth 占位语义：返回 collab-handled（不递归 handleNewTopic）', async () => {
    __testOnly_setBotConfig(APP, collabEnabledConfig());
    const initId = collabInitId(collabSourceKey(APP, DM, 'om_1'));
    const r = await startCollabGroupBirth(data('om_1'), ctx('om_1'), initId, undefined);
    expect(r.kind).toBe('collab-handled');
    if (r.kind === 'collab-handled') expect(r.initId).toBe(initId);
  });

  it('releaseCollabGroupBirth 释放 activeByDmChat（扣费被拒后不永久 busy）', async () => {
    __testOnly_setBotConfig(APP, collabEnabledConfig());
    const initId = collabInitId(collabSourceKey(APP, DM, 'om_1'));
    await preflightCollabGroupBirth(data('om_1'), ctx('om_1'), deps());
    // 释放前 busy
    expect((await preflightCollabGroupBirth(data('om_2'), ctx('om_2'), deps())).kind).toBe('busy');
    await releaseCollabGroupBirth({ dataDir: tempDir, creatorAppId: APP, initId, dmChatId: DM, now });
    // 释放后新 source 可建新请求
    const next = await preflightCollabGroupBirth(data('om_2'), ctx('om_2'), deps());
    expect(next.kind).toBe('ready');
    // sourceIndex 永久：原 source 仍 existing
    expect((await preflightCollabGroupBirth(data('om_1'), ctx('om_1'), deps())).kind).toBe('existing');
  });

  it('peerPreflight Promise rejection → failed 并释放占位，不残留 running（P2#5）', async () => {
    __testOnly_setBotConfig(APP, collabEnabledConfig());
    const r = await preflightCollabGroupBirth(data('om_1'), ctx('om_1'), {
      ...deps(),
      peerPreflight: async () => { throw new Error('boom'); },
    });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.releasesDmChat).toBe(true);
    // 占位已释放：无 running 残留，同 DM 下一条不 busy
    const store = readCollabInitStore(tempDir, APP);
    expect(store.activeByDmChat[DM]).toBeUndefined();
    expect(Object.values(store.entries).some(e => e.state === 'running')).toBe(false);
    const next = await preflightCollabGroupBirth(data('om_2'), ctx('om_2'), deps());
    expect(next.kind).toBe('ready');
  });

  it('生产默认：无 peer（creator-only 配置）时真实 peer preflight 返回 ready（PR-2b 切换真实 preflight）', async () => {
    __testOnly_setBotConfig(APP, collabEnabledConfig());
    // 不注入 peerPreflight：走 realCollabPeerPreflight。creator-only 配置无 peer → 直接 ready。
    const r = await preflightCollabGroupBirth(data('om_1'), ctx('om_1'), {
      dataDir: tempDir,
      now,
      resolveProfile: () => 'r',
      resolveTeamRole: () => null,
      resolveAgent: (appId) => (appId === APP ? { exists: true, apiOnly: false } : undefined),
    });
    expect(r.kind).toBe('ready');
  });
});
