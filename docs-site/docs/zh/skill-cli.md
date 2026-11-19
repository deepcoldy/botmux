# Skill + CLI 交互

<video src="img/video-v8-skills.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

在 botmux 会话里，AI 想跟飞书打交道（发消息、看历史、建定时任务……），靠的是两样东西：

- **`botmux` 命令**：会话启动时自动放进 CLI 的 PATH，AI 在终端里直接执行即可。
- **Skill**（技能说明）：一段 `SKILL.md` 说明书，告诉 AI 什么时候该用哪条命令、怎么用。

```
飞书消息 ──▶ botmux ──▶ CLI 里的 AI
                          │  读 Skill，知道该怎么回
                          ▼
飞书话题 ◀── botmux ◀── botmux send "……"
```

所以「终端里有输出，飞书却没收到」，多半是 AI 没执行 `botmux send`，见 [FAQ · C](/faq#c-终端有输出但没发飞书)。

## 会话里能用哪些命令

在会话里执行时，botmux 会自动认出当前是哪个会话，不用传会话 ID。

| 想做的事 | 命令 |
|------|------|
| 往当前话题发消息（文本、图片、文件、视频、卡片、@ 人） | `botmux send` |
| 看当前会话的历史消息 | `botmux history`（话题里看话题内，普通群看整群；`--limit N` 控制条数） |
| 看被引用的那条消息（会顺便下载附件） | `botmux quoted <message_id>` |
| 查群里有哪些机器人和它们的 open_id（给 `--mention` 用） | `botmux bots list` |
| 做成按钮卡片让人选 | `botmux ask buttons --options "a,b" "<问题>"` |
| 建 / 改 / 删定时任务 | `botmux schedule ...`，见[定时任务](/schedule) |
| 看本会话有哪些 Skill、读某个 Skill 全文 | `botmux skill list` / `botmux skill show <名称>` |

完整清单见 [CLI 命令](/cli-commands)，或在会话里执行 `botmux --help`。大多数子命令都支持 `botmux <子命令> --help`。

## `botmux send`：每条都要先决定 @ 谁

`botmux send` 必须带下面三个选项之一，否则会报错、不发送：

| 选项 | 什么时候用 |
|------|------|
| `--mention-back` | @ 回本轮发消息给你的人。有结论、要对方看或拍板时用 |
| `--mention <open_id>` | 点名 @ 某人或某个机器人，可以写多个 |
| `--no-mention` | 不 @ 任何人。适合纯记录、低优先级的进度 |

```bash
botmux send --mention-back <<'EOF'
修好了，改动在 src/foo.ts，测试全绿。
EOF
```

几条规则：

- `--no-mention` 不能和另外两个一起用。
- 本轮不止一个人（或机器人）参与时，`--mention-back` 不知道该 @ 谁，会被拒绝；这时改用 `--mention` 点名，或 `--no-mention`。
- 加 `--top-level`（发到群顶层，不回进话题）时，上面这些检查都不做。
- 想关掉「必须三选一」的要求：设环境变量 `BOTMUX_REQUIRE_MENTION_DECISION=false`。
- 多行内容用 heredoc（如上例）或 `--content-file` 传，别写成 `"第一行\n第二行"`。

## 不想让 AI 自己发？

有三种情况，最终回复由 botmux 自动发回飞书，AI 不用执行 `botmux send`：

| 情况 | 说明 |
|------|------|
| `codex-app`（Codex App 协议） | 最终回复自动转发。中途推进度、发附件、@ 别的机器人时才用 `botmux send` |
| `replyDelivery: "transcript"` | botmux 从 CLI 的会话记录里取本轮最后的回答发出去，提示词里也不再提 `botmux send` |
| `promptInjection: "none"`（零注入） | botmux 不往提示词里加任何东西，也不注入 Skill，最终回答自动发回 |

后两项只对支持读取会话记录的 CLI 有效，配置方法见 [bots.json 配置](/bots-json)。

## botmux 自带的 Skill

不用装，会话启动就有：

| Skill | 管什么 |
|------|------|
| `botmux-send` | 怎么往飞书发消息、怎么选 @ |
| `botmux-history` | 读历史消息 |
| `botmux-quoted` | 读被引用的消息 |
| `botmux-bots` | 查群里的机器人 |
| `botmux-schedule` | 定时任务 |
| `botmux-chat-rename` / `botmux-session-rename` | 改群名 / 改会话标题 |
| `botmux-handoff` | 把任务交给另一个机器人接着做 |
| `botmux-orchestrate` | 多个机器人、多个话题的长期项目编排（关掉[多话题协作](/multi-topic)时不出现） |

还有几个按条件出现：

- `botmux-ask`：CLI 没有原生提问钩子时才装，让 AI 用按钮卡片问人。
- `botmux-whiteboard`：开启[白板](/whiteboard)后才有。
- `botmux-chat-manager`：机器人开启群负责人功能后才有。
- `botmux-workflow` 等：[Workflow](/workflow) 打开时，只在真正要跑流程时由 AI 按需读取，平时不占提示词。

注意：`botmux-handoff`、`botmux-orchestrate` 是 Skill 的名字，不是可以直接执行的命令。

## Skill 是怎么交给 CLI 的

不同 CLI 接收 Skill 的方式不一样，botmux 按 CLI 自动选：

| CLI | Skill 怎么到 CLI | 会不会影响你手动跑的 CLI |
|------|------|------|
| Claude Code（含 seed / relay）、Cursor、Pi、Oh My Pi | 每个会话单独挂一个插件目录（如 `--plugin-dir`） | 不会 |
| Codex、OpenCode、CoCo、TraeX、Kiro CLI、Genius、Grok 等只有全局 skills 目录的 CLI | 看 `skillInjection` 设置（见下表） | 默认不会 |
| Antigravity | 不装 Skill，只给路由提示 | 不会 |

`skillInjection` 只影响第二类 CLI：

| 取值 | 效果 |
|------|------|
| `prompt`（默认） | 不写 CLI 的全局目录，把一份精简的 Skill 清单放进会话提示词，AI 需要时再执行 `botmux skill show <名称>` 读全文 |
| `global` | 把 Skill 文件装进 CLI 的全局 skills 目录。体验最原生，但你自己手动跑这个 CLI 时也会看到它们 |
| `off` | 不给 Skill，只留路由提示和 `botmux --help`，让 AI 自己摸索 |

怎么改：

- 单个机器人：在 bots.json 里写 `"skillInjection": "global"`，或在 Dashboard「Skill 管理 → 投递设置」里改这个机器人的开关。
- 整台机器的默认值：`botmux skills injection [global|prompt|off|unset]`，不带参数是查看当前值。

路由提示（告诉 AI 当前在哪个群、怎么回复）也按 CLI 走不同通道：Claude Code 和 Genius 用 `--append-system-prompt`，Grok 用 `--rules`，其余大多数 CLI 直接写进第一条消息。提示的语言跟你设置的语言一致。

## 装自己的 Skill

除了自带的，你可以把自己写的或社区的 Skill 装进 botmux，再分配给某几个机器人。

**1. 安装**（在跑 botmux 的机器上执行）

```bash
botmux skills install ./my-skills            # 本机目录
botmux skills install owner/repo             # GitHub 简写，也可以贴 GitHub 网页地址
botmux skills install https://git.example.com/team/skills.git --path skills/foo
```

一个来源里有多个 Skill 时，用 `--skill <名称>` 挑选，或 `--all` 全装。`--ref` 指定分支或 tag。也可以直接把 `npx skills add owner/repo` 这样的命令贴进来。

**2. 分配给机器人**

- 在飞书里对机器人发 `/skills attach <名称>`（需要 owner 权限），`/skills detach <名称>` 取消，`/skills` 查看当前状态。
- 或者在 Dashboard「Skill 管理 → Bot 分配」里拖拽分配。

分配后从**新会话**开始生效，CLI 自己原有的 Skill 照常可用。已在跑的会话要 `/restart` 或新开会话。

**3. 日常维护**

| 想做的事 | 命令 |
|------|------|
| 看装了哪些 | `botmux skills list` |
| 更新某个 | `botmux skills update <名称>` |
| 删除 | `botmux skills remove <名称>`（还被机器人用着会提示，加 `--force` 强删） |
| 检查有没有损坏 | `botmux skills doctor` |
| 看某个机器人最终会拿到哪些 Skill | `botmux skills resolve --bot <名称>` |

想把一组 Skill 一起分给多个机器人，可以建「专项包」：Dashboard「Skill 管理 → 专项包」，或 `botmux skills pack create ...`。

在 Dashboard「Skill 管理 → 投递设置」里还可以：

- 选择是否读取工作区里的 Skill（项目里的 `.agents/skills`、`.botmux/skills`）。
- 设置注入方式：`自动`（能用 CLI 原生通道就用，不行就写进提示词）、`提示词`（所有 CLI 都兼容）、`原生`（只交给 CLI 自己的 Skill 机制）。

## 改写自带的提示词和 Skill

觉得自带的 Skill 或提示词不合适，可以在 Dashboard「自定义」页里改写、停用某个内置 Skill，随时恢复出厂或回滚，也能导出 / 导入给别的机器用。下一个会话就生效，不用重启 daemon。命令行对应 `botmux customize`。

## 命令怎么知道自己属于哪个会话

会话里的 `botmux` 命令来自 `~/.botmux/bin/botmux`。daemon 每次启动都会自动维护它，所以版本总是和 daemon 一致，不需要另外安装。

- curl 安装：这个路径本身就是 botmux 二进制，daemon 不会改写它。
- 其它安装方式：这里是一个很薄的转发脚本，指向当前 daemon 用的那份 botmux。

至于「属于哪个会话」：botmux 启动 CLI 时会按进程号记一个标记，`botmux` 命令沿着进程树往上找，就知道自己在哪个会话、哪一轮。如果进程脱离了进程树（比如用了 `setsid`、`nohup` 后台跑），读历史、发消息这类命令会改用环境变量 `BOTMUX_SESSION_ID` 兜底；但 Workflow 的写操作等需要确认身份的命令会直接拒绝。所以尽量别让命令脱离进程树。

## 为什么用 Skill + CLI，而不是 MCP

- **启动快、省 token**：CLI 启动不用做 MCP 握手，`botmux send` / `history` 这些核心命令完全不依赖 MCP，也不占工具列表。只有插件真的提供了 MCP 服务、且对应 CLI 支持时，才会额外起 MCP。
- **几乎所有 CLI 都能用**：只要 CLI 能跑 shell 命令，`botmux` 命令就能用，Claude Code、Codex、Cursor、OpenCode、Antigravity 等都一样。

不过 Skill 这一层不是每个 CLI 都有：比如 Antigravity 只认插件包里的 `SKILL.md`，所以它只拿到路由提示，没有 Skill 清单。
