/**
 * Canonical skill definitions shipped with botmux.
 *
 * Each skill is a SKILL.md ready to drop into any CLI's skills directory.
 * Skills here MUST:
 *   - use `botmux <subcmd>` shell commands (CLI is the canonical interface)
 *   - not depend on MCP tools (which may not be wired on every CLI)
 *   - keep frontmatter minimal — just `name` and `description` for discovery
 */

export interface SkillDef {
  /** Filesystem-safe name — becomes the directory name under {skillsDir}/ */
  name: string;
  /** Markdown content including YAML frontmatter */
  content: string;
}

const SCHEDULE_SKILL = `---
name: botmux-schedule
description: 在当前飞书/Lark 话题里创建、管理定时提醒（用 botmux schedule 命令，支持增删查改暂停恢复）。触发场景：用户说"每天X点"、"每周X"（任意星期，不限周一）、"每月X号"、"N分钟后/N小时后"、"明天X点"、"提醒我"、"定时任务"、"周期任务"、"recurring"、"reminder"、"crontab" 时；或显式提到 botmux schedule。到点后 daemon 会在原话题自动续一条消息并触发新 CLI 会话。注意区分：本 skill 是飞书话题内提醒；要在云端跑 remote agent 用 superpowers:schedule；要在当前会话循环跑 prompt 用 loop。
---

# botmux-schedule — 定时任务

当用户要求"定时"/"提醒"/"每天"/"每周"/"N 分钟后"等时间相关的自动化请求时，使用本技能创建/管理定时任务。

## 核心原则

1. **创建前必须跟用户确认** schedule 和 prompt 的具体内容，避免误加
2. **默认不传 --chat-id / --root-msg-id** —— 在 Lark 话题的 CLI 会话内运行时 botmux 会自动推断
3. 创建后把 task id 和下次执行时间回显给用户
4. 如果用户是在编程会话里顺手说"以后每天X点都这样做"，先问他：是否希望到点以后自动在当前话题里继续

## 支持的 schedule 格式

| 格式 | 说明 | 示例 |
|---|---|---|
| cron 表达式 | 5 字段 | \`"0 9 * * *"\` 每天 09:00 |
| 英文 duration | 一次性 | \`"30m"\` 30 分钟后 / \`"2h"\` / \`"1d"\` |
| 英文 interval | 循环 | \`"every 30m"\` / \`"every 2h"\` |
| ISO 时间 | 一次性 | \`"2026-05-01T10:00"\` |
| 中文自然语言 | 推荐给中文用户 | \`"每日17:50"\` / \`"每周一10:00"\` / \`"30分钟后"\` / \`"明天9:00"\` |

## 子命令

### 创建

\`\`\`
botmux schedule add "<schedule>" "<prompt>" [--name <name>] [--deliver origin|local] [--new-topic]
\`\`\`

prompt 是到点时会被执行的内容，就像用户新开一个话题向你发送这段 prompt 一样。
可选 \`--deliver local\` 表示只记录不推送（适合"每小时检查一次，没事就别打扰我"）。
可选 \`--new-topic\`（等价 \`--deliver new-topic\`）：每次触发都在同群开一个**全新话题**、起一个独立 CLI 会话，多次执行互不串扰（适合日报这类"每天一篇、各自独立"的任务）。斜杠命令里也可在 prompt 前加"新话题"关键字，如 \`/schedule 每日9:00 新话题 生成日报\`。

### 查看

\`\`\`
botmux schedule list
\`\`\`

### 管理

\`\`\`
botmux schedule pause <id>     # 暂停（不删除）
botmux schedule resume <id>    # 恢复
botmux schedule remove <id>    # 删除
botmux schedule run <id>       # 标记立即执行（< 30 秒内 daemon 会触发）
\`\`\`

## 典型用法

**用户**："每天早上 9 点生成一下昨天的 PR 汇总"

你先跟用户确认：我打算建一个每天 09:00 的定时任务，到点自动在本话题生成 PR 汇总，可以吗？

用户确认后执行：

\`\`\`bash
botmux schedule add "每日9:00" "生成昨天的 GitHub PR 汇总（合并的 / 待 review 的），按 repo 分组"
\`\`\`

**用户**："30 分钟后提醒我检查一下部署状态"

\`\`\`bash
botmux schedule add "30m" "检查部署状态（调用 kubectl get pods 看看有无 CrashLoop）"
\`\`\`

## 到点会发生什么

- botmux daemon 每 30 秒 tick 一次，到点会在**原话题**里自动续一条消息并把 prompt 喂给一个新的 CLI 会话
- 工作目录与创建任务时一致
- 如果原话题的会话还活着，prompt 会直接注入现有会话（不会开新会话）

## 跨群发布场景（changelog 群、动态频道等）

如果定时任务的目的是"把内容发到另一个群作为顶层消息"（而不是回复到当前话题），让 prompt 内部用 \`botmux send --top-level --chat-id <目标群>\` 即可。任务本身仍然创建在当前话题里——这样：

- "🕐 task 开始执行" + 流式卡片留在你当前话题，方便监控
- 实际内容作为顶层消息发到目标群，不绑定话题、不 @ 你

\`\`\`bash
botmux schedule add "每日11:00" "
1. <做事>
2. botmux send --top-level --chat-id oc_xxxxxxxxxxxx '推送内容...'
"
\`\`\`

详见 \`botmux-send\` 技能的"顶层广播 / 跨群发布"章节。
`;

const HISTORY_SKILL = `---
name: botmux-history
description: 需要查看当前飞书会话历史消息时触发。话题/thread 会话默认拉话题内消息；普通群 chat-scope 会话拉整群最近 N 条（默认 50，用 --limit 调节）。普通群通过 /t 或 per-bot 配置开出的 thread 会话也按话题内读取。在 thread 内如果需要 thread 外的群聊上下文，用 --scope ambient。适合"看看之前聊了什么"、"最近的消息"、"上下文"类请求。在 CLI 会话内自动推断 session-id。
---

# botmux-history — 读取会话消息历史

想回顾当前飞书会话里用户之前发过什么、别的机器人说了什么时使用。**话题群和普通群都支持**：默认按当前 session 范围读取；话题/thread 会话只返回当前话题内消息，普通群 chat-scope 会话返回整群最近 N 条（默认 50，按时间倒序取尾部、再按时间正序返回）。普通群通过 \`/t\` 或 per-bot 的普通群开话题回复配置启动时，也会是 thread 会话。觉得历史太多就把 \`--limit\` 调小，需要更多上下文就调大。

如果你在 thread 里需要读取 thread 外的群聊上下文（典型场景：用户在普通群讨论后用 \`/t\` 或普通群开话题回复单开话题叫你处理），使用 \`botmux history --scope ambient --limit 20\`。它会读取当前 thread 所在群里、thread root 之前的最近消息，并排除当前 thread 本身，适合作为环境上下文。注意隐私边界：ambient 会读取 thread 外群聊消息，仅在用户明确需要群聊背景时使用，并优先使用较小的 limit。

## 用法

\`\`\`bash
# 拉取最近 50 条（默认）
botmux history

# 拉取最近 100 条
botmux history --limit 100

# 指定 session-id（不在 CLI 会话内时用）
botmux history --session-id <uuid>

# 在 thread 内读取 thread 外的群聊环境上下文（/t 场景优先用这个）
botmux history --scope ambient --limit 20

# 在 thread 内强制读取整个群聊最近消息（包含其他话题/卡片，噪音更大）
botmux history --scope chat --limit 50
\`\`\`

## 输出

JSON 格式，字段：

\`\`\`json
{
  "sessionId": "...",
  "chatId": "...",
  "scope": "thread" | "chat" | "ambient",
  "sessionScope": "thread" | "chat",
  "rootMessageId": "...",     // 仅 sessionScope=thread 时存在（包括 scope=ambient）
  "ambient": {                 // 仅 scope=ambient 时存在
    "source": "chat",
    "beforeCreateTime": "...",
    "excludeRootMessageId": "..."
  },
  "messages": [
    { "messageId": "...", "senderId": "...", "senderType": "user|app", "msgType": "text|post|interactive", "content": "...", "createTime": "..." }
  ],
  "total": 17
}
\`\`\`

## 注意

- \`scope=thread\`：只返回属于当前话题的消息（按 rootMessageId 过滤）
- \`scope=chat\`：返回当前群整群最近 N 条消息（不限于 session 创建之后，需要更老的就把 --limit 调大）
- \`scope=ambient\`：返回当前 thread 外的群聊上下文，默认排除当前 thread，并优先限制在 thread root 创建前，适合 \`/t\` 后补充群内讨论背景；仅在用户明确需要群聊背景时使用，并优先小 \`--limit\`
- \`senderType="app"\` 表示机器人发的消息（包括 Claude Code / Codex / 其它 bot），\`"user"\` 表示用户
- **合并转发**消息会自动展开：\`msgType\` 变为 \`merge_forward_expanded\`，\`content\` 是 \`<forwarded_messages>...</forwarded_messages>\` XML（含 \`<participants>\` 别名表 + 嵌套 \`<msg from="A">\` 节点），与 daemon 实时事件路径一致
- 需要先把 JSON 读进来再做总结，不要直接把 JSON 扔给用户
`;

const QUOTED_SKILL = `---
name: botmux-quoted
description: 当 prompt 顶部出现 \`[用户引用了消息 用 botmux quoted om_xxx 查看]\` 提示时，用本技能按需读取被引用的那条消息内容。看到这种提示就该判断引用内容是否对当前任务必要，必要就调用，不必要就跳过。
---

# botmux-quoted — 读取被引用的消息

用户在飞书里使用"引用回复" UI @ 机器人时，daemon 会在喂给你的 prompt 头部加一行：

\`\`\`
[用户引用了消息 用 botmux quoted om_xxx 查看]
<用户的实际文字>
\`\`\`

看到这种提示，先判断引用内容是否对当前任务必要：必要就调用 \`botmux quoted om_xxx\` 拉取，不必要就忽略（不要无脑调用、污染上下文）。

## 用法

\`\`\`bash
botmux quoted <message_id>
\`\`\`

\`message_id\` 直接从提示行里复制即可。

## 输出

JSON 格式，与 \`botmux history\` 的单条消息字段一致，并附带 \`resources\` 列表：

\`\`\`json
{
  "messageId": "om_xxx",
  "senderId": "ou_xxx",
  "senderType": "user|app",
  "msgType": "text|post|interactive|image|file|merge_forward_expanded",
  "content": "...",
  "createTime": "1234567890000",
  "resources": [{"type":"image","key":"img_v3_xxx","name":"img_v3_xxx.jpg"}]
}
\`\`\`

## 注意

- 图片/文件渲染成 \`[图片 N]\` / \`[文件 N: name.pdf]\` 占位符（与 \`botmux history\` 一致），实际附件 key 在 \`resources\` 列表里
- 卡片消息会被解析成可读文本
- 合并转发消息会自动展开
- 当前不支持自动下载附件本地化；要看图片实际内容，目前只能让用户单独转发或 \`botmux send\` 询问
`;

const SEND_SKILL = `---
name: botmux-send
description: 向飞书话题发送消息。用户在飞书上阅读看不到终端输出，需要用户看到的内容（关键结论、方案、最终结果、进度更新）必须通过 botmux send 发送。支持图文混排（图片穿插在 markdown 正文中）、文本、图片/文件附件、@mention。**当你自主执行任务撞到只有人类才能解除的硬阻碍、无法靠自己继续时（需要授权/凭证、要人拍不可逆决策、缺访问权限、需求歧义自己定不了），回消息时带 \`--attention\` 举手**——既把"我卡在哪、需要你做什么"发给用户，又把本会话标进 dashboard「需要你」列，让人一眼看到哪个任务卡住、为什么卡。
---

# botmux-send — 向飞书话题发送消息

**核心规则**：用户在飞书上阅读，看不到你的终端输出。想让用户看到的内容**必须**通过 \`botmux send\` 发送。

**格式自动处理**：内容含 markdown 语法时自动用飞书卡片（schema 2.0）发送，原生渲染；纯文本走普通消息。**该用 md 就用 md**——结构化内容（列表、表格、代码块）不要手撸成纯文本。

## 什么时候用

- 关键结论、方案（等用户确认再执行）
- 最终结果
- 进度更新（长任务的中途汇报）
- 需要用户回复的问题

## 什么时候不用

- 中间过程的调试输出
- 给自己看的分析笔记
- 纯粹的代码操作（编辑/运行命令）

## 卡住了需要人介入：\`--attention\`

自主跑任务时撞到**只有人类才能解除**的硬阻碍、无法继续时，回消息带 \`--attention\` 举手：消息照常发出，同时本会话进 dashboard「需要你」列、并把原因显示给用户。

\`\`\`bash
botmux send --attention --mention-back "需要 prod 部署授权才能继续发布 v2.3，你授权后我接着走"
botmux send --attention=decision --mention-back "迁移会删 old_users 表（不可逆），确认我再执行"
botmux send --attention=blocked --mention-back "缺 TOS 上传密钥，拿不到没法继续"
\`\`\`

- \`--attention\` 默认 kind=blocked；\`--attention=authz|decision|blocked|help\` 指定类别。
- 引号里就是消息正文，也是看板上显示的 reason——**一句话说清卡在哪、要人做什么**。
- 举手是**非阻塞**的：发完就返回，你应当随即**结束本轮、停下等人**，别空转、别反复举手。
- 用户**一旦回复本会话**，举手信号**自动撤下**，你按新指示继续即可。无需手动清除。
- **只用于回复当前会话的文本/卡片消息**：不能与 \`--top-level\` / \`--chat-id\` / \`--into\` / \`--voice\` 混用（否则消息发到别处、撤下绑定会裂，或绕过举手置位路径）。也必须有文本正文（看板要显示 reason）。

**什么时候不要 \`--attention\`**：常规进度汇报、你自己查得到/能合理假设的事、只是想确认一下——都用普通 \`send\`。这是"我真卡住了、必须人来"的信号，不是闲聊也不是汇报。需要用户在**给定选项里二选一**那种用 \`botmux ask\`（发按钮、阻塞等结果）。

## 用法

### 纯文本（最常见）

多行内容不要写成 \`botmux send "第一行\\n第二行"\`，否则用户会在飞书里看到字面量 \`\\n\`。在 Unix shell 里可用 heredoc；在 Windows/PowerShell 里发送包含中文或 emoji 的多行内容时，必须先写 UTF-8 文件，再用 \`--content-file\`，不要把中文直接通过 here-string、\`echo\` 或管道送进 stdin。

\`\`\`bash
# 直接传参
botmux send "分析完成，核心问题是 X"

# Unix shell: heredoc
botmux send <<'EOF'
## 分析报告

1. 发现问题 A
2. 建议方案 B

需要你确认后我再动手。
EOF

# 管道
echo "构建成功 ✅" | botmux send
\`\`\`

\`\`\`powershell
# Windows PowerShell: 中文/emoji 多行内容
$msg = Join-Path $env:TEMP "botmux-message.md"
@'
## 分析报告

1. 发现问题 A
2. 建议方案 B

需要你确认后我再动手。
'@ | Set-Content -LiteralPath $msg -Encoding utf8
botmux send --content-file $msg
\`\`\`

> ⚠️ **重要：single-quoted heredoc \`<<'EOF'\` 内反引号直接写真反引号，不要加反斜杠转义。**
> 原因：单引号 heredoc 已经禁用所有特殊字符解释（\`$\`、反斜杠、反引号一律按字面量处理）。再加反斜杠反而会把"反斜杠+反引号"作为字面字符混进 markdown，让 markdown-it 按 CommonMark 的 backslash-escape 处理——结果卡片里三反引号变成可见字符、代码块整段废掉。
> 自检：写完 bash 命令后扫一眼，如果 EOF 块内**任何反引号前面带反斜杠**，删掉那个反斜杠。Windows/PowerShell 需要中文或 emoji 时优先用上面的 \`--content-file\` 写法。

### 可用的 markdown 语法（自动走卡片）

| 语法 | 渲染 |
|---|---|
| \`# / ## / ###\` 标题 | 转**加粗**（v2 markdown 元素不支持 ATX 标题） |
| \`**加粗**\` / \`*斜体*\` / \`~~删除线~~\` | 原生渲染 |
| \`\\\`inline code\\\`\` / \\\`\\\`\\\` 代码块 \\\`\\\`\\\` | 原生渲染（代码块内 \`#\` 和 \`|\` 不会被误解析） |
| \`- 项\` / \`1. 项\` / 嵌套列表 | 原生渲染 |
| \`[文本](url)\` 链接 | 原生渲染 |
| \`> 引用\` / \`---\` 分隔线 | 原生渲染 |
| pipe 表格 | **原生 table 组件**（不是 monospace 伪表格） |
| \`<at id=open_id></at>\` | @mention（一般用 \`--mention\` 自动注入，无需手写） |

**不支持**：外链图片 \`![](http://...)\`（飞书 markdown 元素只认本地上传的 img_key）、setext 标题（\`===\` 下划线式）、HTML 标签。

### 图文混排（图片穿插在正文中）

\`--images <path>\` 上传本地图片（可重复）。在 markdown 正文中用占位符 \`![alt](img:N)\` 标记位置（\`N\` 是 0-based 索引，按 \`--images\` 给出的顺序对应）；不写占位符的图片自动追加到消息末尾。

**多图一行（图片组合）**：一个占位符里写多个逗号分隔的索引，就把这几张图排成一行并列显示（自动等宽缩放、保留完整画面不裁剪）——\`![](img:0,1)\` 两张一行，\`![](img:0,1,2)\` 三张一行。每个占位符是一行，想多行就写多个占位符。适合菜单、多图对比这类「一屏看完」的场景，避免单图全宽纵向堆很长。

\`\`\`bash
# 单图：默认追加到末尾
botmux send --images /tmp/screenshot.png "截图如上，红框部分是问题所在。"

# 图文混排：占位符控制图片位置
botmux send --images chart.png --images table.png <<'EOF'
## 销售报告

第一张是趋势图：

![趋势](img:0)

明细见下表：

![明细](img:1)

环比 +12%。
EOF
\`\`\`

只支持本地路径上传，外链图片 \`![](http://...)\` 不会渲染。

### 带文件附件

\`\`\`bash
botmux send --files /tmp/report.pdf "报告已生成，请查收附件。"
\`\`\`

### @mention 其他机器人协作

\`\`\`bash
# 先查可用机器人
botmux bots list

# 形式 A：带名字 — 文本里 @Aiden 被替换成 <at> 标签
botmux send --mention "ou_xxx:Aiden" "请 @Aiden 帮忙 review 这段代码"

# 形式 B：只传 open_id — 在消息末尾追加 @mention 通知
botmux send --mention ou_xxx "帮忙看下这段代码"
\`\`\`

### @ 决策硬门（必读）

每条回复**必须显式做出 @ 决策**，否则 \`botmux send\` 报错（exit 2）不发送。三选一：

| flag | 何时用 |
|---|---|
| \`--mention <ou_xxx:Name>\` | 点名某人/某 bot（可重复） |
| \`--mention-back\` | @ 回**本轮触发消息的发送者**（open_id 自动从会话取，你不用记） |
| \`--no-mention\` | 明确声明本条不 @ 任何人 |

> ⚠️ \`--mention-back\` / \`--no-mention\` 是开关，后面不跟任何参数；要 @ 具体的人用 \`--mention <open_id:名字>\`。正文来源按 \`--content-file > 位置参数 > stdin\` 选择，多行正文推荐只放在 heredoc/stdin 中。

决策规则（**按内容价值判断，不是按"人还是 bot"**）：
- **有实质结论、需要对方继续看 / 确认 / 决策** → \`--mention-back\`（@回触发者）或 \`--mention\` 点名，确保对方看到。
- **纯记录 / 低优先级进度 / 简短确认（"收到""在看"）** → \`--no-mention\`，别打扰。
- **如果只是没信息量的"收到"** → 不如不发，等下一条有内容时再回。
- ⚠️ 别把 \`--no-mention\` 当默认随手带；也别无意义地 @ 打扰人。

\`\`\`bash
# 回复触发你的那个人，并 @ 回 ta
botmux send --mention-back "好的，已处理完成。"
# 纯状态更新，不想惊动任何人
botmux send --no-mention "后台任务还在跑，预计 5 分钟。"
\`\`\`

（可设环境变量 \`BOTMUX_REQUIRE_MENTION_DECISION=false\` 关闭此硬门。）

### 引用串联（普通群）

普通群里，回复默认会**引用本轮触发的那条消息**（飞书"引用"样式），把对话串成可追溯的链——你无需做任何事。

\`\`\`bash
# 默认：自动引用本轮触发消息
botmux send --no-mention "收到，开始处理。"
# 引用某条特定历史消息
botmux send --quote om_xxxxxx --no-mention "针对上面这条补充一点"
# 发独立消息、不引用任何人
botmux send --no-quote --no-mention "📢 全员通知"
\`\`\`

话题群（话题形态）不支持逐条引用，此能力仅在普通群生效。

### 顶层广播 / 跨群发布

默认行为：消息**回复**到当前话题里。如果要把内容发到群里作为新的顶层消息（不绑定到任何已有话题），或要发到**另一个群**，用 \`--top-level\` 和 \`--chat-id\`。

适用场景：定时任务把更新推到对外发布频道（changelog 群、动态群）；当前会话向另一个群广播通知。

\`\`\`bash
# 在当前群发顶层消息（不回复进当前话题）
botmux send --top-level "📢 重要更新：xxx"

# 跨群顶层发布（任意群，给定 chat_id）
botmux send --top-level --chat-id oc_xxxxxxxxxxxx "📦 自动推送内容..."
\`\`\`

\`--top-level\` 模式下不会附加"发送给：@xxx / cc：xxx" 那行 footer（顶层广播没有特定收件人）。oncall 寻址也会跳过。

## 参数

| 参数 | 说明 |
|---|---|
| (positional 或 stdin) | 消息文本（支持 markdown，自动选择卡片/文本模式） |
| \`--content-file <path>\` | 从文件读取内容（优先于 stdin/positional） |
| \`--images <path>\` | 内联图片，可重复多次 |
| \`--files <path>\` | 附件文件，可重复多次，每个单独发送 |
| \`--mention <open_id[:name]>\` | @mention，可重复。带 \`:name\` 时文本里的 \`@name\` 会被替换成 \<at\> 标签；只传 open_id 则在消息末尾追加 @。用 \`botmux bots list\` 查 open_id |
| \`--mention-back\` | @ 回本轮触发消息的发送者（open_id 自动从会话取）。满足 @ 硬门 |
| \`--no-mention\` | 明确声明本条不 @ 任何人。满足 @ 硬门 |
| \`--quote <message_id>\` | 引用指定消息（普通群）。默认引用本轮触发消息 |
| \`--no-quote\` | 不引用，发独立消息（普通群） |
| \`--top-level\` | 发顶层消息（不回复进当前话题）；自动跳过"发送给/cc" footer |
| \`--chat-id <oc_xxx>\` | 指定目标群（默认当前会话所在群）；常和 \`--top-level\` 一起用做跨群发布 |
| \`--session-id <id>\` | 手动指定 session（通常自动推断，不需要传） |

## 输出

成功返回 JSON: \`{"success":true,"messageId":"om_xxx","sessionId":"...","quotedMessageId":"om_yyy 或 null","mentioned":[{"open_id":"ou_x","name":"Codex"}]}\`
其中 \`quotedMessageId\` 是实际引用的消息（纯发为 null），\`mentioned\` 是实际 @ 的对象。stderr 另给一行人类可读摘要。
失败 exit 1；**未做 @ 决策 exit 2**（按提示补 \`--mention\`/\`--mention-back\`/\`--no-mention\`）。
`;

const BOTS_SKILL = `---
name: botmux-bots
description: 列出当前飞书群里可协作的机器人（协作花名册：含能力标签、是否有团队角色、以及你能否可靠 @ 到它）。在需要点名其他机器人协作、或交棒给队友前查看时使用。
---

# botmux-bots — 群内协作花名册

## 用法

\`\`\`bash
botmux bots list
\`\`\`

## 输出（JSON）

每个机器人一行，关键字段：
- \`name\` / \`openId\` / \`isSelf\`
- \`larkAppId\`：本机托管的机器人才有（可用作 workflow 的 bot id）
- \`capability\`：团队能力标签（它擅长什么）——挑选交棒/协作对象的依据
- \`hasTeamRole\`：是否配置了团队级角色
- \`mentionable\`：**你能不能可靠地 @ 到它**（关键）
- \`mentionSource\`：\`cross-ref\` | \`observed\` | \`self\` | \`fallback\`

\`\`\`json
{
  "sessionId": "...",
  "chatId": "...",
  "bots": [
    { "name": "后端Bot", "openId": "ou_yyy", "isSelf": false, "larkAppId": "cli_b",
      "capability": "服务端排查，擅长日志", "hasTeamRole": true,
      "mentionable": true, "mentionSource": "cross-ref" }
  ],
  "total": 1
}
\`\`\`

## 关键规则

1. **只 @ \`mentionable=true\` 的机器人**。\`mentionable=false\` 表示"知道它在群里，但当前点不准"（飞书 open_id 按 app 隔离）——这种先让它 / 用户在群里 \`/introduce\` 一次，再点名。
2. 按 \`capability\` 挑合适的队友，而不是乱点。
3. 配合 botmux send：\`botmux send --mention "ou_yyy:后端Bot" "请帮忙处理"\`

## 要把任务交棒给别的机器人？

见 **botmux-handoff** 技能（结构化交接）。
`;

const HANDOFF_SKILL = `---
name: botmux-handoff
description: 把当前任务交棒给团队里另一个机器人时使用（多机器人协作接力）。当你做完自己负责的部分、需要另一个机器人接手下一步，或用户说"交给X""让X接着做""@某bot继续""下一步谁谁来"时触发。先用 botmux-bots 查花名册挑对象，再用结构化交接发给对方。
---

# botmux-handoff — 机器人接力交棒

多机器人协作里，一个机器人干完自己那段后把任务交给另一个机器人接手。**随意闲聊可以不拘格式**，但正式交棒要带最小结构，否则接手方拿不到足够上下文、交接质量不可控。

## 步骤

1. 用 \`botmux bots list\`（见 botmux-bots 技能）查群内协作花名册：
   - 按 \`capability\` 挑**合适**的接手机器人；
   - 确认它 \`mentionable: true\`（若为 false，先让它/用户 \`/introduce\` 一次再点名）。
2. 用 \`botmux send --mention\` 发一条**结构化交接**给它。

## 交接必须包含 5 要素

- **交给谁**：@ 目标机器人
- **当前结论**：你已经做完/查清了什么
- **相关上下文**：链接、关键消息、文件路径、数据
- **期望下一步**：希望它具体做什么
- **完成标准**：怎样算这一步做完

## 示例

\`\`\`bash
botmux send --mention "ou_yyy:后端Bot" <<'EOF'
@后端Bot 交接：
- 当前结论：定位到支付回调超时，错误集中在 09:00–09:10，日志 https://...
- 上下文：服务 pay-gateway，最近一次变更 PR #1234
- 期望下一步：判断是否回滚 #1234，并给出修复方案
- 完成标准：给出根因结论 + 可执行的修复/回滚决定
EOF
\`\`\`

## 注意

- 跨部署的外部机器人若 \`mentionable: false\`，**先 \`/introduce\` 一次**再交棒（飞书 open_id 按 app 隔离）。
- 人主导的协作可以不走这套结构；本技能针对**机器人自主接力**。
- 交棒后简短告知用户"已交给 @X 接手"，保持可见。
`;

const WORKFLOW_CREATE_SKILL = `---
name: botmux-workflow-create
description: 根据用户自然语言描述生成 botmux workflow JSON 定义文件。触发场景：用户说"我想做个流程"、"创建 workflow"、"把 X 拆成自动化"、"编排"、"orchestrate"、"自动化跑这几步"；或显式提到 botmux workflow create。必须先用 botmux bots list 查看可用 bot，先给用户确认设计，再写 $HOME/.botmux/workflows/<workflowId>.workflow.json，并用 botmux workflow validate 校验。
---

# botmux-workflow-create — Workflow 编排助手

把用户口头描述的几步任务翻译成可执行的 workflow JSON。本 skill 只负责设计、生成、校验，不负责启动 run；启动用 \`botmux workflow run <id>\` 或 IM \`/workflow run <id>\`。

## 硬规则

1. 不要在用户确认设计稿前写文件。
2. 必须先跑 \`botmux bots list\`，按输出里的 **\`larkAppId\`**（形如 \`cli_xxxxxxxxxxxxxxxx\`）填 \`subagent.bot\`。**不要填 \`name\`**——\`name\` 是 Lark 群里的 displayName（admin 可改、可能带后缀），跨 daemon 必然解析失败。larkAppId 是 bot 的全局唯一 ID。
3. 写到 \`$HOME/.botmux/workflows/<workflowId>.workflow.json\`（**绝对路径**，daemon 的全局位置）。不要写到当前 cwd 的 \`./workflows/\`——CLI agent 和 daemon 进程的 cwd 不一定一致。\`workflowId\` 推荐 kebab-case。
4. 写完必须跑 \`botmux workflow validate $HOME/.botmux/workflows/<workflowId>.workflow.json\`，失败就按错误修到通过。
5. 高风险节点主动建议 \`humanGate\`：发消息、写文件、外部 API、git push、删除/覆盖。纯读、草稿、纯计算通常不加 gate。
6. 数据流有两套语法：**整字段 \`$ref\` 替换** 和 **字符串内 \`\${...}\` 内嵌引用**。**不要**写 \`{{...}}\` 期望 runtime 展开——支持的是 \`\${...}\`，不是双花括号。
7. 两套语法的边界：
   - **整字段 \`$ref\`**（值可以是任意类型，含对象/数组）：
     - \`{ "$ref": "<nodeId>.output.<path>" }\` 引上游节点输出
     - \`{ "$ref": "params.<path>" }\` 引启动时的入参（嵌套用点号：\`params.user.email\`）
     - \`$ref\` 对象必须独占，不能有兄弟 key
   - **字符串内 \`\${...}\` 内嵌**（仅用在 string 字段里，例如 prompt / humanGate.prompt / hostExecutor.input 的 string 值）：
     - \`"prompt": "查询 \${params.city} 未来 \${params.days} 天天气"\`
     - \`"prompt": "基于天气数据 \${fetchWeather.output.summary} 出行规划"\`
     - 引用值只能是 string / number / boolean / null；object / array 会运行时报 BindingError，要用整字段 \`$ref\` 而非内嵌

## 工作流程

### Step 1 — 理解需求

先复述你理解的流程拆分，必要时问 1-3 个澄清问题。不要直接写 JSON。

### Step 2 — 查 bot 清单

\`\`\`bash
botmux bots list
\`\`\`

输出每个 bot 的 \`name\`（人类可读 displayName，仅供你判断哪个 bot 适合做什么）和 \`larkAppId\`（形如 \`cli_xxxxxxxxxxxxxxxx\`，**这是真正要填进 workflow.subagent.bot 的值**）。

### Step 3 — 给用户确认设计草案

用表格展示节点设计（"bot" 列用人类可读名字给用户看，但实际写进 JSON 是 larkAppId）：

| 节点 id | 类型 | bot/executor | 做什么 | 依赖 | humanGate |
|---|---|---|---|---|---|
| draft | subagent | claude-loopy (cli_a930…) | 写草稿 | - | - |
| send | hostExecutor | feishu-send | 发到群里 | draft | 审批草稿 |

同时说明：
- 为什么选择这个 bot 或 executor；
- 哪些字段从上游 output 通过 \`$ref\` 传递；
- 哪些节点需要 humanGate，以及原因。

等用户明确确认后再写文件。

### Step 4 — 生成 JSON

创建 \`$HOME/.botmux/workflows/<workflowId>.workflow.json\`（**绝对路径**，不要写相对路径）。每个 subagent 节点的 \`bot\` 字段必须填 larkAppId（\`cli_xxx...\`），不是 displayName。每个 node 建议写 \`description\`，记录设计理由或 bot 选择理由。

### Step 5 — 校验

\`\`\`bash
botmux workflow validate $HOME/.botmux/workflows/<workflowId>.workflow.json
\`\`\`

validate 能抓 JSON/schema/graph 错误；但它**不会**检查 bot 是否真的存在，也不会检查 \`$ref\` 指向的 output 字段是否运行时一定存在——所以你仍要人工核对 bots list（larkAppId 一定要逐字符匹配）和 outputSchema。

### Step 6 — 交付

告诉用户文件路径、validate 结果、启动命令：

\`\`\`bash
botmux workflow run <workflowId> --param key=value
# 或在飞书话题里:
/workflow run <workflowId> key=value
\`\`\`

如果 workflow 定义了 object / array 类型入参，CLI 用 \`--param-json key=<json>\`；IM \`/workflow run\` 暂不支持 object / array 入参。

## Schema 速查

顶层：

\`\`\`json
{
  "workflowId": "my-workflow",
  "version": 1,
  "params": {
    "name": { "type": "string", "required": true, "description": "human input metadata" }
  },
  "defaults": {
    "retryPolicy": { "maxAttempts": 1, "backoff": "fixed", "baseMs": 1000 },
    "timeoutMs": 60000,
    "maxOutputBytes": 4096
  },
  "nodes": {}
}
\`\`\`

\`params\` 是启动 run 时传入的入参，会被 **严格校验**：

- schema 字段：\`type\`（\`string|number|boolean|object|array\`）、\`required\`、\`default\`、\`description\`、\`format\`。
- 未知参数会被拒绝：\`未知参数：<key>\`。
- 缺必填参数会被拒绝：\`缺少必填参数：<key>\`。
- 类型不匹配会被拒绝，例如 \`参数 retries 必须是 number,收到 "abc"\`、\`参数 dryRun 必须是 boolean (true/false/1/0/yes/no),收到 "maybe"\`。
- 所有错误会聚合一次性报出，不会让用户一轮只修一个问题。
- optional 参数没传且有 \`default\`：runtime 会把 default 原样 materialize 到 run input。
- optional 参数没传且没有 \`default\`：字段缺省；后续引用 \`\${params.X}\` / \`{ "$ref": "params.X" }\` 会在绑定阶段报错。

启动语法：

\`\`\`bash
# CLI: 标量 string / number / boolean
botmux workflow run weather-city --param city=上海 --param days=3 --param dryRun=false
botmux workflow run weather-city --param=city=上海

# CLI: object / array 或者需要保留 JSON 类型的值
botmux workflow run batch-send --param-json tags='["urgent","cn"]'
botmux workflow run batch-send --param-json config='{"mode":"safe","limit":3}'

# IM: 只支持 key=value 标量；object / array 暂不支持
/workflow run weather-city city=上海 days=3 dryRun=false
\`\`\`

在节点里既可以用 \`{ "$ref": "params.<path>" }\` 整字段替换，也可以在字符串里 \`"\${params.<path>}"\` 内嵌（仅限值是标量时）。嵌套对象用点号路径：\`params.user.email\`。

subagent node：

\`\`\`json
{
  "type": "subagent",
  "bot": "cli_xxxxxxxxxxxxxxxx",
  "prompt": "Static prompt string, or a whole-field { \\"$ref\\": \\"draft.output.text\\" }",
  "depends": ["draft"],
  "humanGate": { "stage": "before", "prompt": { "$ref": "draft.output.preview" } },
  "outputSchema": { "type": "object" },
  "description": "Why this bot/node exists"
}
\`\`\`

hostExecutor node：

\`\`\`json
{
  "type": "hostExecutor",
  "executor": "feishu-send",
  "depends": ["draft"],
  "input": {
    "larkAppId": "cli_xxx",
    "chatId": "oc_xxx",
    "content": { "$ref": "draft.output.text" },
    "msgType": "text"
  },
  "description": "Side effect node; usually gated before execution"
}
\`\`\`

已知默认 hostExecutor：
- \`botmux-schedule\`：创建 botmux schedule task。
- \`feishu-send\`：向 chatId 发飞书消息。
- \`feishu-reply\`：回复 rootMessageId。

如果用户提到其他 executor，先问他 executor 名和 input schema，不要猜。

humanGate：

\`\`\`json
{
  "stage": "before",
  "prompt": "literal text or whole-field $ref",
  "approvers": [],
  "deadlineMs": 600000,
  "onTimeout": "fail"
}
\`\`\`

- \`stage\` 只支持 \`"before"\`。
- \`approvers: []\` 或省略 = 任何 bot allowedUsers 都能批；非空 = open_id 白名单。
- gate prompt 如果要展示上游产物，推荐让上游输出一个完整 \`preview\` 字段，然后写 \`{ "$ref": "draft.output.preview" }\`。

## 数据流规则

两种引用语法：

**整字段 \`$ref\`**（任何类型，独占对象）：
\`\`\`json
{ "$ref": "draft.output.text" }
{ "$ref": "params.user" }
\`\`\`

**字符串内 \`\${...}\` 内嵌**（只用在 string 字段，引用值必须是标量）：
\`\`\`json
"prompt": "查询 \${params.city} 未来 \${params.days} 天天气"
"prompt": "基于天气 \${fetchWeather.output.summary} 出行建议"
\`\`\`

共同约束：
- 引用路径形式：\`<nodeId>.output.<path>\` 或 \`params.<path>\`，路径用点号嵌套。
- 引用某个 node 的 output 时，当前 node 必须在 \`depends\` 里声明该 node。
- 引用 \`params.<path>\` 时，不需要写 \`depends\`。
- validate 不会证明 output 字段存在；用 \`outputSchema\` 和 few-shot prompt 约束 subagent 返回 JSON。

两种语法怎么选：
- 上游产物本身是字符串、整段灌给下游 → 整字段 \`$ref\`（更便宜，不需要 string concat）
- 模板需要把多个引用 / 标量参数拼进同一句话 → 字符串内 \`\${...}\`
- 引用值是对象/数组 → 必须整字段 \`$ref\`，**不能**塞进 \`\${...}\` 拼字符串

\`\${...}\` 内嵌的限制：
- 只在字符串字段里识别（prompt / humanGate.prompt / hostExecutor.input 的 string 值）；对象 / 数组字段里的 string 也支持。
- 引用值是 object / array 时报 \`BindingError\`——错误消息会建议改用整字段 \`$ref\`。
- 整字段 \`$ref\` 对象必须独占，不能有兄弟 key（schema 强制）。

## humanGate 启发式

| 操作 | humanGate | 理由 |
|---|---|---|
| 发飞书消息、邮件 | 加 | 不可撤回或高可见 |
| 写 repo 文件、git commit/push | 加 | 影响代码状态 |
| 调外部写 API、付费 API | 加 | 副作用或成本 |
| 删除、覆盖 | 加 | 高风险 |
| 纯读、草稿、总结、纯计算 | 通常不加 | gate 噪音大 |

一般把 gate 放在副作用节点的 \`humanGate.stage="before"\`，让用户审批最终将要发送/执行的内容。

## 范例 A — subagent → humanGate → subagent

\`\`\`json
{
  "workflowId": "hello-review",
  "version": 1,
  "defaults": {
    "retryPolicy": { "maxAttempts": 1, "backoff": "fixed", "baseMs": 1000 },
    "timeoutMs": 60000,
    "maxOutputBytes": 4096
  },
  "nodes": {
    "draft": {
      "type": "subagent",
      "bot": "cli_xxxxxxxxxxxxxxxx",
      "prompt": "Write a short greeting. Return JSON: {\\"preview\\": string, \\"text\\": string}.",
      "outputSchema": {
        "type": "object",
        "required": ["preview", "text"],
        "properties": {
          "preview": { "type": "string" },
          "text": { "type": "string" }
        }
      },
      "description": "Generate the draft greeting."
    },
    "finalize": {
      "type": "subagent",
      "bot": "cli_xxxxxxxxxxxxxxxx",
      "depends": ["draft"],
      "humanGate": {
        "stage": "before",
        "prompt": { "$ref": "draft.output.preview" },
        "deadlineMs": 600000,
        "onTimeout": "fail"
      },
      "prompt": { "$ref": "draft.output.text" },
      "outputSchema": {
        "type": "object",
        "required": ["message"],
        "properties": { "message": { "type": "string" } }
      },
      "description": "Run only after approval and produce the final JSON."
    }
  }
}
\`\`\`

## 范例 B — subagent → gated feishu-send（演示 params 注入）

启动：\`botmux workflow run weekly-report --param larkAppId=cli_xxx --param chatId=oc_xxx\`

\`\`\`json
{
  "workflowId": "weekly-report",
  "version": 1,
  "params": {
    "larkAppId": { "type": "string", "required": true, "description": "Target Lark app for the send" },
    "chatId": { "type": "string", "required": true, "description": "Target chat (open_chat_id)" }
  },
  "defaults": {
    "retryPolicy": { "maxAttempts": 1, "backoff": "fixed", "baseMs": 1000 },
    "timeoutMs": 60000,
    "maxOutputBytes": 8192
  },
  "nodes": {
    "draft": {
      "type": "subagent",
      "bot": "cli_xxxxxxxxxxxxxxxx",
      "prompt": "Draft a weekly report covering this week's PRs, decisions, and blockers. Return JSON: {\\"preview\\": string, \\"text\\": string}.",
      "outputSchema": {
        "type": "object",
        "required": ["preview", "text"],
        "properties": {
          "preview": { "type": "string" },
          "text": { "type": "string" }
        }
      },
      "description": "Generate report content. Prompt is static instruction; bot owns content."
    },
    "send": {
      "type": "hostExecutor",
      "executor": "feishu-send",
      "depends": ["draft"],
      "humanGate": {
        "stage": "before",
        "prompt": { "$ref": "draft.output.preview" },
        "deadlineMs": 600000,
        "onTimeout": "fail"
      },
      "input": {
        "larkAppId": { "$ref": "params.larkAppId" },
        "chatId": { "$ref": "params.chatId" },
        "content": { "$ref": "draft.output.text" },
        "msgType": "text"
      },
      "description": "Target chat parameterized via params — same workflow can target any chat."
    }
  }
}
\`\`\`

**Params 注入最适合的场景**：路由信息（chat id / app id / recipient）、模式开关（mode='draft'|'send'）、配置（threshold、超时）。也适合在 prompt 模板里用 \`\${params.city}\` 这种标量插值（"查询 \${params.city} 天气"）。**仍不适合**：完整 prompt 指令通过 params 整段传——节点的"任务定义"应该写死在 workflow.json 里，让 caller 传业务变量而非整条指令，否则 workflow 就退化成消息转发器。

## 范例 C — string template 演示

启动：\`botmux workflow run weather-city --param city=上海 --param days=3\`

\`\`\`json
{
  "workflowId": "weather-city",
  "version": 1,
  "params": {
    "city": { "type": "string", "required": true, "description": "城市名" },
    "days": { "type": "number", "required": false, "default": 3, "description": "查几天" }
  },
  "defaults": {
    "retryPolicy": { "maxAttempts": 1, "backoff": "fixed", "baseMs": 1000 },
    "timeoutMs": 180000,
    "maxOutputBytes": 8192
  },
  "nodes": {
    "fetchWeather": {
      "type": "subagent",
      "bot": "cli_xxxxxxxxxxxxxxxx",
      "prompt": "查询 \${params.city} 未来 \${params.days} 天天气，返回 JSON: {\\"summary\\": string, \\"forecast\\": [...]}.",
      "outputSchema": {
        "type": "object",
        "required": ["summary", "forecast"],
        "properties": {
          "summary": { "type": "string" },
          "forecast": { "type": "array" }
        }
      },
      "description": "params.city / params.days 通过字符串模板内嵌到 prompt 里；上游不需要再合成 prompt 字段。"
    },
    "planTrip": {
      "type": "subagent",
      "bot": "cli_xxxxxxxxxxxxxxxx",
      "depends": ["fetchWeather"],
      "prompt": "基于 \${params.city} \${params.days} 日天气概要「\${fetchWeather.output.summary}」生成出行建议，返回 JSON: {\\"plan\\": string}.",
      "outputSchema": {
        "type": "object",
        "required": ["plan"],
        "properties": { "plan": { "type": "string" } }
      },
      "description": "把 params 和上游 output 混在同一句 prompt 里——string template 比整字段 \$ref 更适合这种 fan-in 场景。"
    }
  }
}
\`\`\`

注意 \`forecast\` 是数组，**不能**嵌到 \`\${fetchWeather.output.forecast}\` 字符串里（runtime 会报 BindingError）。如果下游真的需要整个 forecast 数组，把 prompt 拆开：用 \`\${fetchWeather.output.summary}\` 做导读，再用整字段 \`{ "$ref": "fetchWeather.output.forecast" }\` 传给 hostExecutor.input 之类支持对象的字段。

## 常见错误

- **\`subagent.bot\` 填了 displayName（如 \`claude-loopy\` 或 \`aiden-oncall(d2)\`）而不是 larkAppId**：跨 daemon 必 fail，runtime 报 "Bot 'X' not found in registry"。一定填 \`cli_xxxxxxxxxxxxxxxx\`。
- **workflow 文件写到当前 cwd 的 \`./workflows/\` 而不是 \`$HOME/.botmux/workflows/\`**：CLI agent cwd 和 daemon cwd 不一致时 daemon 找不到文件。一定用绝对路径 \`$HOME/.botmux/workflows/<id>.workflow.json\`。
- 启动时传了 workflow 没声明的参数：会报 \`未知参数：foo\`。要么删掉参数，要么在顶层 \`params\` schema 里声明。
- 漏传必填参数：会报 \`缺少必填参数：city\`。启动时补 \`--param city=上海\` 或 IM \`city=上海\`。
- number 参数传了非数字：会报 \`参数 retries 必须是 number,收到 "abc"\`。改成 \`--param retries=3\`。
- boolean 参数传了非法值：会报 \`参数 dryRun 必须是 boolean (true/false/1/0/yes/no),收到 "maybe"\`。合法值包括 \`true/false/1/0/yes/no/y/n\`。
- object / array 参数用了 \`--param key=value\` 或 IM \`key=value\`：会报 \`--param-json ... IM 端目前不支持 object/array\`。CLI 改用 \`--param-json tags='["x","y"]'\` 或 \`--param-json config='{"mode":"safe"}'\`；IM 端暂不支持 object/array。
- 写 \`{{...}}\` 模板：runtime 只识别 \`\${...}\`，不识别双花括号；改成 \`\${...}\` 或整字段 \`$ref\`。
- 把对象 / 数组塞进 \`\${...}\` 字符串模板里：会报 \`BindingError\`。对象 / 数组必须用整字段 \`$ref\` 替换。
- \`$ref\` 字符串里没有 \`.output.\` 也不是 \`params.*\` 开头：parse 会报错。
- \`$ref\` 引用的 node 没写进 \`depends\`：validate 可能过，运行时顺序不可靠。
- \`humanGate.stage: "after"\`：不支持。
- \`$ref\` 对象还有其他 key：schema 会拒绝。
- nodeId 含 \`/\`、\`..\`、空格：schema 会拒绝。
- executor 名不是默认三种之一且用户没确认：不要猜。
`;

export const ASK_SKILL = `---
name: botmux-ask
description: 在当前飞书/Lark 话题里向用户发起阻塞式选择题并等待回答。触发场景：你需要用户在多个明确选项中做选择、确认风险动作、决定继续/回滚/中止，且后续命令需要拿到机器可解析的答案。使用 botmux ask buttons，stdout 只返回选中的 key，适合 shell 脚本和 CLI agent 继续执行。
---

# botmux-ask — 阻塞式向用户提问

当你需要用户在明确选项里做选择，并且后续步骤必须等用户回答后才能继续时，使用 \`botmux ask buttons\`。

## 什么时候用

- 发布、回滚、删除、写文件、调用外部 API 等风险动作前，需要用户选择
- 需求存在 2-6 个清晰分支，继续执行前必须拿到其中一个 key
- 你正在 shell / CLI 里执行任务，需要把用户选择赋给变量继续跑

## 不要用

- 只是给用户汇报进展：用 \`botmux send\`
- 需要自由文本长回答：v0.1.7 不支持，先用 \`botmux send\` 问用户
- workflow 节点审批：workflow 已经有 humanGate / decision，不要套两层 ask

## Canonical 用法

\`\`\`bash
choice=$(botmux ask buttons --options "deploy=继续发布,rollback=回滚,abort=中止" "线上 latency 涨了 30%，下一步怎么处理？")
case "$choice" in
  deploy) echo "继续发布" ;;
  rollback) echo "执行回滚" ;;
  abort) echo "中止" ;;
esac
\`\`\`

\`key=label\` 里，**stdout 永远返回 key**，按钮上显示 label。只写 \`yes,no\` 时 key 和 label 相同。

兼容 alias：\`botmux ask --options "yes,no" "继续吗？"\` 可以用，但文档和新脚本优先写 \`botmux ask buttons\`，给未来 \`ask text\` / \`ask confirm\` 留空间。

## JSON 输出

\`\`\`bash
botmux ask buttons --json --options "yes=继续,no=停止" "继续执行吗？"
\`\`\`

stdout 为一行 JSON。注意：\`--json\` 覆盖所有结果类型；超时 / 失效时也会输出 JSON，
同时保留非 0 exit code。脚本判断超时必须看 exit code 或 \`timedOut\` 字段。

\`\`\`json
{"selected":"yes","by":"ou_xxx","timedOut":false,"comment":null}
\`\`\`

## 退出码和 stdout 契约

- 成功：stdout 一行 \`<selected_key>\`，exit 0
- \`--json\`：stdout 一行 JSON（包括超时 / 失效），exit code 仍按结果返回
- 超时：默认模式 stdout 为空，exit 124；\`--json\` 时 \`{"selected":null,"timedOut":true,...}\`
- 缺少 botmux 环境变量 / 参数错误：stdout 为空，exit 2
- daemon 不可达或 ask 被 daemon restart 失效：默认模式 stdout 为空，exit 3；\`--json\` 时 \`selected:null\`

所有人类可读提示都在 stderr，调用方不要 parse stderr。

## 选项规则

- \`--options\` 必填，至少 2 项，逗号分隔
- 推荐 \`key=label\`，key 用稳定英文短词，label 给用户看
- 不支持 comment / multi-select / free-form text（v0.1.7 范围外）
- 默认超时 300 秒，可用 \`--timeout <seconds>\` 调整
`;

const ORCHESTRATE_SKILL = `---
name: botmux-orchestrate
description: 作为「主 bot/编排者」把一个大项目拆成多个子项目，在普通群里自动开多话题、把不同 bot（常 coder+reviewer 一组）派进各话题并行干活，用飞书任务清单当共享进度板，收齐结果再汇总。触发：用户提到「多话题协作模式」，或要「把大项目拆给多个机器人并行做」「协调多个 bot」「多话题并行推进」「你当总控/编排」「一个写一个 review 多组并行」，或显式提到 botmux orchestrate / botmux dispatch 派活。
---

# botmux-orchestrate — 多 bot 多话题编排

你作为**编排者（主 bot）**，把一个大编程项目拆成若干**子项目**，每个子项目在群里**单开一条话题**、派给**一组 bot**（常见：一个写代码 coder + 一个 review）并行推进；用一张**飞书任务清单**当所有人共享的进度板，子 bot 干完回报后你聚合、推进、最终汇总给用户。

## 适用 & 不适用
- 适用：一个需求大到该拆成多个**基本独立**的子项目、由**多个 bot 并行**做。
- 不适用：单个小任务（直接做，或用 botmux-handoff 交棒即可）。

## 物理事实（先记牢）
- **你和子 bot 之间没有直连**，只能靠飞书消息触发；**没有请求-响应关联**——子 bot 干完用 \`botmux report\` 把回报发回**你这条主编排话题**（不是在它自己的子话题里 @ 你——那条子话题没有你的会话，@ 会另起一个无上下文的新会话）。对你就是「话题里来了条新消息」，你被唤起（带完整上下文）后去读任务板拿结构化状态。
- 开新话题靠 \`botmux dispatch\`（发种子消息 + 在线程里 @ 子 bot，子 bot 即在该话题各起独立会话）。**子 bot 必须已在群里且 mentionable**（有 include_bot 权限）。
- 一条话题里可以有多个 bot（如 coder+reviewer），它们在该话题内互相 @ 协作。
- **反方向同理（你 → 子 bot）**：子 bot 的会话只在它的子话题里。你要跟某个子 bot 说话（追问/补任务/确认），**一律 \`botmux dispatch --into <子话题root> --bot <子bot>\`** 发进它的子话题——**绝不要在主群 \`botmux send --mention <子bot>\`**，那条 @ 到不了它在子话题的会话，反而会在主群另起一个无上下文的新会话（与上面的回报问题完全对称）。子 bot 回报后你通常只需聚合，不必回它；要回也走 \`--into\`。（\`botmux send\` 已加护栏：误 @ 活跃子 bot 会被拦下并提示，确需强发才 \`--anyway\`。）

## 流程

### 1. 查花名册
\`botmux bots list\`（见 botmux-bots）：看群里有哪些可协作 bot、能力标签、是否 mentionable。mentionable=false 的先让它 /introduce 一次。

### 2. 拆解 + 出一版分配
把需求拆成 N 个子项目，每个给出：**标题 / 简报(目标+验收) / 工作目录 / 指派的 bot(可一组，带角色) / 依赖**。你**主动提议一版**「子项目 ↔ bot」分配。

### 3. 一次性跟用户确认
把「子项目清单 + 分配 + 开几条话题」用 \`botmux send\` 发给用户**一次审批**（可配合 botmux-ask 做按钮确认）。用户可改、可手动指派。**没通过别派活。**

### 4. 建共享任务板（飞书任务清单）
用 **lark-task** 技能建一个**任务清单**（= 大项目），每个子项目建一条**任务**：
- 负责人(member) 设为该子 bot（type=app，飞书任务支持 bot 当负责人）；
- **把发起人（用户）加为任务清单成员/关注者**（tasklists.add_members，type=user，用他的 open_id）——否则任务板**不会出现在他的飞书任务里**，他看不到进度（这是常见漏点：建了板但没人能看到）；
- 描述写清简报 + 验收标准；
- 记下每条任务的 **task_guid**（后面塞进派活简报，子 bot 据此回写）。
任务板给**人一眼看进度**，也是你的工作记忆。**主 bot 和子 bot 都可读写任务。**
建完把任务清单链接用 \`botmux send\` 发给用户，让他确认能在飞书任务里看到。

### 5. 逐个派活（开话题）
对每个子项目，把简报写进 /tmp/brief-X.md，再：
\`\`\`bash
botmux dispatch --title "<子项目标题>" --bot "<coder_open_id>:名字:coder" --bot "<reviewer_open_id>:名字:reviewer" --repo "<工作目录>" --brief-file /tmp/brief-X.md
\`\`\`
**简报必须写清子 bot 的「完成协议」**，否则收不齐：
- 你的飞书任务 ID 是 <task_guid>；
- 干完用 **lark-task** 把该任务标记完成、并把产出（链接/摘要）挂到任务评论或附件；
- 然后用 \`botmux report "子项目X 完成 + 产出位置"\` 回报（**别在本话题 @ 主bot**——会另起一个无上下文的新会话；\`botmux dispatch\` 已把这条「完成回报」协议自动追加进简报，子 bot 照做即可）；
- coder 写完先 @ reviewer 在本话题 review，过了再标完成。

> repo 预设：\`--repo\` 让子 bot 起会话直接进该目录、免手点「选仓库」卡。注意**跨 owner 的 repo 预设可能受授权限制**——若子 bot 已配 defaultWorkingDir，可省略 \`--repo\`。
> **OnCall 群可省 \`--repo\`**：群若开了 OnCall 并绑了工作目录（\`/oncall <仓库路径>\` 或 dashboard），所有 dispatch 都不用再传 \`--repo\`——子 bot spawn 时按群查 OnCall 绑定（写在共享 bots.json，跨 bot/跨 daemon 都读得到）自动继承该目录，子话题同理。只有当某子项目要用**和群目录不同的仓库**时才单独传 \`--repo\` 覆盖。
> 想「先把 bot 拉起待命、稍后再派具体任务」：用 \`--standby\`（只定目录不派简报），之后用 \`botmux dispatch --into <话题root> --bot ... --brief ...\` 激活。

### 6. 收结果 + 推进
子 bot \`botmux report\` → 你（主编排会话，带完整上下文）被唤起 → 读任务板确认完成、看产出。然后：
- 有依赖的下一波：依赖满足了再 dispatch 下一批；
- 卡住/超时：去对应话题 \`botmux dispatch --into <root>\` @ 它问进展，或改派；
- 全程把关键节点用 \`botmux send\` 同步用户（人看任务板也能一眼掌握）。

### 7. 汇总
所有子项目完成 → 读各任务产出 → 给用户一份总汇总（做了什么、产出在哪、遗留项）。

## 登记（别丢上下文）
把「子项目 ↔ task_guid ↔ 话题root ↔ 指派bot」记一张小表（可写本地 scratch，如 /tmp/orchestrate-<项目>.json）；断点续跑/被唤起时据此恢复。

## 注意
- **没通过用户审批不要建板/派活。**
- 子 bot 不在群 / 不 mentionable → 先解决可达性（拉群、/introduce），否则 dispatch 的 @ 唤不起它。
- 一条话题别塞太多 bot；coder+reviewer 两人一组最顺。
- 失败别硬重试同一招 ≥3 次；上报用户。
`;

const WHITEBOARD_SKILL = `---
name: botmux-whiteboard
description: 使用 botmux 本地项目白板读写跨 agent 的项目摘要、关键决策、已验证命令、阻塞和交接信息。触发场景：用户说白板、上下文、项目记忆、让其他 agent 看本地总结、长任务断点、多 agent 协作、handoff、需要沉淀不适合发飞书的大段上下文时。
---

# botmux-whiteboard — 本地项目白板

白板是可选能力，默认关闭。它用于保存项目级、可持久化的核心摘要知识和本地 handoff 信息；它不是飞书消息的替代，也不是存秘密的地方。

## 先判断是否启用

\`\`\`bash
botmux whiteboard status
\`\`\`

如果未启用，不要尝试隐式开启；告诉用户/dashboard 管理员需要先打开白板能力。关闭时 CLI/agent 读写会拒绝。

## 当前白板

\`\`\`bash
botmux whiteboard current
botmux whiteboard current --create   # 仅在用户要求或你确实需要沉淀长期上下文时使用
botmux whiteboard list
\`\`\`

默认绑定 key 是当前群的 default 白板；不按 bot 或 workingDir 分裂。显式创建的多白板用 id/title 区分。

## 读取

当用户/其他 agent 让你“看白板”、或你需要恢复项目状态时：

\`\`\`bash
botmux whiteboard read --id <whiteboardId>          # 输出 board.md 纯内容
botmux whiteboard read --id <whiteboardId> --json   # 输出 { id, updatedAt, content }
\`\`\`

不要假设白板正文已经在上下文里；prompt 只会给 id 和 CLI 命令说明。

\`--json\` 同时返回内容与该版本的 \`updatedAt\`——更新时用它做并发冲突检测（见下）。

## 写入原则

白板是**当前项目的全局上下文快照**：记录项目目标、组织方式、核心方案、关键进展和下一步。它不是过程日志，也不是零散备忘录——不要把每轮对话/命令流水记上去。

适合写：
- 项目目标、组织方式（群/白板/协作角色分工、默认白板与多白板关系）
- 当前采用的核心方案与关键边界（含「不做什么 / 已废弃什么」）
- 关键进展（已完成、已验证、当前风险/阻塞）
- 下一步计划
- 需要其他 agent 接力时的当前状态说明

不要写：密钥、token、个人隐私、未授权外部信息、大段无用日志、单轮过程流水。

每次 update 都先 read 旧白板，融合新信息后整体重写为一份完整的当前状态，而不是只追加本轮局部信息——白板永远是「当前快照」，不是累加日志。默认用中文撰写，除非用户明确要求其他语言；代码标识、命令、错误信息可保留原文。

### 并发冲突检测（CAS）

白板是整个群共享的单一快照，多个 agent 可能同时读写。为避免后写静默覆盖先写、丢掉其它 agent 的更新，更新时回传 read 到的版本号做 compare-and-set：

\`\`\`bash
# 1) 读取当前内容 + 版本号
botmux whiteboard read --id <whiteboardId> --json
# → { "id": "wb_...", "updatedAt": "2026-06-22T01:23:45.000Z", "content": "# 当前状态\\n..." }

# 2) 融合后整体重写，用 --expected-updated-at 回传刚才读到的 updatedAt
botmux whiteboard update --id <whiteboardId> --expected-updated-at 2026-06-22T01:23:45.000Z <<'EOF'
# 当前状态
...
EOF
\`\`\`

- 若期间没有其它 agent 改过白板，写入成功，返回新的 board（含新 updatedAt）。
- 若报 \`whiteboard_cas_mismatch\`（exit 2），说明有人改过——重新 \`read --json\` 拿最新内容与 updatedAt，再次融合重写，不要直接覆盖。
- 不传 \`--expected-updated-at\` 时退化为直接覆盖（向后兼容），但推荐每次 update 都带上以获得冲突保护。

更新当前状态用 update（覆盖 board.md，保持它是最新全局状态）。建议沿用以下固定结构：

\`\`\`bash
botmux whiteboard update --id <whiteboardId> <<'EOF'
# 当前状态

## 项目目标

- ...

## 组织方式

- 群/白板/协作角色如何分工
- 当前默认白板/多白板关系

## 核心方案

- 当前采用的设计与关键边界
- 不做什么 / 已废弃什么

## 关键进展

- 已完成
- 已验证
- 当前风险/阻塞

## 下一步

- ...
EOF
\`\`\`

\`write --yes\` 是人工强制覆盖的兼容命令；agent 默认使用 \`update\`。

## 飞书提示

白板减少飞书噪音，但不能让人完全不可见：
- 首次创建白板，或首次更新关键状态时，用 \`botmux send\` 发一句短提示：\`已建立/更新 whiteboard:<id>，后续关键状态会维护在那里。\`
- 小更新不要每次通知。
- 需要其他 agent 接力时，在飞书 @ 对方并让它读 \`whiteboard:<id>\`；不要复制大段白板内容。
- 用户可见结论、需要确认的决策、最终结果仍必须 \`botmux send\`。
`;

export const ASK_SKILL_NAME = 'botmux-ask';

export const BUILTIN_SKILLS: SkillDef[] = [
  { name: 'botmux-schedule', content: SCHEDULE_SKILL },
  { name: 'botmux-history', content: HISTORY_SKILL },
  { name: 'botmux-quoted', content: QUOTED_SKILL },
  { name: 'botmux-send', content: SEND_SKILL },
  { name: 'botmux-bots', content: BOTS_SKILL },
  { name: 'botmux-handoff', content: HANDOFF_SKILL },
  { name: 'botmux-workflow-create', content: WORKFLOW_CREATE_SKILL },
  { name: 'botmux-orchestrate', content: ORCHESTRATE_SKILL },
  { name: 'botmux-whiteboard', content: WHITEBOARD_SKILL },
];

/** Skills that earlier botmux versions installed but no longer ship. The
 *  installer cleans these up so renamed skills don't linger as duplicates
 *  in the CLI's skills directory. */
export const RETIRED_SKILL_NAMES: string[] = [
  'botmux-thread-messages',
  // Folded into botmux-send as the `--attention` flag. Installer prunes the old
  // standalone skill dir.
  'botmux-needs-help',
  // Retired in favour of a per-bot "max live sessions" dashboard field
  // (Groups & Bots → bot card). The CLI subcommand was removed too, so the
  // skill has nothing to drive — prune it from every CLI's skills dir on upgrade.
  'botmux-worker-budget',
];
