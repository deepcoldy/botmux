import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingAsk } from '../src/core/ask-types.js';

// vi.mock 被 vitest 提升到模块顶层，在 import 之前执行。
// 用 importOriginal 保留所有真实导出，仅把 submitAsk 替换为可监测的 spy。
vi.mock('../src/core/ask-broker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/ask-broker.js')>();
  return { ...actual, submitAsk: vi.fn(actual.submitAsk) };
});

import {
  _getPending,
  _resetForTest,
  registerAsk,
  setCardDispatcher,
  setCanTalkChecker,
  submitAsk,
} from '../src/core/ask-broker.js';
import {
  ASK_SELECT_ACTION,
  ASK_SUBMIT_ACTION,
  ASK_TOGGLE_ACTION,
  buildAskCard,
  createLarkAskCardDispatcher,
  handleAskCardAction,
  parseFormSelections,
} from '../src/im/lark/ask-card.js';

const mockedSubmitAsk = vi.mocked(submitAsk);

// 答复鉴权 = canTalk。卡片点击测试里默认只放行 ou_owner，其余（如 ou_intruder）拒绝。
beforeEach(() => {
  setCanTalkChecker((_app, _chat, openId) => openId === 'ou_owner');
});

afterEach(() => {
  _resetForTest();
  // 只清计数/记录，不重置实现（spy 默认透传真实 submitAsk）
  mockedSubmitAsk.mockClear();
});

/** 构造一个带 questions/askId/nonce/deadlineAt 的 PendingAsk。 */
function makePending(overrides: Partial<PendingAsk> = {}): PendingAsk {
  return {
    askId: 'ask-1',
    nonce: 'nonce-1',
    larkAppId: 'cli_ask',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    sessionId: 'sess-1',
    questions: [
      {
        prompt: '线上 latency 涨了 30%，下一步怎么处理？',
        options: [
          { key: 'deploy', label: '继续发布' },
          { key: 'rollback', label: '回滚' },
          { key: 'abort', label: '中止' },
        ],
        multiSelect: false,
      },
    ],
    createdAt: 1_000,
    deadlineAt: 1_000 + 300_000,
    settled: false,
    ...overrides,
  };
}

describe('buildAskCard', () => {
  it('多问卡片：每问一个分区 + option buttons + 一个 submit', () => {
    const ask = makePending({
      questions: [
        { prompt: 'q1', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
        { prompt: 'q2', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
    });
    const json = JSON.parse(buildAskCard(ask));
    const blob = JSON.stringify(json);

    // 每问的 prompt 文本出现在卡片中
    expect(blob).toContain('q1');
    expect(blob).toContain('q2');

    // submit 按钮 action 存在
    expect(blob).toContain(ASK_SUBMIT_ACTION);

    // 每问的选项通过 ask_toggle button 编码 question_index + key
    expect(blob).toContain(ASK_TOGGLE_ACTION);
    expect(blob).toContain('"question_index":"0"');
    expect(blob).toContain('"key":"y"');
    expect(blob).toContain('"question_index":"1"');
    expect(blob).toContain('"key":"a"');
  });

  it('单问卡片：渲染 prompt、可答复栏、ask_id、nonce', () => {
    const card = JSON.parse(buildAskCard(makePending()));
    const text = JSON.stringify(card);

    expect(card.header.title.content).toBe('botmux ask');
    expect(text).toContain('线上 latency');
    // 可答复栏 = canTalk 语义，统一显示「本群可对话成员」，不再按 open_id 列名单
    const metaDiv = card.elements[0];
    expect(metaDiv.fields[1].text.content).toContain('可对话成员');
    expect(text).toContain('"ask_id":"ask-1"');
    expect(text).toContain('"nonce":"nonce-1"');
    // 单问单选：稳定 action button，点击即答；不使用会被飞书 silent-drop 的 form/select_static
    expect(text).toContain(ASK_SELECT_ACTION);
    expect(text).not.toContain('select_static');
    expect(text).not.toContain('"tag":"form"');
    expect(text).toContain('继续发布');
  });

  it('未 settle 卡片：含自定义回复提示（直接在话题里回复）', () => {
    const text = buildAskCard(makePending());
    expect(text).toContain('直接在话题');
  });

  it('settled 态（answered + comment）：渲染自定义回复文字与标签', () => {
    const ask = makePending({
      questions: [{ prompt: 'q', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] }],
    });
    const text = buildAskCard(ask, {
      kind: 'answered',
      answers: [[]],
      by: 'ou_u',
      comment: '我想先灰度 10%',
      timedOut: false,
    });
    expect(text).toContain('自定义回复');
    expect(text).toContain('我想先灰度 10%');
    // header 仍为 answered 绿
    expect(JSON.parse(text).header.template).toBe('green');
  });

  it('多问/多选：使用 buttons + submit，不使用 form/select_static', () => {
    const ask = makePending({
      questions: [
        { prompt: 'single', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
        { prompt: 'multi', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
    });
    const blob = buildAskCard(ask);
    expect(blob).toContain(ASK_TOGGLE_ACTION);
    expect(blob).toContain(ASK_SUBMIT_ACTION);
    expect(blob).toContain('☐ A');
    expect(blob).not.toContain('"select_static"');
    expect(blob).not.toContain('"multi_select_static"');
    expect(blob).not.toContain('"tag":"form"');
  });

  it('settled 态（answered）：渲染答案摘要、无可点组件', () => {
    const ask = makePending({
      questions: [{ prompt: 'q', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] }],
    });
    const json = JSON.parse(buildAskCard(ask, {
      kind: 'answered',
      answers: [['y']],
      by: 'ou_u',
      comment: null,
      timedOut: false,
    }));
    const text = JSON.stringify(json);

    expect(json.header.template).toBe('green');
    // 答案摘要包含"已选择"文字
    expect(text).toContain('已选择');
    // 选中标签"是"出现在卡片中
    expect(text).toContain('是');
    // 不含任何 action 动作（无可交互组件）
    expect(text).not.toContain(ASK_SELECT_ACTION);
    expect(text).not.toContain(ASK_SUBMIT_ACTION);
  });

  it('settled 态（answered）：多问多选答案各问均渲染', () => {
    const ask = makePending({
      questions: [
        { prompt: 'q1', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
        { prompt: 'q2', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
    });
    const text = buildAskCard(ask, {
      kind: 'answered',
      answers: [['y'], ['a', 'b']],
      by: 'ou_u',
      comment: null,
      timedOut: false,
    });
    // 两问的标签均出现
    expect(text).toContain('是');
    expect(text).toContain('A');
    expect(text).toContain('B');
  });

  it('settled 态（timedOut）：渲染超时文字', () => {
    const text = buildAskCard(makePending(), {
      kind: 'timedOut',
      selected: null,
      by: null,
      comment: null,
      timedOut: true,
    });
    expect(text).toContain('超时');
  });
});

describe('handleAskCardAction', () => {
  it('旧单选路径 ask_select：resolves pending ask，返回终态卡片（同步替换）', async () => {
    let askId = '';
    setCardDispatcher({
      async send(ask) {
        askId = ask.askId;
        return { messageId: 'om_ask' };
      },
    });
    const promise = registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: makePending().questions,
      timeoutMs: 10_000,
    });
    await Promise.resolve();
    const pending = _getPending(askId);
    expect(pending).toBeDefined();

    // nonce 不匹配 → stale
    const stale = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: ASK_SELECT_ACTION,
          ask_id: askId,
          nonce: 'should-not-match',
          key: 'deploy',
        },
      },
    });
    expect(stale?.toast.content).toContain('失效');

    // 正确 nonce + key → accepted，返回终态卡片（飞书同步替换，不依赖 onSettle 异步 PATCH）
    const accepted = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: ASK_SELECT_ACTION,
          ask_id: askId,
          nonce: pending!.nonce,
          key: 'deploy',
        },
      },
    });
    expect(accepted).toBeDefined();
    expect(accepted?.toast).toBeUndefined();
    expect((accepted as Record<string, any>)?.header?.title?.content).toContain('已结束');
    await expect(promise).resolves.toMatchObject({ kind: 'answered', answers: [['deploy']], by: 'ou_owner' });
  });

  // 未授权点击现在会先尝试弹授权卡（见 test/ask-unauthorized-grant.test.ts）。本用例的
  // 'cli_ask' 未 registerBot → 升级模块取不到 bot 配置，降级成 'unavailable' 回落到
  // 原「没有权限」文案。这条断言因此同时锁住了「升级失败绝不吞掉反馈」的降级契约。
  it('旧单选路径 ask_select：非授权人返回 warning toast（授权卡发不出时的降级）', async () => {
    let captured: PendingAsk | undefined;
    setCardDispatcher({
      async send(ask) {
        captured = ask;
        return { messageId: 'om_ask' };
      },
    });
    registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: makePending().questions,
      timeoutMs: 10_000,
    });
    await Promise.resolve();

    const result = await handleAskCardAction({
      operator: { open_id: 'ou_intruder' },
      action: {
        value: {
          action: ASK_SELECT_ACTION,
          ask_id: captured!.askId,
          nonce: captured!.nonce,
          key: 'deploy',
        },
      },
    });
    expect(result?.toast.type).toBe('warning');
    expect(result?.toast.content).toContain('没有权限');
  });

  it('ask_toggle：累积勾选并返回原地 patch 卡片，展示已选状态', async () => {
    let captured: PendingAsk | undefined;
    setCardDispatcher({
      async send(ask) {
        captured = ask;
        return { messageId: 'om_ask' };
      },
    });
    registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [
        { prompt: 'q', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
      timeoutMs: 10_000,
    });
    await Promise.resolve();

    const patch = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: ASK_TOGGLE_ACTION,
          ask_id: captured!.askId,
          nonce: captured!.nonce,
          question_index: '0',
          key: 'a',
        },
      },
    });

    expect(JSON.stringify(patch)).toContain('☑ A');
    expect(JSON.stringify(patch)).toContain('☐ B');
  });
});

// ─── parseFormSelections 单元测试 ─────────────────────────────────────────────

describe('parseFormSelections', () => {
  it('form_value 为数组：多选问题 → selections 收集所有 key', () => {
    const result = parseFormSelections({ q0: ['0::a', '0::b'] }, 1);
    expect(result).toEqual([['a', 'b']]);
  });

  it('form_value 为单字符串：单选问题 → selections=[["y"]]', () => {
    const result = parseFormSelections({ q0: '0::y' }, 1);
    expect(result).toEqual([['y']]);
  });

  it('form_value 为逗号分隔字符串：备用格式 → 拆分后收集 key', () => {
    const result = parseFormSelections({ q0: '0::a,0::b' }, 1);
    expect(result).toEqual([['a', 'b']]);
  });

  it('两问混合：第0问单选字符串 + 第1问数组多选', () => {
    const result = parseFormSelections({ q0: '0::y', q1: ['1::a', '1::b'] }, 2);
    expect(result).toEqual([['y'], ['a', 'b']]);
  });

  it('prefix 不匹配的 token 被过滤掉（防御乱序/跨问混入）', () => {
    // q0 收到一个 1:: 前缀的混入值，应被忽略
    const result = parseFormSelections({ q0: ['0::y', '1::x'] }, 1);
    expect(result).toEqual([['y']]);
  });

  it('字段缺失时返回空数组', () => {
    const result = parseFormSelections({}, 2);
    expect(result).toEqual([[], []]);
  });
});

// ─── handleAskCardAction: ask_submit 路径 ─────────────────────────────────────

describe('handleAskCardAction: ask_submit 路径', () => {
  /** 注册一个真实 pending ask，返回其 askId 和 nonce。 */
  async function registerTestAsk(overrides: Partial<Parameters<typeof registerAsk>[0]> = {}) {
    let captured: PendingAsk | undefined;
    setCardDispatcher({
      async send(ask) {
        captured = ask;
        return { messageId: 'om_ask' };
      },
    });
    registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [
        {
          prompt: '问题1',
          options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }],
          multiSelect: false,
        },
      ],
      timeoutMs: 10_000,
      ...overrides,
    });
    await Promise.resolve();
    return captured!;
  }

  it('form_value 为数组（multi_select_static）→ submitAsk 收到 selections=[["a","b"]]', async () => {
    // 注册含 1 个多选问题的 ask
    setCardDispatcher({ async send(ask) { return { messageId: 'om_ask' }; } });
    let capturedAsk: PendingAsk | undefined;
    setCardDispatcher({
      async send(ask) {
        capturedAsk = ask;
        return { messageId: 'om_ask' };
      },
    });
    registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [
        { prompt: 'q', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
      timeoutMs: 10_000,
    });
    await Promise.resolve();

    mockedSubmitAsk.mockReturnValueOnce('accepted');

    handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: { action: ASK_SUBMIT_ACTION, ask_id: capturedAsk!.askId, nonce: capturedAsk!.nonce },
        form_value: { q0: ['0::a', '0::b'] },
      },
    });

    expect(mockedSubmitAsk).toHaveBeenCalledWith({
      askId: capturedAsk!.askId,
      nonce: capturedAsk!.nonce,
      by: 'ou_owner',
      selections: [['a', 'b']],
      confirmEmpty: false,
    });
  });

  it('form_value 为单字符串（select_static）→ submitAsk 收到 selections=[["y"]]', async () => {
    const captured = await registerTestAsk();

    mockedSubmitAsk.mockReturnValueOnce('accepted');

    handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: { action: ASK_SUBMIT_ACTION, ask_id: captured.askId, nonce: captured.nonce },
        form_value: { q0: '0::y' },
      },
    });

    expect(mockedSubmitAsk).toHaveBeenCalledWith({
      askId: captured.askId,
      nonce: captured.nonce,
      by: 'ou_owner',
      selections: [['y']],
      confirmEmpty: false,
    });
  });

  it('form_value 为逗号分隔字符串（备用格式）→ submitAsk 收到 selections=[["a","b"]]', async () => {
    setCardDispatcher({
      async send(ask) { return { messageId: 'om_ask' }; },
    });
    let capturedAsk: PendingAsk | undefined;
    setCardDispatcher({
      async send(ask) {
        capturedAsk = ask;
        return { messageId: 'om_ask' };
      },
    });
    registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [
        { prompt: 'q', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
      timeoutMs: 10_000,
    });
    await Promise.resolve();

    mockedSubmitAsk.mockReturnValueOnce('accepted');

    handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: { action: ASK_SUBMIT_ACTION, ask_id: capturedAsk!.askId, nonce: capturedAsk!.nonce },
        form_value: { q0: '0::a,0::b' },
      },
    });

    expect(mockedSubmitAsk).toHaveBeenCalledWith({
      askId: capturedAsk!.askId,
      nonce: capturedAsk!.nonce,
      by: 'ou_owner',
      selections: [['a', 'b']],
      confirmEmpty: false,
    });
  });

  it('两问混合：q0 单选字符串 + q1 数组多选 → selections=[["y"],["a","b"]]', async () => {
    let capturedAsk: PendingAsk | undefined;
    setCardDispatcher({
      async send(ask) {
        capturedAsk = ask;
        return { messageId: 'om_ask' };
      },
    });
    registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [
        { prompt: 'q1', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
        { prompt: 'q2', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
      timeoutMs: 10_000,
    });
    await Promise.resolve();

    mockedSubmitAsk.mockReturnValueOnce('accepted');

    handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: { action: ASK_SUBMIT_ACTION, ask_id: capturedAsk!.askId, nonce: capturedAsk!.nonce },
        form_value: { q0: '0::y', q1: ['1::a', '1::b'] },
      },
    });

    expect(mockedSubmitAsk).toHaveBeenCalledWith({
      askId: capturedAsk!.askId,
      nonce: capturedAsk!.nonce,
      by: 'ou_owner',
      selections: [['y'], ['a', 'b']],
      confirmEmpty: false,
    });
  });

  it('缺少 askId/nonce → 返回 staleToast，submitAsk 不被调用', () => {
    handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: { action: ASK_SUBMIT_ACTION },
        form_value: { q0: '0::y' },
      },
    });

    expect(mockedSubmitAsk).not.toHaveBeenCalled();
  });

  it('缺少 askId/nonce → 返回含"失效"字样的 warning toast', async () => {
    const result = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: { action: ASK_SUBMIT_ACTION },
        form_value: { q0: '0::y' },
      },
    });

    expect(result?.toast.content).toContain('失效');
  });

  it('ask_submit（form_value 单选）accepted → 返回终态卡片，飞书同步替换', async () => {
    const captured = await registerTestAsk();

    const result = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: { action: ASK_SUBMIT_ACTION, ask_id: captured.askId, nonce: captured.nonce },
        form_value: { q0: '0::y' },
      },
    });

    // 返回终态卡片（非 undefined、非 toast），飞书在回调响应里同步替换
    expect(result).toBeDefined();
    expect(result?.toast).toBeUndefined();
    const card = result as Record<string, any>;
    expect(card.header?.title?.content).toContain('已结束');
    expect(card.header?.template).toBe('green');
    // 终态卡片包含选中的答案摘要
    expect(JSON.stringify(card)).toContain('是');
  });

  it('ask_submit（累积勾选后提交）accepted → 返回终态卡片，含已选状态', async () => {
    // 注册一个多选问题的 ask
    let captured: PendingAsk | undefined;
    setCardDispatcher({
      async send(ask) {
        captured = ask;
        return { messageId: 'om_ask' };
      },
    });
    registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [
        { prompt: 'q', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
      timeoutMs: 10_000,
    });
    await Promise.resolve();

    // 先勾选 a
    await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: ASK_TOGGLE_ACTION,
          ask_id: captured!.askId,
          nonce: captured!.nonce,
          question_index: '0',
          key: 'a',
        },
      },
    });

    // 再提交（无 form_value，使用累积勾选）
    const result = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: { action: ASK_SUBMIT_ACTION, ask_id: captured!.askId, nonce: captured!.nonce },
      },
    });

    expect(result).toBeDefined();
    expect(result?.toast).toBeUndefined();
    const card = result as Record<string, any>;
    expect(card.header?.title?.content).toContain('已结束');
    expect(JSON.stringify(card)).toContain('A');
  });
});

// ─── 空多选提交二次确认（B）─────────────────────────────────────────────────
describe('handleAskCardAction: 空多选提交二次确认', () => {
  async function registerMulti(overrides: Partial<Parameters<typeof registerAsk>[0]> = {}) {
    let captured: PendingAsk | undefined;
    setCardDispatcher({
      async send(ask) { captured = ask; return { messageId: 'om_ask' }; },
    });
    registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [
        { prompt: 'q', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
      timeoutMs: 10_000,
      ...overrides,
    });
    await Promise.resolve();
    return captured!;
  }

  it('全空提交（全多选）→ 不 settle，返回包成 card:{type:raw} 的 arm 卡片 + warning toast', async () => {
    const ask = await registerMulti();

    const result = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: ASK_SUBMIT_ACTION, ask_id: ask.askId, nonce: ask.nonce } },
    });

    const r = result as Record<string, any>;
    // 关键（外层整形契约）：arm 响应必须包成 { card: { type:'raw', data }, toast }，
    // 不能把 card 字段摊在顶层——否则 event-dispatcher 只认 toast、raw card 不 patch。
    expect(r.card?.type).toBe('raw');
    expect(r.card?.data?.elements).toBeDefined();
    expect('elements' in r).toBe(false); // 顶层不得直接暴露 card 字段
    expect(r.toast?.type).toBe('warning');
    // arm 卡片里有红色「确认空提交」按钮 + confirm_empty 标志 + 警示文案
    const cardBlob = JSON.stringify(r.card?.data);
    expect(cardBlob).toContain('确认空提交');
    expect(cardBlob).toContain('confirm_empty');
    expect(cardBlob).toContain('你还没有勾选任何选项');
    expect(cardBlob).not.toContain('已结束');
    // 未 settle，可继续
    expect(_getPending(ask.askId)?.settled).toBe(false);
  });

  it('arm 后再次点击（confirm_empty=\'true\'）→ 真正 settle 空答案', async () => {
    const ask = await registerMulti();

    // 第一次：拦成 arm（不 settle）
    await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: ASK_SUBMIT_ACTION, ask_id: ask.askId, nonce: ask.nonce } },
    });
    expect(_getPending(ask.askId)?.settled).toBe(false);

    // 第二次：带 confirm_empty 字符串（飞书按钮 value 回传即字符串）→ settle
    const result = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: ASK_SUBMIT_ACTION, ask_id: ask.askId, nonce: ask.nonce, confirm_empty: 'true' } },
    });

    // submitAsk 收到 confirmEmpty:true
    expect(mockedSubmitAsk).toHaveBeenLastCalledWith({ askId: ask.askId, nonce: ask.nonce, by: 'ou_owner', confirmEmpty: true });
    const card = result as Record<string, any>;
    // 终态卡片（settle 用 settledCardResponse，直接是 raw 卡片体，不含 card 包裹）
    expect(card.header?.title?.content).toContain('已结束');
    expect(_getPending(ask.askId)?.settled).toBe(true);
  });

  it('全空提交但 nonce 不匹配 → stale（不 arm，鉴权/nonce 先于二次确认）', async () => {
    const ask = await registerMulti();

    const result = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: ASK_SUBMIT_ACTION, ask_id: ask.askId, nonce: 'WRONG' } },
    });

    // 鉴权与 nonce 顺序：arm 判定在 broker 里、位于 nonce/canTalk 校验之后 → 坏 nonce 走 stale
    expect(JSON.stringify(result)).not.toContain('确认空提交');
    expect((result as any)?.toast?.content).toContain('失效');
    expect(_getPending(ask.askId)?.settled).toBe(false);
  });

  it('全空提交但无答复权 → unauthorized（不 arm）', async () => {
    const ask = await registerMulti();

    const result = await handleAskCardAction({
      operator: { open_id: 'ou_intruder' },
      action: { value: { action: ASK_SUBMIT_ACTION, ask_id: ask.askId, nonce: ask.nonce } },
    });

    // 鉴权顺序：无权用户不该拿到 arm，应是 unauthorized
    expect(JSON.stringify(result)).not.toContain('确认空提交');
    expect((result as any)?.toast?.content).toContain('权限');
    expect(_getPending(ask.askId)?.settled).toBe(false);
  });

  it('混合 [单选,多选] 全空 → 直接 stale，绝不 arm（避免二次点击死路）', async () => {
    // 混合题约束：只要有一个单选问题，空集非有效答案，submitAsk 直接判 stale；
    // 若误 arm，二次确认后仍因单选未选而 stale，形成永远提交不了的死路。
    let captured: PendingAsk | undefined;
    setCardDispatcher({ async send(ask) { captured = ask; return { messageId: 'om_ask' }; } });
    registerAsk({
      larkAppId: 'cli_ask', chatId: 'oc_chat', rootMessageId: 'om_root', sessionId: 'sess-1',
      questions: [
        { prompt: 'q1', multiSelect: false, options: [{ key: 'y', label: 'Y' }, { key: 'n', label: 'N' }] },
        { prompt: 'q2', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
      timeoutMs: 10_000,
    });
    await Promise.resolve();

    const result = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: ASK_SUBMIT_ACTION, ask_id: captured!.askId, nonce: captured!.nonce } },
    });

    expect(JSON.stringify(result)).not.toContain('确认空提交');
    expect((result as any)?.toast?.content).toContain('失效'); // stale
    expect(_getPending(captured!.askId)?.settled).toBe(false);
  });

  it('勾了至少一项再提交 → 不触发二次确认，直接 settle', async () => {
    const ask = await registerMulti();

    // 勾选 a
    await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: ASK_TOGGLE_ACTION, ask_id: ask.askId, nonce: ask.nonce, question_index: '0', key: 'a' } },
    });

    // 提交（非空）→ 直接 settle，无二次确认
    const result = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: ASK_SUBMIT_ACTION, ask_id: ask.askId, nonce: ask.nonce } },
    });

    const card = result as Record<string, any>;
    expect(card.header?.title?.content).toContain('已结束');
    expect(JSON.stringify(card)).not.toContain('确认空提交');
    expect(_getPending(ask.askId)?.settled).toBe(true);
  });

  it('纯单选问题的空提交不进二次确认（交由 submitAsk 判 stale）', async () => {
    // 单选 ask：全空提交不该被 B 拦（B 只在全多选时触发）；submitAsk 对单选空集返回 stale。
    let captured: PendingAsk | undefined;
    setCardDispatcher({ async send(ask) { captured = ask; return { messageId: 'om_ask' }; } });
    registerAsk({
      larkAppId: 'cli_ask', chatId: 'oc_chat', rootMessageId: 'om_root', sessionId: 'sess-1',
      questions: [{ prompt: 'q', multiSelect: false, options: [{ key: 'y', label: 'Y' }, { key: 'n', label: 'N' }] }],
      timeoutMs: 10_000,
    });
    await Promise.resolve();

    const result = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: ASK_SUBMIT_ACTION, ask_id: captured!.askId, nonce: captured!.nonce } },
    });

    expect(JSON.stringify(result)).not.toContain('确认空提交');
    expect(_getPending(captured!.askId)?.settled).toBe(false);
  });
});

describe('createLarkAskCardDispatcher', () => {
  it('replies into the root thread when rootMessageId exists (forwards dispatchUuid)', async () => {
    const reply = vi.fn(async () => 'om_reply');
    const send = vi.fn(async () => 'om_send');
    const dispatcher = createLarkAskCardDispatcher({ replyMessage: reply as any, sendMessage: send as any });

    await expect(dispatcher.send(makePending({ dispatchUuid: 'req-uuid-1' }))).resolves.toEqual({ messageId: 'om_reply' });
    // The stable dispatchUuid is forwarded as the Feishu message uuid (idempotent re-send).
    expect(reply).toHaveBeenCalledWith('cli_ask', 'om_root', expect.any(String), 'interactive', true, 'req-uuid-1');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends to chat when rootMessageId is absent and patches on settle (forwards dispatchUuid)', async () => {
    const update = vi.fn(async () => undefined);
    const send = vi.fn(async () => 'om_send');
    const dispatcher = createLarkAskCardDispatcher({ sendMessage: send as any, updateMessage: update as any });
    const ask = makePending({ rootMessageId: null, cardMessageId: 'om_card', dispatchUuid: 'req-uuid-2' });

    await expect(dispatcher.send(ask)).resolves.toEqual({ messageId: 'om_send' });
    expect(send).toHaveBeenCalledWith('cli_ask', 'oc_chat', expect.any(String), 'interactive', 'req-uuid-2');

    await dispatcher.onSettle?.(ask, {
      kind: 'timedOut',
      selected: null,
      by: null,
      comment: null,
      timedOut: true,
    });
    expect(update).toHaveBeenCalledWith('cli_ask', 'om_card', expect.stringContaining('超时'));
  });
});
