# 命令路由器：为什么这么改、好在哪、代价是什么

给要评审 `feat/command_op` 这组改动、或半年后回来问"当初为什么"的人看的一页纸。技术细节与决策记录在 [设计文档](./2026-09-11-command-router.md)（§1 决策、§15 逐期执行记录与复审修正），这里只讲动机、形状与取舍。

## 1. 起点：一条命令行被拒，背后是十一层判定

直接动因很小：`/t /repo wt botmux ci/temp_split /model sonnet[1m] 任务` 这一行在飞书里被拒。要让它过，得让头部指令吃一个**可选参数**——而话题指令头（#1361）刻意把每条指令定成单 token，因为解析器只能靠固定 arity 找到正文起点。

把这个小问题往下挖，看到的是：一条 `/xxx` 消息进 daemon 之后要过 **11 层判定**（`/summary` 正则、免@ 触发、指令头、模板渲染、监听器、v3 workflow 两层、`parseSlashCommandInvocation`、五条逐个 `if (cmd === '/xxx')`、透传集、38 个 `case` 的大 switch），至少 4 个各自为政的参数解析器，命令的"注册"是五个手写集合，两条入口（新话题 / thread）各抄一份且已经不一致（thread 里 `/card` `/cot` 会为无会话的消息预建一条幽灵会话）。每次加命令都要在三四处手抄，`/repo wt` 的用法串和帮助行已经互相矛盾。

## 2. 改法：分类 → 解析 → 计划 → 执行，前三段是纯函数

系统是 `飞书 ↔ [切面 1] ↔ botmux 运行时 ↔ [切面 2] ↔ coding agent`。这次改的全部落在两个切面之间，两个切面的协议一个字都没动：进来的仍是飞书事件 + bot 配置，出去的仍是 fork 参数 / `raw_input` / 正文 / 飞书回复。这决定了它能被彻底测试。

三期，各自一个收口 commit，可独立回滚：

| 期 | 做了什么 | 语义变化 |
|---|---|---|
| PR-1 头部 `/repo wt` | 可选分支只在"下一个 token 像分支名且同一行"时才吃；分支名走 `git check-ref-format`（仓库此前没有任何分支名校验）；目标目录预先算出并与 `createRepoWorktree` 用测试钉成逐字一致；复用 auto-worktree 的 pre-fork 路径，失败 fail closed | 只扩宽（原先被拒） |
| PR-2 统一路由器 | `command-schema.ts` 一张表（36 条命令：别名、会话政策、前置特判、多行豁免、help 键），五个集合从表推导；`session-phase.ts` 由现有旗标推导相位；`command-router.ts` 一个纯函数 `classifySlash` 接管两条入口的判定，执行代码一行不动 | 零变化（唯一例外：thread 入口 `/card` `/cot` 不再预建幽灵会话，登记在案） |
| PR-3 runtime 级联 | 会话内「透传命令行 ⏎ … ⏎ 正文」按书写顺序逐条送出，每条之间等 CLI 空闲；riff/mojo/adopt fail closed | 唯一的语义变化：今天这种消息被整条当讨论文本转发 |

## 3. 好在哪

- **可以穷举地证明"没改坏"**。老判定被逐字冻结成一个零 `src` import 的 oracle，新路由器与它在 ≈269 万组输入（23 个符号 × 长度 ≤3 × 两种分隔符 × 两条入口 × 8 个相位 × 3 种透传配置 × 2 种发送方）上逐字差分，Bun 下 1.2 秒。任何改动要么差分全绿，要么在 INTENTIONAL 名单里有一条对应 §9 有意变化表的规则——"回归"与"有意变化"从此是机械判定，不是评审时的感觉。今天名单里只有两条。
- **加命令只改一处**。schema 一行 + `handleCommand` 一个 case；集合从表推导、前置特判从表读、`/help` 键双语齐全由测试守着、switch 与表互相覆盖由测试守着。两条入口共读同一张表，"thread 里少一条特判"这种漂移在结构上没法再发生。
- **执行零风险的重构**。PR-2 的分类替换只碰"判定"，执行段（授权闸、预建会话、冷启动、透传投递、排队激活闸）原样保留，22 个既有路由层测试一字未改通过。
- **状态由已有事实推导，不加持久化**。相位来自 `DaemonSession` 的运行旗标与 `Session` 上本就落盘的状态；唯一新增的是内存态 `cliReady`（worker 的 `prompt_ready` 置位）。回滚 = 装回上一版，没有数据迁移。
- **头部 wt 的每一步失败都有确定落点**。能提前查的（目标、分支名、目录已存在）全部在开话题前拒绝、零副作用；git 运行期失败停在 `pendingRepo` 并告诉用户下一步；daemon 重启窗口内回到选仓卡。

## 4. 代价与诚实的差距

- **两轮对抗性复审各挖出十来条问题**，都已修（见设计文档 §15「复审修正」）：最重的是接线时 grant 限制闸丢掉了对未注册 `/xxx` 的覆盖、级联 detached 之后没有互斥、空闲判据把限流当空闲。这类问题的共性是"执行段的隐含前提没有写成数据"——路由器把判定收拢了，但执行段的两条入口仍各一份约 240 行。
- **schema 只兑现了一半**：集合、特判、help 键从表来；参数形状字段还没有消费者，`/help` 与用法串仍是手写。
- **相位矩阵没有落成数据**：路由决策里只用了"有没有会话"和"有没有活 worker"两个谓词，§5 那张表现在是文档不是代码；`worktreeCreating` / `queued` 两格写的"拒"不是今天的行为。
- **级联的时序只在假 worker 上验过**：判"瞬时命令已完成"靠 3 秒忙态宽限窗，真实 CLI 上还没肉眼看过；中间条目用派生 turn id，`botmux send` 在那几秒内的归属校验不成立。
- **oracle 会累积**：每条有意变化多一条规则；建议 PR-3 稳定一个版本后把 oracle 重新冻结为发布基线。

## 5. 怎么验证、怎么扩展

- 验证：`bun run build`；`bun run vitest run test/command-schema.test.ts test/command-router-oracle-diff.test.ts test/legacy-oracle test/daemon-rename-route.test.ts test/topic-directive-header.test.ts`；全量单测与 master 基线一致（红的只有环境相关的 e2e）。真实 CLI 时序按设计文档 §10 手动项 dogfood。
- 加一条 daemon 命令：`command-schema.ts` 加一行 → `handleCommand` 加 case → 两个测试红了照着改 → 改 `slash-commands.md`（doc-sync 守卫会提醒）。
- 改路由判定：差分红了先判断是回归还是有意变化；有意变化同时写进 `INTENTIONAL` 名单与设计文档 §9，不要改 oracle。

## 6. 2026-09-16 更新：rebase 到主干后又收了两口

分支 rebase 到 dc7b4e63（40 个主干提交）。语义化合并里最重要的一条：主干 #956 已经把 `/tw` 做成了
"force + 显式分支 + 落盘可恢复"的建 worktree 机制，本分支自己那份更弱的头部 worktree 腿被删掉、改为
复用它——头部 `/repo wt` 从此重启可恢复。合并后顺手把主干散在入口里的 `/th` `/tw` `/t here|worktree`
正则预判收进了指令头解析器（解析只有一处），`/tw /repo x` 这种相斥组合由静默丢 `/repo` 改为拒绝；
schema 里没有消费者的 `argShape` / `subcommands` 删掉了——一张表只说它守得住的话。理想终态的六条
与到达路径见设计文档 §16。

