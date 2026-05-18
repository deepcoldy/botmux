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

export const BUILTIN_SKILLS: SkillDef[] = [
  { name: 'botmux-schedule', content: SCHEDULE_SKILL },
  { name: 'botmux-history', content: HISTORY_SKILL },
  { name: 'botmux-quoted', content: QUOTED_SKILL },
  { name: 'botmux-send', content: SEND_SKILL },
  { name: 'botmux-bots', content: BOTS_SKILL },
];

/** Skills that earlier botmux versions installed but no longer ship. The
 *  installer cleans these up so renamed skills don't linger as duplicates
 *  in the CLI's skills directory. */
export const RETIRED_SKILL_NAMES: string[] = [
  'botmux-thread-messages',
];
