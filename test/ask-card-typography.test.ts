import { describe, expect, it } from 'vitest';
import type { AskResult, PendingAsk } from '../src/core/ask-types.js';
import { buildAskCard } from '../src/im/lark/ask-card.js';
import { buildAskListBody, buildAskSettledBody, escapeQuestion, optionControls } from '../src/im/lark/ask-card-look.js';
import { buildTurnReplyAskElements } from '../src/im/lark/turn-reply-ask-elements.js';

const all = (value: unknown): any[] => value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(all)] : [];
const ask: PendingAsk = {
  askId: 'ask-typography', nonce: 'n', larkAppId: 'cli_typography', chatId: 'oc_chat', rootMessageId: 'om_root',
  sessionId: 'sess', originKind: 'hook', createdAt: 1_000, deadlineAt: 61_000, settled: false,
  questions: [{ prompt: '确认本次变更吗？\n只修改显示样式，不改变提交行为。', multiSelect: false,
    options: [{ key: 'yes', label: '同意本次变更（推荐）', description: '保留现有交互' }, { key: 'no', label: '暂不修改' }] }],
};
const selected: AskResult = { kind: 'answered', answers: [['yes']], by: 'ou_owner', comment: null, timedOut: false };
const labelLines = (card: unknown) => all(card).flatMap(n => n.tag === 'checker' ? [n.text.content]
  : n.tag === 'interactive_container' ? [n.elements[0].content] : []).map((s: string) => s.split('\n')[0]);

describe('Ask uses regular-weight questions and options', () => {
  it.each(['form', 'quick', 'input_form', 'embedded'] as const)('%s does not add bold to questions or labels', surface => {
    const current: PendingAsk = { ...ask, ...(surface === 'quick' ? { originKind: 'host_explicit' as const } : {}),
      questions: surface === 'input_form' ? [...ask.questions,
        { prompt: '补充说明', multiSelect: false, options: [], input: { type: 'text' } }] : ask.questions };
    const card = surface === 'embedded' ? buildTurnReplyAskElements({ ask: current }, 'zh') : JSON.parse(buildAskCard(current));
    expect(all(card).filter(n => n.text_size === 'heading').map(n => n.content))
      .toContain((surface === 'input_form' ? '1\\. ' : '') + '确认本次变更吗？');
    expect(labelLines(card)).toEqual(["同意本次变更 <text_tag color='green'>推荐</text_tag>", '暂不修改']);
    expect(JSON.stringify(card)).toContain('保留现有交互');
    expect(JSON.stringify(card)).toContain('只修改显示样式，不改变提交行为。');
  });

  it.each([
    selected,
    { kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true },
    { kind: 'invalidated', reason: 'session ended', selected: null, by: null, comment: null, timedOut: false },
  ] as AskResult[])('$kind keeps regular-weight questions and selected labels', result => {
    const card = JSON.parse(buildAskCard(ask, result));
    expect(all(card).find(n => n.text_size === 'heading').content).toBe('确认本次变更吗？');
    if (result.kind === 'answered') {
      expect(all(card).find(n => n.tag === 'markdown' && n.content.startsWith('✓ ')).content)
        .toBe("✓ 同意本次变更 <text_tag color='green'>推荐</text_tag>\n<font color='grey'>保留现有交互</font>");
    }
    expect(all(card).filter(n => n.tag === 'checker')).toEqual([]);
  });

  it('compact controls and list fallback do not reintroduce bold', () => {
    const compact = optionControls(ask.questions[0], 0, new Set(['yes']), 'zh', 'compact', Infinity);
    expect(labelLines(compact.elements)).toEqual(["同意本次变更 <text_tag color='green'>推荐</text_tag>", '暂不修改']);
    expect(all(compact.elements).filter(n => n.tag === 'checker').map(c => c.checked)).toEqual([true, false]);
    const options = { locale: 'zh' as const, prompt: escapeQuestion, descriptionCap: Infinity };
    const list = buildAskListBody(ask, options).elements[0].content;
    expect(list).toContain('确认本次变更吗？\n只修改显示样式，不改变提交行为。');
    expect(list).toContain('• 同意本次变更');
    expect(list).not.toContain('**');
    expect(buildAskSettledBody(ask, selected, { ...options, density: 'list' }).elements[0].content).not.toContain('**');
  });

  it('literal Markdown stays escaped while a question link stays clickable', () => {
    const current = { ...ask, questions: [{ ...ask.questions[0], prompt: '**plain** [details](https://example.com/details)',
      options: [{ key: 'yes', label: '**literal**' }, { key: 'no', label: 'no' }] }] };
    const card = JSON.parse(buildAskCard(current));
    expect(all(card).find(n => n.text_size === 'heading').content)
      .toBe('\\*\\*plain\\*\\* [details](https://example.com/details)');
    expect(labelLines(card)).toEqual(['\\*\\*literal\\*\\*', 'no']);
  });
});
