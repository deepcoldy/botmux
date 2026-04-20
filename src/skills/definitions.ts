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
description: 当用户要求创建定时任务/提醒（"每天X点提醒"、"30分钟后"、"每周一"、"remind me"、"schedule"）时触发。使用 botmux schedule 命令操作定时任务（增删查改），支持 Lark 话题内自动路由。
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
`;

const THREAD_MESSAGES_SKILL = `---
name: botmux-thread-messages
description: 需要查看当前 Lark 话题的历史消息时触发。适合"看看这个话题之前聊了什么"、"最近的消息"、"上下文"类请求。在 CLI 会话内自动推断 session-id。
---

# botmux-thread-messages — 读取话题消息历史

想回顾当前 Lark 话题里用户之前发过什么、别的机器人说了什么时使用。

## 用法

\`\`\`bash
# 拉取最近 50 条（默认）
botmux thread messages

# 拉取最近 100 条
botmux thread messages --limit 100

# 指定 session-id（不在 CLI 会话内时用）
botmux thread messages --session-id <uuid>
\`\`\`

## 输出

JSON 格式，字段：

\`\`\`json
{
  "sessionId": "...",
  "threadId": "...",
  "messages": [
    { "messageId": "...", "senderId": "...", "senderType": "user|app", "msgType": "text|post|interactive", "content": "...", "createTime": "..." }
  ],
  "total": 17
}
\`\`\`

## 注意

- 只返回属于当前话题的消息（按 rootMessageId 过滤）
- senderType="app" 表示机器人发的消息（包括 Claude Code / Codex / 其它 bot），"user" 表示用户
- 需要先把 JSON 读进来再做总结，不要直接把 JSON 扔给用户
`;

const SEND_SKILL = `---
name: botmux-send
description: 向飞书话题发送消息。用户在飞书上阅读看不到终端输出，需要用户看到的内容（关键结论、方案、最终结果、进度更新）必须通过 botmux send 发送。支持文本、图片、文件附件和 @mention。
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

**图片混排**：\`--images\` 上传的本地图片默认追加到消息末尾。想在正文中指定位置，用占位符 \`![说明](img:N)\`（N 是 0-based 索引），会被替换成真正的 img_key。例：\`botmux send --images a.png --images b.png "前情\\n\\n![图1](img:0)\\n\\n中间文字\\n\\n![图2](img:1)"\`。

**不支持**：外链图片 \`![](http://...)\`（飞书 markdown 元素只认本地上传的 img_key）、setext 标题（\`===\` 下划线式）、HTML 标签。

### 带图片（内联显示）

\`\`\`bash
botmux send --images /tmp/screenshot.png <<'EOF'
截图如上，红框部分是问题所在。
EOF
\`\`\`

### 带文件附件

\`\`\`bash
botmux send --files /tmp/report.pdf "报告已生成，请查收附件。"
\`\`\`

### @mention 其他机器人协作

\`\`\`bash
# 先查可用机器人
botmux bots list

# @mention 协作
botmux send --mention "ou_xxx:Aiden" "请 @Aiden 帮忙 review 这段代码"
\`\`\`

## 参数

| 参数 | 说明 |
|---|---|
| (positional 或 stdin) | 消息文本（支持 markdown，自动选择卡片/文本模式） |
| \`--content-file <path>\` | 从文件读取内容（优先于 stdin/positional） |
| \`--images <path>\` | 内联图片，可重复多次 |
| \`--files <path>\` | 附件文件，可重复多次，每个单独发送 |
| \`--mention <open_id:name>\` | @mention，可重复。用 \`botmux bots list\` 查 open_id |
| \`--card\` / \`--text\` | 强制卡片或纯文本模式（默认按 md 语法自动判断） |
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
  { name: 'botmux-thread-messages', content: THREAD_MESSAGES_SKILL },
  { name: 'botmux-send', content: SEND_SKILL },
  { name: 'botmux-bots', content: BOTS_SKILL },
];
