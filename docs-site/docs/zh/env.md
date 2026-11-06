# 环境变量与文件位置

大部分配置都在 `bots.json` 和 Dashboard 里改，**一般不用碰环境变量**。只有少数整机级别的开关（监听地址、端口、对外地址、后端类型等）写在 `~/.botmux/.env`。本页列出这些开关，以及 botmux 的关键文件放在哪，方便备份和排查。

**什么时候看这页**：Dashboard 或 Web 终端打不开、要改监听地址或端口、终端链接里的地址不对、要切 pty 后端、想知道配置 / 日志 / 数据在哪。

> 本页讲的是 **botmux 自己进程**的环境变量。如果你想控制「会话里的 CLI 能拿到哪些变量」，请到 Dashboard「设置 → 会话环境变量」（全局）或「Bot 配置 → 高级 → 启动环境 → 会话环境变量」（单个 Bot）里改，详见 [bots.json 配置 → 会话环境变量](/bots-json#session-env)。

## 怎么改

1. 编辑 `~/.botmux/.env`，一行一个，格式 `KEY=value`：

   ```bash
   # ~/.botmux/.env
   WEB_EXTERNAL_HOST=10.0.0.12
   BOTMUX_DASHBOARD_PORT=7891
   ```

2. 重启生效：

   ```bash
   botmux restart
   ```

建议**写进文件，而不是只在 shell 里 `export`**。在飞书会话里让 Bot 执行的重启只认 `~/.botmux/.env` 里的值，不会继承你当时 shell 的环境；只 `export` 的话，下次从会话里重启就丢了。

## 网络与访问地址

想让 Web 终端、Dashboard 链接能被别人打开，主要看这一组。

| 变量 | 默认 | 用途 |
|------|------|------|
| `WEB_HOST` | `0.0.0.0` | Web 终端服务监听的地址 |
| `WEB_EXTERNAL_HOST` | 自动取本机局域网 IP | 卡片里终端链接用的主机名 / IP。机器有多张网卡、或要用域名访问时设它（见 [Web 终端](/web-terminal)） |
| `BOTMUX_WEB_PROXY_BASE_PORT` | `8800` | 每个 Bot 的终端入口端口 = 这个值 + Bot 序号（第 1 个 Bot 是 8800，第 2 个是 8801……） |
| `WEB_EXTERNAL_PORT` | 不设，用本机端口 | 中转机对外暴露的端口和本机不一样时设它。同样按 Bot 序号递增：实际是 `WEB_EXTERNAL_PORT + Bot 序号` |
| `BOTMUX_WORKER_HTTP_HOST` | `0.0.0.0` | 每个会话的终端子服务监听地址（旧名 `BOTMUX_WORKER_HOST` 仍可用） |
| `BOTMUX_DASHBOARD_HOST` | `0.0.0.0` | Dashboard 监听地址 |
| `BOTMUX_DASHBOARD_PORT` | `7891` | Dashboard 端口。被占用时会自动往后找空闲端口，实际端口写在 `~/.botmux/.dashboard-port` |
| `BOTMUX_DASHBOARD_EXTERNAL_HOST` | 依次取 `WEB_EXTERNAL_HOST`、非通配的监听地址、局域网 IP | `botmux` 命令打印 Dashboard 链接时用的主机名 |
| `BOTMUX_PUBLIC_URL` | 不设 | 你自己用 nginx 等把 Dashboard 反代到一个域名时设它，如 `https://botmux.example.com`。设了之后，Dashboard 和卡片里的终端链接都变成 `<这个地址>/…`、`<这个地址>/s/<会话 ID>`，只需对外开放这一个入口，不用每个 Bot 一个端口 |
| `BOTMUX_DEVBOX_AUTO_EXPORT` | 开 | 在 Merlin Devbox 上自动为 Dashboard 生成私有短链。已开中心平台远程访问或已设 `BOTMUX_PUBLIC_URL` 时不会生成。设 `0` 或 `false` 关闭；生成失败会自动退回本机地址 |
| `BOTMUX_DAEMON_IPC_BASE_PORT` | `7950` | 各 Bot 后台进程之间内部通信用的端口 = 这个值 + Bot 序号，只监听本机。一般不用改，除非端口冲突 |

> Dashboard 链接用哪个地址：中心平台（开了远程访问时）> `BOTMUX_PUBLIC_URL` > Devbox 短链 > 本机 `主机:端口`。终端链接同理，只是不走 Devbox 短链。

## Dashboard 访问控制

| 变量 | 默认 | 用途 |
|------|------|------|
| `BOTMUX_DASHBOARD_PUBLIC_READONLY` | `true` | 允许不带 token 只读浏览 Dashboard（会话、定时任务等），过期链接也能看，写操作仍要 token。设 `false` 关闭。**注意**：在 Dashboard「设置」页改过这个开关后，以 `~/.botmux/config.json` 里的值为准，再改环境变量不生效 |
| `BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS` | `300000`（5 分钟） | 在 Dashboard 里「接管」终端后可输入的时长，范围 10 秒～15 分钟。到期、主动释放或断开连接后回到只读 |
| `BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH` | `~/.botmux/audit/dashboard-control.ndjson` | 终端接管等操作的审计日志位置。只记时间、操作人、会话和动作，不记输入内容 |

### 飞书内免登录打开 Dashboard（可选）

默认关闭。打开后，可以在飞书 H5 应用里直接进 Dashboard，不用在链接里带 token，只放行名单里的人。

| 变量 | 说明 |
|------|------|
| `BOTMUX_DASHBOARD_FEISHU_H5_ENABLED` | 设 `true` 开启 |
| `BOTMUX_DASHBOARD_FEISHU_H5_APP_ID` / `_APP_SECRET` | 用于免登的飞书应用凭证 |
| `BOTMUX_DASHBOARD_FEISHU_H5_ALLOWED_OPEN_IDS` | 允许登录的用户，逗号分隔（这个应用下的 open_id） |
| `BOTMUX_DASHBOARD_FEISHU_H5_BRAND` | `feishu`（默认）或 `lark` |
| `BOTMUX_DASHBOARD_FEISHU_H5_ENTRY_PATH` | 免登入口路径，默认 `/auth/feishu` |
| `BOTMUX_DASHBOARD_FEISHU_H5_SESSION_TTL_MS` | 登录有效期，默认 30 分钟，范围 1 分钟～24 小时 |
| `BOTMUX_DASHBOARD_FEISHU_H5_SECURE_COOKIE` | 前面有 HTTPS 反代、但没把 `BOTMUX_PUBLIC_URL` 设成 `https://` 时，设 `true` |
| `BOTMUX_DASHBOARD_FEISHU_H5_TRUSTED_PROXY_HOPS` | Dashboard 前面有几层反代（默认 `0`，范围 0～8），用于正确识别来访 IP 做限流 |

这组变量（含应用密钥）只给 Dashboard 进程用，Bot 后台进程和会话里的 CLI 都拿不到。

## 会话与行为

| 变量 | 默认 | 用途 |
|------|------|------|
| `BACKEND_TYPE` | `tmux` | 会话后端。默认始终用 tmux；tmux 不可用时会弹卡片提示，不会悄悄换成 pty。只有显式设 `pty` 才用纯 pty 后端，但 pty 会话在 botmux 重启后不能保留（见 [tmux 后端](/tmux)） |
| `BOTMUX_FORWARD_FOLLOWUP_WAIT_MS` | `1500` | 话题群里新话题发出后，等多久收同一个人紧跟着的补充说明，一起交给 CLI。`0` 关闭，最大 `10000` |
| `BOTMUX_SENDER_RESOLVE_TIMEOUT_MS` | `800` | 查发消息人姓名时每一步的超时（毫秒）。网络慢可设 `3000`（两步都超时时最多等 6 秒）。不影响 owner 身份校验（它有独立的 3 秒预算） |
| `BOTMUX_ASK_TIMEOUT_MS` | `86400000`（24 小时） | CLI 的提问转成飞书卡片后，最多等多久回答。超时后问题退回终端，飞书里就答不了了，所以默认放得很长，不建议调短 |
| `BOTMUX_PERMISSION_TIMEOUT_MS` | `600000`（10 分钟） | 工具权限确认卡最多等多久。超时按「拒绝」处理，会话继续往下跑。会被限制在 1 秒～14 分钟之间 |
| `STUCK_DETECTOR_ENABLED` | 开 | 输入发出后迟迟没完成一轮时，检查 CLI 是否停在 Codex 的 hook 审核界面，是的话提醒你。设 `false` 关闭 |
| `STUCK_DETECTOR_TIMEOUT_MS` | `45000` | 上面这项检查在输入发出后多久（毫秒）进行 |
| `BOTMUX_SCHEDULE_TIMEZONE` | 不设，用页面里选的时区，再没有就用主机时区 | [定时任务](/schedule)用的时区，如 `Asia/Shanghai`。优先级高于「全局设置」页里选的时区；不合法的名字会被忽略 |
| `BOTMUX_RECOVERY_FORK_BATCH` | `5` | botmux 重启后恢复会话时，每批重新拉起几个，避免一下子全起来把机器压满。最小 `1` |
| `BOTMUX_RECOVERY_FORK_DELAY_MS` | `250` | 恢复会话时两批之间隔多久（毫秒）。最小 `0` |
| `BOTMUX_WORKTREE_SLUG_AI_ENABLED` | 关 | 设 `true` 后，用 AI 给新 worktree 起分支名，见下方「用 AI 给 worktree 起名」 |
| `BOTMUX_ALLOW_UNKNOWN_SCOPES` | 不设 | 设 `1` 后，可以申请 botmux 权限清单里还没收录的飞书权限（只检查格式）。飞书新出权限、botmux 还没发版时临时用 |
| `BOTMUX_CODEX_NODE_REPL_PATH` | 不设 | 显式启用浏览器相关功能、但没配好 MCP 运行时时，指定已安装的 Codex `node_repl` 可执行文件的绝对路径 |

`BOTMUX_ASK_TIMEOUT_MS` 和 `BOTMUX_PERMISSION_TIMEOUT_MS` 由会话里的 CLI 读取，默认继承 `~/.botmux/.env` 里的值。它们以 `BOTMUX` 开头，属于 botmux 保留变量，不能在会话环境变量里按 Bot 单独设置；Bot 开了[严格进程环境继承](/bots-json#strict-env)时，这两项传不进会话，按默认值生效。

### 用 AI 给 worktree 起名（可选）

默认关闭。自动给新 worktree 起分支名时（如 `/repo wt`），默认用本地规则。打开后改为调用你配置的 OpenAI 兼容接口，**会把话题标题 / 首条消息发给这个接口**。没开、配置不全或请求失败时，仍用本地规则。

| 变量 | 默认 | 用途 |
|------|------|------|
| `BOTMUX_WORKTREE_SLUG_AI_ENABLED` | 关 | 设 `true` 开启 |
| `BOTMUX_WORKTREE_SLUG_AI_BASE_URL` | 不设 | 接口地址，必填，如 `https://api.example.com/v1`。botmux 会在后面拼上 `/chat/completions` |
| `BOTMUX_WORKTREE_SLUG_AI_API_KEY` | 不设 | 接口密钥，必填 |
| `BOTMUX_WORKTREE_SLUG_AI_MODEL` | 不设 | 模型名，必填 |
| `BOTMUX_WORKTREE_SLUG_AI_TIMEOUT_MS` | `5000` | 请求超时（毫秒） |
| `BOTMUX_WORKTREE_SLUG_AI_EXTRA_HEADERS` | 不设 | 额外请求头，JSON 字符串，如 `{"X-Team":"dev"}`。不是合法 JSON 时忽略 |
| `BOTMUX_WORKTREE_SLUG_AI_EXTRA_BODY` | 不设 | 额外请求体参数，JSON 字符串。不是合法 JSON 时忽略 |

### 主机过载提醒

过载提醒在 Dashboard「全局设置」里打开并选通知 Bot（见 [全局设置](/global-settings)）。下面的变量用来微调阈值，进入阈值优先级高于页面里填的值。

| 变量 | 默认 | 用途 |
|------|------|------|
| `BOTMUX_OVERLOAD_ALERT` | 不设 | 设 `0` 彻底关闭过载提醒，不管页面里怎么设 |
| `BOTMUX_OVERLOAD_ENTER_LOAD_RATIO` | `1.5` | 15 分钟平均负载超过「CPU 核数 × 这个值」时算过载 |
| `BOTMUX_OVERLOAD_EXIT_LOAD_RATIO` | `1.0` | 负载降到「CPU 核数 × 这个值」以下才算恢复 |
| `BOTMUX_OVERLOAD_ENTER_MEM_FRAC` | `0.92` | 内存使用比例（0～1）达到这个值时算过载 |
| `BOTMUX_OVERLOAD_EXIT_MEM_FRAC` | `0.85` | 内存使用比例降到这个值以下才算恢复 |
| `BOTMUX_OVERLOAD_MIN_REALERT_MS` | `900000`（15 分钟） | 两次「进入过载」提醒之间至少隔多久 |

恢复阈值要比进入阈值低。如果填得不低于进入阈值，botmux 会把它改成进入阈值的 95%，并在日志里告警。

## 路径、日志与 GitHub

| 变量 | 默认 | 用途 |
|------|------|------|
| `BOTS_CONFIG` | 不设，用 `~/.botmux/bots.json` | 指定另一个 bots.json 文件 |
| `SESSION_DATA_DIR` | `~/.botmux/data` | 会话、队列等数据存放目录。botmux 启动时会把实际位置记到 `~/.botmux/.data-dir`，命令行工具会跟着用 |
| `BOTMUX_WORKFLOW_RUNS_DIR` | `~/.botmux/workflow-runs` | 工作流运行记录目录 |
| `DEBUG` | 不设 | 设 `1` 打开调试日志 |
| `GITHUB_TOKEN` | 不设 | botmux 访问 GitHub（Dashboard 更新日志、检查更新、重启报告）时用的 token，避免被限流 |
| `GH_TOKEN` | 不设 | 同上，仅在没设 `GITHUB_TOKEN` 时使用 |

`GITHUB_TOKEN` / `GH_TOKEN` 只用于 botmux 自己的 GitHub 请求，**默认不会传给会话里的 CLI**。想让某个 Bot 的会话也能用，请在该 Bot 的会话环境变量里单独配置。

## 高级 / 特殊环境

| 变量 | 默认 | 用途 |
|------|------|------|
| `BOTMUX_COMPANION_SECRET_FILE` | 不设 | [本地 Companion API](/companion-api) 专用的密钥文件路径，通常由 `botmux start/restart --companion-secret-file` 设置。文件必须是当前用户拥有、权限 `0600`、非软链、非空的普通文件，且写绝对路径。它不会传给会话 CLI，也不会退回使用 `.dashboard-secret` |
| `BOTMUX_COMPANION_BOT_APP_ID` | 不设 | Companion API 绑定的那个测试 Bot，通常由 `--companion-bot` 设置。调用方不能自选 Bot |
| `BOTMUX_LOOPBACK_PEERS` | 空 | 只给特殊内核用：同一台机器上的本机连接被系统报成局域网 IP，导致 Dashboard 或内部调用被拒。填额外放行的来源地址，逗号分隔的 IP / CIDR，如 `10.0.0.5,192.168.0.0/16` |

关于 `BOTMUX_LOOPBACK_PEERS` 的几点说明：

- 默认空，只认 `127.0.0.1` 和 `::1`，与旧版一致。
- 它只放宽「请求必须来自本机」这一层，签名、时间戳、防重放校验照旧，签名不对的请求仍被拒。
- 范围过大（`/0`～`/7`）或格式不对的条目会在启动时被忽略并告警。
- 尽量写单个地址（`/32`）或最小的实际子网。IPv4 地址直接写 IPv4 形式即可，例如 `10.0.0.0/8` 同时覆盖普通 IPv4 和双栈下的 `::ffff:10.x` 形式。

## 文件位置

| 路径 | 是什么 |
|------|------|
| `~/.botmux/bots.json` | 机器人配置 |
| `~/.botmux/.env` | 本页的环境变量 |
| `~/.botmux/config.json` | Dashboard「设置」页保存的全局设置，见 [全局设置](/global-settings) |
| `~/.botmux/data/` | 会话数据、消息队列等（可用 `SESSION_DATA_DIR` 改） |
| `~/.botmux/logs/` | 后台进程日志，也可以用 `botmux logs` 查看 |
| `~/.botmux/bin/botmux` | 全局 `botmux` 命令的入口脚本（自动写入） |
| `~/.botmux/lark-scopes.json` | 推荐申请的飞书权限完整清单（setup 时写出，复制后到开放平台批量导入） |
| `~/.botmux/.dashboard-port` | Dashboard 实际监听的端口 |
| `~/.botmux/.dashboard-secret` | Dashboard 签名密钥（权限 0600，不要外传） |
| `~/.botmux/audit/` | Dashboard 终端接管审计日志 |

备份时，至少保留 `bots.json`、`.env`、`config.json` 和 `data/`。
