/**
 * 话题指令头解析器的语法边界。
 *
 * 表驱动，逐条对应设计文档
 * docs/design/2026-09-10-topic-directive-header.md §3 的「边界情况」表 —— 表里每一行
 * 在下面都有一条同名用例（`/repo 2` 与「正文以白名单词开头」两行的**拒绝**发生在语义层，
 * 由 test/topic-spec.test.ts 接住，这里只钉住它们解析出的形状）。
 *
 * Run:  bun run vitest run test/topic-header.test.ts
 */
import { describe, it, expect } from 'vitest';

import { parseTopicHeader, type TopicHeaderParse } from '../src/core/topic-header.js';

/** 头部对象的可断言快照（省掉 ok/sentinel 噪音，直接比语义三件套）。 */
function shape(parsed: TopicHeaderParse) {
  if (parsed === null) return null;
  // sentinel 是给授权提示/日志用的附加信息，断言时剥掉以免每条用例都要重复它。
  if (parsed.ok === false) {
    const { sentinel: _sentinel, ...reason } = parsed;
    return reason;
  }
  return { title: parsed.title, directives: parsed.directives, prompt: parsed.prompt };
}

describe('parseTopicHeader —— §3 边界情况表', () => {
  const cases: Array<{ row: string; input: string; expected: ReturnType<typeof shape> }> = [
    {
      row: '没有 /t token → 普通消息，与今天一致',
      input: '帮我看一下 daemon 日志',
      expected: null,
    },
    {
      row: '/t 在位置 0，后面没有指令 → 今天的 /t [文案] 行为',
      input: '/t 帮我看看 X',
      expected: { title: undefined, directives: {}, prompt: '帮我看看 X' },
    },
    {
      row: '有标题行，没有指令 → 标题 + 正文',
      input: 'botmux 日常运维 /t 今天例行看一下 daemon 日志',
      expected: {
        title: 'botmux 日常运维',
        directives: {},
        prompt: '今天例行看一下 daemon 日志',
      },
    },
    {
      // 设计文档 §3 原表把「缺参数」一律判为拒绝；`/repo` 例外，因为它今天就有裸形式
      //（`/t /repo` = 在默认目录直接开会话），既有用户习惯必须原样兼容。缺参数的拒绝
      // 因此只对没有裸形式的 `/model` `/effort` 生效。
      row: '指令缺参数（… /t /model 结尾）→ 拒绝：用法错误',
      input: '日常运维 /t /model',
      expected: { ok: false, kind: 'missing_arg', directive: 'model' },
    },
    {
      row: '裸 /repo（无参数）→ 记成 null，沿用今天「默认目录直接开会话」的语义',
      input: '日常运维 /t /repo',
      expected: { title: '日常运维', directives: { repo: null }, prompt: '' },
    },
    {
      row: '指令位置出现白名单外的 /xxx → 拒绝：未知指令',
      input: '日常运维 /t /repo botmux /clear',
      expected: { ok: false, kind: 'unknown_directive', token: '/clear' },
    },
    {
      row: '同一指令出现两次 → 拒绝',
      input: '/t /repo botmux /repo homelab 干活',
      expected: { ok: false, kind: 'duplicate_directive', directive: 'repo' },
    },
    {
      row: '正文恰好以白名单词开头 → 被当模型名消费（拒绝发生在语义层）',
      input: '/t /repo botmux /model 命令为啥坏了',
      expected: {
        title: undefined,
        directives: { repo: 'botmux', model: '命令为啥坏了' },
        prompt: '',
      },
    },
    {
      row: '标题区出现第二个 /t → 第一个 /t token 是分隔符',
      input: '/t 顺手说下 /t 是什么',
      expected: { title: undefined, directives: {}, prompt: '顺手说下 /t 是什么' },
    },
    {
      row: '标题里含 / 开头 token → 判为非指令头',
      input: '/close 然后 /t 干活',
      expected: null,
    },
    {
      row: '/repo 2（数字形式）→ 语法上就是个参数（拒绝发生在语义层）',
      input: '/t /repo 2 干活',
      expected: { title: undefined, directives: { repo: '2' }, prompt: '干活' },
    },
    {
      row: '带空格的仓库路径 → 双引号包裹',
      input: '/t /repo "~/Code/my project" 跑一下测试',
      expected: {
        title: undefined,
        directives: { repo: '~/Code/my project' },
        prompt: '跑一下测试',
      },
    },
  ];

  for (const { row, input, expected } of cases) {
    it(row, () => {
      expect(shape(parseTopicHeader(input))).toEqual(expected);
    });
  }
});

describe('parseTopicHeader —— 空白不敏感（D2）', () => {
  const singleLine =
    'botmux 日常运维 /t /repo botmux /model sonnet[1m] 今天例行看一下 daemon 日志里的重启记录';
  const multiLine = [
    'botmux 日常运维',
    '/t',
    '/repo botmux',
    '/model sonnet[1m]',
    '',
    '今天例行看一下 daemon 日志里的重启记录',
  ].join('\n');

  it('单行与多行解析出同一份规格', () => {
    const a = parseTopicHeader(singleLine);
    const b = parseTopicHeader(multiLine);
    expect(shape(a)).toEqual({
      title: 'botmux 日常运维',
      directives: { repo: 'botmux', model: 'sonnet[1m]' },
      prompt: '今天例行看一下 daemon 日志里的重启记录',
    });
    expect(shape(b)).toEqual(shape(a));
  });

  it('正文里的换行与缩进原样保留', () => {
    const parsed = parseTopicHeader('标题 /t /repo botmux 第一行\n  第二行\n\n第三行   ');
    expect(shape(parsed)).toEqual({
      title: '标题',
      directives: { repo: 'botmux' },
      prompt: '第一行\n  第二行\n\n第三行',
    });
  });

  it('标题跨多行时归一化成单行', () => {
    const parsed = parseTopicHeader('线上事故\n复盘\n/t 拉一下时间线');
    expect(shape(parsed)).toEqual({
      title: '线上事故 复盘',
      directives: {},
      prompt: '拉一下时间线',
    });
  });
});

describe('parseTopicHeader —— 分隔符识别', () => {
  it('/topic 是等价别名，大小写不敏感', () => {
    expect(parseTopicHeader('/Topic 干活')).toMatchObject({ ok: true, sentinel: '/topic', prompt: '干活' });
    expect(parseTopicHeader('/T 干活')).toMatchObject({ ok: true, sentinel: '/t', prompt: '干活' });
  });

  it('必须是完整 token：/tea、/topical 不匹配', () => {
    expect(parseTopicHeader('/tea 来一杯')).toBeNull();
    expect(parseTopicHeader('/topical 讨论')).toBeNull();
  });

  it('裸 /t / 裸 /topic → 空正文（今天的话题设置行为）', () => {
    expect(shape(parseTopicHeader('/t'))).toEqual({ title: undefined, directives: {}, prompt: '' });
    expect(shape(parseTopicHeader('  /topic  '))).toEqual({ title: undefined, directives: {}, prompt: '' });
  });

  it('引号包裹的 /t 是字面量，不当分隔符', () => {
    expect(parseTopicHeader('"/t" 是开话题命令')).toBeNull();
  });
});

describe('parseTopicHeader —— 向后兼容（D9）', () => {
  it('/t /repo X 归一成一条 directive，正文为空', () => {
    expect(shape(parseTopicHeader('/t /repo botmux'))).toEqual({
      title: undefined,
      directives: { repo: 'botmux' },
      prompt: '',
    });
  });

  it('裸 /t 后跟别的斜杠命令仍是纯文案，交给既有命令路径', () => {
    // `/t /goal 修一下登录` 今天会冷启动 CLI 的 /goal；解析器不得提前拒掉它。
    expect(shape(parseTopicHeader('/t /goal 修一下登录'))).toEqual({
      title: undefined,
      directives: {},
      prompt: '/goal 修一下登录',
    });
    expect(shape(parseTopicHeader('/t /close'))).toEqual({
      title: undefined,
      directives: {},
      prompt: '/close',
    });
  });

  it('但用户一旦写了标题或指令，未知 /xxx 就 fail closed', () => {
    expect(shape(parseTopicHeader('标题 /t /goal 修一下登录'))).toEqual({
      ok: false, kind: 'unknown_directive', token: '/goal',
    });
    expect(shape(parseTopicHeader('/t /model opus /goal 修一下登录'))).toEqual({
      ok: false, kind: 'unknown_directive', token: '/goal',
    });
  });
});

describe('parseTopicHeader —— 防误触护栏', () => {
  it('标题超过 3 行 → 不是指令头', () => {
    expect(parseTopicHeader('一\n二\n三\n四\n/t 干活')).toBeNull();
  });

  it('标题归一化后超过 200 字 → 不是指令头', () => {
    expect(parseTopicHeader(`${'字'.repeat(201)} /t 干活`)).toBeNull();
    expect(parseTopicHeader(`${'字'.repeat(200)} /t 干活`)).toMatchObject({ ok: true });
  });

  it('长文里第 40 行的 /t 不会被当成开话题', () => {
    const longText = `${Array.from({ length: 40 }, (_, i) => `第 ${i} 行说明`).join('\n')}\n/t 之类的命令`;
    expect(parseTopicHeader(longText)).toBeNull();
  });
});

describe('parseTopicHeader —— 指令参数细节', () => {
  it('指令名大小写不敏感', () => {
    expect(shape(parseTopicHeader('/t /REPO botmux /Model opus 干活'))).toEqual({
      title: undefined,
      directives: { repo: 'botmux', model: 'opus' },
      prompt: '干活',
    });
  });

  it('参数位上出现另一条头部指令 → 不当仓库名吃掉', () => {
    // `/repo` 有裸形式：后面那条 `/model` 照常解析，两条指令都生效。
    expect(shape(parseTopicHeader('/t /repo /model opus 干活'))).toEqual({
      title: undefined,
      directives: { repo: null, model: 'opus' },
      prompt: '干活',
    });
    // 没有裸形式的指令仍然判缺参数。
    expect(shape(parseTopicHeader('/t /model /effort high'))).toEqual({
      ok: false, kind: 'missing_arg', directive: 'model',
    });
    expect(shape(parseTopicHeader('/t /effort'))).toEqual({
      ok: false, kind: 'missing_arg', directive: 'effort',
    });
  });

  it('参数是空的/纯空白的双引号 → 判缺参数，不当成裸形式', () => {
    // `/repo ""` 多半来自模板或复制粘贴事故。此前它被静默当成「没写 /repo」，于是
    // 既不是 `/repo X`（钉仓库）也不是裸 `/repo`（默认目录开工），而是第三种没人定义过
    // 的结果。三条指令统一落到 missing_arg。
    for (const directive of ['repo', 'model', 'effort'] as const) {
      expect(shape(parseTopicHeader(`/t /${directive} "" 干活`))).toEqual({
        ok: false, kind: 'missing_arg', directive,
      });
      expect(shape(parseTopicHeader(`/t /${directive} "   " 干活`))).toEqual({
        ok: false, kind: 'missing_arg', directive,
      });
    }
  });

  it('/repo wt 只吃得下 wt 这一个 token（拒绝发生在语义层）', () => {
    // 会话中途的 `/repo wt <编号|项目名> [分支]` 吃整行；头部里只吃一个 token，
    // 所以 `wt` 会落到仓库名位置。语义层显式拒绝，见 topic-spec 的用例。
    expect(shape(parseTopicHeader('/t /repo wt botmux feat/x'))).toEqual({
      title: undefined,
      directives: { repo: 'wt' },
      prompt: 'botmux feat/x',
    });
  });

  it('引号包裹的参数可以长得像指令', () => {
    expect(shape(parseTopicHeader('/t /repo "/model" 干活'))).toEqual({
      title: undefined,
      directives: { repo: '/model' },
      prompt: '干活',
    });
  });

  it('三条指令可以任意顺序出现', () => {
    expect(shape(parseTopicHeader('/t /effort high /model opus /repo botmux 干活'))).toEqual({
      title: undefined,
      directives: { effort: 'high', model: 'opus', repo: 'botmux' },
      prompt: '干活',
    });
  });

  it('正文里之后出现的 /xxx 原样保留', () => {
    expect(shape(parseTopicHeader('/t /repo botmux 帮我看看 /adopt 这个命令怎么用'))).toEqual({
      title: undefined,
      directives: { repo: 'botmux' },
      prompt: '帮我看看 /adopt 这个命令怎么用',
    });
  });
});
