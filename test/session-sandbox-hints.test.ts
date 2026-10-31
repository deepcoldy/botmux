/**
 * 文件沙盒的会话侧提示：
 *   - 飞书会话卡：会话冻结为 oncall / scratch 时多一行「沙盒：…」；没开沙盒的会话卡片
 *     与改动前逐字节一致（金样见 card-builder-wire-golden 的 session.*，这里再钉
 *     'off' / 未冻结 / 损坏值三种入参都等价于不传）
 *   - Dashboard 会话行：冻结模式与 bot 当前配置不一致时带 sandboxDrift
 *   - 零注入：不支持的具体原因（supportsZeroPromptInjection 只是它的薄包装）
 */
import { describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

const botConfigs = new Map<string, Record<string, unknown>>();
vi.mock('../src/bot-registry.js', async () => {
  const actual = await vi.importActual<typeof import('../src/bot-registry.js')>('../src/bot-registry.js');
  return {
    ...actual,
    getBot: (appId: string) => {
      const cfg = botConfigs.get(appId);
      if (!cfg) throw new Error(`Bot not registered: ${appId}`);
      return { config: cfg } as any;
    },
  };
});
vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionUsageWithContext: vi.fn(() => ({ snapshot: { context: null, tokens: null, turnTokens: null } })),
}));

import { buildSessionCard } from '../src/im/lark/card-builder.js';
import { frozenSessionSandboxMode, sessionSandboxDrift } from '../src/adapters/cli/sandbox-mode.js';
import { composeRowFromActive, composeRowFromPersistedActive } from '../src/core/dashboard-rows.js';
import {
  supportsZeroPromptInjection,
  zeroPromptInjectionUnsupportedReason,
} from '../src/core/zero-prompt-support.js';

type CardArgs = Parameters<typeof buildSessionCard>;
const BASE: CardArgs = ['sess1', 'om_root', 'https://term.example/s/1', 'My task', 'codex', false, false, 'zh', false, undefined];

function elementsOf(json: string): any[] {
  return JSON.parse(json).elements;
}

describe('buildSessionCard — frozen session sandbox line', () => {
  it.each([
    ['off', frozenSessionSandboxMode(false)],
    ['undefined frozen value', frozenSessionSandboxMode(undefined)],
    ['corrupt frozen value', frozenSessionSandboxMode('bogus')],
    ['explicit off', 'off' as const],
  ])('%s renders byte-identically to the card without the argument', (_label, mode) => {
    for (const manage of [false, true]) {
      const args: CardArgs = [...BASE];
      args[5] = manage;
      expect(buildSessionCard(...args, mode)).toBe(buildSessionCard(...args));
    }
  });

  it.each([
    [true, 'zh', '🛡️ 沙盒：白名单隔离'],
    ['oncall', 'zh', '🛡️ 沙盒：白名单隔离'],
    ['scratch', 'zh', '🛡️ 沙盒：scratch 一次性'],
    ['oncall', 'en', '🛡️ Sandbox: Allowlist isolation'],
    ['scratch', 'en', '🛡️ Sandbox: scratch (throwaway)'],
  ] as const)('frozen %s (%s) adds exactly one notation line above the buttons', (frozen, locale, text) => {
    const args: CardArgs = [...BASE];
    args[7] = locale;
    const plain = elementsOf(buildSessionCard(...args));
    const withLine = elementsOf(buildSessionCard(...args, frozenSessionSandboxMode(frozen)));
    expect(withLine).toHaveLength(plain.length + 1);
    expect(withLine[0]).toEqual({ tag: 'markdown', content: text, text_size: 'notation' });
    // Everything else — buttons, header — is the legacy card unchanged.
    expect(withLine.slice(1)).toEqual(plain);
  });
});

function persistedSession(sandbox: unknown, appId = 'app_drift'): any {
  return {
    sessionId: 's1',
    larkAppId: appId,
    cliId: 'claude-code',
    status: 'active',
    createdAt: '2026-10-30T00:00:00.000Z',
    chatId: 'oc_1',
    rootMessageId: 'om_1',
    ...(sandbox === undefined ? {} : { sandbox }),
  };
}

describe('dashboard session rows — sandboxDrift', () => {
  it.each([
    // [frozen session value, bot config, expected drift]
    [true, { sandbox: 'off' }, { session: 'oncall', current: 'off' }],
    ['scratch', { sandbox: 'oncall' }, { session: 'scratch', current: 'oncall' }],
    [false, { sandbox: 'scratch' }, { session: 'off', current: 'scratch' }],
    ['off', { readIsolation: true }, { session: 'off', current: 'oncall' }],
  ] as const)('frozen %j vs bot %j → %j', (frozen, botCfg, expected) => {
    botConfigs.set('app_drift', { ...botCfg });
    expect(composeRowFromPersistedActive(persistedSession(frozen), { includeTokenUsage: false }).sandboxDrift).toEqual(expected);
  });

  it.each([
    ['same mode (true vs oncall)', true, { sandbox: 'oncall' }],
    ['same mode (scratch)', 'scratch', { sandbox: 'scratch' }],
    ['both off', false, {}],
    // Not frozen yet (pre-spawn / legacy row): nothing to compare.
    ['not frozen', undefined, { sandbox: 'oncall' }],
    ['unreadable bot config', true, { sandbox: 'bogus' }],
  ] as const)('%s → no badge field at all', (_label, frozen, botCfg) => {
    botConfigs.set('app_drift', { ...botCfg });
    const row = composeRowFromPersistedActive(persistedSession(frozen), { includeTokenUsage: false });
    expect(row).not.toHaveProperty('sandboxDrift');
  });

  it('unregistered bot → no badge (never throws out of the row composer)', () => {
    const row = composeRowFromPersistedActive(persistedSession(true, 'app_missing'), { includeTokenUsage: false });
    expect(row).not.toHaveProperty('sandboxDrift');
  });

  it('live sessions carry the same field', () => {
    botConfigs.set('app_drift', { sandbox: 'off' });
    const ds = {
      session: persistedSession('scratch'),
      larkAppId: 'app_drift',
      chatId: 'oc_1',
      worker: { pid: 1 },
      spawnedAt: 1,
      lastMessageAt: 2,
    } as unknown as DaemonSession;
    expect(composeRowFromActive(ds, { includeTokenUsage: false }).sandboxDrift).toEqual({ session: 'scratch', current: 'off' });
  });

  it('sessionSandboxDrift itself treats a missing bot config as unknown', () => {
    expect(sessionSandboxDrift(true, undefined)).toBeUndefined();
  });
});

describe('zeroPromptInjectionUnsupportedReason', () => {
  it.each([
    ['claude-code', {}, null],
    ['codex', { backendType: 'tmux' }, null],
    ['cursor', { sandbox: 'oncall' }, null],
    ['gemini', {}, 'cli_unsupported'],
    [undefined, {}, 'cli_unsupported'],
    ['claude-code', { backendType: 'riff' }, 'backend_unsupported'],
    ['cursor', { sandbox: 'scratch' }, 'scratch_unsupported_for_cli'],
    ['antigravity', { sandbox: 'scratch' }, 'scratch_unsupported_for_cli'],
    ['antigravity', { backendType: 'zmx' }, 'zmx_unsupported_for_antigravity'],
    ['cursor', { backendType: 'zmx' }, null],
    // Order: an unsupported backend wins over the scratch / zmx specifics.
    ['antigravity', { backendType: 'riff', sandbox: 'scratch' }, 'backend_unsupported'],
    ['antigravity', { backendType: 'zmx', sandbox: 'scratch' }, 'scratch_unsupported_for_cli'],
  ] as const)('%s %j → %s', (cliId, opts, expected) => {
    expect(zeroPromptInjectionUnsupportedReason(cliId, opts)).toBe(expected);
    // The boolean predicate every caller uses is exactly "no reason".
    expect(supportsZeroPromptInjection(cliId, opts)).toBe(expected === null);
  });
});
