# 上下文

## 背景知识

- 现有 `evaluateMessageListener` 已在 `explicitlyMentionedThisBot=true` 时拒绝 listener 匹配，这是 @ 路由不可被 Subject 截获的基础。
- 现有 listener 默认要求非空 `prompt`，按命中消息创建 per-message thread session；新模式必须保持缺省行为完全兼容。
- `listChatMessagesUntil` 已支持按飞书聊天倒序分页并由调用方决定停止位置；`BOTMUX_NOTHING_TO_SEND` 已有 worker 正向终态信号。
- `botmux history` 的数据来自飞书，但当前通过 CLI session 解析 chat/thread；Subject 需要由受信事件直接绑定 Bot、群和触发消息，不以 CLI session 为事实源。
- 飞书群名、群描述、历史消息、卡片和旧指令全部是不可信业务数据；只有 Subject 协议和管理员配置是可信指令。
- 同一 Bot + 群的 Subject 读取/处理必须有序；游标与现有 `claimMessageOnce` 分工：前者保证上下文连续性，后者只做入站幂等。

## 路径约定

- plan_root: `.plan/subject-listener`
- unit_tests: `test/**/*.test.ts`
- e2e_tests: `test/**/*.e2e.ts`
- docs: `README.md` 与 Dashboard 内联说明
- tsconfig: `tsconfig.json`、`tsconfig.scripts.json`

## 用户需求记录

- “bot 更像是一个 cli 工具，而不是更像人”。
- “先看一下是什么群，在和谁说话，确定一下要做什么”。
- “如果是被 @ 那么一定要回复……如果是没有被 @ 的监听场景，可以融入这个 subject 体系”。
- “subject 还需要有一个能力，就是基于飞书的对话记录了解上下文，而不是基于 cli 的 session”。
- “消息读取的约束应该是，读取到上一次读取过的位置，但是用 N 条消息兜底”。
- 用户最终要求：“按照我们刚才商量的落实”。

## 已确认的行为边界

1. `behavior` 缺省等价于旧 `prompt` listener；启用旧模式仍要求非空 prompt。
2. `behavior: "subject"` 确定性加载内置 Subject Skill，prompt 仅是可选群级关注范围。
3. Subject 只接收未明确 @ 当前 Bot 的顶层群消息；明确 @、权限申请及普通会话逻辑不变。
4. Subject 自动读取飞书快照：从触发消息向前到已提交游标；无游标或游标不可恢复时回退 `fallbackMessages` 条，默认 20，并标记连续性。
5. 快照上界固定为触发消息；事件原文补入并按 message id 去重，避免飞书列表可见性延迟或读到后续消息。
6. 可见回复成功送达或明确静默终态才提交单调游标；失败不推进。
7. 无需介入时不发消息、不发状态卡、不加处理 reaction；需要介入时允许 `botmux send`、handoff、workflow、schedule 等现有能力。
8. Subject 的 CLI 执行可以是一次性 session；不得以 CLI transcript 补齐飞书上下文。

## R-4 架构决策

- Subject 继续是“主体层 Skill”：协议规定它先理解群、发送者和飞书历史，再决定静默、回复、执行或路由；现有 CLI 仍是思考与本地操作工具。
- 新增稳定的 `src/services/subject-listener-protocol.ts`，只拥有可信 Subject 协议与必要的最小协议类型，不依赖 Skill catalog、daemon、Lark client 或 worker。
- `src/skills/definitions.ts` 与 `src/services/message-listener.ts` 都单向依赖协议模块；service 不再反向导入整份 Skill definitions。
- 新增 `src/services/subject-listener-turn.ts`，导出 `prepareSubjectListenerTurn(input, dependencies)` 与 `PreparedSubjectListenerTurn`。该边界集中校验精确群消息 trigger，解析发送者，读取群资料与持久化游标，加载截止 trigger 的飞书快照，并生成首轮 prompt。
- 网络与持久化入口以最小依赖注入：发送者解析、群资料读取、游标读取与飞书消息扫描均由 daemon 传入现有实现；快照与 prompt 仍复用既有 Subject context/renderer。
- `PreparedSubjectListenerTurn` 至少返回 `prompt`、`chatContext`、`resolvedSender` 与 `candidateCursor`，供 daemon 继续写入现有 `DaemonSession` 并注册现有 completion。
- dispatcher 仍只负责匹配/FIFO/Subject 路由；daemon 仍负责 admission、工作目录与 session 创建、调用 turn 准备和注册 completion；worker-pool 仍负责回复/静默终态与游标提交。
- 这是职责拆分，不引入第二套 runtime、session、framework 或公共配置，也不改变 @、legacy listener、Pty/Tmux、CLI/handoff/workflow/schedule 行为。

## 不做范围

- 不改变普通 @、私聊、已有 topic 回复和 legacy prompt listener 的语义。
- 不开放任意 `--chat-id` 历史读取能力。
- 不新增其它 IM 的 Subject 数据源；`source` 当前只接受 `lark`。
- 不自动切换 live daemon；最终是否部署本 checkout 由主代理按验证需要决定。

## 修订历史

| 日期 | 修改内容 | 对 scope 的影响 |
| --- | --- | --- |
| 2026-09-04 | 根据连续讨论固定 Subject、@、飞书上下文和游标契约 | 分为运行时与配置界面两个 sprint |
| 2026-09-04 | Sprint 001 复评固定同 createTime 游标规则：无顺序证据时保留现有游标 | 只收紧游标单调性，不改变上下文或路由 scope |
| 2026-09-04 | Sprint 002 验收确认 Subject/legacy 配置 round-trip、非法写入阻断与试运行只读游标 | 完成 Dashboard/API 入口，不改变 Sprint 001 运行时契约 |
| 2026-09-04 | 用户确认 R-4：独立可信协议所有权并提取 Subject turn 准备边界 | 新增 Sprint 003，仅做职责拆分，不处理其它 review 项 |
| 2026-09-04 | Sprint 003 验收通过：协议与现场准备职责完成拆分 | 保持现有 CLI/session/worker 执行链与公共配置不变 |
