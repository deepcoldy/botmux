---
title: "feat: Skill Pack 与 Skill 管理页重构"
type: feat
status: proposed
date: 2026-08-03
owners:
  - dashboard
  - skills
---

# Skill Pack 与 Skill 管理页重构

> 校对状态：已对照本地 `master` @ `e7af2535` 逐处核实文件路径与行号。新增「Selector 兼容性审计」一节与相关测试项；修正了投递模式枚举的表述。

## Goal Capsule

让用户把多个已安装 Skill 保存为一个可复用的“专项包（Skill Pack）”，再把专项包分配给一个或多个 Bot，避免逐个 Bot 重复勾选 Skill；同时把当前混在一个长页面中的安装、管理、分配和投递设置拆成清晰的工作流。

本方案优先实现“编排型专项包”：专项包只保存 Skill 引用，启动会话时展开为现有的普通 Skill。它不是新的可执行 Skill，也不会改变 `SKILL.md` 格式或各 CLI 的 Skill 执行协议。

## Product Contract

### 用户承诺

1. 用户可以从已安装 Skill 中创建、编辑、复制和删除专项包。
2. 一个 Bot 可以同时引用多个专项包，也可以附加少量单独 Skill。
3. 修改专项包后，所有引用它的 Bot 会在新会话中使用最新内容。
4. 页面明确展示专项包展开后的最终 Skill、来源和缺失项。
5. 现有只包含 `skill:*` 的 Bot 配置无需迁移，行为保持不变。
6. 删除专项包不会卸载成员 Skill；删除被专项包引用的 Skill 前必须提示影响范围。
7. 专项包仍然“装给 Bot”，不会把 Skill 写入用户独立运行的全局 CLI 环境。

### 非承诺

- MVP 不支持专项包嵌套，避免循环依赖和隐式继承。
- MVP 不把专项包伪装成一个独立的运行时 Skill。
- MVP 不自动安装专项包缺失的远程依赖。
- MVP 不允许专项包直接引用未注册的工作区 Skill 或原生内置 Skill。
- MVP 不改变正在运行的会话；变更从新会话生效。

## Problem Statement

当前 `Skill 管理` 页面同时承担四类任务：

1. 配置工作区 Skill 与投递方式。
2. 从 GitHub、Git、本地目录或 AgentBuddy 安装 Skill。
3. 浏览和维护已安装 Skill。
4. 为每个 Bot 单独选择优先 Skill。

这会造成以下问题：

- 安装来源、资源库存量、Bot 分配和运行时设置没有稳定的层级。
- 已安装 Skill 在页面下方，而 Bot 选择器在上方；空库时选择器是无效入口。
- 每个 Bot 重复显示同一套多选控件，Bot 越多，操作成本越高。
- 同一组业务 Skill 无法命名、复用、审阅或批量分配。
- “工作区 Skill”“投递方式”“优先 Skill”“已安装 Skill”等概念同时出现，用户难以判断它们分别影响安装、配置还是执行。
- GitHub URL、Git URL、AgentBuddy 命令和本地目录共用一个输入框，`Ref`、仓库内路径等高级字段长期占据主界面。

## Target Mental Model

用户应当按以下顺序理解和操作能力：

```text
来源/安装  ->  Skill 资源库  ->  专项包  ->  分配到 Bot  ->  会话投递
```

- **Skill 资源库**回答“机器上有哪些可复用能力”。
- **专项包**回答“一个业务场景需要哪组能力”。
- **Bot 分配**回答“哪个 Bot 使用哪些专项包和额外能力”。
- **投递设置**回答“这些能力通过哪种机制进入会话”。

## Key Decisions

### 1. 专项包是声明式引用，不复制 Skill

专项包保存 `skill:<name>` 引用。解析会话时，将 `pack:<id>` 展开成对应 Skill，再进入现有去重、沙箱读取和投递流程。

收益：

- 不重复存储 Skill 文件。
- Skill 更新后，专项包自动使用已安装的新版本。
- Claude 原生通道、Codex 提示词通道和未来通道继续消费统一的 `ResolvedSkill[]`。
- 可以渐进式上线，不需要修改第三方 Skill 格式。

### 2. 专项包独立持久化

新增：

```text
~/.botmux/skills/packs.json
```

不把专项包塞进 `registry.json`：Skill 注册表描述物理安装项，专项包描述用户编排，生命周期和校验规则不同。

建议类型：

```ts
export type SkillSelector = `skill:${string}` | `pack:${string}`;

export interface SkillPack {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  include: Array<`skill:${string}`>;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillPackRegistryFile {
  schemaVersion: 1;
  packs: Record<string, SkillPack>;
}
```

约束：

- `id` 使用稳定 slug，创建后不可直接修改。
- `name` 必填，建议最多 80 字符。
- `description` 最多 500 字符。
- `tags` 最多 20 个，每项最多 40 字符。
- `include` 去重，至少包含一个 Skill，MVP 上限建议 100。
- `include` 只允许 `skill:*`，不允许 `pack:*`。
- `revision` 每次内容更新递增，便于审计和前端冲突提示。

### 3. 扩展现有 Bot policy，不另造分配系统

将当前：

```ts
interface BotSkillPolicy {
  include?: Array<`skill:${string}`>;
}
```

扩展为：

```ts
interface BotSkillPolicy {
  include?: Array<`skill:${string}` | `pack:${string}`>;
}
```

Bot 配置仍然是分配关系的唯一事实源。旧配置无需迁移；没有 `pack:*` 时解析结果与当前版本完全一致。

### 4. 运行时展开并保留来源解释

解析顺序建议：

1. 读取直接 `skill:*` 引用。
2. 读取并展开 `pack:*` 引用，按 policy 中的包顺序和包内顺序排列。
3. 合并插件 Skill。
4. 按 Skill 名称去重。

当同一个 Skill 同时被直接引用和专项包引用时，直接引用优先，确保显式配置拥有最强解释权。

建议扩展诊断：

- `pack_not_found`
- `pack_skill_missing`
- `pack_invalid`
- 继续使用现有 `duplicate_skill_shadowed`

建议来源标记：

```ts
type PriorityReason =
  | "bot:include"
  | `bot:pack:${string}`
  | ExistingPriorityReason;
```

### 5. 修改是动态引用，必须显示影响范围

编辑专项包时，确认区显示：

- 当前引用该包的 Bot 数量与名称。
- 新增、移除的 Skill。
- 缺失或不可用的 Skill。
- “保存后从新会话生效”的说明。

删除被引用的专项包默认阻止。只有显式解除引用或走带影响确认的强制流程才允许删除。删除专项包永远不卸载成员 Skill。

### 6. 保持 Bot 隔离与现有 CLI 桥接原则

专项包只改变 Bot 的 Skill 选择和披露，不改变 Skill 的投递实现：Claude 家族继续使用逐会话原生机制，Codex、Gemini、OpenCode 等继续由现有 delivery 策略决定使用提示词还是原生目录。Botmux 不为专项包增加新的 Agent runtime，也不把成员 Skill 永久写入用户独立运行的 CLI 环境。

基础说明强调“每个 Bot 一套技能、各司其职、本地 CLI 零污染”，因此 UI 中不应把专项包描述为“全局安装包”。更准确的文案是“把一组已安装能力分配给 Bot”。

## Information Architecture

保留一级导航 `Skill 管理`，页面内部重构为四个标签：

### 1. 专项包（默认页）

核心内容：

- 搜索、标签过滤、新建专项包。
- 卡片或紧凑列表展示名称、描述、Skill 数、已分配 Bot 数和健康状态。
- 操作：编辑、复制、分配、删除。
- 健康状态：`完整`、`缺失 N 项`、`未分配`。

空状态使用三步引导：

```text
安装 Skill -> 创建专项包 -> 分配给 Bot
```

### 2. Skill 库

核心内容：

- 已安装 Skill 的搜索、来源、版本、更新时间和被引用情况。
- 更新、查看详情、删除和批量选择。
- `安装 Skill` 改为主按钮，打开分步抽屉或对话框，不长期占用页面。

安装流程：

1. 选择来源类型：GitHub / Git / AgentBuddy / 本地。
2. 输入来源；只有对应场景才显示 Ref、仓库内路径等高级字段。
3. 发现并预览候选 Skill。
4. 选择并安装。
5. 如果一次安装多个 Skill，提供“安装后保存为专项包”。

### 3. Bot 分配

每个 Bot 使用紧凑行，而非大面积重复卡片：

```text
Bot 名称 | 专项包 chips | 单独 Skill（高级） | 最终能力数 | 健康状态 | 编辑
```

编辑抽屉分两层：

- 首要操作：选择专项包。
- 高级操作：附加单独 Skill。
- 预览区：展示展开、去重后的最终 Skill，并标注每项来自哪个专项包或直接选择。

P1 支持逐 Bot 编辑；P2 增加多选 Bot 后批量应用/移除专项包。

### 4. 投递设置

迁移当前全局技术设置：

- 是否读取工作区 Skill。
- `自动 / 提示词 / 原生` 投递模式。
- 每种模式的适用 CLI、回退行为与生效范围。

该页不再出现安装和 Bot 选择器，避免“如何获得能力”和“如何注入能力”混在一起。

注意这里有两套并存的枚举，不要混为一谈：

- **全局 delivery**（`global-config.skills.delivery`，Dashboard「Skill 注入方式」）：`auto | prompt | native` → 中文「自动 / 提示词 / 原生」。
- **per-bot `skillInjection`**（`bot-config-store.ts` 字段）：`global | prompt | off`，只影响 codex/gemini 这类使用全局 skills 目录的 CLI。

历史更新说明里的 `prompt / global / off` 说的是后者，不是投递模式。PR 2 应在同一个标签页里同时呈现这两个设置并说明各自作用域，避免用户把「注入方式」和「per-bot 注入开关」当成同一个东西。

## Visual Direction

延续 Botmux 深色界面，但把页面做成“能力装配台”，建立稳定的层级色：

- 青色：Skill 资源与来源。
- 琥珀色：专项包及编排关系。
- 绿色：已分配、可运行状态。
- 红色：缺失依赖和降级状态。

减少每个区域都使用紫色描边的做法。默认页面优先使用紧凑列表和有意义的状态，避免重复大卡片。顶部指标建议改为：

- 已安装 Skill
- 专项包
- 已配置 Bot
- 异常专项包

“优先引用数量”不再作为一级指标，因为它不能直接指导用户行动。

## API Contract

### 专项包 CRUD

```text
GET    /api/skill-packs
POST   /api/skill-packs
GET    /api/skill-packs/:id
PUT    /api/skill-packs/:id
DELETE /api/skill-packs/:id
POST   /api/skill-packs/:id/clone
```

返回对象建议包含派生状态，避免前端重复拼装：

```ts
interface DashboardSkillPack extends SkillPack {
  resolvedSkills: SkillPackage[];
  missingSkills: string[];
  references: Array<{
    larkAppId: string;
    botName: string;
  }>;
}
```

错误码建议：

- `SKILL_PACK_NOT_FOUND`
- `SKILL_PACK_ID_CONFLICT`
- `SKILL_PACK_INVALID_SELECTOR`
- `SKILL_PACK_SKILL_NOT_FOUND`
- `SKILL_PACK_IN_USE`
- `SKILL_PACK_REVISION_CONFLICT`

更新请求携带预期 `revision`，防止两个 Dashboard 标签页静默覆盖彼此修改。

### Bot policy

沿用现有 Bot Skill policy 接口，只把输入校验扩展到 `pack:*`。服务端返回展开后的预览和诊断，前端不自行实现解析规则。

### CLI

P1 最小命令：

```text
botmux skills pack list
botmux skills pack show <id>
botmux skills pack create
botmux skills pack update <id>
botmux skills pack delete <id>
```

P2 再加入批量分配与导入导出，避免首个 PR 同时扩大 CLI 交互设计范围。

## Selector 兼容性审计（PR 1 必须一次性改全）

`pack:` 是往一个**当前处处被硬过滤成 `skill:` 的字段**里加新值。代码里有 7 处会把非 `skill:` 前缀的 selector 静默丢弃——只要漏掉任何一处，用户配好的包会在下一次无关操作后凭空消失，且没有任何报错。这是本方案最大的落地风险，优先级高于 UI。

| # | 位置 | 现状 | 漏改后果 |
| --- | --- | --- | --- |
| 1 | `src/bot-registry.ts:2605` `readDirectSkillSelectors` | `/^skill:.+$/` 过滤 | `pack:*` 永远读不出来，写进去也等于没写 |
| 2 | `src/core/skills/policy.ts:63` | 只对 `skill:` 前缀做 `appendMatches` | 包不参与解析 |
| 3 | `src/core/skills/im-command.ts:22` `attachSkillPolicy` | 重建 include 时 `filter(startsWith('skill:'))` | **飞书里 `/skills attach xxx` 一次，该 bot 所有包引用被清空** |
| 4 | `src/core/skills/im-command.ts:31` `detachSkillPolicy` | 同上 | detach 一个 skill 顺带清空所有包 |
| 5 | `src/core/skills/im-command.ts:50` `renderStatus` | 只统计 `skill:` | IM 里看不到包，用户无法自查 |
| 6 | `src/core/skills/references.ts:26` `directSkillNames` | 只返回直接 skill | 删 Skill 时影响分析漏掉「被包间接引用」 |
| 7 | `src/dashboard/web/skills-page.tsx:1183` `setBotSkills` | 整体覆写 `{ include: names.map(n => 'skill:'+n) }` | 旧 UI 保存一次 = 包引用被覆盖掉 |

派生要求：

- `attach`/`detach` 语义改为「只增删 `skill:` 项，原样保留 `pack:` 项」，并补一条「attach 的 skill 已被某个包覆盖」的提示。
- `/api/bot-skills` 的 `set` 动作走 `readBotSkillPolicy`，第 1 条不改的话 API 会返回 `ok: true` 但实际什么都没存——这是最容易被误判为「已实现」的坑，API 测试必须断言回读结果而不是只断言状态码。
- Dashboard 的 bot 保存接口建议从「整体覆写 include」改为「按类型分别提交 `skills` 与 `packs`」，从协议上消除覆写风险。

### PR 1 → PR 2 之间的降级窗口

PR 1 合入后、PR 2 未上线前，用户会用**旧 Skill 页面**操作**已支持包**的后端。此时第 7 条会真实发生。三选一，建议选 b：

- a. PR 1 与 PR 2 同一个版本发布，中间不放 canary。
- b. **PR 1 里顺手把 `skills-page.tsx:1183` 改成「保留未知前缀 selector」的合并写入**（约 10 行改动），旧 UI 即使不认识包也不会破坏它。
- c. PR 1 阶段用 feature flag 关闭包的写入路径，只留 CLI。

同理，`packs.json` 是新增文件，botmux 回退到旧版本时 `pack:*` 会被第 1 条静默吃掉——降级不会崩，但 bot 会安静地少掉一批 Skill。发布说明必须写明这一点（对应 Rollout 第 5 条）。

## Implementation Units

### PR 1 — 核心模型、解析器和 API

目标：建立可测试、向后兼容的专项包能力，不依赖新 Dashboard。

主要改动：

- 在 `src/core/skills/types.ts` 增加 pack 类型、selector 联合类型和诊断。
- 在 `src/core/skills/registry-paths.ts` 增加 `packs.json` 路径。
- 新增 `src/services/skill-pack-store.ts`，复用 Skill registry 的原子写入与文件权限策略。
- 扩展 `src/bot-registry.ts` 的 policy 解析，允许 `pack:*`。
- 扩展 `src/core/skills/policy.ts`，实现展开、稳定排序、去重和来源解释。
- 扩展 `src/core/skills/references.ts`，同时统计 Bot -> Pack 和 Pack -> Skill 引用。
- **改 `src/core/skills/im-command.ts` 的 attach/detach/status，保留 `pack:` 项**（见 Selector 兼容性审计 3/4/5）。
- 在 `src/dashboard.ts` 和 `src/core/dashboard-ipc-server.ts` 增加 CRUD 与 policy 校验。
- **把 `skills-page.tsx` 的 bot 保存改为合并写入**，堵住 PR 1/PR 2 之间的降级窗口。
- 增加 CLI pack 子命令及文档。

影响范围评估（按 CLAUDE.md 要求）：改的是 `core/skills/`、`bot-registry.ts` 这类共用层，横跨全部 20+ CLI 与所有会话类型。但由于包只在 policy 解析阶段展开成既有的 `ResolvedSkill[]`，下游（native/prompt 两条投递通道、PtyBackend/TmuxBackend、话题会话/群会话/adopt/restore、sandbox 读取路径、v3 workflow）都不感知包的存在——**验证重点是「无包配置的解析输出与升级前逐字节一致」**，而不是逐 CLI 回归。至少在一个 Claude 家族 CLI（原生通道）和一个非 Claude CLI（提示词通道）上各跑一次真实会话确认。

迁移策略：

- `packs.json` 不存在时按空注册表处理。
- 不重写现有 Bot 配置。
- 不修改 `registry.json` schema。
- 所有旧 `skill:*` 测试必须保持通过。

### PR 2 — Dashboard 信息架构与专项包编辑器

目标：用户能在图形界面完成安装、建包、分配和影响预览。

主要改动：

- 将 `src/dashboard/web/skills-page.tsx` 拆为页面壳和四个标签组件，避免继续扩大单文件。
- 新增专项包列表、创建/编辑抽屉、健康状态和引用预览。
- 把安装表单迁入分步流程，按来源渐进展示字段。
- 将 Bot 卡片网格改为紧凑表格/列表，区分专项包和单独 Skill。
- 增加最终展开结果预览和缺失依赖提示。
- 增加空状态、键盘操作、焦点管理和窄屏布局。

建议组件边界：

```text
skills/
  skills-page.tsx
  skill-packs-tab.tsx
  skill-pack-editor.tsx
  skill-library-tab.tsx
  skill-install-wizard.tsx
  bot-skill-assignments-tab.tsx
  skill-delivery-settings-tab.tsx
  skill-health-badge.tsx
  types.ts
```

具体目录以现有 Dashboard 构建约束为准，但不建议继续把所有逻辑堆叠到现有 `skills-page.tsx`。

### PR 3 — 可移植专项包与效率增强

目标：让专项包可分享、可批量部署，并串联多 Skill 安装体验。

候选能力：

- 多选 Bot 批量应用/移除专项包。
- 安装多个候选 Skill 后一键创建专项包。
- 导入/导出 `.botmux-skillpack.json`。
- 导出时记录 Skill 名称、版本、checksum 和可移植来源。
- 对 `local-link` 等不可移植来源给出明确警告。
- 导入时先展示安装计划，不静默拉取或覆盖本地 Skill。

## File-Level Impact Map

| Area | Existing file | Expected change |
| --- | --- | --- |
| Core types | `src/core/skills/types.ts` | Pack 类型、selector、诊断与来源 |
| Paths | `src/core/skills/registry-paths.ts` | `packs.json` 路径 |
| Persistence | `src/services/skill-registry-store.ts` | 抽取可复用校验/原子写入辅助，或保持独立 |
| Persistence | new `src/services/skill-pack-store.ts` | Pack CRUD、schema 校验、revision |
| Bot config | `src/bot-registry.ts` | 读取 `pack:*` selector |
| Resolver | `src/core/skills/policy.ts` | Pack 展开、去重、诊断 |
| Session | `src/core/skills/session-resolver.ts` | 注入 Pack registry |
| References | `src/core/skills/references.ts` | Pack 与成员 Skill 的影响分析 |
| IM 命令 | `src/core/skills/im-command.ts` | attach/detach 保留 `pack:`；status 展示包 |
| CLI 命令 | `src/core/skills/cli-admin-command.ts` | `skills doctor`/status 输出包展开结果 |
| Dashboard API | `src/dashboard.ts` | Pack payload、CRUD、健康状态 |
| Daemon API | `src/core/dashboard-ipc-server.ts` | policy 写入校验 |
| Dashboard UI | `src/dashboard/web/skills-page.tsx` | 页面壳与过渡迁移 |
| Dashboard UI | new skill page modules | 四个标签和编辑流程 |
| Docs | `docs/setup/skills.md` | 概念、CLI、配置和迁移说明 |

## Edge Cases and Safety

### 缺失 Skill

专项包包含未安装 Skill 时，不让整个 Bot 配置失效：

- 解析存在的成员 Skill。
- 返回 `pack_skill_missing` 诊断。
- Dashboard 把专项包标为降级。
- 新建/编辑时默认阻止保存缺失引用；缺失主要来自安装后被删除或手工修改文件。

### 删除 Skill

删除前影响分析必须同时包含：

- 直接引用该 Skill 的 Bot。
- 包含该 Skill 的专项包。
- 通过这些专项包间接使用该 Skill 的 Bot。

默认阻止删除。强制删除需要明确确认，并保留可诊断的缺失引用，避免静默改变专项包含义。

### 删除专项包

- 未被引用：直接删除。
- 被 Bot 引用：默认返回 `SKILL_PACK_IN_USE` 和引用列表。
- 强制删除：同时从引用 Bot policy 中移除对应 `pack:*`，必须是显式的独立操作并显示 diff。

### 并发编辑

用 `revision` 做乐观并发控制。版本不一致时返回冲突和最新对象，前端提示用户重新应用变更，不能最后写入者静默覆盖。

### 名称冲突

`id` 唯一，展示名称可以重复但 UI 应提示。运行时引用永远使用稳定 `id`，不要用可变的展示名称。

## Verification Plan

### Unit tests

- Pack store 首次创建、读写、原子替换、文件权限和损坏文件处理。
- `id`、长度、重复成员、非法 selector、空成员校验。
- resolver 的单包、多包、稳定顺序、直接引用优先和跨包去重。
- `pack_not_found`、`pack_skill_missing`、`pack_invalid` 诊断。
- 旧 `skill:*` policy 的输出与升级前一致。
- reference analyzer 能返回直接、间接和受影响 Bot。
- **selector 保真回归**（对应兼容性审计，每条一个用例）：
  - `attachSkillPolicy` / `detachSkillPolicy` 在含 `pack:` 的 policy 上操作后，`pack:` 项数量与顺序不变。
  - `readBotSkillPolicy` 能读出 `pack:` 且拒绝 `pack:` 后为空串等畸形值。
  - 「写入含 pack 的 policy → 重新读取」round-trip 相等（防止 API 返回 ok 但实际丢弃）。
  - 模拟旧 UI 的整体覆写请求，断言 `pack:` 不被清空。

### API tests

- CRUD、clone、revision conflict、in-use delete 和鉴权。
- Bot policy 同时接受 `skill:*` 与 `pack:*`。
- Dashboard payload 的健康状态和展开预览正确。

### UI tests

- 零 Skill、零专项包的引导路径。
- 创建、编辑、复制和删除专项包。
- 分配专项包并添加单独 Skill。
- 展开结果的去重和来源标记。
- 缺失 Skill 与冲突更新的错误反馈。
- 安装多个 Skill 后创建专项包。
- 窄屏、键盘导航、焦点恢复和可访问名称。

### Integration tests

- 同一组成员通过直接选择和专项包选择时，最终 `prioritySkills` 一致。
- Claude 原生通道、Codex 提示词通道和自动回退都能消费展开结果。
- 沙箱 Skill 读取仍遵循现有路径边界。
- 删除/更新 Skill 后，新会话反映专项包健康状态；旧会话不被热修改。

### Required commands

```bash
pnpm build
pnpm test
```

Dashboard 视觉改动完成后，还需要按仓库规范在明确授权的测试窗口执行：

```bash
pnpm switch:here
pnpm daemon:restart
```

然后用真实 Dashboard 完成安装、建包、分配和开新会话的完整截图验证。该命令会切换并重启所有 Bot，不应在仅评审方案时执行。

## Rollout and Compatibility

1. PR 1 上线后，即使没有新 UI，也可通过 API/CLI 使用专项包。
2. PR 2 将 UI 默认入口切到专项包，但保留“单独 Skill（高级）”。
3. 不自动把现有 Bot 的相同 Skill 组合转换为专项包；Dashboard 可以提示“检测到重复组合，可保存为专项包”，由用户确认。
4. 如果需要回滚，只需移除 `pack:*` 引用；旧 `skill:*` 路径始终保留。
5. `packs.json` 是新增文件，旧版本 Botmux 会忽略它；但包含 `pack:*` 的 Bot 配置回退到旧版本时无法识别，因此发布说明必须明确降级步骤。

## Effort Estimate

以一名熟悉代码库的开发者估算：

- PR 1：2–3 天。
- PR 2：2–4 天。
- PR 3：2–3 天。

核心 MVP（PR 1 + PR 2 的基础创建、编辑和逐 Bot 分配）约 4–6 个工作日；完整体验约 6–10 个工作日。

## Definition of Done

- [ ] 可以创建一个包含多个已安装 Skill 的专项包。
- [ ] 可以将专项包分配给 Bot，并保留单独 Skill 入口。
- [ ] 新会话解析出的 Skill 集合稳定、可解释且正确去重。
- [ ] 现有 Bot 配置无需迁移，行为保持不变。
- [ ] 缺失成员、删除影响和并发修改都有明确诊断。
- [ ] 安装、资源库、专项包、Bot 分配和投递设置不再混在一个长页面。
- [ ] 单元、API、UI 和会话集成测试通过。
- [ ] `pnpm build` 与 `pnpm test` 通过。
- [ ] 在用户授权的窗口完成真实 Dashboard 和新会话验证。
- [ ] `docs/setup/skills.md` 与版本更新说明完成。

## Open Questions for Product Review

这些问题不阻塞 MVP 核心架构，但应在 PR 2 开始前确认：

1. 中文产品名最终使用“专项包”“能力包”还是“Skill Pack”；建议主界面用“专项包”，技术文档同时保留 Skill Pack。
2. 是否允许一个 Bot 同时引用多个专项包；本方案建议允许，并显示展开去重结果。
3. 修改被多个 Bot 引用的专项包时，是否只确认一次，还是要求逐 Bot 选择；本方案建议一次确认并展示完整影响列表。
4. P2 的导出文件是否只保存依赖清单，还是允许连同 Skill 内容打包；建议先做依赖清单，避免许可证、体积和供应链问题。
5. 投递设置是否继续展示 `自动 / 提示词 / 原生`，以及如何在帮助文案中对应历史上的 `prompt / global / off`。

## Sources Reviewed

- 当前 Dashboard Skill 页面：`src/dashboard/web/skills-page.tsx`
- Skill 类型与解析：`src/core/skills/types.ts`、`src/core/skills/policy.ts`
- 会话解析：`src/core/skills/session-resolver.ts`
- Skill 注册表：`src/services/skill-registry-store.ts`
- Bot policy 读取：`src/bot-registry.ts`
- 引用分析：`src/core/skills/references.ts`
- Dashboard 与 daemon API：`src/dashboard.ts`、`src/core/dashboard-ipc-server.ts`
- 安装来源解析：`src/dashboard/skill-install-request.ts`
- 现有使用文档：`docs/setup/skills.md`
- 飞书基础说明：[Botmux 使用说明](https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg) 中的“Skill 管理”“Dashboard 管控面”“设计理念”。
- 飞书更新说明：[Botmux 更新说明](https://bytedance.larkoffice.com/docx/I4MadRIDxoYInMxKYxBcYHDEnXb) 中的“Skills 工作区：发现 plugin skill + 注入方式可选”。
