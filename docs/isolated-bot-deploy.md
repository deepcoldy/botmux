# 隔离 bot 部署指南（macOS）

在一台 macOS 机器上部署 botmux，并让指定 bot 跑在「本机读隔离」下——一个被授权使用某个 bot 的半可信飞书用户，无法借该 bot 的 agent 读到**其他 bot 的会话数据与凭证**。

> **仅 macOS。** 读隔离用 macOS 的 `sandbox-exec`（Seatbelt）整进程包裹 CLI。非 darwin 平台会在 gate 处 **fail-closed 拒绝启动**隔离 bot（Linux 的 bwrap 包裹尚未实现）。非隔离 bot 不受影响。

## 一分钟原理

两层隔离，叠加：

1. **飞书 app 权限隔离（平台侧）**：每个 bot 是独立飞书 app，token 天然按 app 隔离——多 app 架构的固有属性。
2. **本机读隔离（这份文档）**：每个隔离 bot 的 CLI 数据（配置 / 对话记录 / 记忆 / 登录凭证）重定向进它自己的 **BOT_HOME**（`~/.botmux/bots/<appId>/`，经 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`），然后整个 CLI 进程被 `sandbox-exec` 关住，deny 掉所有兄弟 bot 的数据与系统凭证；自己的那份由 carve-out 放行（resume/记忆正常）。CLI 自身的内置沙箱被 bypass 关掉，**外层 Seatbelt 是唯一 enforcer**——主进程 + 所有 Bash 子进程一并覆盖，无逃逸。

## 部署步骤

```bash
# 0. 环境:node >=22;pnpm 用 corepack
corepack enable                       # 或 npm i -g pnpm@9.5.0

# 1. 克隆 + 构建(仓库 public,拉取无需 token)
git clone https://github.com/xu4wang/botmux.git && cd botmux
pnpm install && pnpm build

# 2. 全局 wrapper 进 PATH(一次性写进 ~/.zshrc)
echo 'export PATH="$HOME/.botmux/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc

# 3. 配置飞书 app(按 README「5 分钟快速接入」)
botmux setup

# 4. 登录 CLI —— 隔离 bot 的凭证从这里自动 provision 进各自 BOT_HOME
claude /login                         # 写 keychain / ~/.claude/.credentials.json
# codex bot 则:codex login(写 ~/.codex/auth.json)

# 5. 部署本 checkout 到 daemon
pnpm switch:here && botmux restart
```

> 源码部署时 `package.json` 的 `version` 是 `0.0.0`，正常——版本号只有 CI 打 tag 发版时才写入，不影响功能。
>
> ⚠️ **同一个飞书 app 不能被两台机器的 daemon 同时监听**——两个 daemon 会争抢同一批飞书事件。新机器要么用**另一批飞书 app**，要么是**迁移**（起新的、停旧的）。

## 开启隔离

`readIsolation` **没有交互式配置项**（setup / dashboard 都不问），需手动编辑 `~/.botmux/bots.json`，给要隔离的 bot 加 `"readIsolation": true`，然后 `botmux restart`：

```json
[
  { "larkAppId": "cli_admin", "cliId": "claude-code" },
  { "larkAppId": "cli_teamA", "cliId": "claude-code", "readIsolation": true },
  { "larkAppId": "cli_teamB", "cliId": "codex",       "readIsolation": true }
]
```

- 没设 `readIsolation` 的 bot 即为**非隔离 admin bot**——照旧读全局 keychain / bots.json，留给运维。它是整套隔离的**旁路**，其 `allowedUsers` / `allowedChatGroups` 必须收紧到可信的人。
- 可选：`"readDenyExtraPaths": ["/abs/path", ...]` 追加自定义 deny 路径（会在自己 BOT_HOME 的 allow 之后生效，能覆盖它）。

**触发条件（全 AND，否则 fail-closed 拒启）**：`readIsolation===true` ＋ adapter 支持（claude-code / codex）＋ 未设 `wrapperCli` ＋ 平台是 macOS ＋ `SESSION_DATA_DIR` 已设。任一不满足，worker 拒绝启动该会话，绝不降级裸跑。

## 验证

发一条消息触发会话后，在部署机上：

```bash
SID=<会话 id 前 8 位>   # botmux list --plain 里能看到

# 隔离 bot:应看到 sandbox-exec 包裹 + CLAUDE_CONFIG_DIR/CODEX_HOME 重定向
tmux list-panes -t bmx-$SID -F '#{pane_start_command}' \
  | grep -oE "sandbox-exec -f [^ ]+|CLAUDE_CONFIG_DIR=[^ ]+|CODEX_HOME=[^ ]+"

# 非隔离 bot:两者都没有(裸 CLI)

# 内核级读探测(用该会话线上的 profile 直接验)
SB=~/.botmux/data/read-isolation/$SID*.sb
sandbox-exec -f $SB cat ~/.botmux/bots.json          # → Operation not permitted
sandbox-exec -f $SB cat ~/.botmux/bots.json.bak      # → Operation not permitted(备份也挡)
sandbox-exec -f $SB cat ~/.botmux/config.json        # → 正常(骨架可读)
```

## 凭证：自动同步，无需脚本

隔离下 Seatbelt deny 了 `~/Library/Keychains`，隔离 bot 读不到系统 keychain，只能走**文件凭证**（各自 BOT_HOME 里的 `claude/.credentials.json` / `codex/auth.json`）。这份文件由 worker 在**每次冷 spawn 时自动同步**：

- claude：比较 keychain 与 `~/.claude/.credentials.json` 的 `expiresAt`，取**最新有效**的那份写入；内容没变则不写。
- codex：取 `~/.codex/auth.json`。

所以 **token 过期 / 在别处重新 `/login` 轮换后，冷启动的会话自动自愈**。唯一要做的是把**已在跑**的会话冷重启一次（它们还持着旧 token）：

```bash
botmux suspend --isolated       # 挂起所有隔离 bot 的活跃会话(--dry-run 可预览)
# 下条飞书消息即冷启动,provisioning 自动写入最新凭证
```

`botmux suspend` 也支持按单会话（`botmux suspend <id>`）或单 bot（`--bot <appId>`）挂起——挂起后会话保持 active，下条消息 `--resume` 续上下文，不丢对话。

> `botmux send` 在隔离下从 BOT_HOME 里的 `send-cred.json`（`0600`）读本 bot 的凭证，secret 不经 env/argv（避免兄弟 bot 用 `ps eww` 窥探）。这个文件由 worker 自动写，别手动改。

## 隔离覆盖面（deny 什么 / 留什么）

| 类别 | deny |
|---|---|
| 全局 CLI 数据 | `~/.claude`、`~/.claude.json`、`~/.codex`（整目录；自己的已重定向到 BOT_HOME） |
| 系统凭证库 | `~/.ssh ~/.aws ~/.azure ~/.gnupg ~/.netrc ~/.git-credentials ~/.npmrc ~/.pypirc ~/.docker/config.json ~/.kube`、`~/.config/{gh,glab-cli,gcloud,op,1Password}`、`~/.1password ~/.password-store`、`~/Library/Keychains` |
| botmux 敏感（surgical，`~/.botmux` 整体不 deny） | `bots.json` **及其一切备份**（`bots.json.bak` / `.bak.*` / `.tmp`）、`logs`、`~/.lark-cli`；**整目录 wholesale-deny** `~/.botmux/bots` 和 `~/.lark-cli-bots`；所有 bot 的 `data/sessions-<appId>.json`（**文件名 regex 整类 deny**）；`data/sessions.json`；`data/{frozen-cards,turn-sends,crash-diagnostics,attachments,whiteboards}` |

**保留可读**：自己的 BOT_HOME `~/.botmux/bots/<自己>`、自己的 `~/.lark-cli-bots/<自己>`、自己的 `data/sessions-<自己>.json`（`botmux send` 路由需要）、`~/.botmux` 其余骨架（config/registry/pm2——`botmux send/list/status` 要广读），以及 BOT_HOME 外的代码 / 仓库（agent 照常干活）。

> 全部用**整类规则**（整目录 wholesale + 文件名 regex），不枚举任何兄弟 appId——**新增 bot 天然被覆盖，无需冷重启已在跑的隔离 bot**。所有 carve-out 都锚在**不可变的 appId**（不是用户可控的 cwd），防 `/cd` 打洞。

## 已知限制

- **仅 macOS**：非 darwin 平台隔离 bot fail-closed 拒启。
- **读隔离 ≠ 防外传**：agent 在 bypass 下有完整网络 / shell，隔离只挡「读到兄弟 bot 的本机文件」，不挡它把自己会话里能读到的东西联网发出去。要防外传需另配网络策略。
- **同一 OS 用户下**：强度 = 沙箱配置完整性 + Seatbelt 内核实现；不防内核漏洞、不防 root。要更强隔离用不同 OS 用户 / 容器。
- **非隔离 admin bot 是旁路**：它能读整机，收紧其 `allowedUsers` / `allowedChatGroups`。推荐只保留一个非隔离 admin、其余全隔离。

## 排错

| 症状 | 排查 |
|---|---|
| 隔离 bot 拒启（日志 `refusing to start`） | 确认 macOS、未设 `wrapperCli`、`SESSION_DATA_DIR` 已设、adapter 支持（claude-code / codex） |
| `botmux send` 报 "Bot not registered" | 确认 `~/.botmux/bin` 在 PATH 最前（用本 build 的 send-cred reader）；确认 BOT_HOME 里有 `send-cred.json` |
| bot 卡 `401 / run /login` | 凭证过期 → `botmux suspend --isolated`，下条消息冷启动自动同步最新凭证 |
| 隔离 bot 读不到自己该读的项目文件 | 确认它在 BOT_HOME 外；`readDenyExtraPaths` 没误伤 |

## 回滚

```bash
# 关某个 bot 的隔离:删掉它 bots.json 里的 "readIsolation": true,然后 botmux restart
```

关掉后该 bot 下次冷启动即恢复为非隔离（读全局 keychain / bots.json）。BOT_HOME 目录留着无害。
