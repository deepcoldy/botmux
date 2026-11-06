# 实时流式卡片

<video src="img/video-v2-daily.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

Botmux 在飞书里用卡片告诉你 CLI 正在干什么，也让你在手机上就能操控它。这一页按「最常用 → 进阶」的顺序介绍：先看一轮对话会出现哪些东西，再讲状态卡、动态单卡、各种开关，最后是给脚本和集成方用的高级能力。

## 一轮对话，群里会出现什么

| 层 | 是什么 | 怎么关 |
|----|--------|--------|
| **终端状态卡** | 每轮一张、实时刷新终端截图的主卡片，带会话控制按钮 | bot 级 `disableStreamingCard`，或本群 `/card off` |
| **思考过程（CoT）** | CLI 工作时的思考文字和工具调用，用飞书原生 CoT 消息流式展示 | bot 级 `cotEnabled: false`，或本群 `/cot off` |
| **消息状态标记** | 只在关掉状态卡的群出现：开工时在你的消息上贴「冲!」表情，结束时换成 ✅ | bot 级 `silentTurnReactions: true` |
| **回复消息** | agent 用 `botmux send` 发的答复、图片、文件、卡片 | 按需发送，没有开关 |

几点说明：

- 状态标记和状态卡**二选一**：开着状态卡就不贴表情；关了状态卡，表情就是唯一的轻量进度信号。两个表情可以用 `receivedReactionEmoji` / `doneReactionEmoji` 换成别的（见 [bots.json](/bots-json)）。
- 思考过程需要飞书客户端 PC ≥ 7.70、移动端 ≥ 7.74，只有能输出思考内容的 CLI（Claude Code、Codex、TraeX、Pi 等）才有。
- 想换成「一轮只一张卡」的展示方式，见下文「动态单卡」一节。

## 终端状态卡

![实时流式卡片](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780419090587_img_v3_0212a_553ca347-4a93-491f-a2ef-30d00a374cdg.jpg)

卡片正文是终端画面的**实时截图**：xterm 在后台把 CLI 的界面原样渲染成图片（边框、配色都在），不是把输出转成文字。

### 卡头颜色就是状态

| 状态 | 颜色 | 什么时候出现 |
|------|------|--------------|
| 启动中… | 黄 | CLI 还在启动 |
| 工作中 | 蓝 | 正在处理这一轮 |
| 正在分析… | 紫 | 正在分析 |
| 等待输入 / ✓ 本轮已结束 · 等待输入 | 绿 | 这一轮做完了，可以接着发 |
| ✓ 本轮已结束（AI 判断无需回复） · 等待输入 | 绿 | 这一轮 AI 判断不需要回话，见下文 |
| ⏳ 主回合已结束 · 后台子任务运行中（N） | 浅蓝 | 主 agent 答完了，但它派出去的后台任务（后台 agent、`run_in_background` 的 Bash、Monitor、Grok 后台任务）还在跑；N 和 Web 终端里的后台任务数一致，全部跑完才算结束 |
| 长时间无进展 | 红 | 很久没看到进展 |
| 限额已达 | 红 | 模型额度用满；能重试时变成绿色的「可重试」 |
| 已中断 | 橙 | 本轮被中断 |

### 「AI 判断无需回复」与耗时显示 {#no-reply-needed}

- **无需回复**：AI 判断这条消息不需要回话（比如只是群里的一句同步）时，不发回复卡，状态卡头显示「✓ 本轮已结束（AI 判断无需回复） · 等待输入」，方便和「卡住了」区分开。这是自动行为，不用配置。如果那条消息明确 @ 了 Bot，还会补一条自动回执；想让它必须回话，再 @ 一次并明确要求答复。
- **等待 / 执行耗时**：默认关闭，打开方法见下文[显示耗时](#显示耗时)。

### 卡片上的按钮

| 按钮 | 作用 |
|------|------|
| 📖 显示输出 / 📕 隐藏输出 | 展开或收起终端截图；展开后还有 📝 导出文字、🔃 刷新 |
| 🖥️ 打开 Web 终端 | **只读**查看终端 |
| 🔑 获取操作链接 | 拿一条**可写**终端链接。普通群优先发一张「仅你可见」的卡片；话题、私聊或发送失败时改为私聊发给你 |
| 🗜️ 压缩 | 给 CLI 发 `/compact` 压缩上下文（CLI 支持时才显示） |
| ⏲️ 闲置自动压缩：开/关 | 本会话闲置一段时间后自动压缩，同 [`/idlecompact`](/slash-commands) |
| ⏹ 停止 | 中断当前这一轮（等同按 ^C），会话保留。只在这一轮还在跑时显示 |
| ❌ 关闭会话 | 关闭会话；接管（adopt）的会话这里是「⏏ 断开」 |
| 🔁 重发上一条任务 | 额度恢复、状态变成「可重试」时出现 |
| 思考强度下拉框 | Codex（tmux 后端、未开沙盒、不走 RPC 输入）会话可在运行中切换思考强度，下一轮生效 |

不想要的按钮可以在 Dashboard 关掉（见下文「隐藏卡片按钮」）。

### 中途打断或纠偏

**不用等它跑完。** 展开输出后，卡片底部有一排快捷键：Esc、^C、Tab、Space、Enter、方向键、⇞ 上半屏、⇟ 下半屏。点 Esc 就是往终端里按了一下 Esc，打断后再发一句新指令就行。

- 快捷键只在**展开输出**时出现，远程后端（Riff / Mojo）没有。
- 默认情况下，这一轮还在跑时你发的新消息会排队，等这一轮结束再输入。想立刻纠偏就先点 Esc 或 ⏹ 停止。

### 卡片的生命周期

- **每轮一张新卡**：上一轮的卡冻结存档，历史清晰可查。会话被 [`/relay`](/relay) 搬到别的群后，原卡片也会冻结并去掉按钮。
- **关闭后可恢复**：关闭卡片上有「▶️ 恢复会话」按钮。CLI 支持原生恢复时，还会附上原生命令（如 `claude --resume <id>`）方便手动接回。
- 管理类按钮（如「🔄 重启」）在会话卡上，不在每轮的状态卡上。

## 需要你点一下的卡片

除了状态卡，Botmux 还会在需要你做决定时发卡片。下面三种最常见。

### 选仓卡

新话题需要选仓库时会弹出「📁 项目仓库管理」卡：从下拉框选一个仓库、手动输入任意目录，或点「▶️ 直接开启会话」用默认目录。

想基于仓库新建 worktree，用「🌿 选仓库新建 worktree 打开」下拉框。扫描到 2 个以上仓库时，旁边有一个「🔀 多仓库」按钮：

- 点一下切成**多仓库选择器**，可以一次勾选多个仓库、各建一个 worktree；再点「🔀 单仓库」切回。
- 这个切换会写进 bot 配置 `worktreeMultiPicker`，**对这个 bot 之后的所有会话都生效**，不只是这张卡。所以只有管理员能点。
- 也可以直接改：`/botconfig set worktreeMultiPicker on|off`。

### AI 提问卡

agent 用 `botmux ask` 提问，或 Claude Code / Codex 自己发起提问时，群里会出现一张提问卡。卡上的「可答复」写着谁能答。

| 你会看到 | 怎么操作 |
|----------|----------|
| 单选 / 多选 | 点选项按钮；多选可以选多个，选完点「提交」。一个都不选时要再点一次「确认空提交」 |
| 一张卡多道题 | 每题标着「问题 1」「问题 2」…，全部答完后一次「提交」 |
| 文本 / 数值输入框 | 直接填；必填项不能留空，数值有范围限制时要填在范围内 |
| 已经选好的选项 | 是提问方给的推荐预选，只是草稿。你不点「提交」就不算回答，可以改 |
| 「其他／自定义」 | 一般每道题后面都有一个输入框（提问方关掉、或卡上有文本／数值框时除外），选项都不合适时写自己的答案，只替换这一题。单题最多 1000 字，整卡最多 2000 字 |
| 「可答复」@ 了某个人 | 提问方用 `--answerer` 指定了答题人，只有这个人能提交（跨应用转来的提问显示为「指定成员（仅本人可操作）」）。它只限制谁能答，不代表业务上的批准 |

没写指定答题人时，本群能和机器人对话的人都能答。选项都不合适时，也可以直接在话题里回一句文字当答案。命令参数见 [CLI 命令](/cli-commands)。

### 终端权限确认卡（Claude Code）

Claude Code 有些操作要在终端里弹确认框，比如内置安全检查拦下的危险 `rm`，即使开了跳过权限也会弹。飞书里看不到这个框，会话就会一直卡着。Botmux 会把它转成一张提问卡，正文写着工具名、命令或文件路径，按钮是「允许执行」和「拒绝」。

- 点「允许执行」，Claude 照常执行；点「拒绝」，Claude 收到拒绝，换个做法继续。
- **默认等 10 分钟**，没人点就按拒绝处理，并告诉 Claude 是超时拒绝。
- 在话题里用文字回复也按**拒绝**处理，你写的话会作为原因转给 Claude。
- 卡片发不出去（比如 daemon 连不上）时同样按拒绝处理，不会退回到没人能点的终端确认框。
- 等待时间可以用环境变量 `BOTMUX_PERMISSION_TIMEOUT_MS`（毫秒）调整，会被限制在 1 秒到 14 分钟之间（见 [环境变量](/env)）。

## 动态单卡：一轮一张答复卡（试用）

![动态单卡示意图：处理中与完成后](/img/unified-reply-card-preview.png)

上图是示意，实际样式以飞书客户端为准。

默认情况下，状态卡、思考过程和最终答复是分开的几条消息。**动态单卡模式**把同一轮的进度、执行过程、提问和最终答复都放进同一张卡里原地更新；下一轮再开新卡，上一轮的答复保留。

### 怎么开

- Dashboard：Bot 配置 → 任务卡片 → **回答展示方式**，选「动态单卡模式」。
- 或者管理员在群里发：`/botconfig set replyCardMode unified`；改回默认用 `/botconfig set replyCardMode legacy`。
- 从**下一轮**开始生效。

只想看到一张卡？选动态单卡，再关掉「**显示独立状态卡**」（默认开）。关掉后不再自动发终端状态卡，答复卡照常更新；需要时用 `/card` 临时打开。`disableStreamingCard` 和 `/card off` 关的也是这张独立状态卡。旧配置 `final-only` 会自动按「动态单卡 + 关闭独立状态卡」处理。

### 哪些会话支持

- 支持：**未开文件沙盒**的 Claude Code、Codex、Grok、TraeX、Pi 普通飞书对话（普通群和话题都行）。
- 不支持、仍走默认模式：文件沙盒会话（含 `readIsolation`、全局 `BOTMUX_SANDBOX=1`）、API-only、非飞书渠道、远程 Riff/Mojo、adopt、本地终端同步、文档评论、视频会议、定时任务、v3 工作流。
- 沙盒状态以会话启动时为准，改 bot 的沙盒开关不影响正在跑的会话。

### 卡片里有什么

- **标题**：当前阶段加耗时，比如 ⏳ 等待执行、💭 处理中、✅ 已完成、❌ 执行失败、⏹ 已停止；有问题待回答时显示「等待你确认」。
- **执行过程**：CLI 已输出的思考文字或摘要、工具调用、进度说明、问答记录，按顺序排列，结束后收进带 📋 图标的折叠区。CLI 没输出的内部思考看不到。
  - 群里 `/cot off` 或 bot 级 `cotEnabled: false` 可以关掉执行过程，但进度和问答记录仍保留。
  - 只想隐藏工具调用：Dashboard 关「显示工具调用」，或 `/botconfig set replyCardShowTools off`。思考摘要和进度照常显示，`/cot show` 也不会把隐藏的工具调出来。这个开关只在动态单卡下有效。
- **⏹ 停止**：执行中的答复卡上也有，只能停当前这一轮，旧卡停不了新任务。Codex RPC 输入模式没有这个按钮。
- **宽度**：随聊天窗口自适应。

### 提问（Ask）也在卡里

同一轮里的 `botmux ask`，以及 Claude Code / Codex 的提问，会直接展开在答复卡里，标题提示「等待你确认」。回答、超时或失效后收进执行过程；多个问题依次展示，不会互相覆盖。多选、文字回答、在 Dashboard 作答都照常可用。

超过 16 个选项、或者问题内容超过 3000 字节的大问卷，仍然单独发卡。审批/授权类卡片也独立发送。

### 和 `botmux send` 怎么配合

- `botmux send` 默认算进度，最终答复用 `botmux send --response-kind final "完整答复"`。
- 多次发送可能返回同一个 `messageId`。脚本需要每次一条独立消息时，用默认模式或 `--response-kind auxiliary`。
- 回复并 @ 本轮提问人（`--mention-back`）仍更新同一张卡；@ 别人、自定义卡片、图片和附件、跨会话投递照旧单独发。

### 限制

- 整卡受飞书 30 KB 的更新上限约束。超了才截断执行过程，优先保留最终答复和待回答的问题，并提示省略了多少。
- 超长答复会转成 Markdown 附件，卡里给出提示。
- 卡片被撤回后不会自动重建；不做逐字动画。

## 开关一览

### bot 级默认 与 按群覆盖

| 显示层 | bot 级默认（Dashboard「Bot 配置 → 任务卡片」） | 本群覆盖（群里发命令） | 默认 |
|--------|-----------------------------------------------|------------------------|------|
| 独立状态卡 | `disableStreamingCard` | `/card off` / `/card on`；裸 `/card` 立即召唤一张 | 开 |
| 思考过程 | `cotEnabled` | `/cot off` / `/cot on`；`/cot show` 临时看一次；`/cot` 查状态 | 开 |
| 消息状态标记 | `silentTurnReactions` | 无 | 关卡的群自动有；设为 `true` 后不再贴 |
| 卡片按钮 | `hiddenStreamingCardButtons` | 无 | 全部显示 |
| 置顶状态卡 | `pinStreamingCard` | `/card pin off｜on｜status` | 关 |

- 按群设置优先于 bot 级，只影响当前群。`/card on` 只清除群级关闭，bot 级关闭仍然有效。
- **`/card`、`/cot` 只有管理员（`allowedUsers`）能用**，查状态也一样。飞书卡片做不到「每人看到不一样」，改一次全群都受影响，所以只交给管理员。
- `silentTurnReactions` 同时会隐藏 Codex App 的「追加指令已收到」回执。

**静默模式预设**：Dashboard 里一键把「思考过程关、状态标记静默、状态卡关」三项一次写好，适合只想安静看结论的群。它只是一次性写入，之后关掉预设**不会**把三项改回去，想恢复哪项就单独打开。

### 隐藏卡片按钮

![实时卡片按钮开关](/img/streaming-card-button-settings.png)

在 Dashboard 的「实时卡片按钮」里逐个开关，或者：

```bash
/botconfig set hiddenStreamingCardButtons writeLink close
```

可选值：`output`（显示输出、导出文字、刷新）、`terminal`、`writeLink`、`compact`（含闲置自动压缩）、`stop`、`close`。`/botconfig unset hiddenStreamingCardButtons` 恢复全部。

### 其它卡片相关开关

| 配置 | 作用 | 默认 |
|------|------|------|
| `writableTerminalLinkInCard` | 卡片里直接放可写终端按钮，看到卡片的人都能操作，只在可信群开 | 关 |
| `privateCard` | 普通群里的 `/card` 改为只给管理员看的静态快照（不会持续更新） | 关 |
| `replyCardActions` | 普通回复卡右下角显示「打开终端 / 切换模型 / 关闭会话」菜单 | 关 |

都可以在 Dashboard 改，或用 `/botconfig set <配置> on|off`。

## 置顶当前状态卡

开了 `pinStreamingCard` 后，Botmux 会把**当前公开的状态卡**置顶到群顶部，方便随时点终端或关闭会话。

- 每个 bot 单独开，默认关。Dashboard 或 `/botconfig set pinStreamingCard on|off` 修改，已有会话会立即尝试跟着调整。
- 只置顶当前的公开状态卡。选仓卡、私有 `/card`、回复卡、思考过程、关闭卡等都不置顶。
- 飞书的置顶是按群的：一个群里有多个话题或多个 bot 在跑时，可能同时有多条置顶。
- 某个群不想置顶：`/card pin off`；恢复：`/card pin on`；`/card pin status` 会告诉你是 bot 级没开、本群关了，还是正在生效。
- 置顶是尽力而为：失败不影响发卡、关闭、搬迁等任何操作，异常时可能短暂没有置顶或多出一条。Botmux 只会撤掉自己置顶的卡，不动别人或其它应用置顶的内容。

## 回复卡页脚

![回复卡片页脚设置](/img/reply-footer-settings.png)

最终回复卡底部的页脚可以按需显示这些信息，在 Dashboard「回复卡片页脚」里逐项开关：

| 配置 | 内容 | 默认 |
|------|------|------|
| `replyFooterEnabled` | 页脚总开关；关掉时整个页脚隐藏，子项设置保留 | 开 |
| `replyFooterBrand` | 品牌签名（文案可用 `brandLabel` 自定义） | 开 |
| `replyFooterModel` | 模型名、思考强度、后端规格 | 开 |
| `replyFooterUsage` | 用量信息 | 开 |
| `replyFooterRecipients` | 收件人及 @ 通知；关掉后页脚不再 @，正文里显式写的 @ 不受影响 | 开 |
| `replyFooterVoice` | 语音总结按钮 | 开 |
| `showReplyTiming` | 等待与执行耗时 | 关 |

### 用量显示在哪

用量行长这样：`ctx 23% · 5h 18% · 7d 5% · 本轮 ↑12k ↓3k · 累计 ↑1.2M ↓80k · 缓存命中 92%`。缺哪项就不显示哪项。

`usageDisplay` 决定它放哪：

| 值 | 位置 |
|----|------|
| `streaming`（默认） | 状态卡正文，显示完整用量 |
| `footer` | 最终回复页脚，只显示上下文占用和账号配额 |
| `off` | 不显示 |

只影响展示，不影响用量统计。

### 显示耗时

默认关闭。在 Dashboard「Bot 配置 → 消息卡片 → 任务卡片 → 等待与执行耗时」打开，或发 `/botconfig set showReplyTiming on`（`bots.json` 键 `showReplyTiming`）。打开后，最终回复页脚会显示「等待 3.2 秒 · 执行耗时 23.4 秒」，从新收到的消息开始计。

- **等待**：Botmux 收下消息，到真正交给 CLI 之间的时间，包括排队和冷启动。
- **执行耗时**：交给 CLI 到看到最终输出。Codex App 用它自己的完成时间。

两项都不含飞书投递时间。算不准的情况（重试、旧会话恢复、模型提前用 `botmux send` 发出的消息）不显示，不会瞎猜。

### 在用量行后面追加自己的内容

想在用量行后面加上网关额度、构建状态、值班人？在 bots.json 给 bot 配一个命令：

```json
"cardFooterExtension": {
  "command": "~/.botmux/scripts/quota.sh",
  "refreshSeconds": 60
}
```

命令输出一行一段，或者 JSON `{"segments": ["…", "…"]}`。例如输出：

```
01 5h 2% 7d 2%
02 5h 4% 7d 2%
```

卡片上显示为 `ctx 14% · 01 5h 2% 7d 2% · 02 5h 4% 7d 2%`。

规则：

- 最多 4 段，每段最多 40 个字，按纯文本显示（Markdown 会被转义）。
- 用 `/bin/sh -c` 执行，3 秒超时，stdin 关闭，非 0 退出算失败。环境变量里有 `BOTMUX_LARK_APP_ID`、`BOTMUX_CLI_ID`、`BOTMUX_BOT_NAME`（取 bot 配置的 CLI）。
- 不会定时跑：有卡片渲染、且结果超过 `refreshSeconds`（默认 60，范围 10–3600）时才在后台刷新，渲染卡片从不等命令。同一个 bot 的所有会话共用一份结果。
- 失败时沿用上次成功的结果；上次成功超过 10 分钟就不显示。
- 所有 CLI 都生效，显示位置跟着 `usageDisplay` 走，`off` 时一起隐藏。

## 自动恢复失败卡

Claude 普通消息遇到临时的模型故障（连不上接口、DNS 故障、断流等）时，Botmux 会自动续跑，最多两次。如果最后还是失败，原群（原话题）里会出现一张失败卡，这是这条消息唯一的提示：

- 先 @ 原发起人，再用一句话说明原因（不贴原始报错），附上原消息摘要、时间、续跑了几次。
- **🔁 重试**：以原发起人的身份重新发这条消息，回复仍回到原群 / 原话题。只有原发起人（仍有对话权限时）或 bot 管理员能点；每张卡只能成功重试一次，之后卡片显示是谁重试的。重发时会提醒 AI 先核对现场，尽量不重复已完成的操作。
- 续跑后一直没结果（终端空闲约 1 分钟）也算失败，不会一直停在「进行中」。
- 发卡时飞书接口也不通的话，会持续补发（最长 24 小时），恢复后只发一张；daemon 重启不会重复发。
- 定时任务失败也会发这张卡，但没有重试按钮，需要时去定时任务里手动再跑一次。

## 停止、重试与花费金额 {#stop-retry-cost}

- **⏹ 停止**：默认就有，只在这一轮还在跑时出现在状态卡上，点了等同按 ^C，会话保留；在话题里发 `/stop` 效果一样。Codex App 会话和开了 `codexRpcInput` 的会话不支持停止，点了只会提示用 `/close`。不想要这个按钮：`/botconfig set hiddenStreamingCardButtons stop`，或在 Dashboard 的「实时卡片按钮」里关掉（见上文[隐藏卡片按钮](#隐藏卡片按钮)）。
- **🔁 重试**：失败卡上默认可用，原发起人或 Bot 管理员能点，见上文[自动恢复失败卡](#自动恢复失败卡)。别的失败或中断的轮次，可以在话题里发 `/retry`。
- **花费金额**：要先在 `bots.json` 给 Bot 配 `pricing`（最简单是 `"pricing": { "usdCny": 7.2 }`，用内置价格表），botmux 才会按 token 用量折算人民币；没配时金额一直是 0。当前版本的金额用于月度预算提醒（`budget`），不显示在卡片上，配置方法见 [花费与预算](/bots-json#budget)。卡片上能看到的是 token 用量行，见上文[用量显示在哪](#用量显示在哪)。

## 用 `botmux send` 发更丰富的消息

agent 用 `botmux send` 发的是独立消息，可以带图片、文件、视频、@ 提及。完整参数见 [CLI 命令](/cli-commands)。下面几种和卡片展示关系最大。

### 自定义卡片

`--card-file` / `--card-json` 可以直接发飞书 interactive 卡片 JSON。

> ⚠️ 自定义卡片**只允许纯展示内容和 open_url 跳转按钮**。会触发回调的控件（带 `value` 的按钮、下拉框、人员选择、日期选择、输入框、表单提交）都会被拒绝，防止伪造交互回调。

### 视频、@、加急与发送前自查 {#send-rich}

都是 `botmux send` 的参数，由会话里的 AI 按需调用，不用开关：

| 想做什么 | 参数 |
|---|---|
| 发带预览的视频 | `--videos <mp4>` 配 `--video-covers <封面图>`，按顺序一一对应，都可以重复 |
| 发自定义卡片 | `--card-json '<json>'` 或 `--card-file <路径>`（只能放纯展示内容和 open_url 按钮，见上） |
| 点名 @ 某人 | `--mention <open_id>`（可重复；Bot 开了 `allowArbitraryMention` 时也能写完整邮箱 / 手机号 / union_id，但对方必须在群里）；`--mention-back` @ 回本轮发消息的人。每条回复必须在 `--mention`、`--mention-back`、`--no-mention` 里三选一 |
| 加急提醒 | `--urgent`（应用内，默认）、`--urgent=sms`、`--urgent=phone`，加急对象是本轮发消息的人，**必须和 `--mention-back` 一起用**。应用要开通对应的 `im:message.urgent*` 权限；短信、电话会消耗租户额度 |
| 发送前自查 | `--dry-run`：把正文按卡片渲染后输出 JSON 和告警，不真的发（不上传图片附件、不解析 @） |

完整参数见 `botmux send --help`。

### 回复卡的语义卡头（`--layout`）

在关键节点可以给回复加一个带颜色和标签的卡头：

```bash
botmux send --layout result --mention-back "构建通过，已发布到测试环境"
```

可选 `result`（结果）、`progress`（进度）、`risk`（需要确认）、`blocked`（受阻）、`handoff`（交接）。不加 `--layout` 就是普通回复卡。对自定义卡片、语音消息不生效。

Dashboard「Bot 配置 → 回复风格」可以调整：是否给 agent 注入这五种写作配方、是否允许 `--layout` 生成卡头、主题（默认 / 极简 / 鲜明），以及每种卡头的颜色和标签。已在跑的会话要重启后才用新设置。

### 在消息里画图表（vega-lite）

正文里的 ` ```vega-lite ` 代码块会渲染成飞书原生图表：

````markdown
```vega-lite
{
  "mark": "bar",
  "data": {"values": [{"day": "周一", "n": 3}, {"day": "周二", "n": 5}]},
  "encoding": {
    "x": {"field": "day", "type": "nominal", "title": "日期"},
    "y": {"field": "n", "type": "quantitative", "title": "次数"}
  }
}
```
````

支持的写法：

- 数据只能用 `data.values` 内联，最多 500 行，值为字符串 / 数字 / 布尔 / null。
- 图形 `mark`：`bar`（只有 x 是数值时画横向条形）、`line`、`area`、`point`、`arc`（饼图；`innerRadius > 0` 是环图）。饼图只写 `theta`（数值）和 `color`（类别），不能带 `x` / `y`，`theta` 不支持 `title`。
- 编码通道：`x`、`y`、`color`（分组）、`theta`；每个通道只认 `field`、`type`、`title`。`x` / `y` 的 `title` 是坐标轴标题，`color` 的 `title` 是图例标题。
- `type: temporal` 不会解析日期，只按给定顺序当类别显示，请先排好序。
- 每张卡最多 5 个图表。整条消息不能超过飞书的 30 KB，放不下时按「图表 → 50 行数据表 → 10 行数据表 → 只留说明」逐级降级。

安全起见，Botmux 只挑认识的字段重新拼图表，`data.url`、`transform`、`params`、`expr`、`signal`、`datasets`、`layer` 等一律拒绝。不支持或放不下时降级成一行说明加原始数据表，stderr 里给出原因，消息照常发出。

**发之前先预览**：`botmux send --dry-run` 不发送、不需要会话，输出 `{dryRun, bytes, fits, diagnostics, card}`，`bytes` 是按飞书真实请求算的大小。它只渲染正文，不上传图片附件、不解析 @、不加页脚。

### 发出去后原地更新卡片（card patch）

`botmux send --card-file/--card-json` 成功后输出 `{"success":true,"messageId":"om_...",...}`。拿着这个 messageId，`botmux card patch` 可以**原地更新**同一张卡，不发新消息，适合做进度卡：

```bash
# 1. 发一张「进行中」卡片，用 jq 取出 messageId
MID=$(botmux send --card-file /tmp/progress.json --no-mention | jq -r .messageId)

# 2. 更新到 50%
botmux card patch --message-id "$MID" --card-json '{"schema":"2.0","header":{"template":"blue","title":{"tag":"plain_text","content":"部署进度"}},"body":{"direction":"vertical","elements":[{"tag":"markdown","content":"进度: 50%"}]}}'

# 3. 完成时再更新一次
botmux card patch --message-id "$MID" --card-json '{"schema":"2.0","header":{"template":"green","title":{"tag":"plain_text","content":"部署完成"}},"body":{"direction":"vertical","elements":[{"tag":"markdown","content":"✅ 已上线"}]}}'
```

- 更新用的卡片和发送时一样要过安全校验（纯展示 + open_url）。
- 示例里 `send` 带了 `--no-mention`：每条回复都要在 `--mention` / `--mention-back` / `--no-mention` 里选一个，否则会被拦下（exit 2）。
- bot 身份从当前会话取。消息已撤回、没权限、目标不是卡片等错误会原样报出（exit 1）；参数错误 exit 2。成功时 stdout 只有一行 JSON。

## 签名按钮：点击者以自己的身份开始一轮（集成方）

本机的集成程序可以让机器人往群里发一张**一次性按钮卡片**。谁点了按钮，这一轮就算谁发起的，和他自己发了一条消息一样。开了 `triggerUserAuth`（`credentialSource: local`）时，凭证也按点击者签发，不会退回会话 owner。

### 怎么发

调用 daemon 的本机 IPC 接口 `POST /api/cards/click-turn`（和 `/api/sessions/spawn` 用同一套本机 HMAC 认证，不是公开接口）。请求体：

| 字段 | 说明 |
| --- | --- |
| `prompt` | 必填。点下去后作为这一轮的用户输入，最长 1500 字 |
| `chatId` / `sessionId` | 二选一。打到某个群的群聊会话，或某个已有会话 |
| `postChatId` | 卡片发到哪个群，默认同 `chatId`；只给 `sessionId` 时必填 |
| `workingDir` | 可选，必须是已存在的绝对路径。点击会新建会话时必填 |
| `chatType` | 可选，`group` 或 `p2p` |
| `ttlMs` | 可选，1 分钟到 7 天，默认 1 小时 |
| `buttonLabel` / `title` | 可选 |

成功返回 `{ ok, messageId, exp }`；机器人不在目标群时返回 403 `bot_not_in_chat`。

### 安全规则

- 按钮内容由 daemon 签名，**每个按钮只能用一次**；篡改、过期、重复点击都会被拒绝，重启后也不能再用。
- 点击者要同时满足：能和机器人对话、有操作权限（管理员）。只有对话授权的人点不了；开了 `restrictGrantCommands` 时，只靠单人授权（本群访客 `chatGrants` 或全局访客 `globalGrants`）获得对话权的人也点不了，整群放开的成员不受这条限制。
- 机器人或应用点击不会开启新一轮，也不会改用 owner 身份。
- `sessionId` 只匹配本机器人当前活跃的会话，找不到就拒绝，不会另开。`chatId` 对应的群还没有会话时，会新建一个，owner 是点击者；已有会话的工作目录和签名不一致时拒绝。
- 新建会话没签 `chatType` 时按群聊处理；私聊需要显式签 `p2p`。
- 开了跨人插话（`crossPrincipalInterruption`）或按人分道的会话，点击会被直接拒绝并提示原因。

点击后飞书先提示「正在开始」，CLI 真正收下输入后，群里再发「已按你的身份开始」；投递失败会撤回这一轮的改动并发失败说明。
