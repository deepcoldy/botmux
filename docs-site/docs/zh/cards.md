# 实时流式卡片

## 一轮一张答复卡（试用）

Dashboard → 机器人默认设置 → 卡片 → **回答展示方式**提供两个选项：

| 模式 | 行为 |
| --- | --- |
| 默认模式 | 保持原有独立状态卡、CoT 和普通发送行为；现有机器人默认使用此模式 |
| 动态单卡模式 | 同一轮的进度、执行过程、Ask 提问和最终答复原地更新；下一轮创建新卡，上一轮答复保留 |

动态单卡支持**未启用文件沙盒**的 Claude Code / Codex 普通飞书对话，包括普通群和话题。模式从**下一轮**生效。可由管理员执行 `/botconfig set replyCardMode unified` 开启，`/botconfig set replyCardMode legacy` 恢复默认模式。

文件沙盒会话（含旧版 `readIsolation`、全局 `BOTMUX_SANDBOX=1`）暂时沿用默认模式，`send`、CoT 和 Ask 保持原交付方式。即使机器人配置为动态单卡，也不会为这些会话创建动态答复卡。沙盒状态以会话和 Worker 已冻结的配置为准；修改机器人沙盒开关不会改变正在运行的会话。当前实现需要多个进程共享卡片记录与文件锁，不能为此开放整个记录目录的写权限。

**显示独立状态卡**是两种模式共用的独立开关，默认开启。开启时额外显示带终端截图和会话控制的状态卡；关闭时不自动发送或更新这张状态卡，动态答复卡里的进度、工具调用和最终答复照常更新。只想一轮一张答复卡时，选择动态单卡模式并关闭这个开关。切换回答模式会保留开关值。`disableStreamingCard` 或本群 `/card off` 仅关闭独立状态卡；`/card on` 只清除群级关闭设置，机器人级关闭仍有效。

旧版 `final-only` 配置会兼容为“动态单卡、独立状态卡关闭”，不再作为独立模式提供。新轮次持续更新答复卡；升级前已经接受的轮次保留原投递状态，以便恢复。

- 执行中显示状态、耗时和当前步骤；“展示执行过程”按接收顺序保留 CLI 已输出的思考文本或摘要、工具调用、公开进度与问答记录，结束后折叠。沿用 `thinkingCard`、`thinkingCardToolResult`、`/cot`，无需增加开关。关闭执行过程后，公开进度和问答记录仍保留；CLI 未输出的内部思考无法展示。
- 状态以 💭 处理中、✅ 已完成、❌ 执行失败等图标区分；工具调用按命令、读写、搜索等类型显示图标，完成的工具保留 ✓ 标记。过程默认收在带 📋 图标、调用次数和浅灰背景的折叠区中。
- 执行过程没有固定条数或独立字节配额，整卡未超限时完整展示。按[飞书卡片更新接口](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch)的 30 KB 限制计算整卡发送体积（含 JSON 转义和回调信息），超限时才截断过程，并优先保留最终答复和待回答问题。工具与文字各保留最近记录，出现省略时明确提示并标明已展示的工具数；仅过程超限不会额外发送附件。本地已接收的记录不因展示截断而删除，不提供额外的完整过程页面。
- 答复卡使用飞书的 `width_mode: fill`，宽度随聊天窗口自适应。飞书还提供默认宽度（桌面端上限 600px）和紧凑宽度（400px），没有按文字长度自动收缩的卡片宽度选项；这些是客户端宽度模式，不是任意像素宽度。参见[飞书卡片 JSON 2.0 配置](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure)。
- `botmux send` 默认为进度，结束时用 `botmux send --response-kind final "完整答复"`。多次发送可能返回同一个 `messageId`。需要每次都有独立消息 ID 的脚本使用默认模式或 `--response-kind auxiliary`。
- 未标记为 `final` 的发送只作为本轮记录，不能抑制尚未送达的最终答复。已明确发送的最终答复不会被后来的终端总结重复覆盖。
- 停止按钮沿用原有管理员权限，校验回合与消息 ID；旧卡片不能停止新任务。Codex RPC 输入模式仍不提供这个按钮。
- 自动显示或 `/card` 手动打开的独立状态卡继续提供终端截图与会话控制。原自动置顶只管理这些状态卡；首版不自动置顶答复卡。反馈继续使用现有反馈策略和按钮。
- 回复并 @ 本轮真人提问者（`--mention-back` 或显式指定该提问者）仍更新同一卡片。通知其他对象、回复机器人或无法确认的身份、独立审批、自定义卡片、手动 CardKit 流、跨会话投递和辅助通知保持独立。图片和附件沿用原交付方式。
- 同轮 `botmux ask` 与 Claude Code / Codex 的 Ask hook 使用原答复卡：问题和选项展开显示，标题提示“等待你确认”；回答、超时或失效后收进执行过程。多个请求依次展示，不覆盖未回答的问题。多选、空提交二次确认、文字答复和 Dashboard 作答沿用原 broker；关闭执行过程不隐藏待回答的问题。
- Ask 只绑定 daemon 已确认运行的同一轮、同一应用和会话。为完整保留题目与选项，超过 16 个选项或问题 JSON 超过 3000 UTF-8 字节的问卷保留独立卡。原审批/授权、跨对象通知不自动并入公开答复卡。待确认提醒的通知效果需在飞书客户端实测，普通卡片更新不等价于新消息通知。
- 文件沙盒、API-only、非飞书、远程 Riff/Mojo、adopt、本地终端同步、文档评论、VC、定时任务和 v3 工作流保持原交付路径。
- 首版使用普通同卡 PATCH，不启用逐字动画。超长完整答复转为 Markdown 附件并在卡片中提示；卡片撤回后不自动重建。网络失败重试复用原卡片与发送幂等键；结果不确定且已超出自动重试窗口时，命令会明确报错。

## 终端状态卡

每轮对话生成一张实时更新的飞书卡片，是你在手机/飞书上**感知并操控 CLI** 的主窗口。

![实时流式卡片](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780419090587_img_v3_0212a_553ca347-4a93-491f-a2ef-30d00a374cdg.jpg)

- **终端画面实时截图刷新到卡片**：xterm 无头渲染成图，**原样还原 CLI 的 TUI**（边框、配色都在），不再把输出转成 Markdown。可一键「显示 / 隐藏输出」「导出文字」「上 / 下半屏」。
- **状态实时指示**：卡片头部颜色即状态（飞书卡片 template，不是正文里的 emoji 圆点）——**启动中…**（黄）→ **工作中**（蓝）→ **等待输入**（绿）；额度用满标 **限额已达**（红），可重试时变 **可重试**（绿）。
- **卡片上直接操作**：打开 Web 终端、🔑 获取操作链接、关闭会话，额度可重试时还有「🔁 重发上一条任务」。
- **每轮一张新卡片**：上一轮卡片冻结存档，对话历史清晰可回溯；会话用 [`/relay`](/relay) 搬到别的群后，原卡片也会自动冻结为存档（移除按钮）。
- **关闭时给「可恢复」卡片**：带「▶️ 恢复会话」按钮随时点回来继续；**该 CLI 若支持原生 resume**（adapter 实现了 `buildResumeCommand` 且有原生 session id），还会附上原生命令（如 `claude --resume <id>`）方便手动恢复；不支持时只给 botmux 的恢复按钮 + 一句提示。

## 置顶当前实时卡片

如果某个 bot 开启了 `pinStreamingCard`，Botmux 会尝试把**当前公开实时状态卡片**置顶到聊天顶部，方便随时点「关闭会话」或打开终端。

- 这是 **per-bot、默认关闭、显式开启** 的选项。
- 飞书层的 Pin 仍然是**按群生效**，但每个活跃会话依旧维护各自的当前/冻结流式卡片生命周期。也就是说，同一个群里如果有多个活跃话题或多个 bot，可能同时出现多个由不同会话独立维护的群级置顶项。
- 只会处理当前公开 live-status 的真实 `streamCardId`。
- repo 选择卡、私有 `/card`、最终回复卡、CoT、关闭卡，以及其它交互卡都**不会**被置顶。
- 通过 dashboard 或 `/botconfig set pinStreamingCard on/off` 改开关后，Botmux 会对这个 bot 的**现有活跃会话**立即做 best-effort 热重算；配置响应本身不会等待飞书 Pin/Unpin 完成。
- `/card pin off` 是**按群逃生阀**：保留实时卡片本身，但停止在当前群自动置顶；`/card pin on` 恢复当前群置顶；`/card pin status` 会区分 bot 级未开启、当前群显式关闭、以及当前群实际开启三种状态。
- 失败是 **fail-open**：不会影响发卡、转移、恢复、关闭或配置写入。异常期间可能暂时没有任何 Pin，也可能短时间同时存在多个 Pin。
- 该能力没有持久重试日志，重启后的恢复也刻意保持很窄。daemon 重启时，Botmux 把当前群 Pin 列表作为持久卡片唯一的来源判定：只有飞书返回 `operator_id_type: "app_id"` 且 `operator_id` 与当前 `larkAppId` 完全一致时，远端 Pin 才算可证明；即便如此，后续清理权限仍然只限于与本进程入队瞬间已知的本地候选 ID 做**严格交集**。若当前卡已经由人工、其它应用或不完整/混合来源置顶，Botmux 会保留原状，既不认领也不重复 Pin；只有列表中不存在当前卡时才会创建，并要求返回的 `data.pin` 同时精确匹配消息 ID 和当前应用来源。Botmux 不会对任意远端 Pin 做宽扫清理，读取或 Pin API 失败时继续 fail-open。显式 bot 级/按群关闭只清理进程内已拥有的 ID，加上远端刚证明属于同应用的本地候选；普通 disable、关闭会话和转移只清理进程内已拥有的 ID。

> **打开终端 = 只读**：卡片主按钮「🖥️ 打开 Web 终端」是只读查看；要**可写操作**点「🔑 获取操作链接」——**私密投递**：普通平铺群优先发一张群内「仅你可见」的 ephemeral 卡（不用离开会话），话题/线程或私聊、以及 ephemeral 失败时才走私聊 DM。「🔄 重启」「接管配置」等管理按钮在**会话卡**上，不在每轮的流式卡上。

## 打断 / 纠偏正在跑的一轮

想中途叫停或纠偏，**别等它跑完**：截图模式下卡片底部带一排快捷键——**Esc、^C、Tab、Space、Enter、方向键、⇞ 上半屏 / ⇟ 下半屏**。点 `Esc` 会把 ESC 字节直接写进那个活着的终端（等同你在本地按 Esc），`^C` 同理。打断后再补一句新指令即可。

> 这排快捷键只在**显示输出（截图模式）**且非 `riff` 后端时出现——先「显示输出」才点得到 Esc。默认行为是当前轮不打断、新消息排队（type-ahead），本轮结束再依次输入；要立刻纠偏就用 Esc 先断。

## CLI 主动发的消息

卡片正文是终端画面的**实时截图（图片）**，不是文本渲染。CLI 主动发的消息（通过 `botmux send`）则是独立的富文本 / 图文消息，可带图片、文件、@mention；需要完全自定义展示时也可以用 `--card-file` / `--card-json` 发送原始 interactive 卡片 JSON。

> ⚠️ 原始卡片**只允许纯展示 + open_url 跳转按钮**：任何会触发回调的控件——回调按钮（带 `value`）、下拉 / 人员选择、日期时间选择、输入框、表单提交——都会被拒绝。这是防止自定义卡片伪造交互回调。

## 发送后更新卡片（card patch）

`botmux send --card-file/--card-json` 成功后会输出 `{"success":true,"messageId":"om_...",...}`。用 `botmux card patch` 可以按这个 messageId **原地更新**同一张卡片——不发新消息、不换群/话题，适合做进度卡片：

```bash
# 1. 发一张「进行中」卡片，从输出 JSON 里拿 messageId
botmux send --card-json '{"schema":"2.0","header":{"template":"blue","title":{"tag":"plain_text","content":"部署进度"}},"body":{"direction":"vertical","elements":[{"tag":"markdown","content":"进度: 0%"}]}}' --no-mention
# → {"success":true,"messageId":"om_xxx","sessionId":"..."}

# 2. 用 jq 提取 messageId，原地更新到 50%
MID=$(botmux send --card-file /tmp/progress.json --no-mention | jq -r .messageId)
botmux card patch --message-id "$MID" --card-json '{"schema":"2.0","header":{"template":"blue","title":{"tag":"plain_text","content":"部署进度"}},"body":{"direction":"vertical","elements":[{"tag":"markdown","content":"进度: 50%"}]}}'

# 3. 完成时再更新一次
botmux card patch --message-id "$MID" --card-json '{"schema":"2.0","header":{"template":"green","title":{"tag":"plain_text","content":"部署完成"}},"body":{"direction":"vertical","elements":[{"tag":"markdown","content":"✅ 已上线"}]}}'
```

- 更新用的卡片 JSON 与发送时走**同一套安全校验**（纯展示 + open_url，回调控件被拒）。
- 示例中的 `send` 带 `--no-mention`：进度卡片不需要 @ 任何人，显式声明不提及可避免被 mention 策略门拦截（exit 2）。
- Bot 身份从会话上下文解析（与 `send` 相同）；消息已撤回、无权限、目标不是卡片消息等错误会原样透出（exit 1）。
- 成功输出 `{"success":true,"messageId":"om_xxx","sessionId":"..."}`（stdout 只有 JSON）；参数错误 exit 2。
