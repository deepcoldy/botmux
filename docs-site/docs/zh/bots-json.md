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
| `launchShell` | 启动 CLI 用的 shell，覆盖 daemon 的 `$SHELL`：填 shell 名（`zsh` / `bash` / `sh`）或绝对路径（如 `/usr/bin/zsh`）。用于登录 `$SHELL`（如 bash）的 rc 文件里有 `exec zsh` 之类跳转、在 botmux 的 `bash -i` 启动里把 CLI 顶掉、导致会话起不来（裸壳里 `parse error`）的场景——指定后直接用它启动、绕开被跳过的 rc。**注意**：PATH / nvm / pnpm 等要放进所选 shell 的 rc（如 `.zshrc` / `.zprofile`）。留空＝用 `$SHELL`。下个会话生效；仅 `tmux` / `zellij` 后端（`pty` 直接 exec CLI，本就不受影响）。也可在 dashboard「机器人默认设置 → 启动 Shell」或 `/config launchShell <值>` 配置 |
| `lang` | 该 bot 的界面语言 `zh` / `en`；留空回落 `BOTMUX_LANG` / `LANG` 环境变量 |
| `customPassthroughCommands` | 在固定透传白名单和当前 CLI adapter 默认放行命令之上，额外放行透传给底层 CLI 的 slash 命令，如 `["/export"]`（Claude Code / Codex 的 `/goal` 已默认放行）。自动归一化（缺失的 `/` 自动补、转小写、仅留 `[a-z0-9:_-]`、去重）；会遮蔽 botmux daemon 命令（如 `/status`）的项会被丢弃，配了也不生效。用 `/list-slash-command` 查看完整放行清单。见 [斜杠命令](/slash-commands) |
| `env` | 该 bot 的进程环境变量 `{ "KEY": "值" }`，注入到这个 bot 的 CLI 进程。最常见用途：让某个 bot 跑 GLM / 第三方 Anthropic·OpenAI 兼容服务商（见下方示例），也可设 `HTTPS_PROXY` 或 CLI 专属开关。值支持字符串 / 数字 / 布尔；`BOTMUX_` / `LARK_APP_` 等 botmux 保留键会被忽略。按**会话**注入（下个新会话生效），不写入共享 tmux server 全局、不会串到别的 bot。也可在 dashboard「机器人默认设置 → 环境变量」配置 |

### 接入 GLM / 第三方服务商（per-bot env）

让某个 bot 跑 GLM Coding Plan（或其它 Anthropic 兼容服务商），另一个 bot 仍跑官方 Claude——给前者配 `env`：

```json
{
  "cliId": "claude-code",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "你的 GLM Coding Plan key"
  }
}
```

- GLM 国内站把 `ANTHROPIC_BASE_URL` 换成 `https://open.bigmodel.cn/api/anthropic`。
- 给 Codex 这类 OpenAI 协议 CLI 接入时，填 `OPENAI_BASE_URL` / `OPENAI_API_KEY`（服务商的 OpenAI 兼容端点）而非 `ANTHROPIC_*`。
- **隔离**：env 按会话注入到 CLI 进程，全后端一致（tmux / zellij 经每个 pane 注入，绝不写共享 server 全局），所以一个 bot 的服务商配置不会串到别的 bot。
- **安全**：值以明文存在 `bots.json` 与进程环境，不是密钥保险箱；`/config get` 等聊天面会脱敏显示（dashboard 编辑器 owner 鉴权后显示原值）。
- 改完下个**新会话**生效。

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
| `autoGrantRequestCards` | 默认开启。显式设为 `false` 时，群里未授权的人或外部 bot @ 本 bot 但被对话权限闸挡住时，不再自动给 owner 发 `/grant` 申请卡，改为静默丢弃 |

## 卡片与终端

| 字段 | 说明 |
|------|------|
| `brandLabel` | 卡片底部品牌文案。`undefined`=默认 `botmux` 链接；`""`=隐藏；其它字符串=原样渲染（支持 markdown）。纯样式，不影响路由 / 权限 |
| `disableStreamingCard` | `true` 时彻底不发实时流式 session 卡片（web 终端仍跑、最终答复仍经 `botmux send` 到达，只是没有自动刷新的状态卡）。给嫌实时卡吵的用户 |
| `silentTurnReactions` | `true` 时，无卡片会话不再给触发消息添加 GoGoGo / DONE reaction。只影响 `disableStreamingCard` 或 `noCardChats` 关闭实时卡片后的轻量状态提示；默认 `false` |
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
