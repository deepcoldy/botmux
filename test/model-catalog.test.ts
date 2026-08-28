import { describe, expect, it } from 'vitest';
import {
  MODEL_DETECT_TTL_MS,
  buildModelChoicesResponse,
  createModelCatalog,
  detectModels,
  mergeModelChoices,
  staticModelChoices,
} from '../src/services/model-catalog.js';
import { TTADK_MODEL_SUGGESTIONS } from '../src/setup/cli-selection.js';
import type { CliAdapter } from '../src/adapters/cli/types.js';

/** 只带 detectModels 的最小适配器 fake（其余字段本服务不碰）。 */
function fakeAdapter(detect: (() => Promise<readonly string[] | null>) | undefined): CliAdapter {
  return { detectModels: detect } as unknown as CliAdapter;
}

describe('staticModelChoices（静态候选，shell-free）', () => {
  it('claude-code 返回非空候选且含 sonnet', () => {
    const models = staticModelChoices('claude-code');
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain('sonnet');
  });

  it('codex 返回其静态候选', () => {
    const models = staticModelChoices('codex');
    expect(models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2']);
  });

  it('codex-app 与 codex 共享同一模型目录快照', () => {
    expect(staticModelChoices('codex-app')).toEqual(staticModelChoices('codex'));
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

describe('mergeModelChoices（合并去重）', () => {
  it('静态在前、live 增量追加在后，整体去重保序', () => {
    const { models, source } = mergeModelChoices(['a', 'b', 'a'], ['b', 'c', 'd']);
    expect(models).toEqual(['a', 'b', 'c', 'd']);
    expect(source).toBe('live');
  });

  it('live 与静态完全重叠时仍标 live（live 非空即 live）', () => {
    const { models, source } = mergeModelChoices(['a', 'b'], ['b']);
    expect(models).toEqual(['a', 'b']);
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
  it('适配器无 detectModels（claude-code）→ null', async () => {
    expect(await detectModels('claude-code')).toBeNull();
  });

  it('ttadk 网关项（ttadk-x-claude）→ null（模型由网关建议列表承载）', async () => {
    expect(await detectModels('ttadk-x-claude')).toBeNull();
    expect(await detectModels('ttadk-x-coco')).toBeNull();
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

  it('live 非空：静态在前 live 增量在后，source=live，detectedAt 取注入时钟', async () => {
    // 用注入 factory 避免真实 shell out；key 取 gemini（本文件其它用例不在模块级
    // 单例上碰它，故单例缓存残留不影响其它断言）。
    const factory = () => fakeAdapter(async () => ['gemini-2.5-flash', 'brand-new-model']);
    const body = await buildModelChoicesResponse('gemini', { now: () => 99_000, adapterFactory: factory });
    expect(body.models[0]).toBe('gemini-2.5-pro'); // 静态候选保持在前
    expect(body.models).toContain('gemini-2.5-flash'); // 静态已有 → 去重
    expect(body.models).toContain('brand-new-model'); // live 增量追加
    expect(body.source).toBe('live');
    expect(body.detectedAt).toBe(99_000);
  });
});
