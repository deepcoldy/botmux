# botmux askUserQuestion：从 skill 触发改为 hook 触发

- 日期：2026-05-25
- 分支：`feat/botmux-ask-hooks`（基于 `feat/botmux-ask`）
- 状态：设计待评审

## 1. 背景与目标

`feat/botmux-ask` 分支已实现一套"向飞书用户发起阻塞式选择题"的能力，但**触发方式是 skill 驱动**：

- `src/skills/definitions.ts` 里的 `ASK_SKILL`（名为 `botmux-ask` 的 SKILL.md）教 agent："要让用户选就 shell 调 `botmux ask buttons --options ...`"。
- `botmux ask` 子命令 → `fetch http://127.0.0.1:<ipcPort>/api/asks` → daemon `ask-broker` → `ask-card` 发飞书互动卡片 → 用户点按钮 → broker settle → 答案沿长轮询回 CLI stdout。

**skill 触发的根本问题**：依赖 agent 肯读 skill、且肯放弃自己**原生的 AskUserQuestion 工具**改调 `botmux ask`。这不可靠——多数 agent 默认用自带的提问工具，skill 抢不过，于是问题根本到不了飞书。

**目标**：把"触发/进料"从 skill 改为 **hook 拦截 agent 原生 askUserQuestion**，做到无需提示词配合、透明自动地把问题送到飞书并把答案送回 CLI。**broker / 卡片 / 答案路由 / 审批人链 / 超时 nonce 等基础设施全部复用，不重写。**

### 非目标（本期不做）

- 终端原生 CLI（Kimi / Gemini / Coco / Aiden 等）的答案回传。这些 CLI 的 hook 只能"给出问题"、不能程序化回填，答案必须靠 PTY 键盘注入，可靠性是另一个等级（见 §8）。**本期只做 directive 回填三家，dogfood 通过后再做剩下的。**
- 多问题（questions[] 长度 > 1）与多选（multiSelect）的完整保真（见 §7 取舍）。

## 2. 设计原则

1. **融会贯通，不盲抄。** 桌面端 x-desktop-app 有成熟实现，但它深度耦合 Electron / IPC / SessionState，与 botmux 的 daemon-worker + localhost HTTP + 飞书卡片骨架完全不同。我们**只借鉴其领域结论**（各 CLI 的事件名映射、payload 形状、directive 形状），代码按 botmux 风格原生重写。
2. **最大化复用现有 ask 基础设施。** `ask-broker` / `ask-card` / `ask-api`（审批人链）/ `card-handler` / daemon `/api/asks` route 一律不动，hook 客户端打同一个 `/api/asks`。
3. **hook 失败必须优雅降级**，绝不能让 agent 永久卡死等一个永不返回的答案（见 §9）。

## 3. 要从桌面端"吃透"的领域知识（认知，非代码）

| 知识点 | 内容 |
| --- | --- |
| askUserQuestion 入口事件 | Claude=`PermissionRequest`(tool=AskUserQuestion)；Codex=`PermissionRequest`(permission_request)；OpenCode=`QuestionAsked` |
| payload 字段形状 | `tool_input.questions[]`，每项含 `question`、`options[]`、`multiSelect`；各家异名/嵌套差异 |
| 阻塞式回填协议 | 这三家的 hook 是"发出后挂起等响应"，答案以 directive 形式写回 stdout 被 CLI 消费——**不碰键盘也能回答**的关键 |
| hook 安装格式 | Claude=`~/.claude/settings.json` hooks；Codex=`~/.codex/hooks.json`+`config.toml`；OpenCode=JS 插件 |
| directive 形状 | Claude=`hookSpecificOutput.decision.updatedInput.answers`；OpenCode=`{type:'answer', answers:string[][]}` |

> 注：以上为设计输入，实现时需在 botmux 内对各 CLI 当前版本逐一**实测核验**，不照抄桌面端的具体字段常量。

## 4. 架构与数据流（新）

```
agent 调用原生 AskUserQuestion
  → CLI 触发 hook（Claude=PermissionRequest / Codex=permission_request / OpenCode=QuestionAsked）
  → 执行 `botmux hook <cliId>`（新子命令；hook 客户端）
      · 从 stdin 读 hook JSON
      · 按 cliId 用 adapter 解析出 { prompt, options[] }
      · 复用 §6 env（BOTMUX_SESSION_ID/CHAT_ID/LARK_APP_ID/ROOT_MESSAGE_ID）
      · POST http://127.0.0.1:<ipcPort>/api/asks（与 `botmux ask` 完全同一路）
      · 长轮询挂起，等 AskResult
  → daemon: parseAskBody → resolveAskApprovers → registerAsk（broker，不变）
  → ask-card 发飞书互动卡片（不变）
  → 用户点按钮 → card-handler → tryResolveAsk → broker settle（不变）
  → AskResult 回到 `botmux hook` 进程
      · adapter 把 selected(key) + 原始 payload → 该 CLI 的 directive
      · 写 directive 到 stdout
  → CLI 消费 directive，agent 拿到答案，继续执行
```

**与现状的差异仅在两端**：进料端（skill 子命令调用 → hook 客户端）和回传端（stdout 打印 key → stdout 打印 directive）。中间 daemon 全链路零改动。

## 5. 组件分解

### 5.1 hook 客户端：`botmux hook <cliId>`（新增 `src/cli.ts` 子命令）

- 职责：stdin→解析→POST `/api/asks`→等结果→stdout 输出 directive。
- 与 `cmdAsk` 共享 daemon 发现（`findDaemon`）、`/api/asks` POST、长轮询逻辑——抽出公共 `postAsk()` 复用，避免两份。
- 输入：`cliId`（claude-code / codex / opencode）作为参数；hook JSON 从 stdin。
- 输出：directive JSON 到 stdout（成功）或安全的"放行/无操作"directive（降级，见 §9）。

### 5.2 per-CLI adapter 归一层（新增 `src/core/ask-hook/<cliId>.ts`）

每个 CLI 一个纯模块，两个纯函数：

```ts
// 入：原始 hook payload → 出：botmux 内部问题结构（或 null = 非 askUserQuestion，放行）
parseQuestion(payload: unknown): { prompt: string; options: AskOption[]; raw: ParsedRaw } | null

// 入：用户选的 key + 原始问题 → 出：该 CLI 的 directive 字符串
formatAnswer(selectedKey: string, raw: ParsedRaw): string
```

- `claude-code.ts`、`codex.ts`、`opencode.ts` 三份。
- 纯函数、无 IO，便于单测（对照各 CLI 真实 payload 样本）。
- 通过 `src/core/ask-hook/registry.ts` 按 cliId 分发。

### 5.3 hook 安装：`ensureHooks(cliId, adapter)`（新增 `src/adapters/hook-installer.ts`）

- 紧贴 `src/core/worker-pool.ts:351` 现有 `ensureSkills(cliId, adapter.skillsDir)` 之后调用。
- 在 `src/adapters/cli/types.ts` 的 adapter 接口上加可选元数据（hook 配置文件路径 + 写入格式），仅 claude-code / codex / opencode 三家填。
- 幂等：内容不变不写（对齐 `ensureSkills` 行为）。
- 把对应 CLI 的 hook 配置写好，命令指向 `botmux hook <cliId>`。

### 5.4 复用（零改动）

`ask-broker.ts`、`ask-card.ts`、`ask-api.ts`、`card-handler.ts`、daemon `/api/asks` route、worker `BOTMUX_*` env 注入（worker.ts:2663）—— 全部保持原样。

### 5.5 退役 `ASK_SKILL`

- 从 `BUILTIN_SKILLS` 移除 `botmux-ask`，加入 `RETIRED_SKILL_NAMES`，让 `ensureSkills` 自动清掉已装到各 CLI 的旧 SKILL.md。
- **保留 `botmux ask` 子命令**：作为手动 / 脚本 / workflow 的显式入口仍有价值，只是不再靠 skill 推给 agent 自动用。

## 6. 复用的会话上下文（env）

hook 客户端运行在 CLI 子进程里，自动继承 worker 注入的 `BOTMUX_SESSION_ID` / `BOTMUX_CHAT_ID` / `BOTMUX_LARK_APP_ID` / `BOTMUX_ROOT_MESSAGE_ID`（worker.ts:2663 现已注入），与 `botmux ask` 同源，无需新增注入。

## 7. askUserQuestion 保真度取舍（需评审确认）

原生 askUserQuestion 是 `questions[]`（可能多问）、每问 `options[]`、可能 `multiSelect: true`；而现有 `ask-broker` / `ask-card` 模型是**单问 + 扁平 options + 单选按钮**。

**本期取舍（MVP）**：
- 只处理 `questions[0]`，单选。覆盖绝大多数实际用法（典型为 1 问 ≤4 选、单选）。
- `multiSelect: true` 或 `questions.length > 1`：MVP 先**降级为取首问、单选**，并在卡片上标注；adapter 的 `parseQuestion` 保留完整 raw 数据，为后续扩展留口。
- 完整多问 / 多选支持列为 fast-follow（需扩 `ask-types` / `ask-card` / broker 的选择模型），不阻塞本期 dogfood。

## 8. 范围与分期

| 阶段 | 内容 | 出口 |
| --- | --- | --- |
| 本期 | directive 三家（Claude / Codex / OpenCode）端到端 hook 接管 + 退役 ASK_SKILL | dogfood 验证：三家原生提问能自动到飞书、点选后答案正确回填、CLI 继续 |
| 后续 | 终端原生那批：hook 取问题 + 复用现有 `tui_keys`/截屏链路回传，并与 ScreenAnalyzer 去重防双重弹卡 | 单独立项、单独验 |

## 9. 错误处理与降级（关键）

hook 客户端必须保证：**任何异常都不能让 agent 永久阻塞**。

- daemon 不可达 / 无 approver / 超时 / 解析失败 → hook 客户端输出"放行/无操作"directive，让 CLI 回退到它**原生的**提问交互（即用户在终端自己答），而不是挂死。
- 这等价于"hook 接管失败时，优雅退回到没有 botmux 接管的原状"。
- 各 CLI 的"无操作 directive"形状需实测确认（通常是不带 decision 的空 `hookSpecificOutput` 或允许放行）。

## 10. 与现有截屏路（ScreenAnalyzer）的关系

- directive 三家：hook 接管后，这三家的 askUserQuestion 不应再被 ScreenAnalyzer 当 TUI prompt 二次弹卡。需确认/处理去重（hook 命中的会话对该工具的截屏弹卡做抑制）。
- 终端原生那批本期不接 hook，截屏路维持现状。

## 11. 测试策略

- adapter 纯函数单测：对照三家真实 hook payload 样本，测 `parseQuestion`（含非 askUserQuestion 放行、multiSelect 降级）与 `formatAnswer`（directive 形状）。
- hook 客户端：mock daemon `/api/asks`，测正常回填、超时、daemon 不可达三条降级路径。
- 复用既有 `ask-broker` / `ask-card` / `ask-api` 测试，确认零回归。
- dogfood：三家真实 CLI 各跑一次原生提问，飞书点选，确认答案正确进 CLI。

## 12. 风险与未决

- 各 CLI hook 配置格式 / directive 形状会随上游版本变动——需实测当前版本，并考虑版本门控（对齐桌面端经验）。
- multiSelect / 多问降级的用户体验是否可接受，待评审。
- 去重策略（§10）的具体实现位置待落实现细节时确认。
