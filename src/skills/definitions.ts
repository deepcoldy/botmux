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
botmux schedule add "<schedule>" "<prompt>" [--name <name>] [--deliver origin|local]
\`\`\`

prompt 是到点时会被执行的内容，就像用户新开一个话题向你发送这段 prompt 一样。
可选 \`--deliver local\` 表示只记录不推送（适合"每小时检查一次，没事就别打扰我"）。

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
description: 需要查看当前飞书会话历史消息时触发。话题群拉话题内消息，普通群拉整群最近 N 条（默认 50，用 --limit 调节，最多 50/页）。适合"看看之前聊了什么"、"最近的消息"、"上下文"类请求。在 CLI 会话内自动推断 session-id。
---

# botmux-history — 读取会话消息历史

想回顾当前飞书会话里用户之前发过什么、别的机器人说了什么时使用。**话题群和普通群都支持**：话题群里只返回当前话题内的消息，普通群里返回整群最近 N 条（默认 50，按时间倒序取尾部、再按时间正序返回）。觉得历史太多就把 \`--limit\` 调小，需要更多上下文就调大。

## 用法

\`\`\`bash
# 拉取最近 50 条（默认）
botmux history

# 拉取最近 100 条
botmux history --limit 100

# 指定 session-id（不在 CLI 会话内时用）
botmux history --session-id <uuid>
\`\`\`

## 输出

JSON 格式，字段：

\`\`\`json
{
  "sessionId": "...",
  "chatId": "...",
  "scope": "thread" | "chat",
  "rootMessageId": "...",     // 仅 scope=thread 时存在
  "messages": [
    { "messageId": "...", "senderId": "...", "senderType": "user|app", "msgType": "text|post|interactive", "content": "...", "createTime": "..." }
  ],
  "total": 17
}
\`\`\`

## 注意

- \`scope=thread\`：只返回属于当前话题的消息（按 rootMessageId 过滤）
- \`scope=chat\`：返回当前群整群最近 N 条消息（不限于 session 创建之后，需要更老的就把 --limit 调大）
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
description: 向飞书话题发送消息。用户在飞书上阅读看不到终端输出，需要用户看到的内容（关键结论、方案、最终结果、进度更新）必须通过 botmux send 发送。支持图文混排（图片穿插在 markdown 正文中）、文本、图片/文件附件、@mention。
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

## 用法

### 纯文本（最常见）

多行内容必须用 heredoc；不要写成 \`botmux send "第一行\\n第二行"\`，否则用户会在飞书里看到字面量 \`\\n\`。

\`\`\`bash
# 直接传参
botmux send "分析完成，核心问题是 X"

# heredoc（多行内容推荐）
botmux send <<'EOF'
## 分析报告

1. 发现问题 A
2. 建议方案 B

需要你确认后我再动手。
EOF

# 管道
echo "构建成功 ✅" | botmux send
\`\`\`

> ⚠️ **重要：single-quoted heredoc \`<<'EOF'\` 内反引号直接写真反引号，不要加反斜杠转义。**
> 原因：单引号 heredoc 已经禁用所有特殊字符解释（\`$\`、反斜杠、反引号一律按字面量处理）。再加反斜杠反而会把"反斜杠+反引号"作为字面字符混进 markdown，让 markdown-it 按 CommonMark 的 backslash-escape 处理——结果卡片里三反引号变成可见字符、代码块整段废掉。
> 自检：写完 bash 命令后扫一眼，如果 EOF 块内**任何反引号前面带反斜杠**，删掉那个反斜杠。

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
| \`--card\` / \`--text\` | 强制卡片或纯文本模式（默认按 md 语法自动判断） |
| \`--top-level\` | 发顶层消息（不回复进当前话题）；自动跳过"发送给/cc" footer |
| \`--chat-id <oc_xxx>\` | 指定目标群（默认当前会话所在群）；常和 \`--top-level\` 一起用做跨群发布 |
| \`--session-id <id>\` | 手动指定 session（通常自动推断，不需要传） |

## 输出

成功返回 JSON: \`{"success":true,"messageId":"om_xxx","sessionId":"..."}\`
失败打印错误到 stderr 并 exit 1。
`;

const BOTS_SKILL = `---
name: botmux-bots
description: 列出当前飞书群聊中的机器人及其 open_id。在需要 @mention 其他机器人协作时使用。
---

# botmux-bots — 查询可用机器人

## 用法

\`\`\`bash
botmux bots list
\`\`\`

## 输出

JSON 格式：
\`\`\`json
{
  "sessionId": "...",
  "chatId": "...",
  "bots": [
    { "name": "Claude", "openId": "ou_xxx", "isSelf": true },
    { "name": "Aiden", "openId": "ou_yyy", "isSelf": false }
  ],
  "total": 2
}
\`\`\`

## 配合 botmux send 使用

\`\`\`bash
# 查到 Aiden 的 open_id 后
botmux send --mention "ou_yyy:Aiden" "请 @Aiden 帮忙处理"
\`\`\`
`;

const WORKFLOW_CREATE_SKILL = `---
name: botmux-workflow-create
description: 根据用户自然语言描述生成 botmux workflow JSON 定义文件。触发场景：用户说"我想做个流程"、"创建 workflow"、"把 X 拆成自动化"、"编排"、"orchestrate"、"自动化跑这几步"；或显式提到 botmux workflow create。必须先用 botmux bots list 查看可用 bot，先给用户确认设计，再写 workflows/<workflowId>.workflow.json，并用 botmux workflow validate 校验。
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
botmux workflow run <workflowId>
# 或在飞书话题里:
/workflow run <workflowId>
\`\`\`

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

\`params\` 是启动 run 时通过 \`--param key=value\` 传入的入参，会被 type/required 校验。在节点里既可以用 \`{ "$ref": "params.<path>" }\` 整字段替换，也可以在字符串里 \`"\${params.<path>}"\` 内嵌（仅限值是标量时）。嵌套对象用点号路径：\`params.user.email\`。

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
- 写 \`{{...}}\` 模板：runtime 只识别 \`\${...}\`，不识别双花括号；改成 \`\${...}\` 或整字段 \`$ref\`。
- 把对象 / 数组塞进 \`\${...}\` 字符串模板里：会报 \`BindingError\`。对象 / 数组必须用整字段 \`$ref\` 替换。
- \`$ref\` 字符串里没有 \`.output.\` 也不是 \`params.*\` 开头：parse 会报错。
- \`$ref\` 引用的 node 没写进 \`depends\`：validate 可能过，运行时顺序不可靠。
- \`humanGate.stage: "after"\`：不支持。
- \`$ref\` 对象还有其他 key：schema 会拒绝。
- nodeId 含 \`/\`、\`..\`、空格：schema 会拒绝。
- executor 名不是默认三种之一且用户没确认：不要猜。
`;

export const BUILTIN_SKILLS: SkillDef[] = [
  { name: 'botmux-schedule', content: SCHEDULE_SKILL },
  { name: 'botmux-history', content: HISTORY_SKILL },
  { name: 'botmux-quoted', content: QUOTED_SKILL },
  { name: 'botmux-send', content: SEND_SKILL },
  { name: 'botmux-bots', content: BOTS_SKILL },
  { name: 'botmux-workflow-create', content: WORKFLOW_CREATE_SKILL },
];

/** Skills that earlier botmux versions installed but no longer ship. The
 *  installer cleans these up so renamed skills don't linger as duplicates
 *  in the CLI's skills directory. */
export const RETIRED_SKILL_NAMES: string[] = [
  'botmux-thread-messages',
];
