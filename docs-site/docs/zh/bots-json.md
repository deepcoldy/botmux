# bots.json 配置

通过 `~/.botmux/bots.json` 配置机器人。运行 `botmux setup` 交互式创建，或手动编辑。文件是一个数组，每个元素是一个 bot（生产环境一个 bot 对应一个独立 daemon 进程）。

```json
[
  {
    "larkAppId": "cli_xxx_bot1",
    "larkAppSecret": "secret_1",
    "name": "claude-main",
    "cliId": "claude-code",
    "model": "sonnet",
    "lang": "zh",
    "workingDir": "~/projects",
    "allowedUsers": ["alice@company.com"],
    "allowedChatGroups": ["oc_xxx_team"],
    "oncallChats": [{ "chatId": "oc_xxx_oncall", "workingDir": "~/projects/foo" }]
  },
  {
    "larkAppId": "cli_xxx_bot2",
    "larkAppSecret": "secret_2",
    "cliId": "codex",
    "model": "gpt-5-codex",
    "workingDir": "~/work",
    "autoStartOnNewTopic": true
  }
]
```

字段较多，按用途分组列出，绝大多数都是**可选**的——只填 `larkAppId` / `larkAppSecret` 就能跑起来，其余按需增配。

## 必填

| 字段 | 说明 |
|------|------|
| `larkAppId` | 飞书应用 App ID |
| `larkAppSecret` | 飞书应用 App Secret |

## CLI 与模型

| 字段 | 说明 |
|------|------|
| `name` | 进程名后缀，如 `claude-main` → `botmux-claude-main`；留空默认 `botmux-<序号>` |
| `cliId` | CLI 适配器，默认 `claude-code`。见 [多 CLI 适配器](/adapters) |
| `model` | 启动 CLI 用的模型名（如 `claude --model opus`）；留空走 CLI 默认。同一 `cliId` 的多个 bot 可跑不同模型。各适配器的 `modelChoices` 是 `botmux setup` 里给出的候选 |
| `cliPathOverride` | CLI 入口绝对路径，用于套 wrapper / router（ccr、claude-w、aiden-x-claude 等） |
| `disableCliBypass` | `true` 时不自动追加 CLI 的免审批 / 沙箱绕过参数（`--yolo`、`--dangerously-*`）；缺省 / `false` 保持原行为 |
| `backendType` | 会话后端，可选 `pty` / `tmux` / `herdr` / `zellij`。留空**自动检测**：tmux 可用选 `tmux`，否则 `pty`（`herdr`、`zellij` 不会被自动选中，需显式指定）。`tmux` / `herdr` / `zellij` 都是持久会话，对应二进制探测失败时自动回落 `pty`（`zellij` 需 ≥ 0.44）；`pty` 直连进程、不跨重启持久。见 [tmux 后端](/tmux) |
| `lang` | 该 bot 的界面语言 `zh` / `en`；留空回落 `BOTMUX_LANG` / `LANG` 环境变量 |
| `customPassthroughCommands` | 在固定透传白名单和当前 CLI adapter 默认放行命令之上，额外放行透传给底层 CLI 的 slash 命令，如 `["/export"]`（Claude Code / Codex 的 `/goal` 已默认放行）。自动归一化（缺失的 `/` 自动补、转小写、仅留 `[a-z0-9:_-]`、去重）；会遮蔽 botmux daemon 命令（如 `/status`）的项会被丢弃，配了也不生效。用 `/list-slash-command` 查看完整放行清单。见 [斜杠命令](/slash-commands) |

## 工作目录

| 字段 | 说明 |
|------|------|
| `workingDir` | 默认工作目录，支持逗号分隔多个。从该目录**向下**递归找 git 仓库（最多 3 层），不向上扫 |
| `workingDirs` | 工作目录数组写法（`["~/a", "~/b"]`）；显式配置时优先于 `workingDir` 的逗号分隔形式 |
| `defaultWorkingDir` | 单仓库默认目录：无 oncall / 无同群兄弟 session 时直接进入，跳过 repo 选择卡片。`/cd` 仍可中途切换。纯运行时回落，不写状态、不改权限模型 |

## 权限与授权

| 字段 | 说明 |
|------|------|
| `allowedUsers` | 操作权名单（**完整邮箱**或 `ou_xxx`）。配了 `allowedChatGroups` 时至少要有一个作为 owner |
| `allowedChatGroups` | 可对话群（`oc_xxx`）。群内任何成员可对话（仅 `canTalk`），敏感操作仍由 `allowedUsers` 控制 |
| `oncallChats` | oncall 绑定，`[{ "chatId": "oc_xxx", "workingDir": "~/projects/foo" }]`。见 [oncall](/oncall) |
| `defaultOncall` | 该 bot 的默认：新群聊首条新话题自动绑定 oncall。`{ "enabled": true, "workingDir": "~/foo", "since": <epoch ms> }`；`since` 之前已存在的老群不受影响 |
| `globalGrants` | 全局可对话名单（`ou_xxx`，人或 bot）。任意群可对话，仅 `canTalk` |
| `chatGrants` | 按群的 per-user 授权 `{ "oc_xxx": ["ou_yyy"] }`，仅放行 `canTalk`。一般由 `/grant` 卡片写入，也可手配 |
| `messageQuota` | 消息额度开关 `{ "defaultLimit": N }`：配了正整数后，不带数字的 `/grant` 套用 N 条额度；不配则授权无限。仅约束 talk 授权，不影响 `canOperate` |
| `restrictGrantCommands` | `true` 时，仅靠 per-user 授权（`chatGrants` / `globalGrants`）放行的人禁用**所有斜杠命令**，只能普通对话；owner / `allowedUsers` / oncall / 整群成员不受影响。默认 `false` |

## 卡片与终端

| 字段 | 说明 |
|------|------|
| `brandLabel` | 卡片底部品牌文案。`undefined`=默认 `botmux` 链接；`""`=隐藏；其它字符串=原样渲染（支持 markdown）。纯样式，不影响路由 / 权限 |
| `disableStreamingCard` | `true` 时彻底不发实时流式 session 卡片（web 终端仍跑、最终答复仍经 `botmux send` 到达，只是没有自动刷新的状态卡）。给嫌实时卡吵的用户 |
| `writableTerminalLinkInCard` | `true` 时卡片正文直接内嵌**可写**终端链接（带 token，看得到卡片的人都能操作）；默认藏在「获取写权限」按钮后私发给点击者。`disableStreamingCard` 开启时无意义 |
| `privateCard` | `true` 时 `/card` 走 ephemeral 私有卡片，仅 `allowedUsers` 可见（talk 授权与裸触发者收不到），仅普通 `group` 聊天有效，且不能 live 更新。只作用于 `/card` 命令本身 |

## 主动开工

| 字段 | 说明 |
|------|------|
| `autoStartOnGroupJoin` | `true` 时，被拉入含至少一名 `allowedUsers` 的新群即自动开工（不必 @）。需在飞书后台为该应用订阅 `im.chat.member.bot.added_v1` 事件 |
| `autoStartOnGroupJoinPrompt` | 配合上面：自动开工的首轮 prompt；留空 / 空白则空消息开场，让 bot 自己读群上下文。`autoStartOnGroupJoin` 关闭时无意义 |
| `autoStartOnNewTopic` | `true` 时，话题群里每个新话题的首条消息无需 @ 也自动开工（普通群无效）。默认被动（仅 @ 触发） |

## 语音

| 字段 | 说明 |
|------|------|
| `voice` | 该 bot 的语音引擎覆盖，按字段合并到 `~/.botmux/config.json` 的全局 `voice` 块之上（per-bot 优先）。有可用语音凭据时，回复卡片会出现「🔊 语音总结」按钮。见 [语音总结](/voice) |

## 运行时状态（自动维护，勿手改）

下列字段由 botmux 自身写入并随授权 / 开关一起持久化进 `bots.json`，列出仅为说明，**不要手动编辑**：

| 字段 | 说明 |
|------|------|
| `defaultOncallAutoboundChats` | `defaultOncall` 已自动绑过的 chat_id（append-only）。一旦记录，即使后续解绑也不会再次自动绑 |
| `quotaState` | scope 级消息额度计数 `{ "chat:<cid>:<oid>" \| "global:<oid>": { limit, used } }`；用满自动收回对应 scope 授权 |
| `noCardChats` | `/card off\|on` 写入的「该群不发流式卡片」名单 |

> **配置优先级**：`BOTS_CONFIG` 环境变量 → `~/.botmux/bots.json`。改完跑 `botmux restart` 生效。
