# 项目进度卡（botmux project）

在普通群里推进一个多步骤项目时，主控 Bot 可以用 `botmux project` 维护一张**置顶的项目进度卡**：目标、当前在做什么、待办、阻塞、里程碑、各子任务的状态，都集中在这一张卡上，并且**原地更新**，不会刷屏。

- 项目状态存在本机，不依赖聊天记录。卡片被撤回了，下一次更新会重新发一张并置顶。
- 主控用 `botmux dispatch` 派出去的子任务会**自动登记**到卡上；子任务 Bot 用 `botmux report` 回报的进展也会**自动同步**到同一张卡。
- 一个群只有一个项目、一张卡。

> 这些命令通常由 AI 自己调用。你在群里跟主控 Bot 说「启动 ×× 项目」「把阻塞记一下」，它就会去执行对应命令。下面的命令说明主要帮你看懂它在做什么，需要时也可以直接让它执行某条。

## 什么时候用它

| 你的需求 | 用什么 |
|---|---|
| 一个项目要推进好几天、拆给多个 Bot，想让群里所有人一眼看到进度 | 项目进度卡（本页） |
| 只想把大任务拆成子话题并行做，进度看飞书任务清单就够了 | [多话题协作](/multi-topic) |
| 有边界的多步任务，跑完出一份交付物 | [Workflow](/workflow) |

两者可以叠加：群里已经有项目时，多话题协作派出去的子任务会同时出现在进度卡的「子任务状态」里。

## 一分钟上手

1. 在普通群的**群消息顶层**（不是某个话题里）@ 你想让它当主控的 Bot：

   ```text
   @机器人 /project enable
   ```

   这个 Bot 成为**主控**，群里其它由本机 botmux 管理的 Bot 自动成为 **Worker**（可被派活的 Bot）。群里会置顶一张「项目群已就绪」的指引卡。只有 Bot 的 owner / `allowedUsers` 能执行这条命令。

2. 还是在群顶层 @ 主控，说你想做什么：

   ```text
   @机器人 启动「官网改版」项目，目标是两周内上线新首页，请拆解并推进。
   ```

   目标还不清楚也没关系，可以先说「我想讨论……，先帮我澄清问题和下一步」。讨论本身就是项目的一个阶段。

3. 主控立项后，会在当前位置发一张新的**项目进度卡**并置顶，原来的指引卡改成「项目已启动」并取消置顶。之后所有进展都更新在这张卡上。

> 不启用项目群模式也能用 `botmux project`，只要是在普通群顶层的会话里（用 `/project disable` 退出过、或在 Dashboard 设成「普通群」的群除外）。启用后多了两件事：主控每一轮都会收到「维护项目状态」的固定规则（读状态 → 有变化就更新 → 汇报前核对卡片），以及派活范围被限制在 Worker 名单内（见下文「项目群模式下的派活规则」）。`/project` 的完整用法见 [斜杠命令](/slash-commands)。

## 卡片上有什么

| 区域 | 内容 | 来自哪里 |
|---|---|---|
| 标题栏 | 项目名 + 状态标签：进行中 / 已完成 | `init --title`、`close`、`resume` |
| 目标 | 项目目标 | `init --goal` / `update --goal` |
| 当前推进 | 主控此刻在做什么 | `--focus` |
| 推进概况 | 例如「1 项阻塞 · 2 项进行中 · 3 项已完成」 | 由子任务状态自动算 |
| 进行中 / 待办计划 / 完成记录 | 子任务分组列出，带「进入话题」链接；待办里也会列出 `--remaining` 写的事项 | 子任务 + `--remaining` |
| 待决策 / 阻塞 | 编号列出所有阻塞 | `--blocker`，以及子任务回报为阻塞时的内容 |
| 子任务状态 | 每个子任务的名称、说明、负责人、状态、话题入口 | `botmux dispatch` / `botmux report` |
| 最近里程碑 | 最近 3 条里程碑和「下一节点」，默认折叠 | `--milestone`、`--next-milestone` |

子任务状态有五种：未开始、进行中、阻塞、已完成、失败。卡片上阻塞的排最前，已完成的排最后。

上表是默认的「状态看板」模板。换成「紧凑清单」模板后（见下文「在 Dashboard 调整」），中间几块会合并成一行摘要（推进概况 · 阶段 · 下一步），子任务改成一行一个的清单。

## 常用操作：想做 X → 这样做

| 想做什么 | 命令 |
|---|---|
| 建项目 | `botmux project init --title "官网改版" --goal "两周内上线新首页"` |
| 看当前状态 | `botmux project status` |
| 改阶段 / 当前焦点 | `botmux project update --phase "开发" --focus "联调首页接口"` |
| 记一个整体完成度 | `botmux project update --progress 40` |
| 写下还剩哪些事 | `botmux project update --remaining "接口联调；移动端适配；上线检查"` |
| 记一个阻塞 | `botmux project update --blocker "等设计确认首屏配色"` |
| 阻塞解决了 | `botmux project update --clear-blockers` |
| 记一个里程碑 | `botmux project update --milestone "首页设计稿定稿"` |
| 写下一个节点 | `botmux project update --next-milestone "周五提测"` |
| 项目完成 | `botmux project close --milestone "新首页已上线"` |
| 完成后又要继续 | `botmux project resume --phase "二期" --focus "补齐埋点"` |

## 完整示例：从立项到收尾

下面是主控 Bot 在一个项目里会依次执行的命令（你只需要在群里跟它说话）：

```bash
# 1. 立项：只有标题和目标是必填的
botmux project init --title "官网改版" --goal "两周内上线新首页" \
  --phase "规划" --focus "拆解需求并派发首批子任务"

# 2. 派活：每个子任务开一个子话题，并自动登记到进度卡（标题必须具体，最多 24 个字）
botmux dispatch ...   # 例如派给前端 Bot「首页前端开发」、派给测试 Bot「首页回归测试」

# 3. 推进中：阶段变了、有了新阻塞，及时更新
botmux project update --phase "开发" --focus "联调首页接口" \
  --remaining "移动端适配；上线检查" --blocker "等设计确认首屏配色"

# 4. 子任务 Bot 在自己的话题里回报，进度卡自动同步
botmux report "首页前端开发完成，预览地址见话题" --status completed

# 5. 阻塞解决、到达里程碑
botmux project update --clear-blockers --milestone "首页开发完成" --next-milestone "周五上线"

# 6. 收尾
botmux project close --milestone "新首页已上线"
```

`close` 之后卡片变成绿色「已完成」：整体完成度记为 100，阶段写成「已完成」，阻塞清空，待办写成「无」。如果后来还要接着做，`resume` 会把状态改回「进行中」。

## 命令参考

细节以 `botmux project --help` 为准。

### init：建项目

```bash
botmux project init --title <项目名> --goal <目标> [--phase <阶段>] [--focus <当前焦点>]
```

- `--title`、`--goal` 必填。
- `--phase` 不写默认是「规划」，`--focus` 不写默认是「拆解并派发首批子任务」。
- 一个群只能有一个项目。已经建过再 `init` 会报错，要继续推进请用 `update` 或 `resume`。

### status：查看状态

```bash
botmux project status
```

输出项目的完整状态（JSON），包括目标、阶段、阻塞、里程碑和每个子任务。

### update：更新

```bash
botmux project update [选项…]
```

至少要带一个选项：

| 选项 | 作用 |
|---|---|
| `--goal <目标>` | 改目标 |
| `--phase <阶段>` | 改阶段，例如「规划」「开发」「验收」 |
| `--focus <当前焦点>` | 改「当前推进」 |
| `--progress <0-100>` | 记录整体完成度，必须是 0–100 的整数。这个数字只记在项目状态里（`status` 能看到），卡片上目前不显示 |
| `--remaining <待完成>` | 写下还剩哪些事，**覆盖**上一次写的内容。用 `；` `;` `·` 或换行分隔多项，只取前 5 项放进卡片「待办计划」 |
| `--blocker <阻塞>` | **追加**一条阻塞（重复的不会加两次） |
| `--clear-blockers` | 清空所有阻塞 |
| `--milestone <里程碑>` | **追加**一条已完成的里程碑 |
| `--next-milestone <下一节点>` | 设置下一个节点，显示在里程碑栏标题上 |
| `--clear-next-milestone` | 清掉下一个节点 |

`--clear-blockers` 和 `--blocker` 可以一起用：先清空，再记新的。

### close：收尾

```bash
botmux project close [--milestone <完成说明>]
```

不写 `--milestone` 时记一条「项目完成」。

### resume：重新开始推进

```bash
botmux project resume [--phase <阶段>] [--focus <当前焦点>]
```

状态改回「进行中」。不写时阶段默认「继续推进」，焦点默认「恢复项目推进」。

### 通用选项

- `--json`：输出完整状态，而不是简短结果。
- `--session-id <id>`：指定主控会话。在会话里运行时会自动识别，一般不用写。

## 子任务怎么同步到卡上

```
主控 botmux dispatch ──► 开子话题、派给 Worker ──► 卡上新增一行子任务
                                                     │
Worker 在子话题里 botmux report --status ... ────────► 这一行更新状态 / 回报内容
```

- **dispatch**：每派一个子任务，卡上就多一行，带子话题的「进入话题」链接和负责的 Bot。Worker 已接单就是「进行中」，只是待命（还没发任务）是「未开始」，派发没被接收会标成「阻塞」。
- **report**：Worker 回报时可以带上这些选项，同步到对应那一行：

  | 选项 | 作用 |
  |---|---|
  | `--status` | `pending`（未开始）/ `in_progress`（进行中）/ `blocked`（阻塞）/ `completed`（已完成）/ `failed`（失败）。不写默认算「进行中」 |
  | `--progress <0-100>` | 这个子任务的完成度 |
  | `--remaining <text>` | 这个子任务还剩什么 |
  | `--milestone <text>` | 给项目追加一条里程碑 |

- 回报 `--status blocked` 时，回报内容会自动进入卡上的「待决策 / 阻塞」；之后再回报成别的状态，这条阻塞会自动移除。
- 子任务做完要明确带上 `--status completed`，卡片不会根据回报内容自己猜是否完成。

`dispatch` / `report` 的完整用法见 [多话题协作](/multi-topic)。

## 项目群模式下的派活规则

启用 `/project enable` 后，为了让卡片和实际分工保持一致，派活有几条限制：

- 只有主控 Bot 能派活，而且只能在本群顶层的会话里派。
- 只能派给本群的 Worker，不能派到别的群。
- 每个新子任务都要有具体标题，最多 24 个字，不能只叫「子任务」「子项目」。

Worker 名单默认「自动纳入新 Bot」：之后新进群、由同一个 botmux 管理的 Bot 会自动成为 Worker。想严格控制名单，可以在 Dashboard 关掉这个开关。

## 在 Dashboard 调整

打开 Dashboard → 群组管理 → 某个群的「管理」→「协作模式」（见 [Dashboard](/dashboard)）：

- 切换普通群 / 项目群，选择主控 Bot 和可派发的 Worker。
- **进度卡展示**：选模板「状态看板」（带子任务表，适合持续盯）或「紧凑清单」（纵向摘要，适合手机看）；勾选要显示的模块（目标、阻塞 / 决策、子任务与话题入口、里程碑）；设置里程碑默认是否展开。保存后当前卡片会立即刷新。
- 「当前项目（只读）」显示项目状态和子任务完成数。

这里只管卡片**怎么展示**，目标、进度这些内容还是在群里由主控维护。各 Agent 在群里的职责可以用 `@机器人 /project roles` 或 [角色](/roles) 配置。

## 常见问题

**提示「project 模式只能在普通群的 chat-scope 主控会话中使用」**
`botmux project` 只在**普通群顶层**的会话里可用。私聊、话题群、普通群里的某个子话题都不行。请回到群消息顶层 @ 主控。

**提示 `project_mode_disabled`**
这个群被明确设成了「普通群」：在 Dashboard 里选了普通群，或者执行过 `/project disable`。项目命令因此被关掉。在 Dashboard 改回「项目群」，或发 `@机器人 /project enable`。

**提示 `project_coordinator_required`**
这个群的主控是另一个 Bot。请 @ 正确的主控，或由原主控先 `/project disable`。

**提示 `project_already_exists`**
本群已经有项目了。用 `update` 继续推进；项目已关闭的话用 `resume`。

**有人把进度卡撤回了**
项目数据不会丢。下一次 `update`（或子任务回报）时会重新发一张卡并置顶。

**退出项目群模式，项目还在吗？**
在。`/project disable` 只会退出模式，项目状态和进度卡都会保留。不过退出后 `botmux project` 命令会被拒绝（报 `project_mode_disabled`），卡片也不再更新；用同一个主控重新 `/project enable` 后就能接着用。
