# botmux askUserQuestion hook 接管 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 botmux 的 askUserQuestion 能力从"skill 教 agent 调 `botmux ask`"改为"hook 拦截 agent 原生 askUserQuestion 自动接管"，并完整支持多选 + 多问。

**Architecture:** CLI 触发 hook → `botmux hook <cliId>` 客户端（读 stdin、解析、POST `/api/asks`、等结果、回吐 directive）→ daemon 复用现有 `ask-broker`/审批链 → 飞书卡片（升级为多问+多选+Submit）→ 用户提交 → broker settle → 客户端把答案格式化成各 CLI 的 directive 写回 stdout。进料/回传两端新增，daemon 中段（审批链、route 骨架、env 注入）复用，broker/card/types 因多选向后兼容扩展。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀)、Node、vitest、飞书互动卡片 JSON。本期仅 Claude Code / Codex / OpenCode 三家（directive 回填）。

**Spec:** `docs/design/2026-05-25-botmux-ask-hooks-design.md`

**测试命令：** `cd /root/iserver/botmux/.claude/worktrees/botmux-ask-hooks && pnpm vitest run <file>`（全量：`pnpm vitest run`）。类型检查：`pnpm typecheck`（若有该 script，否则 `pnpm tsc --noEmit`）。

---

## File Structure

**新增：**
- `src/core/ask-hook/types.ts` — hook adapter 公共类型（`AskQuestion`、`HookAskAdapter`）
- `src/core/ask-hook/claude-code.ts` — Claude `parseQuestions` + `formatAnswer`
- `src/core/ask-hook/codex.ts` — Codex 同上
- `src/core/ask-hook/opencode.ts` — OpenCode 同上
- `src/core/ask-hook/registry.ts` — 按 cliId 取 adapter
- `src/adapters/hook-installer.ts` — 把 hook 配置写入各 CLI 的 settings（幂等）
- `test/ask-hook-claude.test.ts` / `test/ask-hook-codex.test.ts` / `test/ask-hook-opencode.test.ts`
- `test/hook-installer.test.ts`

**修改（向后兼容扩展）：**
- `src/core/ask-types.ts` — 问答模型扩为 questions[]、结果按问分组
- `src/core/ask-broker.ts` — 累积勾选、Submit 才 settle
- `src/core/ask-api.ts` — `parseAskBody` 接受 questions[]（兼容旧 options[]）
- `src/im/lark/ask-card.ts` — 卡片升级为多问+多选+Submit
- `src/cli.ts` — 新增 `botmux hook <cliId>` 子命令 + 抽 `postAsk()` 公共函数
- `src/core/worker-pool.ts` — `ensureCliSkills` 内追加 hook 安装
- `src/adapters/cli/types.ts` — adapter 增加可选 `hookInstall` 元数据
- `src/adapters/cli/{claude-code,codex,opencode}.ts` — 填 `hookInstall`
- `src/skills/definitions.ts` — 退役 `botmux-ask` skill

---

## Task 0: Spike — 验证飞书多选卡片 + Submit 回调形状（非 TDD）

**目的：** Task 4/5 的卡片 JSON 与回调解析依赖飞书互动卡片"多选组 + Submit"的真实 payload 形状。先用一次性脚本发卡并捕获回调，锁定字段，避免后续返工。

**Files:** 临时脚本 `scripts/spike-ask-card.ts`（验证后删除，不提交）。

- [ ] **Step 1：构造一张测试卡片**，含：1 个 `select_static`（单选下拉）、1 个 `multi_select_static`（多选下拉，各 option `value` 用 `q0::keyA` 形式编码"问题序号::选项key"），外层包 `form`（`tag:'form'`, `name:'ask_form'`），底部 1 个 `button`（`action_type:'form_submit'` 或飞书当前等价写法，`value:{action:'ask_submit', ask_id, nonce}`）。参考现有 `src/im/lark/ask-card.ts` 的 `sendMessage(..., 'interactive')` 发送方式。

- [ ] **Step 2：发到一个测试 chat**（用一个真实 larkAppId + chatId，借 `src/im/lark/client.ts` 的 `sendMessage`）。

- [ ] **Step 3：在 daemon webhook/card 回调处打印原始 action data**，点一次 Submit，记录：`data.action.value`、表单各字段名与值的真实结构（单选值形状、多选值是数组还是逗号串）。

- [ ] **Step 4：把结论写进 spec 附录**（`docs/design/2026-05-25-botmux-ask-hooks-design.md` 末尾追加"附录A：飞书 form 回调形状实测"）。后续 Task 4/5 以此为准。

- [ ] **Step 5：删除 spike 脚本，提交 spec 附录**

```bash
rm scripts/spike-ask-card.ts
git add docs/design/2026-05-25-botmux-ask-hooks-design.md
git commit -m "docs(ask): 附录A 飞书 form 多选回调形状实测结论"
```

> 若实测发现飞书不支持 `multi_select_static` + form 一次性提交，回退方案：多选用多个 `checker`（开关）组件 + 状态存 broker（toggle 动作累积），Submit 收口。该回退已在 Task 5 的 broker toggle 路径覆盖。

---

## Task 1: 扩展 `ask-types.ts` 为多问 + 多选模型（向后兼容）

**Files:**
- Modify: `src/core/ask-types.ts`
- Test: `test/ask-types-shape.test.ts`（新增，纯类型/构造用例）

- [ ] **Step 1: 写失败测试**（`test/ask-types-shape.test.ts`）

```ts
import { describe, it, expect } from 'vitest';
import { toLegacySelected, type AskQuestion, type AskResult } from '../src/core/ask-types.js';

describe('ask-types 多问多选模型', () => {
  it('toLegacySelected: 单问单选答案映射回旧 selected 字符串', () => {
    const answered: AskResult = {
      kind: 'answered',
      answers: [['yes']],
      by: 'ou_x',
      comment: null,
      timedOut: false,
    };
    expect(toLegacySelected(answered)).toBe('yes');
  });

  it('toLegacySelected: 多选或多问返回 null（旧单选语义不适用）', () => {
    const multi: AskResult = {
      kind: 'answered', answers: [['a', 'b']], by: 'ou_x', comment: null, timedOut: false,
    };
    expect(toLegacySelected(multi)).toBeNull();
  });

  it('AskQuestion 结构含 prompt/options/multiSelect', () => {
    const q: AskQuestion = { prompt: 'go?', options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }], multiSelect: false };
    expect(q.options).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/ask-types-shape.test.ts`
Expected: FAIL（`toLegacySelected` / `AskQuestion` 未导出）

- [ ] **Step 3: 修改 `ask-types.ts`**

新增 `AskQuestion`；`CreateAskInput`/`PendingAsk` 的 `options` 改为 `questions: ReadonlyArray<AskQuestion>`；`AskResult.answered` 的 `selected: string` 改为 `answers: ReadonlyArray<ReadonlyArray<string>>`（`answers[i]` 对应 `questions[i]` 选中的 key 数组）；`AskClickOutcome` 增加 `'toggled'`（多选勾选累积，未 settle）。新增辅助：

```ts
/** 旧单选语义兼容：仅当"单问且恰好选 1 个"时返回该 key，否则 null。
 *  `botmux ask buttons` 子命令与其测试据此保持单选行为不变。 */
export function toLegacySelected(result: AskResult): string | null {
  if (result.kind !== 'answered') return null;
  if (result.answers.length === 1 && result.answers[0].length === 1) {
    return result.answers[0][0];
  }
  return null;
}
```

`AskResult` 的 `answered` 变体：
```ts
| { kind: 'answered'; answers: ReadonlyArray<ReadonlyArray<string>>; by: string; comment: null; timedOut: false }
```
`AskJsonOutput` 增加 `answers: string[][] | null`，保留 `selected: string | null`（= `toLegacySelected`）做向后兼容。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run test/ask-types-shape.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/ask-types.ts test/ask-types-shape.test.ts
git commit -m "feat(ask): types 扩为多问多选模型 + toLegacySelected 兼容"
```

> 注：本步会让 `ask-broker.ts`/`ask-card.ts`/`ask-api.ts` 暂时类型不通过——Task 2/3/4 依次修复。执行顺序勿跳。

---

## Task 2: 扩展 `ask-broker.ts`：累积勾选 + Submit 才 settle

**Files:**
- Modify: `src/core/ask-broker.ts`
- Test: `test/ask-broker.test.ts`（在现有文件追加用例；现有用例按新模型调整）

- [ ] **Step 1: 写失败测试**（追加到 `test/ask-broker.test.ts`）

```ts
it('多选：toggle 累积，submit 才 settle', async () => {
  _resetForTest();
  setCardDispatcher({ send: async () => ({ messageId: 'm1' }) });
  const p = registerAsk({
    larkAppId: 'a', chatId: 'c', rootMessageId: null, sessionId: 's',
    approvers: new Set(['ou_u']),
    questions: [{ prompt: 'pick', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], multiSelect: true }],
    timeoutMs: 60_000,
  });
  const askId = [..._allAskIds()][0];
  const nonce = _getPending(askId)!.nonce;
  expect(toggleAsk({ askId, nonce, questionIndex: 0, key: 'a', by: 'ou_u' })).toBe('toggled');
  expect(toggleAsk({ askId, nonce, questionIndex: 0, key: 'b', by: 'ou_u' })).toBe('toggled');
  expect(submitAsk({ askId, nonce, by: 'ou_u' })).toBe('accepted');
  const r = await p;
  expect(r.kind).toBe('answered');
  if (r.kind === 'answered') expect([...r.answers[0]].sort()).toEqual(['a', 'b']);
});

it('单问单选：submit 携带单选答案', async () => {
  _resetForTest();
  setCardDispatcher({ send: async () => ({ messageId: 'm1' }) });
  const p = registerAsk({
    larkAppId: 'a', chatId: 'c', rootMessageId: null, sessionId: 's',
    approvers: new Set(['ou_u']),
    questions: [{ prompt: 'go', options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }], multiSelect: false }],
    timeoutMs: 60_000,
  });
  const askId = [..._allAskIds()][0];
  const nonce = _getPending(askId)!.nonce;
  expect(submitAsk({ askId, nonce, by: 'ou_u', selections: [['y']] })).toBe('accepted');
  const r = await p;
  if (r.kind === 'answered') expect(r.answers).toEqual([['y']]);
});

it('未授权 toggle/submit 不改变状态', () => {
  /* 构造同上，toggleAsk/submitAsk 传 by:'ou_other' → 期望 'unauthorized'，_pendingCount() 不变 */
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run test/ask-broker.test.ts`
Expected: FAIL（`toggleAsk`/`submitAsk`/`_allAskIds` 未定义、`registerAsk` 仍要 `options`）

- [ ] **Step 3: 改 `ask-broker.ts`**

- `InternalPending` 增加 `selections: Map<number, Set<string>>`（按问题序号累积选中的 key）。
- `registerAsk` 用 `input.questions` 初始化；为每个 `multiSelect:false` 的问题不预选。
- 新增 `toggleAsk({askId, nonce, questionIndex, key, by})`：校验同 `tryResolveAsk`（存在/nonce/未 settle/授权/选项合法）；命中则在 `selections[questionIndex]` 翻转该 key（单选问题：set 内只保留该 key），返回 `'toggled'`；非法返回对应 outcome。
- 新增 `submitAsk({askId, nonce, by, selections?})`：校验同上；`selections` 显式传入时（按钮单选/一次性 form 提交场景）直接用之，否则用累积的 `selections`；要求每个 `multiSelect:false` 的问题恰好 1 个选中、`multiSelect:true` 的问题按该 CLI 语义（≥0，由 adapter 决定是否允许空，broker 不强制）；校验通过则 `settle(kind:'answered', answers)` 并返回 `'accepted'`。
- 保留 `tryResolveAsk` 作为"单问单选按钮即答"的便捷封装：内部等价 `submitAsk({..., selections:[[selected]]})`，使 `botmux ask buttons` 与其旧测试零回归。
- 新增测试辅助 `export function _allAskIds(): string[]`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run test/ask-broker.test.ts`
Expected: PASS（含原有用例）

- [ ] **Step 5: Commit**

```bash
git add src/core/ask-broker.ts test/ask-broker.test.ts
git commit -m "feat(ask): broker 支持 toggle 累积 + submit 收口，tryResolveAsk 退化为单选封装"
```

---

## Task 3: `ask-api.ts` 接受 questions[]（兼容旧 options[]）

**Files:**
- Modify: `src/core/ask-api.ts`
- Test: `test/ask-api.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试**（追加）

```ts
it('接受 questions[]（多问多选）', () => {
  const body = parseAskBody({
    sessionId: 's', chatId: 'c', larkAppId: 'a', rootMessageId: null,
    timeoutMs: 60000, approvers: [],
    questions: [
      { prompt: 'q1', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
      { prompt: 'q2', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
    ],
  });
  expect('error' in body).toBe(false);
  if (!('error' in body)) { expect(body.questions).toHaveLength(2); expect(body.questions[1].multiSelect).toBe(true); }
});

it('兼容旧 options[]+prompt：归一成单问单选', () => {
  const body = parseAskBody({
    sessionId: 's', chatId: 'c', larkAppId: 'a', rootMessageId: null,
    timeoutMs: 60000, approvers: [], prompt: 'go?', options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }],
  });
  if (!('error' in body)) { expect(body.questions).toHaveLength(1); expect(body.questions[0].prompt).toBe('go?'); expect(body.questions[0].multiSelect).toBe(false); }
});

it('每问 options<2 报错', () => {
  const body = parseAskBody({ sessionId:'s',chatId:'c',larkAppId:'a',rootMessageId:null,timeoutMs:60000,approvers:[], questions:[{prompt:'q',multiSelect:false,options:[{key:'x',label:'X'}]}] });
  expect('error' in body).toBe(true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run test/ask-api.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 `parseAskBody`**

`AskApiBody` 用 `questions: AskQuestion[]` 替代 `options/prompt`。解析逻辑：
- 若 `r.questions` 是数组 → 逐问校验（`prompt` 非空 string、`multiSelect` boolean、`options` 数组且 ≥2、每 option `key` 非空且去重、`label` string）。
- 否则若存在旧的 `r.options`+`r.prompt` → 归一成 `[{ prompt, multiSelect:false, options }]`（兼容 `botmux ask buttons`）。
- 都没有 → `{ error:'bad_options' }`。
- 新增错误码 `'bad_questions'`、`'bad_question_shape'`、`'bad_multiSelect'`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run test/ask-api.test.ts`
Expected: PASS

- [ ] **Step 5: 同步 daemon route**

`src/daemon.ts` 的 `/api/asks` 处理里把 `registerAskBroker({... options: parsed.options ...})` 改为 `questions: parsed.questions`。运行 `pnpm tsc --noEmit` 确认 daemon 类型通过。

- [ ] **Step 6: Commit**

```bash
git add src/core/ask-api.ts src/daemon.ts test/ask-api.test.ts
git commit -m "feat(ask): api 接受 questions[] 并兼容旧 options[]"
```

---

## Task 4: `ask-card.ts` 升级为多问 + 多选 + Submit

**Files:**
- Modify: `src/im/lark/ask-card.ts`
- Test: `test/ask-card.test.ts`（按新模型改写/追加）

> 卡片 JSON 形状以 **Task 0 附录A 实测结论** 为准；下方为基线实现，字段名按附录调整。

- [ ] **Step 1: 写失败测试**（`test/ask-card.test.ts`）

```ts
it('多问卡片：每问一个分区 + 选项组件 + 一个 submit', () => {
  const ask = makePending({ questions: [
    { prompt: 'q1', multiSelect: false, options: [{key:'y',label:'是'},{key:'n',label:'否'}] },
    { prompt: 'q2', multiSelect: true,  options: [{key:'a',label:'A'},{key:'b',label:'B'}] },
  ]});
  const json = JSON.parse(buildAskCard(ask));
  const blob = JSON.stringify(json);
  expect(blob).toContain('q1'); expect(blob).toContain('q2');
  expect(blob).toContain('ask_submit'); // submit 按钮 action
  // 每问的选项 value 编码 questionIndex::key
  expect(blob).toContain('0::y'); expect(blob).toContain('1::a');
});

it('settled 态：渲染答案摘要、无可点组件', () => {
  const ask = makePending({ questions:[{prompt:'q',multiSelect:false,options:[{key:'y',label:'是'},{key:'n',label:'否'}]}] });
  const json = JSON.parse(buildAskCard(ask, { kind:'answered', answers:[['y']], by:'ou_u', comment:null, timedOut:false }));
  expect(JSON.stringify(json)).toContain('已选择');
});
```

（`makePending` 为测试辅助：构造一个带 `questions`/`askId`/`nonce`/`deadlineAt`/`approvers` 的 `PendingAsk`。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run test/ask-card.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 `buildAskCard`**

- 未 settle：遍历 `ask.questions`，每问渲染：标题 `div`（`**问题 N**\n<prompt>`）+ 选项组件（单选用 `select_static`，多选用 `multi_select_static`，各 option `{ text:{tag:'plain_text',content:label}, value:'<i>::<key>' }`，组件 `name:'q<i>'`）。全部包进一个 `form`（`tag:'form', name:'ask_form'`），form 内末尾加 submit 按钮 `{ tag:'button', text:{...'提交'}, type:'primary', action_type:'<附录A 实测>', value:{ action:'ask_submit', ask_id, nonce } }`。
- settled：保持现有"状态摘要"逻辑，但 `settleStatus` 改为遍历 `result.answers` 渲染每问选中的 label（用 `ask.questions[i].options` 映射 key→label）。
- 删除/重写旧的 `chunk(options,4)` 按钮渲染（单问单选场景由"单选 select_static + submit"覆盖；如附录A 表明单选用按钮体验更好，可保留按钮但 value 编码 `0::key` 且复用 submit 即答路径）。
- `dispatcher`（`createLarkAskCardDispatcher`）不变。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run test/ask-card.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/im/lark/ask-card.ts test/ask-card.test.ts
git commit -m "feat(ask): 卡片升级为多问+多选+Submit 渲染"
```

---

## Task 5: 卡片回调解析 toggle/submit（`ask-card.ts` handler + `card-handler.ts`）

**Files:**
- Modify: `src/im/lark/ask-card.ts`（`handleAskCardAction`）
- Modify: `src/im/lark/card-handler.ts`（动作分发，line ~190）
- Test: `test/ask-card.test.ts`（追加 handler 用例）

- [ ] **Step 1: 写失败测试**

```ts
it('handleAskCardAction: form submit 解析出每问答案并调 submitAsk', () => {
  // 以 Task 0 附录A 的真实 form 回调形状构造 data：
  //   data.action.value = { action:'ask_submit', ask_id, nonce }
  //   data.action.form_value = { q0:'0::y', q1:['1::a','1::b'] }  // 形状按附录A
  // 用 vi.mock('../../core/ask-broker.js') 断言 submitAsk 收到 selections=[['y'],['a','b']]
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run test/ask-card.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 handler**

- 新增 `ASK_SUBMIT_ACTION = 'ask_submit'`、`ASK_TOGGLE_ACTION = 'ask_toggle'`（若附录A 表明多选靠 checker toggle 而非 form 一次提交，则启用 toggle 路径）。
- `isAskCardAction` 覆盖 `ask_select`(旧单选即答) / `ask_submit` / `ask_toggle`。
- `handleAskCardAction`：
  - `ask_submit`：从 form 回调字段（附录A 形状）解出每问 `selections[i]`（拆 `'<i>::<key>'`），调 `submitAsk({askId,nonce,by,selections})`，按 outcome 出 toast。
  - `ask_toggle`（回退方案）：解 `questionIndex`+`key`，调 `toggleAsk(...)`。
  - `ask_select`（旧单选）：调 `tryResolveAsk(...)` 不变。
- `card-handler.ts` line ~190：`if (isAskCardAction(value?.action)) return handleAskCardAction(data);` 已存在，无需改；确认新 action 名都进 `isAskCardAction`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run test/ask-card.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/im/lark/ask-card.ts src/im/lark/card-handler.ts test/ask-card.test.ts
git commit -m "feat(ask): 卡片回调解析 submit/toggle，映射到 broker"
```

---

## Task 6: per-CLI hook adapter（Claude / Codex / OpenCode）

**Files:**
- Create: `src/core/ask-hook/types.ts`, `src/core/ask-hook/claude-code.ts`, `codex.ts`, `opencode.ts`, `registry.ts`
- Test: `test/ask-hook-claude.test.ts`, `test/ask-hook-codex.test.ts`, `test/ask-hook-opencode.test.ts`

> payload/directive 形状借鉴桌面端结论（见 spec §3），**实现前用各 CLI 当前版本实测一个真实 payload 样本存入 `test/fixtures/`**，测试以真实样本为准。

- [ ] **Step 1: 定义 `ask-hook/types.ts`**

```ts
import type { AskQuestion } from '../ask-types.js';

export interface ParsedAsk {
  questions: AskQuestion[];
  /** adapter 私有的原始上下文，formatAnswer 用来重建 directive。 */
  raw: unknown;
}

export interface HookAskAdapter {
  /** 非 askUserQuestion 事件返回 null（hook 客户端据此输出"放行"directive）。 */
  parseQuestions(payload: unknown): ParsedAsk | null;
  /** answersByQuestion[i] = questions[i] 选中的 key 数组。返回写回 CLI 的 directive JSON 字符串。 */
  formatAnswer(answersByQuestion: ReadonlyArray<ReadonlyArray<string>>, parsed: ParsedAsk): string;
  /** hook 接管失败时的"放行/无操作"directive（让 CLI 回退原生终端提问）。 */
  passthrough(payload: unknown): string;
}
```

- [ ] **Step 2: 写 Claude 失败测试**（`test/ask-hook-claude.test.ts`，含 fixtures）

```ts
import claude from '../src/core/ask-hook/claude-code.js';
it('parseQuestions: PermissionRequest + AskUserQuestion → questions', () => {
  const payload = { hook_event_name:'PermissionRequest', tool_name:'AskUserQuestion',
    tool_input:{ questions:[{ question:'部署?', multiSelect:false, options:[{label:'继续'},{label:'回滚'}] }] } };
  const parsed = claude.parseQuestions(payload);
  expect(parsed).not.toBeNull();
  expect(parsed!.questions[0].prompt).toBe('部署?');
  expect(parsed!.questions[0].options.map(o=>o.key)).toEqual(['继续','回滚']); // key=label（无独立 key 时）
});
it('parseQuestions: 非 AskUserQuestion → null', () => {
  expect(claude.parseQuestions({ hook_event_name:'PreToolUse', tool_name:'Bash' })).toBeNull();
});
it('formatAnswer: 映射回 hookSpecificOutput.updatedInput.answers 形状', () => {
  const payload = { hook_event_name:'PermissionRequest', tool_name:'AskUserQuestion',
    tool_input:{ questions:[{ question:'部署?', multiSelect:false, options:[{label:'继续'},{label:'回滚'}] }] } };
  const parsed = claude.parseQuestions(payload)!;
  const directive = JSON.parse(claude.formatAnswer([['继续']], parsed));
  // 断言形状按 spec §3 / 实测 fixture（updatedInput.answers）
  expect(JSON.stringify(directive)).toContain('继续');
});
```

- [ ] **Step 3: 运行确认失败** → `pnpm vitest run test/ask-hook-claude.test.ts`（FAIL）

- [ ] **Step 4: 实现 `claude-code.ts`**（按 fixture 形状），导出 `default: HookAskAdapter`。`parseQuestions` 只在 `hook_event_name==='PermissionRequest' && tool_name==='AskUserQuestion'` 时解析 `tool_input.questions[]`（option 无独立 key 时 `key=label`，`multiSelect` 透传）；`formatAnswer` 把答案塞进 Claude directive；`passthrough` 返回放行 directive（按 §9 实测形状）。

- [ ] **Step 5: 运行确认通过** → PASS

- [ ] **Step 6: 重复 Step 2–5 实现 `codex.ts`** （事件 `permission_request`/PermissionRequest，directive 按 Codex 实测形状）与 **`opencode.ts`**（事件 `QuestionAsked`，directive `{type:'answer', answers:string[][]}`）。各自独立 fixture + 测试文件。

- [ ] **Step 7: `registry.ts`**

```ts
import type { HookAskAdapter } from './types.js';
import claude from './claude-code.js';
import codex from './codex.js';
import opencode from './opencode.js';
const REGISTRY: Record<string, HookAskAdapter> = { 'claude-code': claude, codex, opencode };
export function getHookAdapter(cliId: string): HookAskAdapter | undefined { return REGISTRY[cliId]; }
```

- [ ] **Step 8: Commit**

```bash
git add src/core/ask-hook test/ask-hook-*.test.ts test/fixtures
git commit -m "feat(ask): 三家 hook adapter（parseQuestions/formatAnswer/passthrough）"
```

---

## Task 7: `botmux hook <cliId>` 子命令 + 抽 `postAsk()`

**Files:**
- Modify: `src/cli.ts`（新增 `cmdHook`；抽 `postAsk`；在命令分发处注册 `hook`）
- Test: `test/cmd-hook.test.ts`（对 `postAsk` + 答案→directive 流程做可注入测试）

- [ ] **Step 1: 抽公共 `postAsk()`**：把 `cmdAsk` 里"findDaemon → fetch /api/asks → 解析 AskResult/错误码"抽成 `async function postAsk(body): Promise<AskResult>`（daemon 不可达/HTTP 错误时抛带 exitCode 的错误）。`cmdAsk` 改为调用它（行为不变，跑原有 ask 测试确认零回归）。

- [ ] **Step 2: 写失败测试**（`test/cmd-hook.test.ts`）：mock `postAsk` 返回 `{kind:'answered', answers:[['继续']], ...}`，喂一个 Claude AskUserQuestion 的 stdin payload，断言 `cmdHook('claude-code')` 向 stdout 写出的 directive 含 `继续`；mock `postAsk` 抛 daemon-unreachable，断言输出 passthrough directive 且**退出码为 0**（不挂死、优雅放行）。

- [ ] **Step 3: 运行确认失败** → FAIL

- [ ] **Step 4: 实现 `cmdHook(cliId)`**

流程：读 stdin 全文 → `JSON.parse` → `getHookAdapter(cliId)`（未知 cliId：输出 passthrough/空并 exit 0）→ `adapter.parseQuestions(payload)`；`null` 则 `console.log(adapter.passthrough(payload))` 并 return（放行）。否则构造 body：
```ts
const body = {
  sessionId: process.env.BOTMUX_SESSION_ID!, chatId: process.env.BOTMUX_CHAT_ID!,
  larkAppId: process.env.BOTMUX_LARK_APP_ID!, rootMessageId: process.env.BOTMUX_ROOT_MESSAGE_ID || null,
  questions: parsed.questions, timeoutMs: <默认 e.g. 3600_000，可由 env BOTMUX_ASK_TIMEOUT_MS 覆盖>, approvers: [],
};
```
`try { const r = await postAsk(body); ... } catch { console.log(adapter.passthrough(payload)); return; }`（任何失败都放行，绝不挂死）。`r.kind==='answered'` → `console.log(adapter.formatAnswer(r.answers, parsed))`；`timedOut`/`invalidated` → `console.log(adapter.passthrough(payload))`。缺 env（非 botmux 会话）→ 同样 passthrough 放行。复用 `cmdAsk` 的 `BOTMUX_WORKFLOW==='1'` gate（workflow subagent 内直接 passthrough）。

- [ ] **Step 5: 注册命令**：在 `src/cli.ts` 主分发 switch 增加 `case 'hook': await cmdHook(args[0]); break;`（`args[0]`=cliId）。

- [ ] **Step 6: 运行确认通过** → PASS；并 `pnpm vitest run test/ask-args.test.ts test/ask-api.test.ts`（ask 子命令零回归）。

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts test/cmd-hook.test.ts
git commit -m "feat(ask): botmux hook <cli> 客户端 + 抽 postAsk 公共流程"
```

---

## Task 8: hook 安装器 + adapter 元数据 + spawn 接缝

**Files:**
- Create: `src/adapters/hook-installer.ts`
- Modify: `src/adapters/cli/types.ts`（加 `hookInstall?`）、`src/adapters/cli/{claude-code,codex,opencode}.ts`（填）、`src/core/worker-pool.ts`（`ensureCliSkills` 内调用）
- Test: `test/hook-installer.test.ts`

- [ ] **Step 1: adapter 元数据类型**（`cli/types.ts`）

```ts
/** hook 安装描述：本期仅 directive 三家填。undefined = 不通过 hook 接管 askUserQuestion。 */
readonly hookInstall?: {
  /** 待写入的配置文件绝对路径（~ 由 installer 展开）。 */
  configPath: string;
  /** 写入格式：决定 installer 如何合并进既有配置。 */
  format: 'claude-settings' | 'codex-hooks' | 'opencode-plugin';
};
```

- [ ] **Step 2: 写失败测试**（`test/hook-installer.test.ts`）：用临时目录（`os.tmpdir()`）模拟各 configPath，调 `installHook(adapter, hookCommand)`，断言：(a) Claude settings.json 写入了指向 `botmux hook claude-code` 的 PermissionRequest hook；(b) 幂等——二次调用内容不变不重写（用 mtime 或内容比较）；(c) 既有无关配置不被破坏（合并而非覆盖）。

- [ ] **Step 3: 运行确认失败** → FAIL

- [ ] **Step 4: 实现 `hook-installer.ts`**

`export function installHook(cliId, hookInstall, hookCommand)`：按 `format` 分派——`claude-settings`：读/建 JSON，向 `hooks.PermissionRequest` 合并一个指向 `hookCommand` 的 entry（matcher `*`、足够大的 timeout），保留其他事件/entry；`codex-hooks`：写 `~/.codex/hooks.json` 的 `PermissionRequest`；`opencode-plugin`：写插件文件（内容里 `QuestionAsked` 时连 daemon——本期可先写一个调 `botmux hook opencode` 的薄插件）。幂等：写前比对内容。`hookCommand` 形如 `<botmux 可执行路径> hook <cliId>`。

- [ ] **Step 5: 填三家 adapter 的 `hookInstall`**（`claude-code.ts`/`codex.ts`/`opencode.ts` 各加常量）。

- [ ] **Step 6: 接入 spawn**（`worker-pool.ts` 的 `ensureCliSkills`，line ~351 `ensureSkills(...)` 之后）

```ts
if (adapter.hookInstall) {
  try { installHook(cliId, adapter.hookInstall, hookCommandFor(cliId)); }
  catch (err) { logger.warn(`[hook] install failed for ${cliId}: ${err instanceof Error ? err.message : String(err)}`); }
}
```
（`hookCommandFor` 解析 botmux 可执行路径 + `hook <cliId>`，参考仓库现有"botmux 自身路径"解析方式，如 `process.execPath`/`process.argv[1]` 或现有 helper。）

- [ ] **Step 7: 运行确认通过** → `pnpm vitest run test/hook-installer.test.ts` PASS

- [ ] **Step 8: Commit**

```bash
git add src/adapters/hook-installer.ts src/adapters/cli/types.ts src/adapters/cli/claude-code.ts src/adapters/cli/codex.ts src/adapters/cli/opencode.ts src/core/worker-pool.ts test/hook-installer.test.ts
git commit -m "feat(ask): spawn 时安装各 CLI hook 指向 botmux hook 客户端"
```

---

## Task 9: 退役 `ASK_SKILL`

**Files:**
- Modify: `src/skills/definitions.ts`
- Test: `test/builtin-skills.test.ts`（调整）

- [ ] **Step 1: 改测试**：断言 `BUILTIN_SKILLS` 不再含 `botmux-ask`，且 `RETIRED_SKILL_NAMES` 含 `botmux-ask`。

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 改 `definitions.ts`**：从 `BUILTIN_SKILLS` 移除 `{ name:'botmux-ask', content: ASK_SKILL }`；把 `'botmux-ask'` 加入 `RETIRED_SKILL_NAMES`（使 `ensureSkills` 清掉已装的旧 SKILL.md）；删除 `ASK_SKILL` 常量。**保留 `botmux ask` 子命令本身**（`cmdAsk` 不动），仅去掉自动推给 agent 的 skill。

- [ ] **Step 4: 运行确认通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/skills/definitions.ts test/builtin-skills.test.ts
git commit -m "feat(ask): 退役 botmux-ask skill（改由 hook 接管，子命令保留）"
```

---

## Task 10: 全量校验 + dogfood

- [ ] **Step 1: 全量测试 + 类型检查**

Run: `pnpm vitest run && pnpm tsc --noEmit`
Expected: 全绿

- [ ] **Step 2: 构建**：`pnpm build`（确认 `dist/cli.js` 含 `hook` 子命令）。

- [ ] **Step 3: dogfood — Claude Code**：重启 daemon → 在飞书话题起一个 Claude 会话 → 让它触发原生 AskUserQuestion（单问单选）→ 确认飞书弹出问答卡片、点选 → 确认 CLI 收到答案继续。

- [ ] **Step 4: dogfood — 多选/多问**：构造一个多选或多问的 AskUserQuestion，飞书勾选 + Submit，确认答案完整正确回填。

- [ ] **Step 5: dogfood — Codex + OpenCode**：各重复 Step 3 一次。

- [ ] **Step 6: dogfood — 降级**：停 daemon 后让 CLI 提问，确认 CLI 回退到原生终端提问、不挂死。

- [ ] **Step 7: dogfood — 双重弹卡检查（spec §10）**：directive 三家提问时，观察是否同时被 ScreenAnalyzer 当 TUI prompt 又弹出一张截屏卡片（hook 卡 + 截屏卡）。
  - 若**不双弹**（hook 经 directive 回填后 CLI 未渲染可截的菜单）：记录确认，无需额外处理。
  - 若**双弹**：作为 fast-follow——在 ScreenAnalyzer 侧对"已装 hookInstall 的 CLI 的 AskUserQuestion 菜单"做抑制（按当前会话 cliId 是否 `hookInstall` 命中来 gate 截屏弹卡）。本期先记录现象，不阻塞合入。

- [ ] **Step 8: 确认旧 skill 已清除**：检查各 CLI skills 目录下 `botmux-ask/SKILL.md` 已被 `ensureSkills` 删除。

- [ ] **Step 9: 开 PR**

```bash
git push -u origin feat/botmux-ask-hooks
# gh pr create --base feat/botmux-ask --head feat/botmux-ask-hooks --title "feat(ask): hook 接管 askUserQuestion（替换 skill 触发，支持多选多问）"
```

---

## 风险与执行注意

- **Task 0 是后续卡片任务的前置**，务必先做完并把附录A 落定，Task 4/5 的 form 字段名/回调形状以附录为准。
- **Task 1 提交后中段类型暂不通过属预期**，Task 2/3/4 依序修复；勿跳序执行。
- 各 CLI 的 hook payload / directive / passthrough 形状**必须用当前版本实测 fixture**，不照搬桌面端常量（spec §2 原则）。
- 向后兼容红线：`botmux ask buttons` 单选语义与其现有测试**零回归**（`toLegacySelected` + `tryResolveAsk` 封装保障）。
