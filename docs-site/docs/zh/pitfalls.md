# 常见踩坑与规避

> 这里收集社区里反复出现的问题，按常见程度排序。**装完或升级后行为不对，先来这里扫一眼**，多半是已知问题。不知道从哪查起，直接看文末的[排查通用手法](#排查通用手法)。

## 先按症状找

| 你看到的现象 | 先看哪一节 |
|------|------|
| 群里收不到消息、CLI 像是中途退出、`botmux history` 报 400 | 机器人权限 / 应用创建 |
| `botmux: command not found`、安装失败、启动被拒 | 环境 / 安装 |
| 话题里提示「卡在目录信任确认 / 登录 / 升级确认」 | 环境 / 安装 → 首次启动卡在确认框 |
| `API Error 403`、网关 token 报错 | 环境变量丢失 |
| 启动直接失败、掉进 shell、`unknown option` | 自定义 wrapper / 网关接入 |
| 模型在终端里答了，飞书里没回复 | 输入 / 提交 |
| 机器人时好时坏、会话被关又自己起来 | 进程 / 连接 |
| Dashboard 打不开 | Dashboard / 安全 |

## 机器人权限 / 应用创建（最常见）

**症状**五花八门：CLI 像是「中途退出」、群里收不到消息、`botmux history` 报 400……根因大多是机器人权限没配全。常见的来路有三种：复用了旧应用建的机器人、没用最新版 `botmux setup` 扫码创建、手动建应用时漏了权限。

**怎么办**：用最新版 `botmux setup` 扫码**重新创建**应用。它会自动配齐全部权限并发布版本。别复用旧应用的机器人，手动建也别漏权限。

## 环境 / 安装

- **装完提示 `botmux: command not found`**：`~/.botmux/bin` 还不在 PATH 里。curl 和 npm 两种安装方式都会把它写进你当前 shell 的启动文件（如 `.zshrc` / `.bashrc`），但**要开一个新终端（或 `source` 一下）才生效**。还不行，就手动把 `export PATH="$HOME/.botmux/bin:$PATH"` 加进启动文件。
- **npm 安装失败，提示 `no prebuilt binary package`**：npm 包现在装的也是自包含二进制，按你的平台挑对应的子包。子包没装上就会报这个错。→ 先试 `npm i -g botmux --force`；还不行就改用 curl 安装（不依赖 Node）。npm 本身要求 **Node ≥ 22**。
- **从源码跑，`botmux start` / `restart` 拒绝启动，提示「加载不出 SQLite 引擎」**：会话存储需要 Node ≥ 22.13（23.x 需 ≥ 23.4）或 bun。这个检查在停掉旧进程**之前**做，所以拒绝时线上的 bot 还在正常跑。→ 按提示用合格的解释器重跑（例如 `bun dist/cli.js restart`）。别用裸 `node`，它跟着 PATH 走，可能又落到老版本。
- **`cliId: "gemini"` 的 bot 不启动**：Gemini CLI 已停止维护，适配器已移除，其它 bot 不受影响。→ 把 `cliId` 改成 `"antigravity"`（命令 `agy`，先安装并用 Google 账号登录，或配 Gemini API key），并清掉原来给 Gemini 配的 `cliPathOverride` / `wrapperCli` / `model`。详见 [Gemini CLI 已下线](/adapters#gemini-cli-已下线)。
- **首次启动卡在确认框**：有的 CLI 第一次启动会问「信任这个目录吗」「要不要登录 / 升级」「用不用环境变量里的 API key」等。botmux 没法在飞书里替你回答，会在话题里发一条提示，比如「⚠️ Claude Code 卡在目录信任确认」，你发的消息先暂存、不会被打进确认框。→ 打开 Web 终端（或在本机）做出选择，之后会自动接着处理。一般只需确认一次。

## 环境变量丢失（高频）

- **bash 用户把变量写在 `.bash_profile`，会话里拿不到**：botmux 用 `bash -i` 启动会话，它只读 `.bashrc`。→ 在 `.bashrc` 里加一行 `source ~/.bash_profile`，或直接把变量写进 `.bashrc`。zsh 写 `.zshrc`，fish 写 `~/.config/fish/config.fish`。这是 `API Error 403`、网关 token 报错最常见的原因。
- **root 下 Claude 报 "cannot be used with root/sudo privileges"**：Claude Code 在 root 下拒绝 `--dangerously-skip-permissions`。botmux 检测到 root 时会自动给 Claude 系 CLI 注入 `IS_SANDBOX=1`，一般不用管。如果你的 wrapper 清空了环境、仍然报错，再手动 `export IS_SANDBOX=1`（PM2 / systemd / Docker 场景配在对应的启动环境里）。

## 自定义 wrapper / 网关接入

用自己的脚本包一层再启动 CLI（比如接内部网关）时，常见两种问题：

- **没把参数透传下去**：脚本里没有正确写 `"$@"`，CLI 就收不到 `--session-id` 等参数。
- **把 botmux 要用的参数拦掉了**：比如屏蔽了 `--settings`，或报 `unknown option '--images'`，启动失败后会掉进 shell。

**怎么定位**：拿到 botmux 实际执行的启动命令，在本机手动跑一遍。两种拿法：Dashboard 会话列表里点「复制复现命令」（命令里含 token 等凭证，注意保密）；或者 `botmux logs` 里找 `Spawning fresh CLI:` 那一行。

## 输入 / 提交

- **多行消息被拆成好几条提交**：有些 TUI 会把 prompt 里的换行、Tab 当成回车或补全键。botmux 对 Codex、CoCo 已改成「整段粘贴」（bracketed paste）的方式输入。你自己用 `botmux send` 发多行内容时，也请用 heredoc。
- **模型在终端里答了，飞书里却没回复**：默认情况下最终回复要靠模型自己调用 `botmux send`。弱模型或套壳模型容易忘了调，或者反复调停不下来。→ 两个办法：
  - 换更强的模型，或加更明确的提示约束；
  - 对支持的 CLI（Claude Code、Codex、CoCo 等）打开 `replyDelivery: "transcript"`：botmux 直接从 CLI 记录里取本轮最后一段回答发到飞书，不再依赖模型调用 `botmux send`。配置方法见 [bots.json 配置](/bots-json) 里的 `replyDelivery`。
- **`botmux send --images` 一次 6 张以上可能静默失败**：→ 一次最多 4 张，分批发。

### 消息发出去没反应：看诊断卡 {#submit-failure-diagnosis}

自动的，不用配置。消息交给 CLI 后迟迟确认不了，botmux 会先看一眼终端现场，再发一张说清原因的卡片（错误码仍是 `submit_unconfirmed`），而不是笼统的「提交确认失败」：

| 卡片说的情况 | 怎么处理 |
|---|---|
| CLI 停在登录 / 鉴权页面 | 打开 Web 终端完成 CLI 自己的登录，再重发。CLI 登录和飞书授权是两回事 |
| CLI 停在等键盘选择的界面（更新、数据迁移、hooks review、确认框等） | 打开 Web 终端选一项，或按 Esc 取消后再重发。botmux 不会替你选 |
| 正文已粘贴但停在输入框没提交 | 打开 Web 终端按 Enter 提交；确认不需要执行再回飞书重发 |
| 看不出原因 | 卡片会提醒：确认失败不等于没执行，先去 Web 终端核对，确实没执行再重发 |

## 进程 / 连接

- **同一个飞书机器人被两个程序同时连着**：飞书长连接谁先抢到归谁，botmux 就会时好时坏。→ 一个机器人只给一个程序用。
- **`tmux ls` 看不到 bot 的会话**：botmux 的会话跑在独立的 tmux server 上，要加 `-L botmux`，例如 `tmux -L botmux ls`。见 [Tmux 会话常驻](/tmux)。
- **手动 `tmux kill-session` 之后会话又起来了**：daemon 仍认为会话活着，下一条消息会把它拉起来。→ 要真正结束，在话题里发 `/close`，或在命令行用 `botmux delete <会话 ID>`。
- **配了 `defaultWorkingDir`，每个新话题都直接开会话**：这是「跳过选仓库」的正常效果，不会再先弹选仓卡片。不想要就删掉这项配置。如果配置的目录不存在，botmux 不会在别的目录乱跑，而是发一张「工作目录不存在」卡片让你选，选完这条消息直接开始，不用重发：

  ![工作目录不存在时弹出的选仓卡片](/img/pitfalls-missing-workdir-card-zh.png)

- **在 bot 自己的终端里执行 `botmux restart`，之后偶发 token / 网关报错**：会话里带着一批运行时变量（`TMUX`、`LARK_*`、`BOTMUX_*` 等）。botmux 已在各个进程边界清理这些变量，但如果仍遇到这类偶发错误，在**干净的、不在 tmux 里的 shell** 中重启一次。
- **`/repo` 的编号会变**：仓库列表里多了新仓库，后面的编号就会往后挪。→ 自动化脚本别写死编号，用 `/repo <项目名>` 或 `/repo <路径>`。

## 磁盘 / 日志

- **`tmux-server-*.log` 把磁盘撑满**：这类文件只在用 `tmux -v` / `-vv` 启动 tmux 时产生，不会自动轮转，长期运行能涨到上百 GB。botmux 自己从不加 `-v`，可以放心删，不影响 botmux 日志。

## 协作

- **两个 bot 互相 @，停不下来**：每条消息末尾都「发送给 @对方」，就会无限循环。→ 通常一方停下就好。根本上是模型话太多，给它加约束。

## Dashboard / 安全

- **别把带 token 的 Dashboard 链接发到群里**：token 就是登录凭证，发出去等于把钥匙交给群里所有人。它会一直有效，直到你执行 `botmux dashboard rotate` 换新 token，旧链接才会立刻失效；`botmux dashboard` 和 `botmux dashboard current` 都不会换。安全要求高时，把 Dashboard 只绑在本机：`BOTMUX_DASHBOARD_HOST=127.0.0.1`。更多见 [Dashboard · 链接里的 token 是什么](/dashboard#链接里的-token-是什么)。
- **Dashboard 打不开**：先 `curl http://<host>:<port>/__health`，返回 `{"ok":true}` 说明服务正常。那问题多半在浏览器这边：代理没绕开、host 不对（Mac 连内网时 IP 可能变了），或者打开的是已经轮换掉的旧 token 链接。

## 排查通用手法

遇到「起不来」或「行为不对」，先走这三步：

1. **复现启动命令**：从 Dashboard 「复制复现命令」，或在 `botmux logs` 里找 `Spawning fresh CLI:` 那一行，在本机手动跑一遍。权限、参数、登录状态问题基本都能这样一眼看出来。
2. **看 Web 终端**：打开会话的 Web 终端，直接看模型或网关报的真实错误。
3. **让 agent 自查**：把现象丢给本机的 agent 让它查一下。修好了欢迎给社区提 PR。
