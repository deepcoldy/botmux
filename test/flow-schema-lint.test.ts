/**
 * JSON Schema 子集校验器（§4.7）与脚本静态检查（§10）。
 */
import { describe, expect, it } from 'vitest';
import { SchemaInvalidError, assertSchema, extractLastJsonBlock, validateValue } from '../src/flow/schema.js';
import { lintScript, stripCommentsAndStrings, transformDefaultExport } from '../src/flow/script-lint.js';

describe('schema 子集校验器', () => {
  const slogan = { type: 'object', required: ['slogan'], properties: { slogan: { type: 'string', minLength: 1 } }, additionalProperties: false };

  it('接受子集内的 schema，拒绝 pattern / $ref / 元组 items / 过深', () => {
    expect(assertSchema(slogan)).toBeGreaterThan(0);
    expect(() => assertSchema({ type: 'string', pattern: '^a' })).toThrow(SchemaInvalidError);
    expect(() => assertSchema({ $ref: '#/x' })).toThrow(/unsupported keyword/);
    expect(() => assertSchema({ type: 'array', items: [{ type: 'string' }] })).toThrow(/tuple/);
    expect(() => assertSchema({ type: 'weird' })).toThrow(/unknown type/);
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 40; i++) deep = { type: 'object', properties: { x: deep } };
    expect(() => assertSchema(deep)).toThrow(/deeper/);
    expect(() => assertSchema({ type: 'string', description: 'x'.repeat(40_000) })).toThrow(/bytes/);
  });

  it('按 type / required / additionalProperties / items / enum / const / 范围 校验值', () => {
    expect(validateValue(slogan, { slogan: 'hi' })).toEqual([]);
    expect(validateValue(slogan, { slogan: '' }).map((i) => i.path)).toEqual(['$.slogan']);
    expect(validateValue(slogan, { slogan: 'x', extra: 1 }).map((i) => i.path)).toEqual(['$.extra']);
    expect(validateValue(slogan, {}).map((i) => i.message)).toEqual(['missing required property "slogan"']);
    expect(validateValue(slogan, 'nope')).toHaveLength(1);
    const pick = { type: 'object', required: ['index'], properties: { index: { type: 'integer', minimum: 1, maximum: 3 } } };
    expect(validateValue(pick, { index: 2 })).toEqual([]);
    expect(validateValue(pick, { index: 2.5 })).toHaveLength(1);
    expect(validateValue(pick, { index: 0 })).toHaveLength(1);
    expect(validateValue({ type: 'array', items: { enum: ['a', 'b'] } }, ['a', 'c']).map((i) => i.path)).toEqual(['$[1]']);
    expect(validateValue({ const: { k: [1, 2] } }, { k: [1, 2] })).toEqual([]);
    expect(validateValue({ const: { k: [1, 2] } }, { k: [2, 1] })).toHaveLength(1);
    expect(validateValue({ type: ['string', 'null'] }, null)).toEqual([]);
    expect(validateValue({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 3)).toEqual([]);
    expect(validateValue({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 3).map((i) => i.message)).toEqual(['matches 2 of oneOf, expected exactly 1']);
    expect(validateValue(true, 'anything')).toEqual([]);
    expect(validateValue(false, 'anything')).toHaveLength(1);
  });

  it('从回复文本里取最后一个平衡 JSON 块', () => {
    expect(extractLastJsonBlock('Here you go:\n```json\n{"slogan":"a"}\n```\nDone.')).toEqual({ slogan: 'a' });
    expect(extractLastJsonBlock('first {"a":1} then {"b":[1,{"c":"}"}]}')).toEqual({ b: [1, { c: '}' }] });
    expect(extractLastJsonBlock('I said "hello {world}" and then\n{"ok":true}')).toEqual({ ok: true });
    expect(extractLastJsonBlock('see [note] and {"x":1}')).toEqual({ x: 1 });
    expect(extractLastJsonBlock('{"x":1} trailing [not json]')).toEqual({ x: 1 });
    expect(extractLastJsonBlock('no json here')).toBeNull();
    expect(extractLastJsonBlock('{"unclosed": 1')).toBeNull();
  });
});

describe('脚本静态检查', () => {
  const good = `
// slogan.mjs
export default async function (ctx) {
  const { input, parallel, agent } = ctx;
  const drafts = await parallel(['a', 'b'].map((tone) => (c) => c.agent({
    cli: 'claude-code',
    prompt: \`Use setTimeout? No. Write one \${tone} slogan for \${input.topic}. Don't call process.exit or fetch()\`,
  })));
  /* Date is fine inside a comment; "Math.random" in a string too */
  return drafts.filter((d) => d.ok).map((d) => d.value);
}
`;

  it('合规脚本零问题；字符串、模板与注释里的关键字不误报', () => {
    expect(lintScript(good)).toEqual([]);
  });

  it('剥离器保留模板表达式内的代码并保留行号', () => {
    const src = 'const a = `x ${ b + "}" + `${c}` } y`;\n// tail\nfoo(`{`)';
    const stripped = stripCommentsAndStrings(src);
    expect(stripped.split('\n')).toHaveLength(3);
    expect(stripped).toContain('${ b + " " + `${c}` }');
    expect(stripped).not.toContain('tail');
  });

  it('逐条拒绝清单中的用法', () => {
    const bad = `
import fs from 'node:fs';
export const x = 1;
export default async (ctx) => {
  const t = Date.now() + Math.random() + performance.now();
  setTimeout(() => {}, 1);
  await Promise.all([ctx.agent({ cli: 'a', prompt: 'p' })]);
  ctx.agent({ cli: 'a', prompt: 'q' }).then(() => {});
  const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0);
  globalThis.exit(); process.env.X; eval('1'); new Function('x'); fetch('u'); require('fs');
  new WeakRef({}); new FinalizationRegistry(() => {}); queueMicrotask(() => {});
};
`;
    const rules = new Set(lintScript(bad).map((i) => i.rule));
    for (const rule of [
      'no-import', 'no-named-export', 'no-date', 'no-random', 'no-performance', 'no-timers', 'no-promise-combinators', 'no-then',
      'no-shared-memory', 'no-globalThis', 'no-process', 'no-eval', 'no-function-ctor', 'no-fetch', 'no-require',
    ]) expect(rules, rule).toContain(rule);
    expect(lintScript('const a = 1;').map((i) => i.rule)).toEqual(['missing-default-export']);
    expect(lintScript('export default 1;\nexport default 2;').map((i) => i.rule)).toEqual(['single-default-export']);
    // 属性访问不算：obj.process / x.import 是合法的成员名
    expect(lintScript('export default async (ctx) => ctx.state.process + ctx.import;')).toEqual([]);
  });

  it('transformDefaultExport 只替换关键字，行号不变', () => {
    const out = transformDefaultExport(good, '__flow.main');
    expect(out).toContain('__flow.main = async function (ctx)');
    expect(out.split('\n')).toHaveLength(good.split('\n').length);
    expect(transformDefaultExport('export default (ctx) => 1', '__x')).toBe('__x = (ctx) => 1');
  });
});
