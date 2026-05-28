# Lark post 富文本完整解析 Archive

## Brainstorm

# Lark post 富文本完整解析 Brainstorm

## Background
飞书 `post` 富文本目前只解析少数 tag，代码块等有语义节点会被静默丢弃，导致 Claude、`botmux history`、`botmux quoted` 看到的内容和用户实际发送内容不一致。

## Goals & End State
- Goal: 实时消息、history、quoted 三条入口都能保留 post 富文本里的用户可见语义内容。
- Goal: 对代码块、链接、mention、图片/文件占位、常见文本样式/内联结构有明确解析策略。
- Goal: 未知节点不再被误当作普通文本拼进 prompt，避免结构化内容产生噪声。
- End State: `post` 富文本解析有明确支持清单和回归测试，代码块不会在传给 CLI 前丢失，未支持节点不会产生噪声。

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| 修复范围 | 只覆盖 `post` 富文本解析 | 问题根因在 post parser，避免扩大到 card/发送渲染 |
| 支持清单 | 基于真实 payload + 飞书 schema 建明确 tag 清单 | 避免猜测式兼容过宽 |
| 未知节点 | 默认忽略，不做通用 text/content fallback | 避免把非正文结构误拼进 prompt |
| 代码块 | markdown fence，前后换行保护 | 保证 Claude 可读、可复制，不与正文粘连 |
| 测试 | `parseEventMessage` + `parseApiMessage` + 混排结构断言 | 锁住 live/history/quoted 共同入口 |

## Out of Scope
- 不改 `interactive` 卡片解析。
- 不改 `merge_forward` 展开策略。
- 不改 `botmux send` 的 markdown/card 渲染。
- 不新增附件下载能力。

## Risks & Mitigations
- Risk: 飞书 post 节点结构可能有多种历史/客户端变体。Mitigation: 先确认真实 payload，再按 schema 补少量明确兼容。
- Risk: 未知节点可能包含新的用户可见语义。Mitigation: 不做通用 fallback；后续基于真实 payload 显式加入支持清单。
- Risk: fence 渲染可能和段落拼接冲突。Mitigation: 代码块输出自带最小换行边界，并用“正文 + 代码块 + 正文”测试锁定。

---

## Spec

# Lark post 富文本完整解析 Spec

## Overview
本需求修复飞书 `post` 富文本消息进入 botmux 后的内容保真问题：实时消息、`botmux history`、`botmux quoted` 都必须通过同一套 `post` 节点解析策略保留用户可见语义内容，避免代码块、链接、mention、图片/文件占位等在传给 CLI 前被静默丢弃。

## User Stories

### Story 1: 用户发送含代码块的飞书富文本消息
- **Acceptance**: 当用户在飞书 `post` 消息中发送代码块和普通正文时，Claude 收到的 `<user_message>` 内容包含 fenced code block、语言标识和前后正文，且代码块不会与正文粘连。
- **Technical implementation**: `src/im/lark/message-parser.ts` 的 `extractTextContent()` 在 `msgType === 'post'` 分支中识别代码块节点并渲染为 markdown fence。

### Story 2: 用户发送常见富文本样式内容
- **Acceptance**: 当 `post` 消息包含已明确支持的富文本节点时，解析结果保留可见文本内容；未支持节点不得被通用 fallback 误拼进 prompt。
- **Technical implementation**: `src/im/lark/message-parser.ts` 的 `post` 节点映射逻辑只支持明确 tag，新增 tag 必须基于真实 payload 或 schema 显式加入。

### Story 3: 用户通过 history 或 quoted 回看富文本消息
- **Acceptance**: 同一条 `post` 消息通过实时事件、`botmux history`、`botmux quoted` 读取时，解析出的正文结构一致，至少在代码块、普通文本、链接、mention、图片/文件占位上保持同样语义。
- **Technical implementation**: `parseEventMessage()` 与 `parseApiMessage()` 继续共享 `extractTextContent()` 的 `post` 分支，并在 `test/message-parser.test.ts` 对两个入口都加回归测试。

## Functional Requirements

| ID | Requirement | Acceptance check |
|---|---|---|
| FR-1 | 当 `post` 富文本包含代码块节点时，系统必须把代码块渲染为 markdown fence，并保留语言标识和代码正文。 | `pnpm vitest run test/message-parser.test.ts` 中的 `parseApiMessage` 代码块用例断言完整输出。 |
| FR-2 | 当代码块前后存在普通文本节点时，系统必须在 fence 前后保留换行边界，不得输出 `前文```...```后文` 这类粘连结构。 | `pnpm vitest run test/message-parser.test.ts` 中的混排结构用例使用完整字符串或换行结构断言。 |
| FR-3 | 当 `post` 富文本包含链接、mention、图片、视频图片占位或文件节点时，系统必须保持现有可读输出语义，不得回退已有行为。 | `pnpm vitest run test/message-parser.test.ts` 中现有 post 图片/文件用例继续通过，并新增/保留链接、mention 覆盖。 |
| FR-4 | 当 `post` 富文本包含未明确支持的节点时，系统不得通过通用 `text/content` fallback 把结构化内容误拼进 prompt。 | 新增未知节点测试，断言未知文本节点和未知对象都不产生噪声。 |
| FR-5 | 新增 `post` 富文本 tag 支持时，系统必须基于真实 payload 或 schema 显式加入 tag 分支，不得通过通用未知节点 fallback 扩大范围。 | 代码中 `renderPostNode()` 只包含明确 tag 分支；未知节点测试锁定默认忽略。 |
| FR-6 | `parseEventMessage()` 与 `parseApiMessage()` 必须对同一类 `post` 富文本结构输出一致的用户可见内容。 | `pnpm vitest run test/message-parser.test.ts` 中分别覆盖 live 事件入口和 API 消息入口。 |
| FR-7 | 修复不得改变 `interactive` 卡片、`merge_forward` 展开、`botmux send` markdown/card 渲染、附件下载能力。 | `pnpm build` 通过；相关现有 message-parser 测试继续通过，diff 不触碰非必要模块。 |

## Success Criteria
1. 会话 `7be99f68` 中同类“代码块 + 正文”消息在修复后不会只剩普通正文。
2. `post` 富文本的用户可见内容在实时消息、history、quoted 三条入口中保持一致。
3. 代码块输出可读、可复制，且不会与前后正文粘连。
4. 未支持的结构化节点不会通过通用 fallback 误拼进 prompt。
5. 现有图片/文件占位与资源编号行为不回退。
6. `pnpm vitest run test/message-parser.test.ts` 与 `pnpm build` 通过。

## Key Entities
- `extractTextContent()`: `src/im/lark/message-parser.ts` 中负责把 Lark message content 转成可读文本的核心函数。
- `resolvePostBody()`: `src/im/lark/message-parser.ts` 中负责兼容 wrapped/unwrapped post body 的解析入口。
- `parseEventMessage()`: `src/im/lark/message-parser.ts` 中实时 WS 事件的消息解析入口。
- `parseApiMessage()`: `src/im/lark/message-parser.ts` 中 REST/API 拉取消息的解析入口，用于 history/quoted 等路径。
- `test/message-parser.test.ts`: 消息解析回归测试文件。

## Assumptions
- 飞书 `post` 的主体结构仍是 `content` 段落数组，节点以 `tag` 区分类型。
- 真实代码块 payload 可通过现有消息、OpenAPI 或本地调试日志确认；实现不得只凭猜测字段名落地。
- 样式类节点只有在真实 payload 或 schema 证明其 tag 应被显式支持时才加入支持清单。
- 未知节点不做通用 fallback，不把任意 text/content 字段拼进 prompt。

## Clarifications
- 修复范围: 只覆盖 `post` 富文本解析。
- 未知节点策略: 默认忽略，不做通用 text/content fallback。
- 代码块格式: 使用 markdown fence，并做前后换行保护。

## Out of Scope
- 不改 `interactive` 卡片解析。
- 不改 `merge_forward` 展开策略。
- 不改 `botmux send` 的 markdown/card 渲染。
- 不新增附件下载能力。

---

## Plan

# Lark post 富文本完整解析 Implementation Plan

**Goal:** 修复飞书 `post` 富文本解析，确保实时消息、history、quoted 都保留明确支持节点的用户可见语义内容，不再静默丢弃代码块，也不把未知结构化节点误拼进 prompt。

**Architecture:** 保持 `parseEventMessage()` 与 `parseApiMessage()` 共享 `extractTextContent()` 的架构，只重构 `msgType === 'post'` 分支的节点渲染。新增局部 helper 负责 post 节点到文本的转换、代码块 fence 渲染与段落内换行边界；未知节点默认忽略，新增 tag 必须基于真实 payload 或 schema 显式加入。

**Tech Stack:** TypeScript、Vitest；核心文件为 `src/im/lark/message-parser.ts` 和 `test/message-parser.test.ts`；验证命令为 `pnpm vitest run test/message-parser.test.ts` 与 `pnpm build`。

---

## File Structure

- Modify: `src/im/lark/message-parser.ts:384-425` — 扩展 `post` 富文本节点渲染，增加代码块渲染并明确未知节点不输出噪声。
- Modify: `test/message-parser.test.ts:397-426` — 增加 post 富文本代码块回归测试，覆盖 API 和 live 事件入口，并锁定未知节点默认忽略。

---

## FR Coverage

| FR | Implementing Task |
|---|---|
| FR-1 代码块 fence | Task 1 |
| FR-2 fence 前后换行 | Task 1 |
| FR-3 链接/mention/图片/文件不回退 | Task 2 |
| FR-4 未支持节点不产噪声 | Task 2 |
| FR-5 新 tag 必须显式支持 | Task 2 |
| FR-6 `parseEventMessage` 与 `parseApiMessage` 一致 | Task 1、Task 2 |
| FR-7 不改其他模块并完成验证 | Task 3 |

---

### Task 1: 支持 post 代码块并保护 fence 换行

**Files:**
- Modify: `src/im/lark/message-parser.ts:384-425`
- Test:   `test/message-parser.test.ts:397-426`

- [ ] **Step 1: Write the failing test**

在 `test/message-parser.test.ts` 的 `describe('Post message parsing', ...)` 内新增代码块 API/live 回归测试，以及代码内容包含三反引号时使用更长 fence 的测试。

- [ ] **Step 2: Verify test fails**

Run: `pnpm vitest run test/message-parser.test.ts`

Expected: FAIL，新增测试实际输出为 `前文后文` 或不包含 fenced code block。

- [ ] **Step 3: Minimal implementation**

在 `src/im/lark/message-parser.ts` 的 `resolveMentions()` 后、`extractTextContent()` 前新增 helper：`normalizeFenceLanguage()`、`renderPostCodeBlock()`、`renderPostNode()`、`joinPostNodeText()`。`renderPostNode()` 只支持 `text/a/at/code_block/img/media/file`；`renderPostCodeBlock()` 根据代码内容最长反引号串选择更长 fence。

- [ ] **Step 4: Verify test passes**

Run: `pnpm vitest run test/message-parser.test.ts`

Expected: PASS，新增代码块测试通过，现有 post 图片/文件测试继续通过。

- [ ] **Step 5: Commit**

```bash
git add src/im/lark/message-parser.ts test/message-parser.test.ts docs/specs/20260525-lark-post-richtext-complete/brainstorm.md docs/specs/20260525-lark-post-richtext-complete/spec.md docs/specs/20260525-lark-post-richtext-complete/plan.md
git commit -m "fix(lark): 保留 post 富文本代码块"
```

---

### Task 2: 锁定明确 tag 清单并避免未知节点噪声

**Files:**
- Modify: `src/im/lark/message-parser.ts:384-425`
- Test:   `test/message-parser.test.ts:397-426`

- [ ] **Step 1: Write the failing test**

在 `describe('Post message parsing', ...)` 内新增未知节点测试，断言未知文本节点和未知对象都不进入输出：

```ts
  it('does not render unsupported post nodes as noisy text', () => {
    const post = {
      zh_cn: {
        content: [
          [
            { tag: 'text', text: '普通' },
            { tag: 'unknown_text', text: '未知文本' },
            { tag: 'unknown_object', value: { nested: true } },
          ],
          [
            { tag: 'a', text: '文档', href: 'https://example.com' },
            { tag: 'at', user_name: 'Alice' },
          ],
        ],
      },
    };

    expect(parseApiMessage(makeMsg('post', post)).content).toBe('普通\n文档@Alice');
  });
```

- [ ] **Step 2: Verify test fails**

Run: `pnpm vitest run test/message-parser.test.ts`

Expected: 如果存在通用 unknown fallback，则 FAIL，实际输出包含 `未知文本`；如果已收窄，则 PASS。

- [ ] **Step 3: Minimal implementation**

确认 `renderPostNode()` 的最终 fallback 是 `return ''`，且没有 `node.text` / `node.content` / `text.content` / `content.text` 通用兜底。

- [ ] **Step 4: Verify test passes**

Run: `pnpm vitest run test/message-parser.test.ts`

Expected: PASS，未知节点不产生噪声，现有明确 tag 行为不回退。

- [ ] **Step 5: Commit**

```bash
git add src/im/lark/message-parser.ts test/message-parser.test.ts
git commit -m "test(lark): 锁定 post 未知节点默认忽略"
```

---

### Task 3: 验证构建和范围不回退

**Files:**
- Modify: `src/im/lark/message-parser.ts:384-425`
- Test:   `test/message-parser.test.ts:397-426`

- [ ] **Step 1: Write the failing test**

本任务不新增生产行为测试；Task 1 和 Task 2 已覆盖 FR-1 到 FR-6。本任务的验证目标是构建和范围控制。

执行前检查 diff 只触碰以下路径：

```bash
git diff --name-only
```

Expected paths:

```text
docs/specs/20260525-lark-post-richtext-complete/brainstorm.md
docs/specs/20260525-lark-post-richtext-complete/spec.md
docs/specs/20260525-lark-post-richtext-complete/plan.md
docs/specs/20260525-lark-post-richtext-complete/tasks.md
docs/specs/20260525-lark-post-richtext-complete/review.md
src/im/lark/message-parser.ts
test/message-parser.test.ts
```

- [ ] **Step 2: Verify test fails**

Run: `git diff --name-only`

Expected: 如果出现 `interactive`、`merge_forward`、`botmux send` 渲染相关文件，则本任务失败并撤回非必要改动。

- [ ] **Step 3: Minimal implementation**

如 diff 包含非范围文件，移除对应改动；保持只修改 `post` parser、测试和 SDD 文档。

- [ ] **Step 4: Verify test passes**

Run:

```bash
pnpm vitest run test/message-parser.test.ts && pnpm build
```

Expected: 两条命令均成功退出，`message-parser` 测试和 TypeScript 构建通过。

- [ ] **Step 5: Commit**

如果 Task 1/2 已分 commit，且本任务没有代码改动，则无需新增 commit；如只剩验证文档或小修，使用：

```bash
git add docs/specs/20260525-lark-post-richtext-complete/plan.md src/im/lark/message-parser.ts test/message-parser.test.ts
git commit -m "test(lark): 覆盖 post 富文本解析"
```

---

## Tasks

# Lark post 富文本完整解析 Tasks

| ID | Description | Files | Depends-On | Acceptance |
|---|---|---|---|---|
| T-1 | 为 `post` 富文本代码块增加 markdown fence 渲染，并验证 API/live 两个入口输出一致。 | `src/im/lark/message-parser.ts`, `test/message-parser.test.ts` | — | `pnpm vitest run test/message-parser.test.ts` 通过代码块 API/live 回归测试。 |
| T-2 | 锁定 `post` 富文本明确 tag 清单，并验证未知节点不会产生噪声。 | `src/im/lark/message-parser.ts`, `test/message-parser.test.ts` | T-1 | `pnpm vitest run test/message-parser.test.ts` 通过未知节点默认忽略回归测试。 |
| T-3 | 验证改动范围、message-parser 单测和 TypeScript 构建，确认不触碰 out-of-scope 模块。 | `docs/specs/20260525-lark-post-richtext-complete/*`, `src/im/lark/message-parser.ts`, `test/message-parser.test.ts` | T-2 | `git diff --name-only` 只包含范围内文件，且 `pnpm vitest run test/message-parser.test.ts && pnpm build` 成功。 |

## Dispatch notes
- T-1 和 T-2 都修改同一组文件，必须串行执行。
- T-3 依赖 T-2 的最终 diff 和测试结果。
- 任务文件边界不干净，不适合 dispatch；选择 implement，由主 agent 在当前会话内按 T-1 → T-2 → T-3 顺序完成。

---

## Review

# Review: 20260525-lark-post-richtext-complete

**Base:** origin/master@53c1166af91188c1da07531bb95744c2a5e969d0
**Head:** working tree on feature/20260525_lark_post_richtext_complete (未提交，HEAD=53c1166af91188c1da07531bb95744c2a5e969d0)
**Date:** 2026-05-25

## 🟢 Passing
- FR-1 covered by T-1 (working diff, `src/im/lark/message-parser.ts:388-400`, `test/message-parser.test.ts:398-423`). 代码块渲染为 markdown fence，并覆盖 `parseApiMessage` 与 `parseEventMessage`。
- FR-2 covered by T-1 (working diff, `src/im/lark/message-parser.ts:396-430`, `test/message-parser.test.ts:426-433`). `joinPostNodeText()` 保护 fence 前后换行，代码中含三反引号时使用更长 fence。
- FR-3 covered by T-2 / existing behavior (working diff, `src/im/lark/message-parser.ts:403-420`, `test/message-parser.test.ts:458-485`). 链接、mention、图片、media、文件节点保留现有输出语义。
- FR-4 covered by T-2 (working diff, `src/im/lark/message-parser.ts:421-426`, `test/message-parser.test.ts:436-455`). 未支持节点默认忽略，不通过通用 `text/content` fallback 产生噪声。
- FR-5 covered by T-2 (working diff, `src/im/lark/message-parser.ts:403-426`, `test/message-parser.test.ts:436-455`). `renderPostNode()` 只包含明确 tag 分支；未知节点测试锁定默认忽略。
- FR-6 covered by T-1 (working diff, `test/message-parser.test.ts:410-423`). API 和实时事件入口共用同一预期输出。
- FR-7 covered by T-3. Diff 仅触碰 `src/im/lark/message-parser.ts`、`test/message-parser.test.ts` 和 SDD 文档；`.gitignore` 是会话开始前已有改动，不属于本功能。
- Verification: `corepack pnpm vitest run test/message-parser.test.ts` → 55 tests passed；`corepack pnpm build` → TypeScript + dashboard bundle 成功。
- Risk scan: correctness / project standards / robustness / performance / API contract / architecture 未发现阻塞项；本次没有鉴权、密钥、路径、shell 拼接或反序列化安全敏感改动。

## 🟡 Improvement
- 当前 review 引用的是 working diff 不是 commit SHA，因为本轮按用户要求只改代码、未提交。若后续需要 PR，建议提交后重新跑一次 review，把 evidence 从 working diff 更新为 commit SHA。

## 🔴 Blocking
- (none)
