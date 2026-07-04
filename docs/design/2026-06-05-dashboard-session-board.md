# Dashboard 会话 Status Board（方案 A 轻量版）

> 2026-06-05 | 老滕拍板：先做 A，claude + codex 一起讨论一起做。worktree：`/root/claude-code-workspace/botmux-seedclaw`（master @ 8979b81）。
> 背景：老滕看了 seedclaw Issues 看板截图，想从会话管理维度优化 dashboard 展示。讨论结论：不照搬任务 kanban（session 状态机器推导、高频跳变、无 Done 语义），做**按状态分列的 status board**。
> 状态：待 codex review/认领 → 实现 → mock 截图给老滕过目。

## 1. 目标 / 非目标

**目标**
- dashboard sessions 面板新增 board 视图：按「会话此刻需要什么」分列，挂起会话一眼可见
- 保留现有表格视图，可切换，偏好持久化
- 「需要你」列用现有/低成本信号拼出 v1（不等 wait primitive）

**非目标（B 完整版，另行）**
- 不做 ask 等待 / plan 待审批的显式 awaiting 信号上报（属 wait primitive）
- 不做拖拽改状态（session 状态不由人驱动）
- 不动 closed 会话的管理逻辑（board 默认不显示 closed，表格可看）

## 2. 列定义与状态映射（核心设计点）

四列，映射为纯函数 `deriveBoardColumn(row: SessionRow): BoardColumn`：

| 列 | 判定（按优先级短路） | 信号来源 |
|---|---|---|
| 🔴 needs-you 需要你 | `pendingRepo` \|\| `tuiPromptActive` \|\| `status === 'limited'` | 新增字段 ×2 + 既有 status |
| 🟡 starting 启动中 | `status === 'starting'` | 既有 |
| 🟢 working 干活中 | `status === 'working' \|\| 'analyzing'` | 既有 |
| ⚪ idle 空闲 | `status === 'idle'` | 既有 |

- 判定顺序：needs-you 先于其它（limited 的会话归 needs-you 不归 working）
- `closed` 不进 board
- 列内排序：needs-you 按**挂起时长降序**（等最久的最上面，用 `lastMessageAt` 距今）；其余列按 `lastMessageAt` 降序
- 列头带计数徽章（学截图）

## 3. SessionRow 扩展（daemon 侧，小改动）

`src/core/dashboard-rows.ts` 的 `SessionRow` 增加：

```ts
/** Repo-selection card is waiting for a click (CLI not spawned yet). */
pendingRepo?: boolean;
/** A TUI prompt card is open and waiting for the user's choice. */
tuiPromptActive?: boolean;
```

- `composeRowFromActive`：`pendingRepo: !!ds.pendingRepo`、`tuiPromptActive: !!ds.tuiPromptCardId`
- **publish 点核查**（实现时必须确认）：`pendingRepo` 置位/清除、`tuiPromptCardId` 置位/清除的地方是否都有 `session.update` publish；缺的补 `publish({type:'session.update', body:{sessionId, patch:{...}}})`。否则 board 列不实时。
- Aggregator 是泛型 Row 透传，**零改动**；前端拿到新字段即可用。

## 4. 前端（`src/dashboard/web/`）

- `sessions.ts`：新增 board 渲染分支；视图切换 toggle（board/table），写 `preferences.ts` 持久化；默认 board（待讨论：还是默认 table 灰度一阵？）
- 卡片内容（学截图密度，但字段是 botmux 的）：
  - 标题：`title`（话题标题，空则 sessionId 短形式）
  - 标签行：`botName` + `cliId` + repo（`workingDir` 末段）+ `adopt` 徽章（若有）
  - 元信息：状态徽章 + 距 `lastMessageAt` 时长（needs-you 列显示「等了 Xm」）
  - 动作：点卡片跳飞书话题（`feishuChatLink`）；次级动作 web 终端 / 关闭（复用现有行级动作）
- 多选批量关闭在 board 视图保留（卡片 checkbox 或长按，从简实现）
- `style.css`：四列 grid，窄屏退化为单列堆叠
- 5s 轮询/SSE 更新时卡片跨列移动**不做动画**（高频跳变，动画反而晃眼）

## 5. 分工提议（讨论起点，codex 可调）

| 块 | 内容 | 提议 owner |
|---|---|---|
| D1 | `SessionRow` 扩展 + publish 点核查补齐 + `deriveBoardColumn` 纯函数 + 单测 | claude |
| D2 | 前端 board 渲染 + 切换持久化 + CSS + mock 截图 | codex |
| R | 互相 review 对方的块 | both |

接口契约：D1 先落 `deriveBoardColumn` 的类型签名和 SessionRow 字段（本文 §2§3 即契约），D2 可并行开工（先用假数据渲染）。

## 6. 验收

- [ ] board/table 可切换且偏好持久化
- [ ] 等选仓库、TUI 卡挂起、limited 的会话出现在 needs-you 列，且字段变化后 5s 内移列
- [ ] 列计数正确；closed 不出现在 board
- [ ] `pnpm build` + 现有 dashboard 测试不挂；deriveBoardColumn 有单测
- [ ] mock/实跑截图发话题，老滕过目
