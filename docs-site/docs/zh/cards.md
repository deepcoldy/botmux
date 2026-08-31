# 实时流式卡片

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
- 该能力只基于当前会话已知的 `streamCardId` / 冻结卡 ID 做补偿，不做全群 Pin 扫描，也没有持久重试日志。显式从 on 切到 off 时会按这些已知 ID 清理；如果进程丢失来源记录时配置已经是 off，后续关闭或转移可能无法区分功能 Pin 与人工 Pin，因此不会冒险清理。

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
