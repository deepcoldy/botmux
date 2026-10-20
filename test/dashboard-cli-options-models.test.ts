/**
 * dashboard-cli-options-models.test.ts
 *
 * GET /api/cli-options/models 端点的最小化验证。
 *
 * 路由的可测逻辑已抽进 src/services/model-catalog.ts（400 判定谓词
 * isKnownSelectionKey + 200 响应体构造 buildModelChoicesResponse）与
 * src/dashboard/model-catalog-request.ts（按 Bot 的 runtime/env 构造探测上下文
 * modelCatalogProbeContext）。本文件按端点契约验证这三者：400 分支、200 响应
 * shape、Bot runtime 上下文。dashboard.ts 是模块级 createServer 的重型模块，
 * 路由本身的接线不在这里钉。
 */
import { describe, expect, it } from 'vitest';
import {
  buildModelChoicesResponse,
  isKnownSelectionKey,
} from '../src/services/model-catalog.js';
import { modelCatalogProbeContext } from '../src/dashboard/model-catalog-request.js';
import type { BotConfig } from '../src/bot-registry.js';
import {
  CLI_SELECTION_ALIASES,
  resolveCliSelection,
  TTADK_MODEL_SUGGESTIONS,
} from '../src/setup/cli-selection.js';

// ─── 400 分支：路由用 isKnownSelectionKey 判定 ──────────────────────────────

describe('GET /api/cli-options/models — 400 分支（unknown_selection_key）', () => {
  it('key 缺失/空串/未知 → 拒绝', () => {
    expect(isKnownSelectionKey('')).toBe(false);
    expect(isKnownSelectionKey('   ')).toBe(false);
    expect(isKnownSelectionKey('does-not-exist')).toBe(false);
  });

  it('普通 cliId 与网关键均放行', () => {
    expect(isKnownSelectionKey('claude-code')).toBe(true);
    expect(isKnownSelectionKey('codex')).toBe(true);
    expect(isKnownSelectionKey('ttadk-x-claude')).toBe(true);
    expect(isKnownSelectionKey('aiden-x-claude')).toBe(true);
    expect(isKnownSelectionKey('aiden-x-codex')).toBe(true);
  });
});

// ─── 200 响应 shape：{ models, source, detectedAt } ─────────────────────────

describe('GET /api/cli-options/models — 200 响应 shape', () => {
  it('无 live 探测能力：models=静态候选，source=static，detectedAt 为 epoch millis', async () => {
    const body = await buildModelChoicesResponse('claude-code', { now: () => 1_700_000_000_000 });
    expect(body).toEqual({
      models: expect.arrayContaining(['sonnet']) as unknown as string[],
      source: 'static',
      detectedAt: 1_700_000_000_000,
    });
    expect(Object.keys(body).sort()).toEqual(['detectedAt', 'models', 'source']);
    expect(typeof body.detectedAt).toBe('number');
  });

  it('ttadk 网关项：models=TTADK 建议列表，source=static', async () => {
    const body = await buildModelChoicesResponse('ttadk-x-claude');
    expect(body.models).toEqual([...TTADK_MODEL_SUGGESTIONS]);
    expect(body.source).toBe('static');
    expect(typeof body.detectedAt).toBe('number');
  });

  it('aiden-x-codex 返回 AIPROXY live 目录，不混入原生 Codex 静态模型', async () => {
    const body = await buildModelChoicesResponse('aiden-x-codex', {
      now: () => 1_700_000_000_001,
      aidenCodexDetector: async () => ['deepseek-v4-pro', 'gpt-6-astra'],
    });
    expect(body).toEqual({
      models: ['deepseek-v4-pro', 'gpt-6-astra'],
      source: 'live',
      detectedAt: 1_700_000_000_001,
    });
    expect(body.models).not.toContain('gpt-5.2');
  });

  it('live 能力目录作为可选 modelCapabilities 字段追加，不替换旧三字段', async () => {
    const body = await buildModelChoicesResponse('gemini', {
      now: () => 1_700_000_000_002,
      adapterFactory: () => ({
        detectModelCapabilities: async () => [{ slug: 'gemini-live', serviceTiers: ['priority'] }],
      } as any),
    });
    expect(body.modelCapabilities).toEqual([
      { slug: 'gemini-live', serviceTiers: ['priority'] },
    ]);
    expect(body.source).toBe('live');
    expect(body.detectedAt).toBe(1_700_000_000_002);
    expect(body.models).toContain('gemini-live');
  });

  it('未知 key 的响应构造也是 fail-soft（空 models + static），400 由路由在更外层拦截', async () => {
    // 注意：真实路由先经 isKnownSelectionKey 拦截返回 400，不会走到这里；
    // 这里验证 helper 自身对未知 key 不抛异常。
    const body = await buildModelChoicesResponse('does-not-exist');
    expect(body.models).toEqual([]);
    expect(body.source).toBe('static');
  });
});

describe('GET /api/cli-options/models — Bot runtime 上下文', () => {
  it('每个 alias 与正式键使用相同的 Bot runtime executable、context 和 env', () => {
    for (const [alias, canonicalKey] of Object.entries(CLI_SELECTION_ALIASES)) {
      const selection = resolveCliSelection(canonicalKey);
      const bot = {
        larkAppId: `cli_alias_${alias}`,
        cliId: selection.cliId,
        ...(selection.wrapperCli ? { wrapperCli: selection.wrapperCli } : {}),
        ...(selection.cliLaunchMode ? { cliLaunchMode: selection.cliLaunchMode } : {}),
        cliPathOverride: '/bot/bin',
        env: { BOT_ONLY_SECRET: `secret-${alias}` },
      } as BotConfig;
      const baseEnv = { PATH: '/system/bin' };

      expect(modelCatalogProbeContext(alias, bot, baseEnv)).toEqual(
        modelCatalogProbeContext(canonicalKey, bot, baseEnv),
      );
    }
  });

  it.each([
    ['cjadk-x-codex', { cliId: 'codex', wrapperCli: 'cjadk codex' }],
    ['forge-x-traex', { cliId: 'traex', cliLaunchMode: 'forge-traex' }],
  ] as const)('%s 不把 Bot override 当作底层适配器 executable', (key, selection) => {
    const bot = {
      larkAppId: `cli_${key}`,
      ...selection,
      cliPathOverride: '/bot/bin',
    } as BotConfig;

    expect(modelCatalogProbeContext(key, bot, { PATH: '/system/bin' }).runtimeExecutable)
      .toBeUndefined();
  });

  it('未知 wrapper 请求原生 key 时不注入 Bot env、runtimeContext 或 override', () => {
    const bot = {
      larkAppId: 'cli_unknown_wrapper',
      cliId: 'codex',
      wrapperCli: 'ccr claude',
      cliPathOverride: '/bot/codex',
      env: { BOT_ONLY_SECRET: 'must-not-leak' },
    } as BotConfig;
    expect(modelCatalogProbeContext('codex', bot, { PATH: '/system/bin' })).toEqual({
      cliId: 'codex',
      runtimeExecutable: undefined,
      runtimeContext: undefined,
      probeEnv: undefined,
    });
  });
});
