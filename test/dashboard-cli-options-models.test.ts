/**
 * dashboard-cli-options-models.test.ts
 *
 * GET /api/cli-options/models 端点的最小化验证。
 *
 * 取舍说明：dashboard.ts 是 daemon 侧重型模块（模块级 createServer + 大量飞书/
 * daemon 依赖），仓库内没有任何测试整体 import 它，起全量 HTTP harness 代价过高
 * 且脆弱。故按既有模式（见 test/api-only-mode-wiring.test.ts 的 source-lock）：
 *   1. 路由的可测逻辑已抽进 src/services/model-catalog.ts（400 判定谓词
 *      isKnownSelectionKey + 200 响应体构造 buildModelChoicesResponse），在
 *      test/model-catalog.test.ts 里充分覆盖；本文件只验证「端点契约」本身——
 *      400 分支与 200 响应 shape。
 *   2. 路由接线（路径、400 错误码、helper 调用、与 /api/cli-options 的相邻位置、
 *      cli-options 新增 modelChoices 字段）用 source-lock 钉住，防止重构时静默走样。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

// ─── Source-lock：dashboard.ts 的路由接线 ───────────────────────────────────

describe('dashboard.ts 路由接线（source-lock）', () => {
  const source = readFileSync(resolve('src/dashboard.ts'), 'utf8');

  it('注册了 GET /api/cli-options/models 且与 /api/cli-options 相邻', () => {
    const cliOptions = source.indexOf("url.pathname === '/api/cli-options'");
    const models = source.indexOf("url.pathname === '/api/cli-options/models'");
    expect(cliOptions).toBeGreaterThan(-1);
    expect(models).toBeGreaterThan(cliOptions);
    // 相邻：两条路由之间不再隔其它 pathname 分支（切片含 cli-options 路由自身
    // 的那一次出现，故计数应为 1）
    const between = source.slice(cliOptions, models);
    expect(between.split('url.pathname ===').length - 1).toBe(1);
  });

  it('未知 key 返回 400 unknown_selection_key', () => {
    const routeStart = source.indexOf("url.pathname === '/api/cli-options/models'");
    expect(routeStart).toBeGreaterThan(-1);
    const routeBlock = source.slice(routeStart, routeStart + 1200);
    expect(routeBlock).toContain('isKnownSelectionKey(key)');
    expect(routeBlock).toContain("jsonRes(res, 400, { ok: false, error: 'unknown_selection_key' })");
  });

  it('200 分支走 buildModelChoicesResponse（live 权威 / 静态兜底的单一事实源）', () => {
    const routeStart = source.indexOf("url.pathname === '/api/cli-options/models'");
    const routeBlock = source.slice(routeStart, routeStart + 1200);
    expect(routeBlock).toContain('buildModelChoicesResponse(key, {');
  });

  it('带 bot 参数时按该 Bot 的精确 launch shape、runtime/env 探测', () => {
    const routeStart = source.indexOf("url.pathname === '/api/cli-options/models'");
    const routeBlock = source.slice(routeStart, routeStart + 2000);
    expect(routeBlock).toContain("url.searchParams.get('bot')");
    expect(routeBlock).not.toContain("url.searchParams.get('appId')");
    expect(routeBlock).toContain('getBot(appId).config');
    expect(routeBlock).toContain('modelCatalogProbeContext(key, botConfig, process.env)');
    expect(routeBlock).toContain('runtimeContext: probeContext.runtimeContext');
    expect(routeBlock).toContain('probeEnv: probeContext.probeEnv');
    expect(routeBlock).toContain('runtimeExecutable: probeContext.runtimeExecutable');
  });

  it('/api/cli-options 每个 option 带 modelChoices 字段（静态候选）', () => {
    const routeStart = source.indexOf("url.pathname === '/api/cli-options'");
    const routeEnd = source.indexOf("url.pathname === '/api/cli-options/models'");
    const routeBlock = source.slice(routeStart, routeEnd);
    expect(routeBlock).toContain('staticModelChoices(o.key)');
    expect(routeBlock).toContain('modelChoices');
    // 保留既有字段（回归防护）：id/label/available/command/availabilityReason
    for (const field of ['id: o.key', 'label: o.label', 'available: availability.available', 'command: availability.command', 'availabilityReason: availability.reason']) {
      expect(routeBlock).toContain(field);
    }
  });
});
