/**
 * parseDebugModelsJson —— traex / codex / coco 的 `debug models` JSON 目录
 * 共享解析（src/adapters/cli/model-catalog-json.ts）。
 * 三个适配器的 detectModels 都复用它，过滤/容错行为在这里统一覆盖。
 */
import { describe, it, expect } from 'bun:test';
import { parseDebugModelsJson } from '../src/adapters/cli/model-catalog-json.js';

const REAL_SHAPE = (models: unknown[]) => JSON.stringify({ models });
const modelEntry = (slug: string, visibility: string = 'list') => ({
  slug,
  description: `model ${slug}`,
  visibility,
  supported_in_api: true,
});

describe('parseDebugModelsJson', () => {
  it('真实 shape：两个 visibility=list 模型 → 按原顺序返回 slug', () => {
    const out = parseDebugModelsJson(
      REAL_SHAPE([modelEntry('Seed-Evolving'), modelEntry('gpt-5.5')]),
    );
    expect(out).toEqual(['Seed-Evolving', 'gpt-5.5']);
  });

  it('过滤 visibility !== "list" 的模型（hidden / 缺字段）', () => {
    const out = parseDebugModelsJson(
      REAL_SHAPE([
        modelEntry('visible-1', 'list'),
        modelEntry('secret', 'hidden'),
        modelEntry('visible-2', 'list'),
        { slug: 'no-visibility', description: 'x' },
      ]),
    );
    expect(out).toEqual(['visible-1', 'visible-2']);
  });

  it('models 为空数组 → []', () => {
    expect(parseDebugModelsJson(REAL_SHAPE([]))).toEqual([]);
  });

  it('非法 JSON → []（不抛）', () => {
    expect(parseDebugModelsJson('not json at all')).toEqual([]);
    expect(parseDebugModelsJson('{"models": [')).toEqual([]);
  });

  it('models 不是数组 / 顶层非对象 → []', () => {
    expect(parseDebugModelsJson('{"models": "nope"}')).toEqual([]);
    expect(parseDebugModelsJson('{"models": null}')).toEqual([]);
    expect(parseDebugModelsJson('null')).toEqual([]);
    expect(parseDebugModelsJson('123')).toEqual([]);
  });

  it('元素缺 slug / slug 非字符串 / 非对象元素 → 跳过非法元素，保留合法的', () => {
    // 设计选择：跳过非法元素而非整体返回 [] —— 一条坏数据不应让整个模型
    // 目录在 picker 里不可选。
    const out = parseDebugModelsJson(
      REAL_SHAPE([
        modelEntry('good-1'),
        { description: 'no slug', visibility: 'list' },
        { slug: 42, visibility: 'list' },
        { slug: '', visibility: 'list' },
        'not-an-object',
        null,
        modelEntry('good-2'),
      ]),
    );
    expect(out).toEqual(['good-1', 'good-2']);
  });
});
