import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MODEL_DETECT_TTL_MS,
  buildModelChoicesResponse,
  createModelCatalog,
  detectModels,
  mergeModelChoices,
  runtimeExecutableForBotSelection,
  staticModelChoices,
} from '../src/services/model-catalog.js';
import { TTADK_MODEL_SUGGESTIONS } from '../src/setup/cli-selection.js';
import { parseAidenCodexModelsJson } from '../src/services/aiden-model-catalog.js';
import type { CliAdapter } from '../src/adapters/cli/types.js';

/** 只带 detectModels 的最小适配器 fake（其余字段本服务不碰）。 */
function fakeAdapter(
  detect: (() => Promise<readonly string[] | null>) | undefined,
  capabilities?: () => Promise<readonly { slug: string; serviceTiers: string[] }[] | null>,
): CliAdapter {
  return {
    ...(detect ? { detectModels: detect } : {}),
    ...(capabilities ? { detectModelCapabilities: capabilities } : {}),
  } as unknown as CliAdapter;
}

describe('staticModelChoices（静态候选，shell-free）', () => {
  it('claude-code 返回非空候选且含 sonnet', () => {
    const models = staticModelChoices('claude-code');
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain('sonnet');
  });

  it('codex 返回其静态候选', () => {
    const models = staticModelChoices('codex');
    expect(models).toEqual([
      'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
    ]);
  });

  it('codex-app 与 codex 共享同一模型目录快照', () => {
    expect(staticModelChoices('codex-app')).toEqual(staticModelChoices('codex'));
  });

  it('aiden-x-codex 不回退原生 Codex 静态模型', () => {
    expect(staticModelChoices('aiden-x-codex')).toEqual([]);
  });

  it('traex returns a curated model list that includes reasoning-capable models', () => {
    const models = staticModelChoices('traex');
    expect(models).toContain('DeepSeek-V4-Pro');
    expect(models).toContain('gpt-5.5');
  });

  it('aiden-x-claude 网关键回退到底层 claude-code 候选', () => {
    // 非 ttadk 网关（aiden/cjadk）不拦截，读底层适配器的 modelChoices。
    expect(staticModelChoices('aiden-x-claude')).toContain('sonnet');
    expect(staticModelChoices('cjadk-x-claude')).toContain('sonnet');
  });

  it('ttadk-x-claude 返回 TTADK 建议列表', () => {
    expect(staticModelChoices('ttadk-x-claude')).toEqual([...TTADK_MODEL_SUGGESTIONS]);
    expect(TTADK_MODEL_SUGGESTIONS).toContain('glm-5.1');
  });

  it('ttadk-x-coco（不接受 -m）返回 []', () => {
    expect(staticModelChoices('ttadk-x-coco')).toEqual([]);
  });

  it('未知 key 返回 []', () => {
    expect(staticModelChoices('does-not-exist')).toEqual([]);
    expect(staticModelChoices('')).toEqual([]);
  });
});

describe('mergeModelChoices（权威 live / 静态兜底）', () => {
  it('live 非空时使用 runtime 权威目录并去重保序', () => {
    const { models, source } = mergeModelChoices(['a', 'b', 'a'], ['b', 'c', 'd']);
    expect(models).toEqual(['b', 'c', 'd']);
    expect(source).toBe('live');
  });

  it('live 与静态完全重叠时仍标 live（live 非空即 live）', () => {
    const { models, source } = mergeModelChoices(['a', 'b'], ['b']);
    expect(models).toEqual(['b']);
    expect(source).toBe('live');
  });

  it('live 为 null → 只保留静态，source=static', () => {
    const { models, source } = mergeModelChoices(['a', 'b'], null);
    expect(models).toEqual(['a', 'b']);
    expect(source).toBe('static');
  });

  it('live 为空数组 → 等同 null，source=static', () => {
    const { models, source } = mergeModelChoices(['a'], []);
    expect(models).toEqual(['a']);
    expect(source).toBe('static');
  });

  it('静态为空 + live 非空 → 纯 live 列表', () => {
    const { models, source } = mergeModelChoices([], ['x', 'y']);
    expect(models).toEqual(['x', 'y']);
    expect(source).toBe('live');
  });
});

describe('detectModels（live 探测，fail-soft）', () => {
  it('aiden-x-codex 使用 Aiden 专用探测器，不构造 Codex adapter', async () => {
    const catalog = createModelCatalog();
    let adapterCalls = 0;
    let aidenCalls = 0;
    const models = await catalog.detectModels('aiden-x-codex', {
      adapterFactory: () => { adapterCalls++; return fakeAdapter(async () => ['native-codex']); },
      aidenCodexDetector: async () => { aidenCalls++; return ['deepseek-v4-pro', 'gpt-6-astra']; },
    });
    expect(models).toEqual(['deepseek-v4-pro', 'gpt-6-astra']);
    expect(aidenCalls).toBe(1);
    expect(adapterCalls).toBe(0);
  });

  it('Aiden 的成功目录沿用缓存，过期后重探', async () => {
    const catalog = createModelCatalog();
    let now = 1_000;
    let calls = 0;
    const opts = {
      now: () => now,
      adapterFactory: () => { throw new Error('must not construct Codex adapter'); },
      aidenCodexDetector: async () => { calls++; return ['deepseek-v4-pro']; },
    };
    for (let i = 0; i < 2; i++) {
      expect(await catalog.detectModels('aiden-x-codex', opts)).toEqual(['deepseek-v4-pro']);
    }
    expect(calls).toBe(1);
    now += MODEL_DETECT_TTL_MS;
    expect(await catalog.detectModels('aiden-x-codex', opts)).toEqual(['deepseek-v4-pro']);
    expect(calls).toBe(2);
  });

  it('适配器无 detectModels（claude-code）→ null', async () => {
    expect(await detectModels('claude-code')).toBeNull();
  });

  it('ttadk 网关项（ttadk-x-claude）→ null（模型由网关建议列表承载）', async () => {
    const catalog = createModelCatalog();
    let calls = 0;
    const factory = () => { calls++; return fakeAdapter(async () => ['must-not-run']); };
    expect(await catalog.detectModels('ttadk-x-claude', { adapterFactory: factory })).toBeNull();
    expect(await catalog.detectModels('ttadk-x-coco', { adapterFactory: factory })).toBeNull();
    expect(calls).toBe(0);
  });

  it('cjadk-x-codex 保留底层 Codex live 探测', async () => {
    const catalog = createModelCatalog();
    let calls = 0;
    const models = await catalog.detectModels('cjadk-x-codex', {
      adapterFactory: (cliId, executable) => {
        calls++;
        expect(cliId).toBe('codex');
        expect(executable).toBeUndefined();
        return fakeAdapter(async () => ['cjadk-live']);
      },
    });
    expect(models).toEqual(['cjadk-live']);
    expect(calls).toBe(1);
  });

  it('未知 key → null', async () => {
    expect(await detectModels('does-not-exist')).toBeNull();
  });

  it('TTL 内命中缓存、过期后重新探测', async () => {
    let now = 10_000;
    const catalog = createModelCatalog();
    let calls = 0;
    const factory = () => fakeAdapter(async () => {
      calls++;
      return ['m1', 'm2'];
    });
    const opts = { now: () => now, adapterFactory: factory };

    expect(await catalog.detectModels('codex', opts)).toEqual(['m1', 'm2']);
    expect(calls).toBe(1);

    // TTL 内：直接复用缓存，不再探测
    now += MODEL_DETECT_TTL_MS - 1;
    expect(await catalog.detectModels('codex', opts)).toEqual(['m1', 'm2']);
    expect(calls).toBe(1);

    // TTL 过期：重新探测
    now += 2;
    expect(await catalog.detectModels('codex', opts)).toEqual(['m1', 'm2']);
    expect(calls).toBe(2);
  });

  it('同一 key 并发调用 in-flight 去重（只探测一次）', async () => {
    const catalog = createModelCatalog();
    let calls = 0;
    let release!: (v: readonly string[]) => void;
    const blocked = new Promise<readonly string[]>((r) => { release = r; });
    const factory = () => fakeAdapter(() => {
      calls++;
      return blocked;
    });

    const p1 = catalog.detectModels('codex', { adapterFactory: factory });
    const p2 = catalog.detectModels('codex', { adapterFactory: factory });
    // 两个调用都已进入：factory 只被同步调起一次（in-flight 复用）
    expect(calls).toBe(1);

    release(['live-only']);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(['live-only']);
    expect(r2).toEqual(['live-only']);
    expect(calls).toBe(1);

    // 完成后 in-flight 已清理：再来一次（TTL 内）走缓存而非 in-flight
    expect(await catalog.detectModels('codex', { adapterFactory: factory })).toEqual(['live-only']);
    expect(calls).toBe(1);
  });

  it('失败不缓存：抛异常 / null / 空数组 下次都会重试', async () => {
    // 抛异常 → null，且不缓存
    const throwing = createModelCatalog();
    let throwCalls = 0;
    const throwFactory = () => fakeAdapter(async () => {
      throwCalls++;
      if (throwCalls === 1) throw new Error('boom');
      return ['recovered'];
    });
    expect(await throwing.detectModels('codex', { adapterFactory: throwFactory })).toBeNull();
    expect(throwCalls).toBe(1);
    expect(await throwing.detectModels('codex', { adapterFactory: throwFactory })).toEqual(['recovered']);
    expect(throwCalls).toBe(2);

    // null → 不缓存
    const nullCatalog = createModelCatalog();
    let nullCalls = 0;
    const nullFactory = () => fakeAdapter(async () => { nullCalls++; return null; });
    expect(await nullCatalog.detectModels('codex', { adapterFactory: nullFactory })).toBeNull();
    expect(await nullCatalog.detectModels('codex', { adapterFactory: nullFactory })).toBeNull();
    expect(nullCalls).toBe(2);

    // 空数组 → 原样返回 []，不缓存
    const emptyCatalog = createModelCatalog();
    let emptyCalls = 0;
    const emptyFactory = () => fakeAdapter(async () => { emptyCalls++; return []; });
    expect(await emptyCatalog.detectModels('codex', { adapterFactory: emptyFactory })).toEqual([]);
    expect(await emptyCatalog.detectModels('codex', { adapterFactory: emptyFactory })).toEqual([]);
    expect(emptyCalls).toBe(2);
  });

  it('适配器无 detectModels 字段 → null（注入 factory 验证）', async () => {
    const catalog = createModelCatalog();
    const factory = () => ({}) as CliAdapter;
    expect(await catalog.detectModels('codex', { adapterFactory: factory })).toBeNull();
  });

  it('适配器无目录探测能力时不解析或指纹化 executable', async () => {
    const catalog = createModelCatalog();
    let resolves = 0;
    await expect(catalog.detectModels('claude-code', {
      runtimeExecutable: 'missing-claude',
      adapterFactory: () => ({}) as CliAdapter,
      resolveExecutable: () => { resolves++; throw new Error('must not resolve'); },
    })).resolves.toBeNull();
    expect(resolves).toBe(0);
  });

  it('Bot runtime 只对三元组精确匹配的 native 选择生效', () => {
    expect(runtimeExecutableForBotSelection('codex', {
      cliId: 'codex',
      cliRuntime: { executable: '/opt/codex-app' },
      cliPathOverride: '/legacy/codex',
    })).toBe('/opt/codex-app');
    expect(runtimeExecutableForBotSelection('codex-app', {
      cliId: 'codex',
      cliRuntime: { executable: '/opt/codex-app' },
    })).toBeUndefined();
    expect(runtimeExecutableForBotSelection('cjadk-x-codex', {
      cliId: 'codex',
      wrapperCli: 'cjadk codex',
      cliPathOverride: '/legacy/codex',
    })).toBeUndefined();
    expect(runtimeExecutableForBotSelection('forge-x-traex', {
      cliId: 'traex',
      cliLaunchMode: 'forge-traex',
      cliPathOverride: '/legacy/traex',
    })).toBeUndefined();
  });

  it('未知 wrapper + cliPathOverride 不会回落成裸 cliId runtime', () => {
    expect(runtimeExecutableForBotSelection('claude-code', {
      cliId: 'claude-code',
      wrapperCli: 'ccr claude',
      cliPathOverride: '/legacy/claude',
    })).toBeUndefined();
  });

  it('可探测 runtime 的缓存按实际 executable 指纹隔离并感知原地替换', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-model-runtime-'));
    const executable = join(dir, 'codex');
    try {
      writeFileSync(executable, 'old');
      const catalog = createModelCatalog();
      let calls = 0;
      const opts = {
        runtimeExecutable: 'codex',
        resolveExecutable: () => executable,
        adapterFactory: () => fakeAdapter(async () => [`catalog-${++calls}`]),
      };
      expect(await catalog.detectModels('codex', opts)).toEqual(['catalog-1']);
      writeFileSync(executable, 'new-runtime-with-different-size');
      expect(await catalog.detectModels('codex', opts)).toEqual(['catalog-2']);
      expect(calls).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detectModelCapabilities 一次探测同时服务 slug 与能力目录缓存', async () => {
    let now = 20_000;
    let calls = 0;
    const catalog = createModelCatalog();
    const factory = () => fakeAdapter(undefined, async () => {
      calls++;
      return [{ slug: 'gpt-6-astra', serviceTiers: ['priority'] }];
    });
    const opts = { now: () => now, adapterFactory: factory };

    const detected = await catalog.detectModelCatalog('codex', opts);
    expect(detected).toEqual({
      models: ['gpt-6-astra'],
      modelCapabilities: [{ slug: 'gpt-6-astra', serviceTiers: ['priority'] }],
    });
    now += MODEL_DETECT_TTL_MS - 1;
    await expect(catalog.detectModels('codex', opts)).resolves.toEqual(['gpt-6-astra']);
    await expect(catalog.detectModelCatalog('codex', opts)).resolves.toEqual(detected);
    expect(calls).toBe(1);
  });

  it('能力探测器失败时不回落到 slug-only 探测器重复执行', async () => {
    let calls = 0;
    const catalog = createModelCatalog();
    const factory = () => fakeAdapter(
      async () => {
        calls++;
        return ['fallback'];
      },
      async () => {
        calls++;
        return null;
      },
    );

    await expect(catalog.detectModelCatalog('codex', { adapterFactory: factory })).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it('同一 CLI 的不同 runtime 与环境使用独立缓存', async () => {
    let calls = 0;
    let context = 'runtime-a';
    let env: NodeJS.ProcessEnv = { PATH: '/runtime-a/bin' };
    const catalog = createModelCatalog();
    const factory = () => fakeAdapter(undefined, async probe => {
      calls++;
      expect(probe?.env).toBe(env);
      return [{ slug: `model-${calls}`, serviceTiers: ['priority'] }];
    });

    const first = await catalog.detectModelCatalog('codex', {
      adapterFactory: factory,
      runtimeContext: context,
      probeEnv: env,
    });
    context = 'runtime-b';
    env = { PATH: '/runtime-b/bin' };
    const second = await catalog.detectModelCatalog('codex', {
      adapterFactory: factory,
      runtimeContext: context,
      probeEnv: env,
    });
    context = 'runtime-a';
    env = { PATH: '/runtime-a/bin' };
    await expect(catalog.detectModelCatalog('codex', {
      adapterFactory: factory,
      runtimeContext: context,
      probeEnv: env,
    })).resolves.toEqual(first);

    expect(first?.models).toEqual(['model-1']);
    expect(second?.models).toEqual(['model-2']);
    expect(calls).toBe(2);
  });
});

describe('parseAidenCodexModelsJson', () => {
  it('extracts unique codex ids and ignores malformed or foreign entries', () => {
    expect(parseAidenCodexModelsJson(JSON.stringify({
      schema_version: 1,
      models: [
        { cli_type: 'codex', id: 'deepseek-v4-pro' },
        { cli_type: 'claudecode', id: 'claude-only' },
        { cli_type: 'codex', id: 'deepseek-v4-pro' },
        { cli_type: 'codex', id: 'gpt-6-astra' },
        { cli_type: 'codex', id: '' },
      ],
    }))).toEqual(['deepseek-v4-pro', 'gpt-6-astra']);
  });

  it('returns [] for invalid JSON or schema', () => {
    expect(parseAidenCodexModelsJson('not json')).toEqual([]);
    expect(parseAidenCodexModelsJson(JSON.stringify({ schema_version: 2, models: [] }))).toEqual([]);
  });
});

describe('buildModelChoicesResponse（端点 200 响应体构造）', () => {
  it('无 live 探测能力时：静态候选 + source=static + detectedAt', async () => {
    // claude-code 无 detectModels → live=null → source=static
    const body = await buildModelChoicesResponse('claude-code', { now: () => 42_000 });
    expect(body.models).toContain('sonnet');
    expect(body.source).toBe('static');
    expect(body.detectedAt).toBe(42_000);
  });

  it('ttadk 网关项：静态建议列表 + source=static（不探测底层 CLI）', async () => {
    const body = await buildModelChoicesResponse('ttadk-x-claude', { now: () => 7_000 });
    expect(body.models).toEqual([...TTADK_MODEL_SUGGESTIONS]);
    expect(body.source).toBe('static');
    expect(body.detectedAt).toBe(7_000);
  });

  it('live 非空：只使用 live 权威目录，source=live，detectedAt 取注入时钟', async () => {
    // 用注入 factory 避免真实 shell out；key 取 mtr（本文件其它用例不在模块级
    // 单例上碰它，故单例缓存残留不影响其它断言）。
    const factory = () => fakeAdapter(async () => ['gemini-2.5-flash', 'brand-new-model']);
    const body = await buildModelChoicesResponse('mtr', { now: () => 99_000, adapterFactory: factory });
    expect(body.models).toEqual(['gemini-2.5-flash', 'brand-new-model']);
    expect(body.source).toBe('live');
    expect(body.detectedAt).toBe(99_000);
  });

  it('能力目录作为可选字段进入 live 响应，slug-only 探测不产生该字段', async () => {
    const capabilitiesFactory = () => fakeAdapter(undefined, async () => [
      { slug: 'gpt-6-astra', serviceTiers: ['priority'] },
    ]);
    const withCapabilities = await buildModelChoicesResponse('opencode', {
      now: () => 100_000,
      adapterFactory: capabilitiesFactory,
    });
    expect(withCapabilities.modelCapabilities).toEqual([
      { slug: 'gpt-6-astra', serviceTiers: ['priority'] },
    ]);

    const slugOnly = await buildModelChoicesResponse('opencode2', {
      now: () => 101_000,
      adapterFactory: () => fakeAdapter(async () => ['slug-only']),
    });
    expect(slugOnly).not.toHaveProperty('modelCapabilities');
  });

  it('仅下发与统一校验表精确一致的 reasoning levels，默认档位暂不下发', async () => {
    const body = await buildModelChoicesResponse('codex', {
      adapterFactory: () => ({
        detectModelCapabilities: async () => [{
          slug: 'gpt-6.1-sol',
          serviceTiers: ['priority'],
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultReasoningEffort: 'medium',
        }],
      }) as CliAdapter,
    });
    expect(body.reasoningEffortsByModel).toEqual({
      'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    });
    expect(body.modelCapabilities).toEqual([
      { slug: 'gpt-6.1-sol', serviceTiers: ['priority'] },
    ]);
    expect(JSON.stringify(body)).not.toContain('defaultReasoningEffort');
  });

  it('wrapper 选择保留旧 slug 目录但不暴露未经真实 wrapper 证明的档位', async () => {
    const body = await buildModelChoicesResponse('cjadk-x-codex', {
      adapterFactory: () => fakeAdapter(undefined, async () => [
        { slug: 'gateway-model', serviceTiers: ['priority'] },
      ]),
    });
    expect(body.models).toContain('gateway-model');
    expect(body).not.toHaveProperty('modelCapabilities');
  });
});
