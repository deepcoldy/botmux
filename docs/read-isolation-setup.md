# 读隔离配置指南（Agent 运维手册）

> 面向：一个在 botmux 里运行的 AI agent（例如管理员 bot），照本文即可为整台机器配置**两层读隔离**——把**自己保留为 admin（不隔离）**，其余 bot 的 agent 全部隔离，使它们**读不到其他 bot 的对话数据和凭证**。
>
> 适用版本：botmux 含 `read-isolation` 特性（`feat/read-isolation` 分支或其后发布的版本）。老版本会**静默忽略** `readIsolation` 字段——务必先确认跑的是新 build。

---

## 0. 一分钟原理

| 层 | 作用 | 机制 |
|---|---|---|
| **第一层：飞书 App 权限隔离** | 每个 bot 用自己的飞书应用 → 从飞书侧限制"能访问哪些资源" | `.zshenv` 按 `BOTMUX_LARK_APP_ID` 设 `LARKSUITE_CLI_CONFIG_DIR=~/.lark-cli-bots/<appId>` |
| **第二层：本地读隔离** | agent 读不到其他 bot 的对话 transcript / 会话元数据 / 凭证 | Claude = 内置沙箱 `--settings`（denyRead + permissions.deny）；Codex 及其他 = 外部 Seatbelt 包裹（`sandbox-exec`） |

**隔离是逐 bot opt-in 的**：给某个 bot 加 `"readIsolation": true` 才生效；不加的（如 admin）行为不变。

---

## 1. 前提检查（开始前先跑）

```bash
# ① 确认 daemon 跑的是含 read-isolation 的 build（源码部署 version 常是 0.0.0；
#    关键是 cli.js 里有 fallback）
grep -c BOTMUX_READ_ISOLATION "$(readlink -f "$(command -v botmux)")" || echo "0=旧版无隔离，先升级"

# ② Claude bot 需要 Claude Code >= 2.1.187（内置沙箱）
claude --version

# ③ Codex bot（仅 macOS）：sandbox-exec 系统自带；codex 自身认证 ~/.codex/auth.json 会被自动保留
command -v sandbox-exec && ls ~/.codex/auth.json

# ④ 记下所有 bot 的 appId（用于决定谁隔离）
node -e "const a=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.botmux/bots.json','utf8'));for(const b of (Array.isArray(a)?a:a.bots))console.log(b.larkAppId,b.cliId,b.readIsolation??'未设')"
```

> Linux：Claude 内置沙箱走 bwrap（需装 `bubblewrap`）；Codex/其他的外部包裹目前是 **bwrap 占位、未实现 → 会 fail-closed 拒启**。Linux 上只对 Claude bot 开隔离。

---

## 2. 决定谁 admin、谁隔离

- **当前 agent 自己 = admin，不加 `readIsolation`**。它能读所有 bot 数据，是整套隔离的**旁路**。
  - ⚠️ 因此 admin bot 的 `allowedUsers` / `allowedChatGroups` 必须**收紧到可信的人**，否则半可信用户借 admin 就能读全部。
  - agent 识别"自己"：worker 注入了 `BOTMUX_LARK_APP_ID` 环境变量，即当前 bot 的 appId。
- **其余每个 bot = 加 `"readIsolation": true`**。

---

## 3. 第一层：飞书 App 权限隔离（bot 用 lark skill 时**必须**先配）

> ⚠️ **关键坑**：读隔离会 `deny` 共享的 `~/.lark-cli`。如果某 bot 的 agent 用 lark skill（发飞书消息 / 读文档等）且走的是**共享 `~/.lark-cli`**，开隔离后 lark skill 会挂。所以**用 lark skill 的 bot，必须先把它切到 per-bot 的 `~/.lark-cli-bots/<appId>`**（读隔离会保留 bot 自己的这个目录）。纯测试 / 不用 lark skill 的 bot 可跳过本层（`botmux send` 在隔离下走注入的 secret，不需要 lark-cli）。

1. `~/.zshenv` 里按注入的 app id 跟随（非交互 shell 只加载 `.zshenv`，别放 `.zshrc`）：
   ```sh
   if [ -n "$BOTMUX_LARK_APP_ID" ]; then
     export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-bots/$BOTMUX_LARK_APP_ID"
   fi
   ```
2. 为每个 bot 建 `~/.lark-cli-bots/<appId>/` 并用该 bot 的飞书 app 凭证初始化 lark-cli。
3. 飞书开放平台按 app 分别开 scope。

---

## 4. 第二层：给非 admin bot 开读隔离

编辑 `~/.botmux/bots.json`，给**每个要隔离的 bot**（即除 admin 外的所有 bot）加一行：

```json
"readIsolation": true
```

- `backend` **pty 或 tmux 都支持**（tmux 保留 idle-suspend 省内存；daemon 每次启动生成 bootId 标记隔离 pane，重启后陈旧 pane 自动杀掉冷 spawn）。默认 tmux 即可。
- 可选增强：`readDenyExtraPaths`（追加自定义 deny 路径）、`readIsolationStrict: true`（改为 allowlist 模式，`denyRead ~/` + `readAllowPaths` 放行集）。

脚本化写入（保留 admin 不动）：

```bash
ADMIN_APPID="<当前 agent 自己的 appId>"   # 这个不隔离
node -e '
const fs=require("fs"),os=require("os"),p=os.homedir()+"/.botmux/bots.json";
const admin=process.env.ADMIN_APPID;
const arr=JSON.parse(fs.readFileSync(p,"utf8"));
fs.copyFileSync(p, p+".bak");                       // 先备份
for(const b of (Array.isArray(arr)?arr:arr.bots))
  if(b.larkAppId!==admin) b.readIsolation=true;     // 其余全隔离
fs.writeFileSync(p, JSON.stringify(arr,null,2));
console.log("done, admin=",admin);
'
```

---

## 5. 重启 daemon 让配置生效

```bash
botmux restart
```

> ⚠️ **PM2 复用旧注册的坑（源码部署时常见）**：如果你刚把全局 `botmux` 从 npm 版切到源码 build，PM2 会从旧 dump 复用**旧的 daemon 脚本路径**，`restart`/`start` 都还跑旧 build。此时要**彻底重注册**：
> ```bash
> PM2_HOME=~/.botmux/pm2 <pm2> delete all         # <pm2> = botmux 自带的 pm2 二进制
> node <当前checkout>/dist/cli.js start            # 用当前 build 的 cli.js 全新注册
> ```
> 确认生效：`pm2 describe botmux-0 | grep 'script path'` 应指向当前 checkout 的 `dist/index-daemon.js`。

重启后新会话即带隔离；已有会话冷 resume 时套上隔离。

---

## 6. 验证（上线前后对比）

在测试群 @ 目标 bot 逐条发，**隔离 bot 应全部被拦，admin 应能读**：

| 读什么 | 命令（@ bot 发） | 隔离 bot | admin |
|---|---|---|---|
| 全量凭证 | `cat ~/.botmux/bots.json \| head -c 100` | 🟢 被拦 | 🔴 读到（含所有 app secret）|
| 主机凭证 | `cat ~/.ssh/id_* 2>/dev/null` | 🟢 被拦 | 🔴 读到 |
| 其他 claude bot 对话 | `ls ~/.claude/projects/` | 🟢 被拦 | 🔴 列出 |
| 其他 codex bot 对话 | `ls ~/.codex/sessions/` | 🟢 被拦（claude bot）| 🔴 |
| 其他 bot 会话元数据 | `cat ~/.botmux/data/sessions-<别的appId>.json` | 🟢 被拦 | 🔴 |
| botmux 消息内容 | `ls ~/.botmux/data/turn-sends/` | 🟢 被拦 | 🔴 |
| **不误伤——读自己/工作区** | `cat ~/.botmux/data/sessions-<自己appId>.json` | ✅ 正常 | ✅ |
| **botmux send 正常** | 让 bot 回一条消息 | ✅ 正常 | ✅ |
| **resume 正常** | 追问上一条 | ✅ 记得 | ✅ |

Read 工具层（非 bash）同样应被拦：用 Read 工具读 `~/.botmux/bots.json` → `denied by permission settings`（`bypassPermissions` 也绕不过）。

---

## 7. 隔离覆盖面（deny 什么）

每个隔离 bot 的 deny 列表（surgical，不整目录封 `SESSION_DATA_DIR`，以免挡 `botmux send` 读自己路由）：

- 凭证：`~/.botmux/bots.json`、共享 `~/.lark-cli`、**其他** bot 的 `~/.lark-cli-bots/<appId>`、`~/.ssh` `~/.aws` `~/.config/gh` `~/.config/glab-cli` `~/.npmrc` `~/.docker/config.json` `~/.kube` `~/.git-credentials`、`~/.codex/auth.json`、`~/.claude/.credentials.json`、`~/.claude.json` + `readDenyExtraPaths`
- 对话 transcript：`~/.claude/projects`（claude）、`~/.codex/sessions`（**跨 CLI 家族也隔离**：codex bot 也 deny claude 的、claude bot 也 deny codex 的）
- botmux 内容：`$SESSION_DATA_DIR/{frozen-cards,turn-sends,crash-diagnostics,attachments,whiteboards}`、`sessions.json`、**其他** bot 的 `sessions-<appId>.json`
- **保留可读**：该 bot 自己的 `~/.lark-cli-bots/<自己appId>`（skill 需要）、自己的 `sessions-<自己appId>.json`（`botmux send` 需要）、当前 CLI 自己的 auth（`~/.codex/auth.json` 对 codex bot / `~/.claude/.credentials.json` 对 claude bot——否则 CLI 崩）

---

## 8. 排错（部署实测踩过的坑）

| 症状 | 原因 | 解决 |
|---|---|---|
| `botmux send` 报 **Bot not registered** | agent 的 `botmux` 解析到**没有 fallback 的旧 build**（如 npm 版）；隔离下读不了 bots.json | 把 `botmux` 指向当前 build：`ln -sf <checkout>/dist/cli.js /opt/homebrew/bin/botmux`，或把 `~/.botmux/bin` 放到 PATH 最前 |
| **codex** 的 botmux send 仍 Bot not registered | codex 默认不把自定义 env 透传给 shell 子进程 | 已在 codex adapter 修（隔离时加 `shell_environment_policy.inherit="all"` + `ignore_default_excludes=true`，把注入的 secret 经 env 传给 bash）——确认跑的是含此修复的 build |
| **codex 反复崩溃**（Operation not permitted, os error 1） | 外部包裹把 codex 主进程也关住，却 deny 了它自己的 `~/.codex/auth.json` | 已修：`ownAuthPaths` 自动保留 CLI 自身 auth——确认跑新 build |
| bot 起不来 / `refusing to reattach` | 旧版：隔离 bot 用 tmux 且重启后 reattach fail-closed | 已修：daemon 用 bootId marker，重启后杀陈旧 pane 冷 spawn；用新 build 即可，pty/tmux 都行 |
| 隔离 bot 起不来，报 `Claude Code >= 2.1.187 required` | claude 版本旧，**或** `claude --version` 在高负载下超时 | 升级 claude；瞬时超时已修为不永久毒化缓存（下次重试）——别在机器过载时反复重启 |
| 读**其他 bot 对话记录**没被拦 | 老 build 漏了跨 CLI transcript deny | 用含 `foreignTranscriptDirs` 修复的 build（codex deny `~/.claude/projects`、claude deny `~/.codex/sessions`） |
| dashboard 打不开（`not_found_yet`） | 源码 checkout 缺 react，无法重构 dashboard 浏览器 bundle | 从 npm 包复制预构建 bundle：`cp -R <npm>/dist/dashboard-web/. <checkout>/dist/dashboard-web/` 后重启 dashboard；或在有 react 的环境 `pnpm install && pnpm build` |
| lark skill 挂 | bot 用共享 `~/.lark-cli`，被隔离 deny 了 | 配第一层（per-bot `~/.lark-cli-bots/<appId>`），见第 3 节 |

**沙箱可否绕过？** 不能。实测 `cat` / `python3` / `curl`（联网命令）读 deny 路径全部被 Seatbelt 内核级拦死，联网不会让 file-read deny 失效；Read/Grep/Glob 工具经 `permissions.deny` 硬拦（`bypassPermissions` 也绕不过）。codex 整进程被外部 Seatbelt 关死（最硬），claude 内置沙箱直接读已证硬拦。

---

## 9. 已知限制

- **admin bot 是旁路**：不隔离的 bot 能读所有数据，务必收紧其 `allowedUsers`。
- **读隔离 ≠ 防外传**：agent 对**能读到**的文件仍可联网上传，需另配网络策略。
- **多 codex bot 共享 `~/.codex/sessions`**：codex 自己的 transcript 目录不按 bot 分离（deny 它会破坏 codex 自身 resume），所以多个 codex bot 之间的对话记录目前**不互相隔离**。单 codex bot 无此问题。claude bot 之间的 transcript 正常隔离。
- **同一 OS 用户下**：隔离强度 = 沙箱配置完整性；不防内核漏洞、不防 root。要更强隔离用不同 OS 用户 / 容器（见 `docs/design/` 的 Phase-2 方案）。
- **Linux**：Codex/其他的外部包裹是 bwrap 占位、未实现（fail-closed）；仅 Claude bot 可在 Linux 隔离。

---

## 10. 回滚

```bash
# 关某个 bot 的隔离：删掉它 bots.json 里的 "readIsolation": true，然后 botmux restart
# 或整体回滚配置：
cp ~/.botmux/bots.json.bak ~/.botmux/bots.json && botmux restart
```
