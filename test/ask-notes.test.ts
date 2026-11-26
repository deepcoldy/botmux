import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runHook } from '../src/cli.js';
import { _resetForTest, applyAskForm, getAskSnapshot, registerAsk, restorePersistedAsks, setAskPersistStore,
  setCanTalkChecker, setCardDispatcher } from '../src/core/ask-broker.js';
import { createAskPersistStore } from '../src/core/ask-persist-store.js';
import type { AskQuestion, AskResult, CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
import antigravity from '../src/core/ask-hook/antigravity.js';
import dsh from '../src/core/ask-hook/dsh.js';
import opencode from '../src/core/ask-hook/opencode.js';
import { getDefaultLocale, setDefaultLocale } from '../src/i18n/index.js';
import { askResponseBody } from '../src/core/ask-api.js';
import { buildAskCard, handleAskCardAction } from '../src/im/lark/ask-card.js';
import { turnReplyAskSummary } from '../src/im/lark/turn-reply-ask-elements.js';
import { codexAsyncAnswerText } from '../src/services/codex-async-user-input.js';
import { codexUserInputAnswer } from '../src/services/codex-user-input.js';

const questions: AskQuestion[] = [
  { prompt: '谁一起去？', multiSelect: false, options: [{ key: '家人 (推荐)', label: '家人 (推荐)' }, { key: '朋友', label: '朋友' }] },
  { prompt: '玩什么？', multiSelect: true, options: [{ key: '爬山', label: '爬山' }, { key: '看海', label: '看海' }] },
];
const withNote: Extract<AskResult, { kind: 'answered' }> = {
  kind: 'answered', answers: [['家人 (推荐)'], ['爬山', '看海']], notes: ['带一只狗', null], by: 'ou_owner', comment: null, timedOut: false,
};
const claudePayload = {
  hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
  tool_input: { questions: questions.map(q => ({ question: q.prompt, header: 'h', multiSelect: q.multiSelect,
    options: q.options.map(o => ({ label: o.label, description: '' })) })) },
};
const ENV = { BOTMUX_SESSION_ID: 'sess', BOTMUX_CHAT_ID: 'oc_chat', BOTMUX_LARK_APP_ID: 'cli_app', BOTMUX_ROOT_MESSAGE_ID: 'om_root' };
async function claudeAnswers(result: AskResult): Promise<Record<string, string>> {
  const { stdout } = await runHook(claudePayload, ENV, async () => result, 'claude-code', async () => null);
  return JSON.parse(stdout).hookSpecificOutput.updatedInput.answers;
}

describe('勾了选项又写的备注，交给各个提问方', () => {
  let locale: ReturnType<typeof getDefaultLocale>;
  beforeEach(() => { locale = getDefaultLocale(); });
  afterEach(() => setDefaultLocale(locale));

  it('Claude Code：同一条答案字符串里，选项后面接「；备注：…」（英文界面「; note: …」）', async () => {
    expect(await claudeAnswers(withNote)).toEqual({ '谁一起去？': '家人 (推荐)；备注：带一只狗', '玩什么？': '爬山, 看海' });
    setDefaultLocale('en');
    expect((await claudeAnswers(withNote))['谁一起去？']).toBe('家人 (推荐); note: 带一只狗');
  });

  it('Claude Code：只写不勾仍是该题答案；旧版存的结果（没有 notes）照旧', async () => {
    const own: AskResult = { ...withNote, answers: [[], ['爬山']], customAnswers: ['自驾去', null], notes: undefined };
    expect(await claudeAnswers(own)).toEqual({ '谁一起去？': '自驾去', '玩什么？': '爬山' });
  });

  it.each([
    ['英文机器人跑在中文默认的 daemon 上', 'zh', 'en', '家人 (推荐); note: 带一只狗'],
    ['中文机器人跑在英文默认的 daemon 上', 'en', 'zh', '家人 (推荐)；备注：带一只狗'],
  ] as const)('Claude Code：备注标记跟着提问机器人的语言走（%s）', async (_case, processDefault, botLocale, expected) => {
    setDefaultLocale(processDefault);
    // What the daemon answers the waiting hook with for this bot.
    const response = askResponseBody(withNote, 'hook', botLocale);
    expect((await claudeAnswers(response))['谁一起去？']).toBe(expected);
  });

  it('daemon 只给 hook 的答案带上机器人语言，不改别的结果', () => {
    expect(askResponseBody(withNote, 'hook', 'en')).toMatchObject({ locale: 'en' });
    expect(askResponseBody(withNote, 'explicit', 'en')).not.toHaveProperty('locale');
    const timedOut: AskResult = { kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true };
    expect(askResponseBody(timedOut, 'hook', 'en')).toEqual(timedOut);
  });

  it('OpenCode：单选的备注接在同一条答案后面，多选的备注是标签之后多出的一项', () => {
    const parsed = { questions, raw: { tool_input: { questions: [{}, {}] } } } as any;
    const multiNote = [null, '带上相机'];
    expect(JSON.parse(opencode.formatAnswer(withNote.answers, parsed, null, undefined, withNote.notes)).answers)
      .toEqual([['家人 (推荐)；备注：带一只狗'], ['爬山', '看海']]);
    expect(JSON.parse(opencode.formatAnswer(withNote.answers, parsed, null, undefined, multiNote)).answers)
      .toEqual([['家人 (推荐)'], ['爬山', '看海', '备注：带上相机']]);
    expect(JSON.parse(opencode.formatAnswer([['朋友'], ['爬山']], parsed, null, undefined, multiNote)).answers)
      .toEqual([['朋友'], ['爬山', '备注：带上相机']]);
    expect(JSON.parse(opencode.formatAnswer(withNote.answers, parsed, null, undefined, ['带一只狗', '带上相机'], 'en')).answers)
      .toEqual([['家人 (推荐); note: 带一只狗'], ['爬山', '看海', 'note: 带上相机']]);
  });

  it('dsh：备注放进 custom，与 selected 一起交回', () => {
    const parsed = { questions, raw: { rawQuestions: [{ id: 'who' }, { id: 'what' }] } } as any;
    expect(JSON.parse(dsh.formatAnswer(withNote.answers, parsed, null, undefined, withNote.notes)).answers).toEqual([
      { id: 'who', selected: ['家人 (推荐)'], custom: '带一只狗' },
      { id: 'what', selected: ['爬山', '看海'] },
    ]);
  });

  it('Antigravity：答案行是英文的，备注写成「; note: …」', () => {
    const parsed = { questions, raw: {} } as any;
    const reason = JSON.parse(antigravity.formatAnswer(withNote.answers, parsed, null, undefined, withNote.notes)).reason;
    expect(reason).toContain('A1: 家人 (推荐); note: 带一只狗');
    expect(reason).toContain('A2: 爬山, 看海');
  });

  it('Codex request_user_input：按 Codex 自己的格式多一项「user_note: …」；异步回复同样带上', () => {
    const entries = questions.map((question, i) => ({ id: `q${i}`, question }));
    expect(codexUserInputAnswer(entries, withNote)).toEqual({ answers: {
      q0: { answers: ['家人 (推荐)', 'user_note: 带一只狗'] }, q1: { answers: ['爬山', '看海'] },
    } });
    const text = codexAsyncAnswerText({ itemId: 'item' } as any, questions, withNote);
    const replies = JSON.parse(text.split('\n')[1]!);
    expect(replies.map((r: any) => r.answer)).toEqual(['家人 (推荐)\nuser_note: 带一只狗', '爬山\n看海']);
  });

  it('回复卡执行过程里的摘要：✓ 选项后另起一行备注', () => {
    const ask = { askId: 'a', nonce: 'n', larkAppId: 'cli_app', chatId: 'oc_chat', rootMessageId: 'om_root', sessionId: 's',
      questions, createdAt: 0, deadlineAt: 60_000, settled: true } as PendingAsk;
    expect(turnReplyAskSummary({ ask, result: withNote })).toContain('✓ 家人 (推荐)\n备注：带一只狗');
  });
});

describe('备注与存盘、重启', () => {
  const input: CreateAskInput = { larkAppId: 'cli_notes', chatId: 'oc_chat', rootMessageId: 'om_root', sessionId: 'sess',
    requestId: 'notes-request', originKind: 'hook', backendSurvivesRestart: true, questions, timeoutMs: 60_000 };
  let dir: string;
  let sent: PendingAsk[];
  const wire = () => {
    setCardDispatcher({ async send(ask) { sent.push(ask); return { messageId: 'om_card' }; } });
    setCanTalkChecker((_a, _c, by) => by === 'ou_owner');
    setAskPersistStore(createAskPersistStore(dir));
  };
  /** Daemon restart: memory gone, the hook not yet re-attached (its answer is stashed). */
  const restart = () => { _resetForTest(); wire(); restorePersistedAsks(Date.now(), input.larkAppId); };
  const submitCard = (ask: PendingAsk, formValue: Record<string, unknown>) => {
    const card = JSON.parse(buildAskCard(ask));
    const nodes = (v: any): any[] => v && typeof v === 'object' ? [v, ...Object.values(v).flatMap(nodes)] : [];
    const value = nodes(card).find(n => n.tag === 'button').behaviors[0].value;
    return handleAskCardAction({ operator: { open_id: 'ou_owner' }, action: { value, form_value: formValue } }) as Promise<any>;
  };
  beforeEach(() => { vi.useFakeTimers(); sent = []; dir = mkdtempSync(join(tmpdir(), 'ask-notes-')); wire(); });
  afterEach(() => { _resetForTest(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  it('备注随答案存盘：daemon 重启后重连的 hook 拿到的答案仍带着备注', async () => {
    void registerAsk(input); await vi.advanceTimersByTimeAsync(0);
    const { askId } = sent[0]!;
    restart();
    await submitCard(getAskSnapshot(askId)!, { opt_0_0: true, custom_0: '带一只狗', opt_1_1: true, custom_1: '' });
    restart();
    const result = await registerAsk(input);
    expect(result).toMatchObject({ kind: 'answered', answers: [['家人 (推荐)'], ['看海']], notes: ['带一只狗', null] });
    expect(sent).toHaveLength(1);
  });

  it('旧版留下的草稿（「其他」写了字）重启恢复后：该题选项不勾、文字在输入框，照原样提交仍是这题的答案', async () => {
    void registerAsk(input); await vi.advanceTimersByTimeAsync(0);
    const { askId, nonce } = sent[0]!;
    // What the pre-redesign card stored: an own answer on q1, a tick on q2 (v1 toggle callback).
    expect(applyAskForm({ askId, nonce, by: 'ou_owner', revision: 0, fields: { custom_0: '旧版写的答案' },
      toggle: { questionIndex: 1, key: '爬山' } })).toBe('toggled');
    restart();
    const restored = getAskSnapshot(askId)!;
    expect(restored).toMatchObject({ customAnswers: ['旧版写的答案', null], customRevision: 1 });
    const card = JSON.parse(buildAskCard(restored));
    const nodes = (v: any): any[] => v && typeof v === 'object' ? [v, ...Object.values(v).flatMap(nodes)] : [];
    expect(nodes(card).filter(n => n.tag === 'checker' && n.checked).map(n => n.name)).toEqual(['opt_1_0']);
    expect(nodes(card).find(n => n.name === 'custom_0').default_value).toBe('旧版写的答案');
    await submitCard(restored, { opt_0_0: false, opt_0_1: false, custom_0: '旧版写的答案', opt_1_0: true, opt_1_1: false, custom_1: '' });
    restart();
    const result = await registerAsk(input);
    expect(result).toMatchObject({ answers: [[], ['爬山']], customAnswers: ['旧版写的答案', null] });
    expect(result).not.toHaveProperty('notes');
    expect(await claudeAnswers(result)).toEqual({ '谁一起去？': '旧版写的答案', '玩什么？': '爬山' });
  });

  it('旧卡片上的「其他」提交（v1 回调）仍按旧语义：写的字顶替该题选项，不变成备注', async () => {
    const answer = registerAsk(input); await vi.advanceTimersByTimeAsync(0);
    const { askId, nonce } = sent[0]!;
    expect(applyAskForm({ askId, nonce, by: 'ou_owner', revision: 0, fields: { custom_0: '自驾' }, toggle: { questionIndex: 1, key: '看海' } }))
      .toBe('toggled');
    expect(applyAskForm({ askId, nonce, by: 'ou_owner', revision: 1, fields: { custom_0: '自驾' } })).toBe('accepted');
    const result = await answer;
    expect(result).toMatchObject({ answers: [[], ['看海']], customAnswers: ['自驾', null] });
    expect(result).not.toHaveProperty('notes');
  });
});
