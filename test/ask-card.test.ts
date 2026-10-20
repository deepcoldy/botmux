import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AskResult, PendingAsk } from '../src/core/ask-types.js';

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
  askPromptAttachmentText,
  buildAskCard,
  createLarkAskCardDispatcher,
  renderAskCard,
  handleAskCardAction,
  parseFormSelections,
} from '../src/im/lark/ask-card.js';
import {
  askOptionLayoutForBot,
  normalizeAskOptionLayout,
  setAskOptionLayoutLookup,
} from '../src/im/lark/ask-option-layout.js';
import { getDefaultLocale, setDefaultLocale } from '../src/i18n/index.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../src/im/lark/turn-reply-card-size.js';

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
  it.each([false, true])('preserves labelled web links before and after settlement (%s)', (settled) => {
    const ask = makePending();
    ask.questions[0]!.prompt = 'Review [design](https://example.com/design?id=4&rev=2) and [preview](http://localhost:3000/path_(v2)) before _confirming_.';
    const result: AskResult | undefined = settled ? { kind: 'answered', answers: [['deploy']], by: 'ou_owner', comment: null, timedOut: false } : undefined;
    const card = JSON.parse(buildAskCard(ask, result));
    const question = card.elements.find((item: any) => item.text?.content?.includes('Review'));
    expect(question.text.content).toContain('[design](https://example.com/design?id=4&rev=2)');
    expect(question.text.content).toContain('[preview](http://localhost:3000/path_%28v2%29)');
    expect(question.text.content).toContain('\\_confirming\\_');
  });

  it('keeps unsupported, escaped and incomplete link markup literal', () => {
    const ask = makePending();
    ask.questions[0]!.prompt = String.raw`literal \[escaped](https://example.com) ![image](https://example.com/a.png) [unsafe](javascript:alert(1)) [file](file:///tmp/a) [broken](https://example.com`;
    const card = JSON.parse(buildAskCard(ask));
    const question = card.elements.find((item: any) => item.text?.content?.includes('literal'));
    for (const label of ['escaped', 'image', 'unsafe', 'file', 'broken']) {
      expect(question.text.content).toContain(`\\[${label}\\]`);
    }
  });

  it.each(['ou_proposer_123', 'ou_proposer-123', '"ou_proposer-123"', "'ou_proposer-123'"])('preserves a host question mention with ID %s', (id) => {
    const tag = `<at id=${id}></at>`;
    const ask = makePending({ questions: [{
      prompt: `${tag} choose _one_`, multiSelect: false,
      options: [{ key: 'independent', label: 'independent' }, { key: 'suggestion', label: 'suggestion' }],
    }] });
    const card = JSON.parse(buildAskCard(ask));
    const question = card.elements.find((item: any) => item.text?.content?.includes('choose'));
    expect(question.text.content).toContain(tag);
    expect(question.text.content).toContain('\\_one\\_');
    expect(question.text.content).not.toContain('ou\\_');
  });

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

  it('XPI 指定答复人只用于点击鉴权，不作为 at/person 资源写进卡片', () => {
    const text = buildAskCard(makePending({
      answererOpenId: 'ou_cross_app_answerer',
      originKind: 'host_cross_principal_owner',
    }));

    expect(text).toContain('指定成员（仅本人可操作）');
    expect(text).not.toContain('ou_cross_app_answerer');
    expect(text).not.toContain('<at');
  });

  it('普通同 app 指定答复人仍显示具体成员', () => {
    const text = buildAskCard(makePending({ answererOpenId: 'ou_same_app_answerer' }));

    // Master keeps the complete <at> mention atomic (escaping the id underscores
    // invalidates the card); same-app asks still render the concrete mention.
    expect(text).toContain('<at id=ou_same_app_answerer></at>');
    expect(text).not.toContain('指定成员（仅本人可操作）');
  });

  it('异步文档提问保留私信答复提示，普通异步提问提示引用本卡片', () => {
    const ask = makePending({ originKind: 'native-user-input-async', answererOpenId: 'ou_owner' });
    expect(buildAskCard(ask)).toContain('引用');
    const documentAsk = buildAskCard({ ...ask, deliveryTarget: {
      kind: 'document-author', openId: 'ou_owner', turnId: 'document-turn', fileToken: 'file', commentId: 'comment',
    } });
    expect(documentAsk).toContain('文档评论任务');
    expect(documentAsk).not.toContain('只有一张待答卡');
    expect(documentAsk).not.toContain('card.ask.async_reply_hint');
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
      questions: [{ prompt: '审批内容：补充回归测试', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] }],
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
    // 终态仍保留原问题，让审批人能回看自己批准的内容。
    expect(text).toContain('审批内容：补充回归测试');
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

  it('长问题正文（>512 字符）完整渲染，不附加截断标记', () => {
    // 回归：ask 卡片曾对每个 q.prompt 做 512 字符截断（无飞书硬限制依据），
    // 审批人会在信息不全的情况下点按钮。现在问题正文必须完整渲染。
    const head = '线上 latency 涨了 30%，请确认下一步处理方案，详细背景如下：';
    const tail = '【尾部关键信息：必须看到这段才能做出正确决定】';
    const prompt = `${head}${'甲乙丙丁'.repeat(200)}${tail}`; // 800+ 字符，远超旧的 512 上限
    expect(prompt.length).toBeGreaterThan(512);
    const ask = makePending({
      questions: [
        { prompt, multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
      ],
    });

    const json = JSON.parse(buildAskCard(ask));
    const blob = JSON.stringify(json);

    // 旧逻辑截掉的尾部内容必须仍在卡片中
    expect(blob).toContain(tail);
    expect(blob).not.toContain('已截断');

    // 完整正文原样落在问题 div（prompt 不含会被 escapeMd 转义的字符）
    const questionDiv = json.elements.find(
      (el: any) => el.tag === 'div' && typeof el.text?.content === 'string' && el.text.content.includes(head),
    );
    expect(questionDiv).toBeDefined();
    expect(questionDiv.text.content).toBe(`**问题 1**\n${prompt}`);
  });

  it('多问卡片：每个长问题正文都完整渲染', () => {
    const tailA = '【第一问尾部标记-AAA】';
    const tailB = '【第二问尾部标记-BBB】';
    const promptA = `第一问 ${'子丑寅卯'.repeat(200)} ${tailA}`;
    const promptB = `第二问 ${'辰巳午未'.repeat(200)} ${tailB}`;
    const ask = makePending({
      questions: [
        { prompt: promptA, multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
        { prompt: promptB, multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
    });

    const json = JSON.parse(buildAskCard(ask));
    const questionDivs = json.elements.filter(
      (el: any) => el.tag === 'div' && typeof el.text?.content === 'string' && el.text.content.startsWith('**问题 '),
    );
    expect(questionDivs).toHaveLength(2);
    expect(questionDivs[0].text.content).toBe(`**问题 1**\n${promptA}`);
    expect(questionDivs[1].text.content).toBe(`**问题 2**\n${promptB}`);
  });

  it('英文 locale：长问题正文完整渲染，无 truncated 标记', () => {
    const prevLocale = getDefaultLocale();
    setDefaultLocale('en');
    try {
      const head = 'Production latency is up 30%, please confirm the next step. Full context: ';
      const tail = ' TAIL MARKER: must be visible to make the right call';
      const prompt = `${head}${'lorem ipsum '.repeat(100)}${tail}`;
      expect(prompt.length).toBeGreaterThan(512);
      const ask = makePending({
        questions: [
          { prompt, multiSelect: false, options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }] },
        ],
      });

      const json = JSON.parse(buildAskCard(ask));
      const blob = JSON.stringify(json);
      expect(blob).toContain(tail);
      expect(blob).not.toContain('(truncated)');
      const questionDiv = json.elements.find(
        (el: any) => el.tag === 'div' && typeof el.text?.content === 'string' && el.text.content.includes(head),
      );
      expect(questionDiv).toBeDefined();
      expect(questionDiv.text.content).toBe(`**Question 1**\n${prompt}`);
    } finally {
      setDefaultLocale(prevLocale);
    }
  });
});

describe('ask 卡整卡字节预算（飞书卡片请求体 30KB）', () => {
  const cardBytes = (json: string, chatId = 'oc_chat') => turnReplyCardRequestBytes(json, chatId);
  const questionDivs = (json: string) => (JSON.parse(json).elements as any[]).filter(
    (el) => el.tag === 'div' && typeof el.text?.content === 'string' && el.text.content.startsWith('**问题 '),
  );

  it.each([
    ['多字节中文', `${'中文多字节正文'.repeat(3000)}【中文尾部】`],
    ['ASCII 约 2.9 万字符以上', `${'stack trace line: at foo (bar.ts:1:2)\n'.repeat(1000)}ASCII-TAIL`],
  ])('超长正文（%s）：卡片请求字节 ≤ 上限，截断提示可见，全文进附件', (_name, prompt) => {
    const ask = makePending({ questions: [
      { prompt, multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
    ] });
    const rendered = renderAskCard(ask);
    expect(rendered.promptTruncated).toBe(true);
    expect(cardBytes(rendered.json)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    expect(buildAskCard(ask)).toBe(rendered.json);
    const [div] = questionDivs(rendered.json);
    expect(div.text.content).toContain('完整内容见本话题中的附件文件');
    // 预算内尽量多展示：截断后的正文仍占据大部分预算，而不是退化成很短的摘要
    expect(cardBytes(rendered.json)).toBeGreaterThan(TURN_REPLY_CARD_MAX_BYTES * 0.8);
    // 全文（含尾部）在附件内容中完整可达
    expect(askPromptAttachmentText(ask)).toContain(prompt);

    // settle 后 PATCH 的卡同样受预算约束
    const settled = renderAskCard(ask, { kind: 'answered', answers: [['y']], by: 'ou_owner', comment: null, timedOut: false });
    expect(settled.promptTruncated).toBe(true);
    expect(cardBytes(settled.json)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
  });

  it('预算内的长正文（2 万 ASCII）不截断、不发附件', () => {
    const prompt = `${'x'.repeat(20_000)}TAIL`;
    const ask = makePending({ questions: [{ prompt, multiSelect: false, options: [{ key: 'y', label: '是' }] }] });
    const rendered = renderAskCard(ask);
    expect(rendered.promptTruncated).toBe(false);
    expect(questionDivs(rendered.json)[0].text.content).toBe(`**问题 1**\n${prompt}`);
  });

  it('多问：只截断超长的那一问，短问题保持完整', () => {
    const shortPrompt = '短问题：是否继续？';
    const longPrompt = '长'.repeat(20_000);
    const ask = makePending({ questions: [
      { prompt: shortPrompt, multiSelect: false, options: [{ key: 'y', label: '是' }] },
      { prompt: longPrompt, multiSelect: true, options: [{ key: 'a', label: 'A' }] },
    ] });
    const rendered = renderAskCard(ask);
    expect(rendered.promptTruncated).toBe(true);
    expect(cardBytes(rendered.json)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    const divs = questionDivs(rendered.json);
    expect(divs[0].text.content).toBe(`**问题 1**\n${shortPrompt}`);
    expect(divs[1].text.content).toContain('完整内容见本话题中的附件文件');
    const attachment = askPromptAttachmentText(ask);
    expect(attachment).toContain(shortPrompt);
    expect(attachment).toContain(longPrompt);
  });

  it('不在代理对中间截断（emoji 正文）', () => {
    const ask = makePending({ questions: [{ prompt: '😀'.repeat(20_000), multiSelect: false, options: [{ key: 'y', label: '是' }] }] });
    const rendered = renderAskCard(ask);
    expect(rendered.promptTruncated).toBe(true);
    expect(rendered.json).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(cardBytes(rendered.json)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
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
  it('超长正文：先把全文作为附件发进同一话题，再发预算内的截断卡（独立 ask 卡的 overflow 兜底）', async () => {
    const prompt = `${'跨 principal 建议正文'.repeat(3000)}【尾部关键条件】`;
    const realUuid = 'ask-'.padEnd(44, 'a'); // 真实 dispatchUuid 形态：ask- + 40 hex = 44 字符
    const calls: Array<{ type: string; content: string; uuid?: string }> = [];
    let uploaded = '';
    const reply = vi.fn(async (_app: string, _root: string, content: string, type: string, _inThread: boolean, uuid?: string) => {
      calls.push({ type, content, uuid });
      return type === 'file' ? 'om_file' : 'om_card';
    });
    const upload = vi.fn(async (_app: string, path: string) => {
      uploaded = readFileSync(path, 'utf8');
      return 'file_key_1';
    });
    const dispatcher = createLarkAskCardDispatcher({ replyMessage: reply as any, uploadFile: upload as any });
    const ask = makePending({ dispatchUuid: realUuid, questions: [
      { prompt, multiSelect: false, options: [{ key: 'y', label: '采纳' }, { key: 'n', label: '不采纳' }] },
    ] });

    await expect(dispatcher.send(ask)).resolves.toEqual({ messageId: 'om_card' });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(uploaded).toContain(prompt);
    expect(calls.map(c => c.type)).toEqual(['file', 'interactive']);
    expect(JSON.parse(calls[0]!.content)).toEqual({ file_key: 'file_key_1' });
    expect(calls[0]!.uuid).toMatch(/^askf_[0-9a-f]{32}$/);
    expect(calls[0]!.uuid!.length).toBeLessThanOrEqual(50);
    expect(calls[1]!.uuid).toBe(realUuid);
    // 用真实 uuid 测量截断卡，两种信封都必须 ≤ 30KB
    expect(turnReplyCardRequestBytes(calls[1]!.content, ask.chatId, realUuid)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    expect(calls[1]!.content).toContain('完整内容见本话题中的附件文件');
  });

  it('P2 回归：send 信封（root=null）截断卡真实请求体 ≤ 30KB，不少算 8 字节', async () => {
    // 变异友好：若 renderAskCard 预算时未传真实 uuid（沿用 36 字符短尺），
    // 二分顶到测量 30,000 时 send 信封真实体 = 30,008，此断言变红。
    const prompt = `${'跨 principal 建议正文'.repeat(3000)}【尾部关键条件】`;
    const realUuid = 'ask-'.padEnd(44, 'b');
    const calls: Array<{ type: string; content: string; uuid?: string }> = [];
    const send = vi.fn(async (_app: string, _chat: string, content: string, _type: string, uuid?: string) => {
      calls.push({ type: 'send', content, uuid });
      return 'om_card';
    });
    const upload = vi.fn(async (_app: string, path: string) => {
      readFileSync(path, 'utf8');
      return 'file_key_1';
    });
    const dispatcher = createLarkAskCardDispatcher({ sendMessage: send as any, uploadFile: upload as any });
    const ask = makePending({ rootMessageId: null, dispatchUuid: realUuid, questions: [
      { prompt, multiSelect: false, options: [{ key: 'y', label: '采纳' }, { key: 'n', label: '不采纳' }] },
    ] });

    await expect(dispatcher.send(ask)).resolves.toEqual({ messageId: 'om_card' });
    expect(calls).toHaveLength(2); // file + interactive
    expect(calls[1]!.uuid).toBe(realUuid);
    // send 信封（receive_id）+ reply 信封（reply_in_thread）都必须 ≤ 30KB
    expect(turnReplyCardRequestBytes(calls[1]!.content, ask.chatId, realUuid)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    // 变异友好锁死：直接断言 send 信封不超（不用 max，单独测 receive_id 信封）
    const sendBytes = Buffer.byteLength(JSON.stringify({
      msg_type: 'interactive',
      content: calls[1]!.content,
      uuid: realUuid,
      receive_id: ask.chatId,
    }), 'utf8');
    expect(sendBytes).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
  });

  it('附件发送瞬时失败：抛 retryable，且不发出卡片（重试复用同一 uuid 去重）', async () => {
    const reply = vi.fn(async () => 'om_x');
    const upload = vi.fn(async () => { throw Object.assign(new Error('rate limited'), { code: 99991400 }); });
    const dispatcher = createLarkAskCardDispatcher({ replyMessage: reply as any, uploadFile: upload as any });
    const ask = makePending({ questions: [{ prompt: '长'.repeat(20_000), multiSelect: false, options: [{ key: 'y', label: '是' }] }] });
    await expect(dispatcher.send(ask)).rejects.toMatchObject({ retryable: true });
    expect(reply).not.toHaveBeenCalled();
  });

  it('附件确定性失败：仍发出截断卡，不让审批卡整张丢失', async () => {
    const reply = vi.fn(async () => 'om_card');
    const upload = vi.fn(async () => { throw Object.assign(new Error('no permission'), { response: { status: 400, data: { code: 99991672 } } }); });
    const dispatcher = createLarkAskCardDispatcher({ replyMessage: reply as any, uploadFile: upload as any });
    const ask = makePending({ questions: [{ prompt: '长'.repeat(20_000), multiSelect: false, options: [{ key: 'y', label: '是' }] }] });
    await expect(dispatcher.send(ask)).resolves.toEqual({ messageId: 'om_card' });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith('cli_ask', 'om_root', expect.any(String), 'interactive', true, undefined);
  });

  it('预算内的卡不上传附件', async () => {
    const reply = vi.fn(async () => 'om_reply');
    const upload = vi.fn(async () => 'fk');
    const dispatcher = createLarkAskCardDispatcher({ replyMessage: reply as any, uploadFile: upload as any });
    await dispatcher.send(makePending());
    expect(upload).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });
});

describe('ask option layout（askOptionLayout per-bot 配置）', () => {
  afterEach(() => {
    // 还原为「无配置」lookup，避免污染同文件其它用例（未配置即 compact）。
    setAskOptionLayoutLookup(() => undefined);
  });

  it('normalizeAskOptionLayout：合法值原样通过，非法值给 warning 并丢弃', () => {
    expect(normalizeAskOptionLayout(undefined)).toEqual({ warnings: [] });
    expect(normalizeAskOptionLayout(null)).toEqual({ warnings: [] });
    expect(normalizeAskOptionLayout('compact')).toEqual({ layout: 'compact', warnings: [] });
    expect(normalizeAskOptionLayout('vertical')).toEqual({ layout: 'vertical', warnings: [] });
    for (const bad of ['sideways', 42, true, [], {}]) {
      const r = normalizeAskOptionLayout(bad);
      expect(r.layout, JSON.stringify(bad)).toBeUndefined();
      expect(r.warnings).toHaveLength(1);
    }
  });

  it('askOptionLayoutForBot：lookup 未注册 / bot 未知 / 值非法 / 抛错一律回退 compact', () => {
    expect(askOptionLayoutForBot('cli_ask')).toBe('compact');
    setAskOptionLayoutLookup(() => undefined);
    expect(askOptionLayoutForBot('cli_ask')).toBe('compact');
    setAskOptionLayoutLookup(() => ({ config: { askOptionLayout: 'sideways' } }));
    expect(askOptionLayoutForBot('cli_ask')).toBe('compact');
    setAskOptionLayoutLookup(() => { throw new Error('boom'); });
    expect(askOptionLayoutForBot('cli_ask')).toBe('compact');
    setAskOptionLayoutLookup(() => ({ config: { askOptionLayout: 'vertical' } }));
    expect(askOptionLayoutForBot('cli_ask')).toBe('vertical');
    expect(askOptionLayoutForBot(undefined)).toBe('compact');
  });

  it('默认 compact：action 行每行最多 4 个按钮，无 column_set', () => {
    const ask = makePending({
      questions: [{
        prompt: 'q', multiSelect: false,
        options: Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, label: `L${i}` })),
      }],
    });
    const card = JSON.parse(buildAskCard(ask));
    expect(card.elements.some((el: any) => el.tag === 'column_set')).toBe(false);
    const optionRows = card.elements.filter((el: any) =>
      el.tag === 'action' && el.actions.some((a: any) => a.value?.action === ASK_SELECT_ACTION));
    expect(optionRows).toHaveLength(2);
    expect(optionRows[0].actions).toHaveLength(4);
    expect(optionRows[1].actions).toHaveLength(2);
  });

  it('vertical：每个选项一个 column_set 行，单列 weighted、一按钮', () => {
    setAskOptionLayoutLookup((id) => id === 'cli_ask'
      ? { config: { askOptionLayout: 'vertical' } }
      : undefined);
    const card = JSON.parse(buildAskCard(makePending()));
    const columnSets = card.elements.filter((el: any) => el.tag === 'column_set');
    expect(columnSets).toHaveLength(3);
    for (const row of columnSets) {
      expect(row.flex_mode).toBe('none');
      expect(row.horizontal_spacing).toBe('small');
      expect(row.columns).toHaveLength(1);
      expect(row.columns[0]).toMatchObject({ tag: 'column', width: 'weighted', weight: 1 });
      const buttons = row.columns[0].elements.filter((el: any) => el.tag === 'button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0].value.action).toBe(ASK_SELECT_ACTION);
    }
    // vertical 下不再有装选项按钮的 action 行
    expect(card.elements.some((el: any) =>
      el.tag === 'action' && el.actions.some((a: any) => a.value?.action === ASK_SELECT_ACTION))).toBe(false);
  });

  it('vertical 只影响选项按钮：submit 行仍是 action 行，按钮值不变', () => {
    setAskOptionLayoutLookup(() => ({ config: { askOptionLayout: 'vertical' } }));
    const ask = makePending({
      questions: [
        { prompt: 'q1', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
    });
    const card = JSON.parse(buildAskCard(ask));
    const submitRow = card.elements.find((el: any) =>
      el.tag === 'action' && el.actions.some((a: any) => a.value?.action === ASK_SUBMIT_ACTION));
    expect(submitRow).toBeDefined();
    const toggleRows = card.elements.filter((el: any) => el.tag === 'column_set');
    expect(toggleRows).toHaveLength(2);
    expect(toggleRows[0].columns[0].elements[0].value.action).toBe(ASK_TOGGLE_ACTION);
  });
});
