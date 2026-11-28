# TRAE 输入框已恢复，但后续消息持续暂存

## 现象与失败边界

TRAE 已完成当前轮次，终端也显示正常输入框，但 Botmux 仍暂存新的话题消息或 `/compact`。另一个触发方式是消息写入 PTY 后没有收到精确提交回执：Botmux 发出一次提交未确认通知，之后持续检查，同时把后续消息挡在输入隔离后。

两种情况都需要区分输入保护是否仍有实际依据。普通输入框不能证明一个尚未绘制的提问页面已经消失；终端重绘也不能证明某条消息已进入模型。

## 旧 question 状态的回收

TRAE 的异步问题可以在主轮次结束后保留 `blocked kind=question` 子记录。Worker 原先将这个状态与屏幕上的提问页用 OR 合并，因此没有真正提问页时也会一直阻塞。

恢复需要同时满足：

- 当前所有已观察到的 TRAE 原生 open turn 都已结束，没有仍在执行的前驱或后继轮次；跨 drain 的 `turn_bind` 与逆序 final 也必须完成归属和收口。
- 完成证据和最近程序状态报告都已经过静默窗口。
- 新鲜、权威的当前终端屏幕显示已初始化的空输入框，没有实际提问页、忙碌标记或待执行输入面板。同步热路径只用 backend 原生的同步 capture；PTY 则在 `writeAndFlush` 后的异步 capture 中回收，并复验 backend、lifetime、generation 与 hold revision，未 settle 的 renderer fallback 不能作为释放依据。
- 所有剩余 blocked 记录都是 question；permission、approval、未知阻塞、活跃子任务与被淘汰的未知 busy 记录仍保留保护。

完成证据来自结构化桥接器。普通 `fireIdle()`、屏幕静默和输入提交超时都不提供这项证明。新的原生 user、新输入周期以及任何新的 working / blocked 报告都会使旧完成证据失效。

实现入口：`IdleDetector.noteTranscriptTerminal()`、`IdleDetector.releaseStaleQuestionStatus()` 和 worker 的 `traexQuestionBlockReported()`。真实提问页仍通过现有 question bridge 与卡片处理，恢复不会替用户作答。

`TraexTurnCompletionTracker` 跟踪所有尚未终结的原生 turn，包括没有 Botmux queue mark 的真人终端输入，并消费 parser 的 `turn_bind` 为 legacy id-less user 补上归属。完成证明绑定原生 session / turn、记录时间及 UUID / rawId 去重；旧 final 重读、已关闭轮次的 user 镜像和同一 drain 中已开启的后继 user 都不能退休新的 question。多个 type-ahead turn 逆序完成时，只有最后一个 open turn 终结才产生完成证据，空 drain 不会重复发出旧证据。

## 未确认输入的隔离解除

TRAE 适配器提供 `screenShowsNoPendingInput`，供已有的精确回执观察流程使用。判定复用 `traexRestoredComposerReady(..., { requireThreadReady: true })` 的严格初始化条件和空 composer 检查，支持长 cwd 在 Context 前截断及有初始化内容佐证的 hint-only footer，同时拒绝尚未初始化的 shortcut-only 页面、草稿、忙碌状态、提问页、原生待执行输入。窄视口下折成多行的待执行面板头及其可识别片段一律 fail closed。

新版 TRAE 收起的异步问题会同时显示普通 composer 和 `? N questions` / 回答快捷键。这仍是待答状态，不能当作无待执行输入；保留 question 状态才能由原生问题桥接打开相应飞书卡片。

这些结构判定使用保留列间距的 PTY 屏幕。普通展示清理会把草稿续行的两个前导空格折成一个，导致长待执行输入面板的边界丢失。TRAE 恢复路径显式请求 `preserveFormatting`；其他消费者的默认采集行为保持原样。

原有隔离流程继续绑定具体 backend、CLI generation、turn 与 dispatch attempt。只有连续两次有效空输入框观察，或精确归属到该会话的晚到提交回执，才能解除隔离。恢复释放后续消息，不自动重发原来结果未知的消息。

晚到回执与普通确认链的归属保持原样：桥接 mark 仍有效时由原链处理；mark 结算后，由只读观察器继续核验。操作员编辑输入、CLI 更换或重启时，过期回调不能落到新一代输入上。

## 跨库巡检的非会话数据库

未注册的合约探针可能在 `session-stores/<namespace>/sessions.db` 下留下只有 contracts、entities、runtime_bindings 的数据库。对所有文件直接查询 sessions 会让整个巡检因缺表跳过。

跨库巡检只忽略表、列和索引匹配真实合约创建 schema、且不属于当前注册机器人的纯合约库；兼容尚未引入 `contract_execution_turns` 性能索引的完整旧格式。额外备份表、迁移中断、缺失列或其他索引都不会被忽略。有效的已移除机器人会话库仍纳入保护；已注册机器人的 sessions 表缺失、损坏库和未知格式仍使巡检失败，避免把不完整清单用于清理。

## 回归入口

- `test/traex-turn-completion.test.ts`：id-less user 的跨 drain `turn_bind`、raw line 去重，以及三个 type-ahead turn 按 2 → 3 → 1 完成后才产生一次完成证据。
- `test/worker-bridge-final-idle-signal.test.ts`：真实 queue 的逆序 final 接线，最后一个 open turn 终结后直接记录完成，空 drain 不依赖额外新 turn。
- `test/stale-program-status.test.ts`：完成证据、静默窗口、新输入和并发 permission / approval 保护。
- `test/traex-question-hold-wiring.test.ts`：新鲜屏幕与缓存帧不同、真实提问页保留阻塞、正常 composer 释放旧状态；PTY 未 settle 的 renderer 不同步释放，flush 后仍是提问页也不释放，只有空 composer 的异步 capture 才回收，并覆盖 await 中五类身份变化。
- `test/traex-parked-submit-recovery.test.ts`：两次空屏恢复、草稿在中途重现、原输入不会重放、40 列真实 xterm 折行面板、严格初始化 footer 变体与 provisional shortcut-only 拒绝。
- `test/worker-quarantine-late-receipt.test.ts`：晚到回执、代次变化与恢复边界。
- `test/session-store-sqlite.test.ts`：纯合约库、注册机器人缺表与有效遗留会话库的区别。

真实 worker 的问答页与晚到回执集成用例分别在 `test/worker-traex-question-page.integration.test.ts` 和 `test/traex-quarantine-late-receipt.repro.integration.test.ts`。临时探针必须通过仓库的 `scripts/fenced-run.ts`，保护真实 HOME、systemd 与 fleet tmux。
