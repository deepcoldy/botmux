---
title: 替身模式群聊黑名单 - Plan
type: feat
date: 2026-07-30
topic: substitute-chat-blocklist
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# 替身模式群聊黑名单 - Plan

## Goal Capsule

- **目标（Objective）**：给替身模式（`替身模式` / substitute mode）增加一个「声明式群聊黑名单」——按 chat ID 列出禁止代答的群聊。这些群里 bot 不再触发替身代答，但被直接 `@机器人` 时照常应答。
- **产品授权（Product authority）**：本计划仅覆盖替身触发链路上的「群聊维度硬过滤」。不改替身对象解析、代答提示语、话题/普通群路由分支等其它替身能力；不改任何非替身的消息路由。
- **执行画像（Execution profile）**：横向叠加改动，落在既有替身链路的 6 处点位（类型 / normalize / 触发门 / 命令 / 配置写入 / dashboard）。以单测为主，触发行为需飞书 live 验证。
- **停止条件（Stop conditions）**：改动溢出到「直接 @机器人 路由」「非替身消息处理」「其它替身子能力（disclosure / topicGroups / 控制卡片）」时立即停下核对——这些不在本计划范围。
- **未决阻塞（Open blockers）**：无。

## Product Contract

### Summary

在替身模式配置里新增一个 per-bot 的群聊黑名单字段：列入的群聊，替身代答被硬性关闭，且无法用群内 `/substitute on` 重新打开。它是现有「生效群聊」白名单（allow-list）的镜像——白名单表达「只在这些群代答」，黑名单表达「除了这些群哪都能代答」。过滤只作用于替身触发路径，直接 @机器人 的问答不受影响。

### Problem Frame

替身模式当前有两种群聊范围控制，但都不满足「除了少数几个群，其它群都替身」这个需求：

- **`chats` 白名单**（dashboard「生效群聊」）：填了就只在列出的群触发。要表达「除 A、B 外全部代答」，得把除 A、B 之外的**所有**群都枚举进去——群会持续新增，维护不可行。
- **群内 `/substitute off`**：是运行态、逐群、手动的临时开关，任何有权限的人可以随时 `/substitute on` 翻回来。它不是「这个群永久不许代答」的策略表达，也无法在配置里一次性声明。

结果是：想让某几个敏感群（如领导群、跨部门正式群）永不代答，只能靠人记得逐群 `/substitute off`，且随时可能被误开。缺一个配置层的、声明式的、不可被现场翻回的「禁止代答」名单。

### Key Decisions

这些是**产品行为**决策（决定「代答与否」这一可观察行为），实现层如何落地见 Planning Contract 的 KTD。

- **声明式黑名单，不是自动共存判定。** 由运维在 `bots.json` / dashboard 显式列出群聊 ID，而非让 bot 自动侦测「被替身的人也在群里 / 在线」来临场闭嘴。Governs R1, R2。（session-settled: user-directed — 选择「声明式黑名单」而非「自动共存回避」：用户明确要显式列群）
- **硬黑名单：不可被运行态开关覆盖。** 列入黑名单的群，群内 `/substitute on` 不能重新开启代答——黑名单表达的是策略而非临时开关。Governs R3, R6。（session-settled: user-directed — 选择「硬黑名单」而非「软默认可现场覆盖」）
- **Deny-wins：黑名单优先于白名单。** 同一个群同时出现在 `chats` 白名单与黑名单时，以黑名单为准（不代答）。这样「先大范围放开、再精确排除少数群」这一常见组合可直接表达。Governs R4。（session-settled: user-approved — agent 提出 deny-wins 默认，用户确认）
- **过滤只关替身触发，不影响直接 @机器人。** 黑名单落在替身触发判断，而 `explicitlyMentionedThisBot`（直接 @机器人）在其上游独立计算、不受影响。Governs R5。（session-settled: user-directed — 用户确认「仍可被 @ 回答问题」）
- **覆盖普通群与话题群，与白名单同构。** 黑名单不区分群形态，和 `chats` 白名单在同一判断层生效，语义保持一致。Governs R2。

### Requirements

**核心过滤行为**

- R1. 替身模式配置支持一个可选的群聊黑名单字段（per-bot），值为 chat ID 列表。字段缺省 / 为空时行为与今天完全一致（不排除任何群）。
- R2. 当某群聊 ID 命中黑名单时，该群里一条「本该触发替身」的消息（@ 到配置的替身对象、但未直接 @ 本 bot）被**当作没读到**——不代答、不喂入任何会话、不产生任何卡片，直接丢弃。对普通群和话题群一视同仁。
- R3. 黑名单为「硬」关闭：命中黑名单的群，即使该群未被运行态逐群开关关闭（`isSubstituteEnabledForChat` 为真），也不触发代答。
- R4. 黑名单优先于 `chats` 白名单：一个群同时在白名单和黑名单里时，最终结果为不触发代答。

**边界与共存行为**

- R5. 黑名单只影响替身触发路径。在命中黑名单的群里，用户直接 `@机器人`（`explicitlyMentionedThisBot`）仍照常路由并应答，行为与非黑名单群一致。
- R6. 群内 `/substitute on|off|status` 命令需感知黑名单：当群命中黑名单时，`/substitute on` 不得回报 `✅ 已开启当前群替身模式` 这类假成功，`status` 也应如实反映「本群已被配置黑名单屏蔽」，避免用户看到「已开启」却得到静默不代答。

**配置面**

- R7. 黑名单可在 `bots.json` 的 `substituteMode` 配置块中手工维护，经现有 normalize 流程校验（去空、去重）。
- R8. 黑名单可在 dashboard「Bot Defaults」页的替身模式区块中编辑，与「生效群聊」白名单并列，含中英文文案说明其语义（黑名单 / 硬关闭 / 与白名单的 deny-wins 关系）。

### Acceptance Examples

- AE1. **Covers R2, R5.** 群 `oc_X` 在黑名单中。用户在 `oc_X` 里 @替身对象「张三」→ bot 静默，不代答。同一群里用户直接 @机器人「帮我查下 xxx」→ bot 正常应答。
- AE2. **Covers R3, R6.** 群 `oc_X` 在黑名单中，有权限用户发 `/substitute on` → bot 回报「本群已被配置黑名单屏蔽」（而非「✅ 已开启」）；此后 @替身对象仍不代答。
- AE3. **Covers R4.** 群 `oc_Y` 同时出现在 `chats` 白名单和黑名单中。用户在 `oc_Y` @替身对象 → bot 不代答（deny-wins）。
- AE4. **Covers R1.** 黑名单字段为空 / 未配置。所有群的替身行为与本改动前完全一致（回归基线）。

### Scope Boundaries

- 不做「自动共存回避」：不侦测被替身人是否在群 / 在线 / 刚发言来临场闭嘴。
- 不做 per-target 黑名单：黑名单是 per-chat，不支持「只在为某人代答时才屏蔽」。与白名单粒度保持一致。
- 不改直接 @机器人 的任何路由 / 应答行为。
- 不改代答提示语（disclosure）、话题群支持开关（`topicGroups` / `topicActiveSessionTrigger`）、控制卡片等其它替身子能力。

---

## Planning Contract

### Key Technical Decisions

- KTD1. **黑名单字段命名 `excludedChats`。** 与现有白名单 `chats` 并列、语义相反；`excluded` 前缀自解释「排除」，且与运行态 store 的 `disabled` 命名区分开（一个是配置策略、一个是运行态）。Governs R1, R7。（session-settled: user-approved — 需求阶段将命名列为 Deferred to Planning，此处定稿；备选 `blockedChats` / `denyChats`）
- KTD2. **黑名单命中即 early-return 丢弃消息，而非仅清 `substituteTrigger`。** 触发门里，当群命中 `excludedChats`、消息 @ 到替身对象、且未直接 @ 本 bot 时，直接 `return`——当作没读到。仅让 `isSubstituteAllowedChat` 返回 `false`（清 trigger）不够：消息会继续 fall-through 到通用群消息门，若 bot 在该群有活跃会话 / solo 群 / mentionMode 放开，仍被喂入并弹卡片。`isSubstituteAllowedChat` 保留黑名单短路以维持 deny-wins + 硬关闭（跳过运行态开关），early-return 额外保证「零卡片」。直接 @ 本 bot 不受影响。Governs R2, R3, R4, R5。
- KTD5. **抽出 `isSubstituteExcludedChat(cfg, chatId)` 纯判定 helper。** 单一职责「群是否在黑名单」，被 `isSubstituteAllowedChat`（deny-wins 短路）与触发门 early-return 两处复用，避免 `excludedChats.includes` 判断散落。
- KTD3. **`/substitute` 命令直接查 `excludedChats.includes`，不复用触发门 helper。** 命令只需要「本群是否被配置屏蔽」这一个维度（不关心白名单），内联一次 `includes` 判断比导出/复用 `isSubstituteAllowedChat`（含白名单逻辑）更贴切、更少耦合。Governs R6。
- KTD4. **`excludedChats` 走与 `chats` 完全相同的 normalize / 持久化管道。** 在 `normalizeSubstituteMode`、`updateBotSubstituteMode`、IPC PUT handler 三处，紧邻 `chats` 各加一段同构处理（`map(String).trim().filter` + 去重，空则不落字段）。保证配置侧行为与白名单一致、且旧配置无该字段时向后兼容。Governs R7, R8。

### High-Level Technical Design

替身触发门现状（`event-dispatcher.ts` 约 2485 行）：

```
if (substituteCfg?.enabled === true && chatType === 'group'
    && isSubstituteAllowedChat(substituteCfg, chatId)) {   // ← 黑名单收进这里
  const chatMode = await getChatMode(...)
  if (modeSupported && isSubstituteEnabledForChat(larkAppId, chatId)) {  // 运行态开关
    substituteChatMode = chatMode
  }
}
```

`isSubstituteAllowedChat` 目标形态（KTD2）：

```ts
function isSubstituteAllowedChat(cfg, chatId): boolean {
  if (cfg?.excludedChats?.includes(chatId)) return false; // deny-wins + 硬关闭
  if (!cfg?.chats?.length) return true;                   // 无白名单 = 全放行
  return cfg.chats.includes(chatId);
}
```

因为黑名单命中直接让整个 `if` 块短路，其后的运行态开关 `isSubstituteEnabledForChat` 根本不会被查到 → 群内 `/substitute on` 写入的 enabled 状态对黑名单群无效（R3 硬关闭）。直接 @机器人 的 `explicitlyMentionedThisBot` 在此门之前独立计算，不受影响（R5）。

### Sequencing

U1 是根（定义字段 + 触发门行为）。U2、U3 依赖 U1（需要 `excludedChats` 字段存在、normalize 接受它）。U4 依赖 U3（UI 通过 PUT 写路径落库）。U1 完成即可单测验证核心行为，U2–U4 为配置面铺开。

## Implementation Units

### U1. 数据模型 + normalize + 触发门（核心行为）

- **Goal**：定义 `excludedChats` 字段并让替身触发门按 deny-wins + 硬关闭跳过命中群。
- **Requirements**：R1, R2, R3, R4, R5。
- **Files**：
  - `src/bot-registry.ts` — `SubstituteModeConfig` 接口加 `excludedChats?: string[]`（紧邻 `chats` 字段，附 JSDoc 说明「黑名单，deny-wins，硬关闭」）。
  - `src/services/substitute-mode-normalize.ts` — 仿 `chats` 解析 `rec.excludedChats`（`map(String).trim().filter(Boolean)` + 去重），非空才写入 `out.excludedChats`。
  - `src/im/lark/event-dispatcher.ts` — `isSubstituteAllowedChat`（约 1123 行）按 KTD2 形态加黑名单短路；更新其 JSDoc。
- **Approach**：见 KTD2 / High-Level Technical Design。黑名单判断置于白名单判断之前。
- **Test Scenarios**（`test/substitute-mode-normalize.test.ts`、`test/event-dispatcher.test.ts`）：
  - normalize：`excludedChats: ['oc_a','oc_a',' oc_b ']` → `['oc_a','oc_b']`；缺省 / 空数组 → 不含 `excludedChats` 字段。
  - normalize：`enabled:false` 但有 targets + `excludedChats` → 字段保留（与 `chats` 同构）。
  - dispatcher：群 `oc_X` 在 `excludedChats`，非 @bot 的 @替身对象消息 → 不触发替身（`substituteChatMode` 未置位）。
  - dispatcher：群 `oc_X` 在 `excludedChats` 且运行态开关为开 → 仍不触发（R3）。
  - dispatcher：群 `oc_Y` 同时在 `chats` 和 `excludedChats` → 不触发（R4 deny-wins）。
  - dispatcher：黑名单群里直接 @机器人 → 走正常应答路径（R5，`explicitlyMentionedThisBot` 为真，不被替身门吞掉）。
  - dispatcher 回归：无 `excludedChats` 配置 → 行为与改动前一致（AE4）。
- **Verification**：`pnpm test` 相关文件绿；`pnpm build` 通过 tsc。

### U2. `/substitute` 命令感知黑名单 + i18n

- **Goal**：黑名单群里 `/substitute on|off|status` 如实回报「已被配置屏蔽」，不产生假成功、不写运行态开关。
- **Requirements**：R6。依赖 U1（`excludedChats` 字段）。
- **Files**：
  - `src/im/lark/substitute-command.ts` — 在 `chatMode` 解析后、arg 分支前，查 `getBot(larkAppId).config.substituteMode?.excludedChats?.includes(chatId)`；命中则回 `cmd.substitute.blocked` 文案并 `return true`，不调用 `setSubstituteEnabledForChat`（KTD3）。位置紧邻现有 `topic_disabled` 检查。
  - `src/i18n/zh.ts` / `src/i18n/en.ts` — 新增 `cmd.substitute.blocked`（zh：「⚠️ 当前群已被配置黑名单屏蔽，替身不会触发（且无法用 /substitute on 开启）。」；en 对应）。
- **Approach**：单点插入，覆盖 status/on/off 三个子命令（对黑名单群统一回报屏蔽，先于 owner 权限检查，屏蔽状态非敏感）。
- **Test Scenarios**（`test/substitute-command.test.ts`）：
  - 黑名单群 `/substitute on` → 回 `cmd.substitute.blocked`，`setSubstituteEnabledForChat` 未被调用。
  - 黑名单群 `/substitute status` → 回 `cmd.substitute.blocked`。
  - 非黑名单群 `/substitute on` → 维持现有 `updated_on` 行为（回归）。
- **Verification**：`pnpm test test/substitute-command.test.ts` 绿。

### U3. 配置写入路径（store + IPC PUT）

- **Goal**：`excludedChats` 能经 dashboard PUT 与 `bots.json` 持久化。
- **Requirements**：R7, R8。依赖 U1（normalize 接受字段）。
- **Files**：
  - `src/services/substitute-mode-store.ts` — `updateBotSubstituteMode` 里仿 `chats` 解析并透传 `excludedChats` 给 `normalizeSubstituteMode`。
  - `src/core/dashboard-ipc-server.ts` — `PUT /api/bot-substitute-mode`（约 2588 行）仿 `chats` 解析 `rec.excludedChats` 并传入 store。
- **Approach**：两处各加与 `chats` 同构的 `Array.isArray(...) ? [...new Set(map/trim/filter)] : []`，非空才带入。
- **Test Scenarios**（`test/substitute-mode-store.test.ts`、`test/dashboard-ipc.test.ts`）：
  - store：PUT `excludedChats:['oc_a','oc_b']` → registry 与落盘的 `substituteMode.excludedChats` 均为 `['oc_a','oc_b']`。
  - store：不带 `excludedChats` → 落盘无该字段（回归）。
  - ipc：PUT body 带 `excludedChats` → 200 且响应 `substituteMode.excludedChats` 正确。
- **Verification**：`pnpm test` 相关文件绿。

### U4. Dashboard UI（黑名单编辑框 + 文案）

- **Goal**：Bot Defaults 页替身区块新增「黑名单群聊」编辑框，与「生效群聊」并列。
- **Requirements**：R8。依赖 U3（PUT 接受字段）。
- **Files**：
  - `src/dashboard/web/bot-defaults.ts` — `BotSubstituteMode` type 加 `excludedChats?: string[]`。
  - `src/dashboard/web/bot-defaults-page.tsx` — 加 `excludedChatsText` state（`formatSubstituteChats(initial?.excludedChats)`）、mode-sync（约 2417/2444 行两处 `setChatsText` 同款）、textarea（复用 `substituteChats` 那段结构）、save payload 加 `excludedChats: parseSubstituteChats(excludedChatsText)`（约 2517 行）；同时给 `save()` body 参数类型（约 2424 行）补 `excludedChats?: string[]`（与既有 `chats?: string[]` 并列，否则 payload 不过 tsc）。复用现有 `parseSubstituteChats` / `formatSubstituteChats`。
  - `src/dashboard/web/i18n.ts` — 新增 `botDefaults.substituteExcludedChats` / `...Help` / `...Placeholder`（zh + en 两套），Help 说明黑名单语义 + deny-wins + 硬关闭。
- **Approach**：镜像现有「生效群聊」textarea 全链路（state / sync / render / save），字段名换成 `excludedChats`。
- **Test Scenarios**：dashboard 前端无独立单测框架覆盖此页，改动经 `pnpm build`（含 `dashboard:bundle`）保证编译；行为在 live 验证覆盖（见 Verification Contract）。
- **Verification**：`pnpm build` 通过；dashboard 保存后 `bots.json` 出现 `excludedChats`。

## Verification Contract

| 门 | 命令 | 覆盖 |
|---|---|---|
| 编译 | `pnpm build` | 全量 tsc + dashboard bundle（U1–U4） |
| 单测 | `pnpm test` | U1–U3 的 normalize / dispatcher / command / store / ipc 场景 |
| 定向单测 | `pnpm test test/event-dispatcher.test.ts test/substitute-command.test.ts test/substitute-mode-normalize.test.ts test/substitute-mode-store.test.ts` | 快速回归替身链路 |
| Live 验证 | `pnpm switch:here && pnpm daemon:restart`，再在飞书实测 | R2/R3/R5 触发行为 + U4 UI（纯单测无法覆盖 PTY/飞书路由） |

Live 验证必测项（AGENTS.md 要求需手动验证的改动先部署本 checkout）：
1. 黑名单群 @替身对象 → bot 静默（R2）。
2. 同群直接 @机器人 → bot 正常应答（R5）。
3. 黑名单群 `/substitute on` → 回「已被配置黑名单屏蔽」（R6）。
4. 非黑名单群 @替身对象 → 代答如常（回归）。

## Definition of Done

- 全局：`pnpm build` 与 `pnpm test` 均绿；U1–U4 全部落地。
- 每单元：其 Test Scenarios 全部通过（U4 以 `pnpm build` + live 验证代替单测）。
- R1–R8 均有对应实现与测试（或 live）覆盖；AE1–AE4 行为经 dispatcher 单测或 live 验证坐实。
- 向后兼容：无 `excludedChats` 的旧 `bots.json` 行为不变（AE4 回归通过）。
- Live 验证 4 项必测项全过并在 PR 描述中注明结果（含截图：dashboard 新编辑框）。
- 清理：无遗留调试代码 / 半成品分支代码。
- 影响范围结论写入 PR：动了 `event-dispatcher` 触发门这一跨普通群/话题群共用路径，需说明两种群形态均已验证；未触及其它 CLI / 后端 / 直接 @ 路由。

## Sources / Research

- 替身配置类型：`src/bot-registry.ts:792`（`SubstituteModeConfig`，现有 `chats` 白名单在 :797）；normalize 挂载 `src/bot-registry.ts:1936`。
- 触发门与白名单判断：`src/im/lark/event-dispatcher.ts:1123`（`isSubstituteAllowedChat`）、`:2485`（触发主判断段）、`:2477`（`explicitlyMentionedThisBot` 独立计算）。
- 配置 normalize：`src/services/substitute-mode-normalize.ts:44`（`chats` 解析范式）。
- 运行态逐群开关：`src/services/substitute-chat-toggle-store.ts:41`（`isSubstituteEnabledForChat`，`disabled` 列表语义）。
- 群内命令：`src/im/lark/substitute-command.ts:37`（`topic_disabled` 检查位置，黑名单检查紧邻其后）。
- 配置写入：`src/services/substitute-mode-store.ts:22`（`updateBotSubstituteMode` 的 `chats` 解析）、`src/core/dashboard-ipc-server.ts:2588`（IPC PUT 的 `chats` 解析）。
- dashboard UI：`src/dashboard/web/bot-defaults.ts:28`（`BotSubstituteMode` type）、`src/dashboard/web/bot-defaults-page.tsx:2324`（`chatsText` state）/`:2517`（save payload）/`:2590`（textarea）、`:200`（`parseSubstituteChats`/`formatSubstituteChats`）。
- i18n：`src/i18n/zh.ts:225-232`（`cmd.substitute.*`）、`src/dashboard/web/i18n.ts:1844`（`botDefaults.substituteChats*` zh）/`:3846`（en）。
- 测试范式：`test/event-dispatcher.test.ts:3240`（per-chat off 用例）/`:3273`（白名单用例）、`test/substitute-mode-normalize.test.ts`、`test/substitute-mode-store.test.ts:145`、`test/substitute-command.test.ts`、`test/dashboard-ipc.test.ts:1483`。
