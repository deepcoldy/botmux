import { describe, expect, it, vi } from 'vitest';
import { bridgeMinimaxForm, bridgeMinimaxPermission, parseMinimaxForm } from '../src/services/minimax-user-input.js';
const context = { sessionId: 'botmux', larkAppId: 'app', chatId: 'chat', originTurnId: 'turn', env: {} };
const signal = () => new AbortController().signal;
const form = (properties: object, required: string[] = []) => ({ mode: 'form', sessionId: 'native', message: 'Choose', requestedSchema: { type: 'object', properties, required } });
const choice = (title = 'Strategy') => ({ type: 'string', title, oneOf: [{ const: 'safe-id', title: 'Safe', description: 'Check first' }, { const: 'fast-id', title: 'Fast' }] });
const answer = (answers: Record<string, string[]>) => ({ answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])) });
describe('mcode ACP questionnaire bridge', () => {
  it.each(['single', 'multi'] as const)('accepts every legal %s choice count and rejects 0, 21 and 22 before presenting a card', async kind => {
    const choices = Array.from({ length: 22 }, (_, i) => ({ const: `id-${i}`, title: `Choice ${i}` }));
    const field = (count: number) => kind === 'single'
      ? { type: 'string', oneOf: choices.slice(0, count) }
      : { type: 'array', items: { anyOf: choices.slice(0, count) } };
    const ask = vi.fn();
    for (let count = 1; count <= 20; count++) {
      ask.mockReset().mockResolvedValue(answer({ a: [`Choice ${count - 1}`] }));
      expect(parseMinimaxForm(form({ a: field(count) }, ['a'])).fields[0].options).toHaveLength(count);
      expect((await bridgeMinimaxForm(context, form({ a: field(count) }, ['a']), signal(), ask)).content)
        .toEqual({ a: kind === 'single' ? `id-${count - 1}` : [`id-${count - 1}`] });
      expect(ask.mock.calls[0][1].questions[0].options).toHaveLength(Math.max(2, count));
    }
    for (const count of [0, 21, 22]) {
      ask.mockClear();
      await expect(bridgeMinimaxForm(context, form({ a: field(count) }, ['a']), signal(), ask)).rejects.toThrow('不支持');
      expect(ask).not.toHaveBeenCalled();
    }
  });
  it('accepts 24 form fields and rejects 25 before presenting a card', () => {
    const properties = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`field-${i}`, { type: 'string' }]));
    expect(parseMinimaxForm(form(properties)).fields).toHaveLength(24);
    expect(() => parseMinimaxForm(form({ ...properties, extra: { type: 'string' } }))).toThrow('不支持');
  });
  it.each([0, 1, 2, 10, 11])('enforces native permission option bounds for %s options', async count => {
    const options = Array.from({ length: count }, (_, i) => ({ optionId: `option-${i}`, name: `Option ${i}` }));
    const ask = vi.fn().mockResolvedValue(answer({ permission: ['Option 0 (1)'] }));
    const run = bridgeMinimaxPermission(context, { options }, signal(), ask);
    if (count < 2 || count > 10) {
      await expect(run).rejects.toThrow('不支持');
      expect(ask).not.toHaveBeenCalled();
    } else {
      expect(await run).toEqual({ outcome: { outcome: 'selected', optionId: 'option-0' } });
      expect(ask).toHaveBeenCalledTimes(1);
    }
  });

  it('batches choices and sends native ids back, with no automatic selection', async () => {
    const ask = vi.fn().mockResolvedValue(answer({ approach: ['Safe'], checks: ['Unit', 'Smoke'] }));
    const result = await bridgeMinimaxForm(context, form({ approach: choice(), checks: { type: 'array', title: 'Checks', items: { anyOf: [{ const: 'unit-id', title: 'Unit' }, { const: 'smoke-id', title: 'Smoke' }] } } }, ['approach', 'checks']), signal(), ask);
    expect(result).toEqual({ action: 'accept', content: { approach: 'safe-id', checks: ['unit-id', 'smoke-id'] } });
    expect(ask).toHaveBeenCalledTimes(1);
    const params = ask.mock.calls[0][1];
    expect(params.questions[0].question).toContain('Check first');
    expect(params.questions[1].multiSelect).toBe(true);
    expect(params.questions[0].defaultSelectedKeys).toBeUndefined();
  });
  it('asks text fields individually so separate answers stay separate', async () => {
    const ask = vi.fn().mockResolvedValueOnce(answer({ a: ['one'] })).mockResolvedValueOnce(answer({ b: ['two'] }));
    expect(await bridgeMinimaxForm(context, form({ a: { type: 'string', title: 'A' }, b: { type: 'string', title: 'B' } }, ['a', 'b']), signal(), ask))
      .toEqual({ action: 'accept', content: { a: 'one', b: 'two' } });
  });
  it('collects native Other only when explicitly selected', async () => {
    const params = form({ approach: choice(), approach__other: { type: 'string', title: 'Strategy — Other' } });
    const ask = vi.fn().mockResolvedValueOnce(answer({ approach: ['填写其他答案'] })).mockResolvedValueOnce(answer({ approach__other: ['custom'] }));
    expect(await bridgeMinimaxForm(context, params, signal(), ask)).toEqual({ action: 'accept', content: { approach__other: 'custom' } });
    ask.mockReset().mockResolvedValue(answer({ approach: ['Safe'] }));
    expect(await bridgeMinimaxForm(context, params, signal(), ask)).toEqual({ action: 'accept', content: { approach: 'safe-id' } });
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it('preserves a custom text reply as Other for a single native choice, without assigning it to every question', async () => {
    const ask = vi.fn().mockResolvedValue(answer({ a: ['custom choice'] }));
    const params = form({ a: choice(), a__other: { type: 'string', title: 'Strategy — Other' } });
    expect((await bridgeMinimaxForm(context, params, signal(), ask)).content).toEqual({ a__other: 'custom choice' });
    ask.mockResolvedValue(answer({ a: ['same text'], b: ['same text'] }));
    await expect(bridgeMinimaxForm(context, form({ ...params.requestedSchema.properties, b: choice() }), signal(), ask)).rejects.toThrow('多题');
  });
  it('retains multi-select alongside a separate Other value', async () => {
    const params = form({ checks: { type: 'array', title: 'Checks', items: { anyOf: [{ const: 'unit', title: 'Unit' }, { const: 'smoke', title: 'Smoke' }] } }, checks__other: { type: 'string', title: 'Checks — Other' } });
    const ask = vi.fn().mockResolvedValueOnce(answer({ checks: ['Unit', '填写其他答案'] })).mockResolvedValueOnce(answer({ checks__other: ['manual'] }));
    expect((await bridgeMinimaxForm(context, params, signal(), ask)).content).toEqual({ checks: ['unit'], checks__other: 'manual' });
  });
  it('recognizes a collision-safe Other field without consuming a real text step with the original id', () => {
    const params = form({ a: choice(), a__other: { type: 'string', title: 'Real text step' }, a__other_: { type: 'string', title: 'Strategy — Other' } });
    const fields = parseMinimaxForm(params).fields;
    expect(fields.map(f => f.id)).toEqual(['a', 'a__other']);
    expect(fields[0].other?.id).toBe('a__other_');
  });
  it('allows an explicit skip for optional choices and text', async () => {
    const ask = vi.fn().mockResolvedValueOnce(answer({ a: ['跳过此项（可选）'] })).mockResolvedValueOnce(answer({ b: ['跳过'] }));
    expect((await bridgeMinimaxForm(context, form({ a: choice(), b: { type: 'string' } }), signal(), ask)).content).toEqual({});
  });
  it('fills optional text only after explicit selection', async () => {
    const ask = vi.fn().mockResolvedValueOnce(answer({ a: ['填写'] })).mockResolvedValueOnce(answer({ a: ['value'] }));
    expect((await bridgeMinimaxForm(context, form({ a: { type: 'string' } }), signal(), ask)).content).toEqual({ a: 'value' });
  });
  it('supports duplicate labels without confusing their native ids', async () => {
    const ask = vi.fn().mockResolvedValue(answer({ a: ['Same (2)'] }));
    const params = form({ a: { type: 'string', oneOf: [{ const: 'one', title: 'Same' }, { const: 'two', title: 'Same' }] } }, ['a']);
    expect((await bridgeMinimaxForm(context, params, signal(), ask)).content).toEqual({ a: 'two' });
  });
  it('handles prototype-looking field ids as ordinary data', async () => {
    const properties = JSON.parse('{"__proto__":{"type":"string"}}');
    const ask = vi.fn().mockResolvedValue({ answers: JSON.parse('{"__proto__":{"answers":["value"]}}') });
    const result = await bridgeMinimaxForm(context, form(properties, ['__proto__']), signal(), ask);
    expect(Object.hasOwn(result.content, '__proto__')).toBe(true);
    expect(result.content.__proto__).toBe('value');
  });
  it.each([
    {}, { mode: 'url' }, form({}), form({ a: { type: 'number' } }), form({ a: { type: 'string', pattern: 'x' } }),
    form({ a: { type: 'array', items: { anyOf: [] } } }), form({ a: { type: 'string', oneOf: [{ const: 'same' }, { const: 'same' }] } }),
    form({ a: choice() }, ['missing']), form({ a: { type: 'string', format: 'password' } }),
  ])('rejects unsupported forms before any card: %j', params => expect(() => parseMinimaxForm(params)).toThrow());
  it.each([answer({ a: ['unknown'] }), answer({ a: [] }), { answers: {} }])('does not accept an incomplete required answer: %j', result => {
    const ask = vi.fn().mockResolvedValue(result);
    return expect(bridgeMinimaxForm(context, form({ a: choice() }, ['a']), signal(), ask)).rejects.toThrow();
  });
  it('does not turn a cancelled/timed out Ask into accepted empty input', async () => {
    const ask = vi.fn().mockRejectedValue(new Error('ask not answered (timedOut)'));
    await expect(bridgeMinimaxForm(context, form({ a: choice() }, ['a']), signal(), ask)).rejects.toThrow('timedOut');
  });
  it('maps explicit permission selection back to the native permission id', async () => {
    const ask = vi.fn().mockResolvedValue(answer({ permission: ['Deny (2)'] }));
    expect(await bridgeMinimaxPermission(context, { toolCall: { title: 'Write' }, options: [{ optionId: 'allow', name: 'Allow' }, { optionId: 'deny', name: 'Deny' }] }, signal(), ask))
      .toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });
});
