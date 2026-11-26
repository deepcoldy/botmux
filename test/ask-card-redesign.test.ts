import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetForTest, getAskSnapshot, registerAsk, setCanTalkChecker, setCardDispatcher } from '../src/core/ask-broker.js';
import type { AskQuestion, AskResult, CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
import claude from '../src/core/ask-hook/claude-code.js';
import { buildAskCard, handleAskCardAction, renderAskCard } from '../src/im/lark/ask-card.js';
import { buildTurnReplyAskElements } from '../src/im/lark/turn-reply-ask-elements.js';
import { askReplyHint } from '../src/im/lark/ask-card-look.js';
import { buildTurnReplyCard } from '../src/im/lark/turn-reply-card.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../src/im/lark/turn-reply-card-size.js';
import type { TurnReplyCardRecord } from '../src/services/turn-reply-card.js';
import { setDefaultLocale, t, type Locale } from '../src/i18n/index.js';
import { logger } from '../src/utils/logger.js';

// Element limit Feishu documents for one Card JSON 2.0 card (text objects included).
const FEISHU_CARD_ELEMENT_LIMIT = 200;

const all = (value: unknown): any[] => value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(all)] : [];
const tagged = (value: unknown) => all(value).filter(node => !Array.isArray(node) && typeof node.tag === 'string').length;
const checkers = (card: unknown) => all(card).filter(n => n.tag === 'checker');
const callbackOf = (node: any) => node.value ?? node.behaviors?.find((b: any) => b.type === 'callback')?.value;
const submitOf = (card: unknown) => callbackOf(all(card).find(n => n.tag === 'button' && n.form_action_type === 'submit'));
/** First line of each option row: what the label shows. */
const labelLines = (card: unknown) => all(card).flatMap(n => n.tag === 'checker' ? [n.text.content]
  : n.tag === 'interactive_container' ? [n.elements[0].content] : []).map((content: string) => content.split('\n')[0]);

let sent: PendingAsk[];
beforeEach(() => {
  _resetForTest(); sent = [];
  setCardDispatcher({ async send(ask) { sent.push(ask); return { messageId: 'om_card' }; } });
  setCanTalkChecker((_app, _chat, by) => by === 'ou_owner');
});
afterEach(() => { _resetForTest(); vi.restoreAllMocks(); });

const base: Omit<CreateAskInput, 'questions'> = {
  larkAppId: 'cli_redesign', chatId: 'oc_chat', rootMessageId: 'om_root', sessionId: 'sess', timeoutMs: 60_000,
};
const single = (over: Partial<AskQuestion> = {}): AskQuestion => ({ prompt: '去几天？', multiSelect: false,
  options: [{ key: 'one', label: '当天' }, { key: 'two', label: '两天' }, { key: 'three', label: '三天' }], ...over });
const multi = (over: Partial<AskQuestion> = {}): AskQuestion => ({ prompt: '玩什么？', multiSelect: true,
  options: [{ key: 'hike', label: '徒步' }, { key: 'park', label: '乐园' }, { key: 'food', label: '美食' }], ...over });

async function open(questions: AskQuestion[], over: Partial<CreateAskInput> = {}) {
  const answer = registerAsk({ ...base, originKind: 'hook', ...over, questions });
  await Promise.resolve();
  const ask = sent.at(-1)!;
  return { ask, answer, card: JSON.parse(buildAskCard(ask)) };
}
function submit(ask: PendingAsk, value: Record<string, unknown>, formValue: unknown, by = 'ou_owner') {
  return handleAskCardAction({ operator: { open_id: by },
    action: { value: { ask_id: ask.askId, nonce: ask.nonce, ...value } as Record<string, unknown>, form_value: formValue } }) as Promise<any>;
}

describe('推荐标记：卡片上换成「推荐」标签，答案仍是原始选项', () => {
  it.each([
    ['带小孩（推荐）'], ['带小孩(推荐)'], ['带小孩 (Recommended)'], ['带小孩（recommended）'], ['带小孩 ( 推荐 ) '],
  ])('%s → 标签去掉标记并带推荐标签', async label => {
    const { card } = await open([single({ options: [{ key: label, label }, { key: 'b', label: '带老人' }] })]);
    const [first, second] = checkers(card);
    expect(first.text.content.split('\n')[0]).toBe(`带小孩 <text_tag color='green'>${t('card.ask.recommended')}</text_tag>`);
    expect(second.text.content).not.toContain('text_tag');
  });

  it('多选里每个推荐项各带一个标签；defaultSelectedKeys 里的项也带标签并预先勾上', async () => {
    const { card } = await open([multi({ options: [
      { key: 'hike', label: '徒步（推荐）' }, { key: 'park', label: '乐园' }, { key: 'food', label: '美食 (Recommended)' },
      { key: 'spa', label: '泡温泉' },
    ], defaultSelectedKeys: ['park'] })]);
    const rows = checkers(card);
    expect(rows.map(row => row.text.content.includes('text_tag'))).toEqual([true, true, true, false]);
    expect(rows.map(row => row.checked)).toEqual([false, true, false, false]);
    expect(labelLines(card).map(line => line.replace(/ <text_tag.*$/, ''))).toEqual(['徒步', '乐园', '美食', '泡温泉']);
  });

  it('只有标记本身的标签不会被删成空白', async () => {
    const { card } = await open([single({ options: [{ key: 'x', label: '（推荐）' }, { key: 'y', label: '其他' }] })]);
    expect(labelLines(card)[0]).toContain('（推荐）');
  });

  it('提交后回给 Claude Code 的仍是原始标签（含标记），不是卡片上显示的文字', async () => {
    const question = single({ prompt: '同行？', options: [{ key: '带小孩 (Recommended)', label: '带小孩 (Recommended)' }, { key: '带老人', label: '带老人' }] });
    const { ask, answer } = await open([question]);
    await submit(ask, submitOf(JSON.parse(buildAskCard(ask))), { opt_0_0: true, opt_0_1: false, custom_0: '' });
    const result = await answer;
    expect(result).toMatchObject({ kind: 'answered', answers: [['带小孩 (Recommended)']] });
    const parsed = { questions: [question], raw: { tool_input: { questions: [{ question: '同行？' }] } } } as any;
    const out = JSON.parse(claude.formatAnswer((result as any).answers, parsed, null, (result as any).customAnswers));
    expect(out.hookSpecificOutput.updatedInput.answers).toEqual({ '同行？': '带小孩 (Recommended)' });
  });
});

describe('一次提交：勾选框的值读法', () => {
  it.each([
    ['布尔', { opt_0_0: false, opt_0_1: true, opt_0_2: false }],
    ['字符串', { opt_0_0: 'false', opt_0_1: 'true', opt_0_2: 'false' }],
    ['数字与大小写', { opt_0_0: 0, opt_0_1: 'TRUE', opt_0_2: '0' }],
    ['带 checked 的对象', { opt_0_0: { checked: false }, opt_0_1: { checked: true } }],
    ['未勾的项缺省不传', { opt_0_1: true }],
  ])('%s：读出勾选的那一项', async (_shape, fields) => {
    const { ask, answer } = await open([single()]);
    const response = await submit(ask, submitOf(JSON.parse(buildAskCard(ask))), { ...fields, custom_0: '' });
    expect(response.header.template).toBe('green');
    expect(await answer).toMatchObject({ kind: 'answered', answers: [['two']] });
  });

  it.each([
    ['数组', ['opt_0_1']], ['看不懂的字符串', 'maybe'], ['没有 checked 的对象', { value: true }],
  ])('读不懂的形状（%s）不猜：不作答、提示改在对话里回复、记录字段类型', async (_shape, raw) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { ask } = await open([single()]);
    const response = await submit(ask, submitOf(JSON.parse(buildAskCard(ask))), { opt_0_0: false, opt_0_1: raw, custom_0: '' });
    expect(response).toEqual({ toast: { type: 'warning', content: t('card.ask.toast.unreadable') } });
    expect(getAskSnapshot(ask.askId)?.settled).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).toContain('opt_0_1');
  });

  it('引用不存在的选项或题号 → 视为失效卡片，不作答', async () => {
    const { ask } = await open([single()]);
    for (const field of ['opt_0_9', 'opt_3_0', 'opt_00_1']) {
      const response = await submit(ask, submitOf(JSON.parse(buildAskCard(ask))), { [field]: true, custom_0: '' });
      expect(response.toast.content).toBe(t('card.ask.toast.stale'));
    }
    expect(getAskSnapshot(ask.askId)?.settled).toBe(false);
  });
});

describe('一次提交：每题规则（toast 说明第几题，卡片与已勾内容不动）', () => {
  const twoQuestions = [single(), multi()];
  const toastFor = (key: string, n: number) => ({ toast: { type: 'warning', content: t(key, { n }) } });

  it('单选勾了两项 → 提示第 1 题只能勾一项', async () => {
    const { ask, card } = await open(twoQuestions);
    const response = await submit(ask, submitOf(card), { opt_0_0: true, opt_0_1: true, opt_1_0: true, custom_0: '', custom_1: '' });
    expect(response).toEqual(toastFor('card.ask.toast.too_many', 1));
    expect(getAskSnapshot(ask.askId)?.settled).toBe(false);
  });

  it('必答的单选没勾也没写 → 提示第 1 题还没回答', async () => {
    const { ask, card } = await open(twoQuestions);
    const response = await submit(ask, submitOf(card), { opt_1_0: true, custom_0: '', custom_1: '' });
    expect(response).toEqual(toastFor('card.ask.toast.unanswered', 1));
  });

  it.each([
    ['单选', { opt_0_1: true, custom_0: '  带一只狗  ', opt_1_0: true, custom_1: '' }, [['two'], ['hike']], ['带一只狗', null]],
    ['多选', { opt_0_1: true, custom_0: '', opt_1_0: true, opt_1_2: true, custom_1: '还想看海' }, [['two'], ['hike', 'food']], [null, '还想看海']],
  ])('%s题勾了选项又写了字 → 选项照常作答，写的字作为该题备注', async (_kind, fields, answers, notes) => {
    const { ask, answer, card } = await open(twoQuestions);
    const response = await submit(ask, submitOf(card), fields);
    expect(response.header.template).toBe('green');
    const result = await answer;
    expect(result).toMatchObject({ kind: 'answered', answers, notes });
    expect(result).not.toHaveProperty('customAnswers');
  });

  it('输入框的提示写明它既是备注、也是都不合适时的答案', async () => {
    const { card } = await open([single()]);
    expect(all(card).find(n => n.tag === 'input').placeholder.content).toBe(t('card.ask.custom_placeholder'));
  });

  it('只写不勾：自写内容作为该题答案，其它题照常', async () => {
    const { ask, answer, card } = await open(twoQuestions);
    await submit(ask, submitOf(card), { opt_0_2: true, custom_0: '', custom_1: '  还想看海  ' });
    const result = await answer;
    expect(result).toMatchObject({ kind: 'answered', answers: [['three'], []], customAnswers: [null, '还想看海'] });
    expect(result).not.toHaveProperty('notes');
  });

  it('多选可以多勾，答案按选项顺序', async () => {
    const { ask, answer, card } = await open(twoQuestions);
    await submit(ask, submitOf(card), { opt_1_2: true, opt_0_0: true, opt_1_0: true, custom_0: '', custom_1: '' });
    expect(await answer).toMatchObject({ answers: [['one'], ['hike', 'food']] });
  });

  it('鉴权与 nonce 先于规则：坏 nonce 得到「失效」，无权的人拿不到规则提示', async () => {
    const { ask, card } = await open(twoQuestions);
    const invalid = { opt_0_0: true, opt_0_1: true, custom_0: '', custom_1: '' };
    expect((await submit({ ...ask, nonce: 'old' }, { ...submitOf(card), nonce: 'old' }, invalid)).toast.content).toBe(t('card.ask.toast.stale'));
    const stranger = await submit(ask, submitOf(card), invalid, 'ou_stranger');
    expect(stranger.toast.content).not.toBe(t('card.ask.toast.too_many', { n: 1 }));
    expect(getAskSnapshot(ask.askId)?.settled).toBe(false);
  });

  it('卡片显示的草稿版本过期 → 用当前草稿重绘并提示', async () => {
    const { ask, card } = await open(twoQuestions);
    const response = await submit(ask, { ...submitOf(card), revision: '5' }, { opt_0_0: true, custom_0: '', custom_1: '' });
    expect(response.toast.content).toBe(t('card.ask.toast.draft_conflict'));
    expect(response.card.type).toBe('raw');
    expect(getAskSnapshot(ask.askId)?.settled).toBe(false);
  });
});

describe('一次提交：全空的多选先确认', () => {
  it('预选的项被取消后全空提交 → 重绘的确认卡里不再勾着预选，确认后以空作答', async () => {
    const { ask, answer, card } = await open([multi({ defaultSelectedKeys: ['hike', 'food'] })]);
    expect(checkers(card).map(c => c.checked)).toEqual([true, false, true]);
    const armed = await submit(ask, submitOf(card), { opt_0_0: false, opt_0_1: false, opt_0_2: false, custom_0: '' });
    expect(armed.toast.content).toBe(t('card.ask.toast.empty_confirm_needed'));
    expect(checkers(armed.card.data).map((c: any) => c.checked)).toEqual([false, false, false]);
    const confirm = submitOf(armed.card.data);
    expect(confirm.confirm_empty).toBe('true');
    expect(all(armed.card.data).find(n => n.tag === 'button').type).toBe('danger_filled');
    await submit(ask, confirm, { opt_0_0: false, opt_0_1: false, opt_0_2: false, custom_0: '' });
    expect(await answer).toMatchObject({ kind: 'answered', answers: [[]] });
  });
});

describe('不支持自填的提问（宿主审批等）', () => {
  const closed = { originKind: 'host_explicit' };

  it('多题时仍是勾选框 + 一次提交，但没有输入框；带输入值的提交被拒', async () => {
    const { ask, answer, card } = await open([single({ allowCustom: false }), multi({ allowCustom: false })], closed);
    expect(all(card).filter(n => n.tag === 'input')).toEqual([]);
    const value = submitOf(card);
    expect(value).not.toHaveProperty('revision');
    const injected = await submit(ask, value, { opt_0_0: true, custom_0: 'free text' });
    expect(injected.toast.type).toBe('warning');
    expect(getAskSnapshot(ask.askId)?.settled).toBe(false);
    await submit(ask, value, { opt_0_0: true, opt_1_1: true });
    expect(await answer).toMatchObject({ kind: 'answered', answers: [['one'], ['park']] });
  });

  it.each([
    ['缺失', undefined], ['字符串', 'opt_0_0=true'], ['数组', ['opt_0_0']], ['null', null], ['数字', 1],
  ])('顶层 form_value 为%s时不猜成全不勾：普通提交与空提交确认都拒收', async (_shape, formValue) => {
    const { ask, card } = await open([multi({ allowCustom: false })], closed);
    const submitValue = submitOf(card);
    for (const value of [submitValue, { ...submitValue, confirm_empty: 'true' }]) {
      const response = await submit(ask, value, formValue);
      expect(response).toEqual({ toast: { type: 'warning', content: t('card.ask.toast.unreadable') } });
      expect(getAskSnapshot(ask.askId)).toMatchObject({ settled: false });
      expect(getAskSnapshot(ask.askId)?.result).toBeUndefined();
    }
  });

  it('空对象仍是可读的全不勾：照常经过空提交确认后作答', async () => {
    const { ask, answer, card } = await open([multi({ allowCustom: false })], closed);
    const armed = await submit(ask, submitOf(card), {});
    expect(armed.toast.content).toBe(t('card.ask.toast.empty_confirm_needed'));
    await submit(ask, submitOf(armed.card.data), {});
    expect(await answer).toMatchObject({ kind: 'answered', answers: [[]] });
  });

  it('单问单选、无预选 → 点一下即提交；有预选 → 改为勾选 + 提交', async () => {
    const quick = (await open([single({ allowCustom: false })], closed)).card;
    expect(all(quick).filter(n => n.tag === 'interactive_container').map(callbackOf).map((v: any) => v.action))
      .toEqual(['ask_select', 'ask_select', 'ask_select']);
    expect(all(quick).some(n => n.tag === 'form')).toBe(false);
    const withDefault = (await open([single({ allowCustom: false, defaultSelectedKeys: ['two'] })], closed)).card;
    expect(all(withDefault).some(n => n.tag === 'interactive_container')).toBe(false);
    expect(checkers(withDefault).map(c => c.checked)).toEqual([false, true, false]);
  });

  it('点一下即提交的卡点完直接换成已提交的卡', async () => {
    const { ask, answer, card } = await open([single({ allowCustom: false })], closed);
    const row = all(card).filter(n => n.tag === 'interactive_container')[2];
    const response: any = await handleAskCardAction({ operator: { open_id: 'ou_owner' }, action: { value: callbackOf(row) } });
    expect(response.header).toMatchObject({ template: 'green', title: { content: t('card.ask.header.answered') } });
    expect(await answer).toMatchObject({ answers: [['three']] });
    expect(ask.askId).toBe(callbackOf(row).ask_id);
  });
});

describe('题目形态', () => {
  it('文字题：只有一个输入框（不是「都不合适」的占位）；单题不编号，多题编号', async () => {
    const { card } = await open([{ prompt: '补充说明', multiSelect: false, options: [], inputMode: 'text' }, single()],
      { originKind: 'native-user-input' });
    const inputs = all(card).filter(n => n.tag === 'input');
    expect(inputs.map(n => [n.name, n.placeholder.content])).toEqual([
      ['custom_0', t('card.ask.text_placeholder')], ['custom_1', t('card.ask.custom_placeholder')]]);
    const headings = all(card).filter(n => n.text_size === 'heading').map(n => n.content);
    expect(headings).toEqual(['1\\. 补充说明', '2\\. 去几天？']);
    const one = (await open([single()])).card;
    expect(all(one).filter(n => n.text_size === 'heading').map(n => n.content)).toEqual(['去几天？']);
  });

  it('多行问题：第一行是大字标题，其余行正常大小紧随其后', async () => {
    const { card } = await open([single({ prompt: '要发布吗？\n改动：修复登录\n影响：全部用户' })]);
    const column = all(card).find(n => n.tag === 'column' && n.elements.some((e: any) => e.text_size === 'heading'));
    const at = column.elements.findIndex((e: any) => e.text_size === 'heading');
    expect(column.elements[at].content).toBe('要发布吗？');
    expect(column.elements[at + 1]).toMatchObject({ tag: 'markdown', text_size: 'normal', content: '改动：修复登录\n影响：全部用户' });
  });

  it('自写过的题重绘时：输入框带着内容，该题选项都不勾', async () => {
    const { ask } = await open([single()]);
    const card = JSON.parse(buildAskCard({ ...ask, selections: [['one']], customAnswers: ['自己写的'] }));
    expect(all(card).find(n => n.tag === 'input').default_value).toBe('自己写的');
    expect(checkers(card).every(c => !c.checked)).toBe(true);
  });
});

describe('已结束的卡', () => {
  const questions = [single({ options: [{ key: 'one', label: '当天（推荐）', description: '不用订住宿' }, { key: 'two', label: '两天' }] }), multi()];
  const ask = (): PendingAsk => ({ askId: 'ask-s', nonce: 'n', larkAppId: 'cli_redesign', chatId: 'oc_chat', rootMessageId: 'om_root',
    sessionId: 'sess', originKind: 'hook', questions, createdAt: 1_000, deadlineAt: 61_000, settled: true });
  const answerLines = (card: unknown) => all(card).filter(n => n.tag === 'markdown' && /^✓ |<font color='grey'>/.test(n.content)
    && !n.text_size).map(n => n.content);

  it('已提交：绿色，每题保留问题，答案为 ✓ 选项（去掉推荐标记，带说明）或自己写的内容；未选的多选写明未选择', () => {
    const answered: AskResult = { kind: 'answered', answers: [['one'], []], by: 'ou_owner', comment: null, timedOut: false };
    const card = JSON.parse(buildAskCard(ask(), answered));
    expect(card.header).toMatchObject({ template: 'green', title: { content: t('card.ask.header.answered') } });
    expect(all(card).filter(n => n.text_size === 'heading').map(n => n.content)).toEqual(['1\\. 去几天？', '2\\. 玩什么？']);
    const lines = answerLines(card);
    expect(lines[0]).toMatch(/^✓ 当天 <text_tag[^>]*>.*<\/text_tag>\n<font color='grey'>不用订住宿<\/font>$/);
    expect(lines[1]).toContain(t('card.ask.answer.none'));
    const custom = JSON.parse(buildAskCard(ask(), { ...answered, answers: [[], ['hike']], customAnswers: ['<b>周末</b>', null] }));
    expect(answerLines(custom)).toEqual(['✓ &lt;b&gt;周末&lt;/b&gt;', '✓ 徒步']);
    expect(all(card).filter(n => n.behaviors || ['button', 'checker', 'input', 'form'].includes(n.tag))).toEqual([]);
  });

  it('勾了选项又写了备注：✓ 选项之后跟一行「备注：…」（备注按原文显示，不当标记）', () => {
    const withNotes: AskResult = { kind: 'answered', answers: [['two'], ['hike', 'food']], notes: ['带一只*狗*', null],
      by: 'ou_owner', comment: null, timedOut: false };
    const lines = answerLines(JSON.parse(buildAskCard(ask(), withNotes)));
    expect(lines[0]).toBe(`✓ 两天\n${t('card.ask.note_line', { note: '带一只\\*狗\\*' })}`);
    expect(lines[1]).toBe('✓ 徒步\n✓ 美食');
  });

  it('提交人显示成飞书里的名字（只展示、不 @ 人），不是一串 open_id；非飞书用户 id 照原文', () => {
    const answered = (by: string): AskResult => ({ kind: 'answered', answers: [['one'], []], by, comment: null, timedOut: false });
    const footer = (by: string) => JSON.parse(buildAskCard(ask(), answered(by))).body.elements.at(-1).content as string;
    const human = footer('ou_75dd0123456789abcdef');
    expect(human).toContain("<person id='ou_75dd0123456789abcdef' show_name=true show_avatar=false style='normal'></person>");
    expect(human).not.toContain('<at');
    expect(human.replace(/<person[^>]*><\/person>/, '')).not.toContain('ou_75dd');
    expect(footer('desktop')).toContain('desktop');
    expect(footer('desktop')).not.toContain('<person');
    // Anything that is not a plain open_id never becomes markup.
    expect(footer("ou_x' show_name=false")).not.toContain('<person');
  });

  it.each([
    ['已超时', { kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true }, 'card.ask.header.timed_out'],
    ['已失效', { kind: 'invalidated', reason: 'session ended', selected: null, by: null, comment: null, timedOut: false }, 'card.ask.header.invalidated'],
  ] as Array<[string, AskResult, string]>)('%s：灰色标题，题目仍在，没有作答行', (_name, result, title) => {
    const card = JSON.parse(buildAskCard(ask(), result));
    expect(card.header).toMatchObject({ template: 'grey', title: { content: t(title) } });
    expect(all(card).filter(n => n.text_size === 'heading')).toHaveLength(2);
    expect(answerLines(card)).toEqual([]);
  });
});

describe('Claude 权限确认卡', () => {
  const permissionQuestions = () => claude.parsePermissionRequest!({
    hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' },
  })!.questions;
  const permissionAsk = (settled: boolean): PendingAsk => ({ askId: 'ask-p', nonce: 'n', larkAppId: 'cli_redesign', chatId: 'oc_chat',
    rootMessageId: 'om_root', sessionId: 'sess', originKind: 'hook', questions: permissionQuestions(), createdAt: 1_000, deadlineAt: 61_000, settled });
  const inLocale = <T,>(locale: Locale, fn: () => T): T => { setDefaultLocale(locale); try { return fn(); } finally { setDefaultLocale('zh'); } };
  const answered = (keys: string[], comment: string | null = null): AskResult => ({ kind: 'answered', answers: [keys], by: 'ou_owner', comment, timedOut: false });

  it.each([
    ['zh', ['allow'], null, 'green', 'card.ask.header.permission_allowed'],
    ['en', ['allow'], null, 'green', 'card.ask.header.permission_allowed'],
    ['zh', ['deny'], null, 'grey', 'card.ask.header.permission_denied'],
    ['en', ['deny'], null, 'grey', 'card.ask.header.permission_denied'],
    ['zh', ['allow'], '先别删，换个目录', 'grey', 'card.ask.header.permission_denied'],
    // A thread reply settles with no option and a comment: the hook denies and forwards the text.
    ['zh', [], '先别删，换个目录', 'grey', 'card.ask.header.permission_denied'],
  ] as Array<[Locale, string[], string | null, string, string]>)('%s：选 %j / 回复 %j → %s 标题 %s', (locale, keys, comment, template, title) => {
    const card = inLocale(locale, () => JSON.parse(buildAskCard(permissionAsk(true), answered(keys, comment))));
    expect(card.header).toMatchObject({ template, title: { content: t(title, undefined, locale) } });
  });

  it('允许与拒绝的标题不同，也都不是普通提问的「已提交」；普通提问作答后仍是绿色已提交', () => {
    const titles = new Set([t('card.ask.header.permission_allowed'), t('card.ask.header.permission_denied'), t('card.ask.header.answered')]);
    expect(titles.size).toBe(3);
    const plain: PendingAsk = { ...permissionAsk(true), questions: [single()] };
    const card = JSON.parse(buildAskCard(plain, answered(['one'])));
    expect(card.header).toMatchObject({ template: 'green', title: { content: t('card.ask.header.answered') } });
  });

  it.each(['zh', 'en'] as Locale[])('未答的权限卡（%s）底部给权限专用的话题回复说明；普通一键卡保持原提示', locale => {
    const footer = (ask: PendingAsk) => inLocale(locale, () => JSON.parse(buildAskCard(ask))).body.elements.at(-1).content as string;
    const permissionHint = t('card.ask.permission_reply_hint', undefined, locale);
    const genericHint = t('card.ask.custom_reply_hint', undefined, locale);
    expect(permissionHint).not.toBe(genericHint);
    const permission = footer(permissionAsk(false));
    expect(permission).toContain(permissionHint);
    expect(permission).not.toContain(genericHint);
    const quick = footer({ ...permissionAsk(false), questions: [single({ allowCustom: false })] });
    expect(quick).toContain(genericHint);
    expect(quick).not.toContain(permissionHint);
  });
});

describe('元素上限（Card 2.0 每卡 200）与字节预算', () => {
  const many = (questions: number, options: number, description = '') => Array.from({ length: questions }, (_, i) => ({
    prompt: `问题 ${i + 1}`, multiSelect: i % 2 === 1,
    options: Array.from({ length: options }, (_, j) => ({ key: `k${j}`, label: `选项 ${j + 1}`, ...(description ? { description } : {}) })),
  }));
  const pending = (questions: AskQuestion[]): PendingAsk => ({ askId: 'ask-big', nonce: 'n', larkAppId: 'cli_redesign', chatId: 'oc_chat',
    rootMessageId: 'om_root', sessionId: 'sess', originKind: 'hook', questions, createdAt: 1_000, deadlineAt: 3_600_000, settled: false });

  it.each([
    ['1 题 4 项', 1, 4], ['4 题 4 项', 4, 4], ['11 题 42 项', 11, 4], ['11 题 132 项', 11, 12],
  ])('%s：整卡不超过 200 个元素，每个选项仍然能在卡上选到', (_name, questions, options) => {
    const qs = many(questions, options, '说明');
    const rendered = renderAskCard(pending(qs));
    const card = JSON.parse(rendered.json);
    expect(tagged(card)).toBeLessThanOrEqual(FEISHU_CARD_ELEMENT_LIMIT);
    expect(turnReplyCardRequestBytes(rendered.json, 'oc_chat')).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    // Each option is reachable: a checker per option, or the question's dropdown lists it.
    for (const [i, q] of qs.entries()) {
      const dropdown = all(card).find(n => n.name === `pick_${i}`);
      const reachable = dropdown ? dropdown.options.map((o: any) => o.value)
        : checkers(card).filter(c => c.name.startsWith(`opt_${i}_`)).map(c => q.options[Number(c.name.split('_')[2])]!.key);
      expect(reachable).toEqual(q.options.map(o => o.key));
    }
  });

  it.each([['20 题 160 项', 20, 8], ['40 题 400 项', 40, 10], ['150 题 300 项', 150, 2]])(
    '%s：任何控件都放不下 → 整卡列出问题与选项、请在对话里回复，仍不超过 200 个元素', (_name, questions, options) => {
      const qs = many(questions, options, '说明');
      const rendered = renderAskCard(pending(qs));
      const card = JSON.parse(rendered.json);
      expect(tagged(card)).toBeLessThanOrEqual(FEISHU_CARD_ELEMENT_LIMIT);
      expect(turnReplyCardRequestBytes(rendered.json, 'oc_chat')).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
      expect(all(card).filter(n => ['form', 'checker', 'input', 'button', 'select_static', 'multi_select_static'].includes(n.tag))).toEqual([]);
      expect(card.body.elements.at(-1).content).toContain(t('card.ask.list_reply_hint'));
      const text = all(card).filter(n => n.tag === 'markdown').map(n => n.content).join('\n');
      expect(text).toContain(`选项 ${options}`);
      expect(text).toContain(`${questions}\\. 问题 ${questions}`);
      // The settled card of such an Ask stays within the limit too.
      const settled = renderAskCard(pending(qs), { kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true });
      expect(tagged(JSON.parse(settled.json))).toBeLessThanOrEqual(FEISHU_CARD_ELEMENT_LIMIT);
    });

  it.each(['native-user-input-async', 'native-user-input-async-restore', 'native-user-input-standalone'])(
    '%s：普通卡与纯文字列表都提示引用本卡回复', originKind => {
      const ask = { ...pending([multi()]), originKind };
      const hint = t('card.ask.async_reply_hint', undefined, 'zh');
      expect(askReplyHint(ask, 'zh')).toBe(hint);
      const list = JSON.parse(renderAskCard({ ...ask, questions: many(20, 8) }).json);
      expect(list.body.elements.at(-1).content).toContain(hint);
      expect(list.body.elements.at(-1).content).not.toContain(t('card.ask.list_reply_hint', undefined, 'zh'));
    });

  it('题少时用一行一个勾选框的完整样式；放不下时下拉框列全选项、说明转附件', () => {
    expect(all(JSON.parse(renderAskCard(pending(many(4, 4))).json)).filter(n => n.background_style === 'bg-white')).toHaveLength(16);
    const big = renderAskCard(pending(many(11, 12, '每个选项的说明')));
    expect(all(JSON.parse(big.json)).some(n => n.tag === 'select_static' || n.tag === 'multi_select_static')).toBe(true);
    expect(big.descriptionsTruncated).toBe(true);
  });

  it('下拉框排布的提交（pick_<题>）同样按题读出答案', async () => {
    const qs = many(11, 12);
    const { ask, answer } = await open(qs);
    const card = JSON.parse(buildAskCard(ask));
    expect(all(card).filter(n => n.name?.startsWith?.('pick_'))).toHaveLength(11);
    const fields: Record<string, unknown> = {};
    qs.forEach((q, i) => { fields[`pick_${i}`] = q.multiSelect ? ['k1', 'k3'] : 'k2'; fields[`custom_${i}`] = ''; });
    await submit(ask, submitOf(card), fields);
    const result = await answer as Extract<AskResult, { kind: 'answered' }>;
    expect(result.answers[0]).toEqual(['k2']);
    expect(result.answers[1]).toEqual(['k1', 'k3']);
  });
});

describe('回复卡里内嵌的提问', () => {
  function record(asks: PendingAsk[]): TurnReplyCardRecord {
    return { larkAppId: 'cli_redesign', sessionId: 'sess', turnId: 'turn', mode: 'unified', chatId: 'oc_chat', rootId: 'om_root',
      version: 1, phase: 'working', createdAtMs: 1, progress: ['先确认一下'], tools: [{ id: 'tool', name: 'Read', subject: 'a.ts' }],
      activity: [{ kind: 'progress', id: 'progress:0', text: '先确认一下' }, { kind: 'tool', id: 'tool' }],
      asks: asks.map(ask => ({ ask })) } as TurnReplyCardRecord;
  }
  const inline = (questions: AskQuestion[]): PendingAsk => ({ askId: 'ask-inline', nonce: 'n', larkAppId: 'cli_redesign', chatId: 'oc_chat',
    rootMessageId: 'om_root', sessionId: 'sess', originKind: 'hook', questions, createdAt: 1_000, deadlineAt: 61_000, settled: false,
    replyCardTarget: { turnId: 'turn' } });

  it('同样的灰底分区与勾选框，灰底颜色随卡片配置带上', () => {
    const card = JSON.parse(buildTurnReplyCard(record([inline([single(), multi()])]), { showProcess: true, showToolResults: false, canStop: true }));
    expect(card.config.style.color.qblock).toMatchObject({ light_mode: expect.any(String), dark_mode: expect.any(String) });
    expect(all(card).filter(n => n.background_style === 'qblock')).toHaveLength(2);
    expect(checkers(card)).toHaveLength(6);
    expect(submitOf(card)).toMatchObject({ action: 'ask_choice_submit', ask_id: 'ask-inline' });
  });

  it('准入门内最大的提问（16 个都带说明的选项）整张回复卡仍在 200 个元素与 30KB 内', () => {
    const options = Array.from({ length: 16 }, (_, j) => ({ key: `k${j}`, label: `选项 ${j}`, description: '说明'.repeat(20) }));
    const questions = [{ prompt: '选哪些？', multiSelect: true, options }];
    expect(Buffer.byteLength(JSON.stringify(questions))).toBeLessThanOrEqual(3000);
    const json = buildTurnReplyCard(record([inline(questions)]), { showProcess: true, showToolResults: true, canStop: true });
    expect(tagged(JSON.parse(json))).toBeLessThanOrEqual(FEISHU_CARD_ELEMENT_LIMIT);
    expect(turnReplyCardRequestBytes(json, 'oc_chat')).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    expect(checkers(JSON.parse(json))).toHaveLength(16);
  });

  it('回复卡剩下的元素不够时退到裸勾选框，仍是每个选项一个勾选框', () => {
    const questions = [multi({ options: Array.from({ length: 16 }, (_, j) => ({ key: `k${j}`, label: `选项 ${j}` })) })];
    const roomy = buildTurnReplyAskElements({ ask: inline(questions) }, 'zh');
    const tight = buildTurnReplyAskElements({ ask: inline(questions) }, 'zh', tagged(roomy) - 1);
    expect(tagged(tight)).toBeLessThan(tagged(roomy));
    expect(checkers(tight)).toHaveLength(16);
    expect(all(tight).some(n => n.background_style === 'bg-white')).toBe(false);
  });
});
