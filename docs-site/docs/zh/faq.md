# FAQ / 排错

> 综合自 README 与社区交流群高频问题，持续补充中。更多坑见 [常见踩坑](/pitfalls)。

## 「机器人不回复」怎么排查？（最高频问题）

先按**症状**对号入座，不同症状根因不同：

| 症状 | 大概率根因 | 跳转 |
|------|-----------|------|
| 发消息**完全没反应**（连表情都没有） | 事件订阅 / 发版 / 长连接没通 | [A. 完全收不到消息](#a-完全收不到消息) |
| 只有**我（owner）**能触发，别人 @ 弹授权卡 / 不回 | 只配了操作权、没配对话权 | [B. 别人不能用 / 弹授权卡](#b-别人不能用--弹授权卡) |
| 群里**必须 @ 才回** / 想免 @ 自动回 | 群 @ 策略 | [B. 别人不能用 / 弹授权卡](#b-别人不能用--弹授权卡) |
| 有 🟡「工作中」但**结果没发出来**（终端里有输出） | 终端 CLI 会话：模型没调 `botmux send`（`codex-app` 是自动转发、属例外） | [C. 终端有输出但没发飞书](#c-终端有输出但没发飞书) |
| 会话**起不来** / 首条消息报 `zsh: parse error` | 登录 shell 启动文件跳转 | [会话起不来](#会话怎么都起不来--首条消息报-zsh-parse-error) |

### A. 完全收不到消息

按顺序自查（PersonalAgent 默认配好，正常不用动）：

1. **事件订阅**：开放平台 → 事件与回调 → 应订阅 `im.message.receive_v1` + `card.action.trigger`，方式为「长连接 (WebSocket)」，且 daemon 已在跑。
2. **机器人能力**：开放平台 → 应用功能 → 机器人 应已开通。
3. **发版**：应用要创建并发布过版本（可用性「仅自己可见」自动通过）。改完权限 / 事件**必须重新发版**才生效。
4. **长连接独占**：确认这个 Bot 没被别的应用同时抢长连接。
5. 确认后 `botmux restart`（在干净 shell 里）。

> 想让 agent 帮你自查，见 [常见踩坑 · 排查通用手法](/pitfalls#排查通用手法)（`botmux logs` 找 spawn 命令本地复现 + Web 终端看真实报错）。

### B. 别人不能用 / 弹授权卡

botmux 权限分两层（详见 [权限怎么分](#权限怎么分谁能操作)）：**对话权**（谁能问）和**操作权**（谁能 `/cd` `/restart` 点按钮）。默认只有 owner 有对话权，所以别人 @ 会被拒 / 弹授权卡。

- **让整个群都能用**：给 bot 配 `allowedChatGroups`（该群全员可对话），或用 `/grant` 授权指定群。
- **群 @ 策略**（必须 @ vs 免 @）：默认多人群必须 @；话题内免 @ / 全群免 @ 可在群 @ 策略里配。注意「1 个人 + 1 个 bot」的 1v1 群本来就免 @。
- **oncall 场景**（每工单一个新群、全员免 @ 直接问）：见 [Oncall 模式](/oncall)。

### C. 终端有输出但没发飞书

**这条只针对需要显式发送的终端 CLI 会话**（Claude Code / Codex CLI / Gemini / CoCo 等）：终端 stdout ≠ 已发飞书，模型必须显式执行 `botmux send`（并带 `--mention-back` / `--mention` / `--no-mention` 之一），群里才看得到。只 `echo`/`print` 或忘调 `botmux send` 就不会发出。多行内容用 heredoc，别写成 `"第一行\n第二行"`。

> ⚠️ **例外：`codex-app`（Codex App app-server 协议）**——它的最终 assistant message 由 botmux **自动转发**回飞书，**常规回复不要调 `botmux send`**（否则会重复发送），仅在中途主动推送 / 发附件 / 跨 bot @ 时才用。

## `botmux history` 报 400 / 飞书网关 411？

- **400**：通常是飞书机器人权限缺失（如缺 `im:message.group_msg`）→ 把权限 JSON 全开。
- **411**：飞书网关对"带空 body 的 GET"更严格，旧版 SDK 给 GET 带 `{}` body 触发 → 升级到新版已修。

## `Please run /login · API Error: 403` 怎么解？

先分清是哪个 `/login`：

- **飞书侧 App Token 调 API 被拒**：话题里发 `/login` → 点授权链接 → 把浏览器跳转的 callback URL（`http://127.0.0.1:9768/callback?...`，页面打不开是正常的）复制回话题。
- **模型网关侧 403**：跟飞书授权无关，多为环境变量 / 网关 token 问题，常见根因是 bash 用户把变量写在 `.bash_profile` 没被 `bash -i` 读到（见 [常见踩坑](/pitfalls)）。

**macOS 补充：claude 的登录 token 有 keychain / 文件「双存储」，两者分裂是 macOS 下 claude 报 `Please run /login` 的主要原因。**

- **keychain**（钥匙串条目 `Claude Code-credentials`）：**GUI 里跑 claude** 和 **botmux 默认（非隔离）配置**都走这里；
- **文件**（`~/.claude/.credentials.json`）：**SSH 里跑 `/login` 只能写到这里**。

坑点：**只要 keychain 条目存在，claude 就只读 keychain 里的 token、不会去读文件**——哪怕文件里才是刚更新的新 token。于是会出现「SSH `/login` 明明成功了（只写进了文件），GUI / 非隔离 bot 却仍读 keychain 里的旧 token、报 `Please run /login`」。再叠加 claude 刷新时 refresh token 会轮换，谁先刷就把对方的 token 作废，导致集体掉登录。

**推荐做法（统一收敛到「文件」单一源）：**

1. **禁止在 GUI 下使用 claude code**——GUI 会往 keychain 写 / 刷 token，凭空制造第二个源；
2. **统一通过 SSH 跑 `/login` 更新 token**，让 SSH 和 botmux 都以文件作为登录 token 的来源；
3. keychain 里若已残留旧条目，删掉它、收敛到单一文件源。

## 支持 Lark 国际版（larksuite.com）吗？

支持。飞书 (feishu.cn) 和 Lark 国际版 (larksuite.com) 都能用：扫码建应用时**自动识别**租户类型（国内 / 国际）并记住，手动粘 AppID/Secret 时会让你选一次。每个机器人按所属版本独立连对应域名，同一台机器可同时跑飞书和 Lark 机器人，登录凭证按应用隔离、互不干扰。

## 多个机器人怎么互相协作？

**默认就支持，不用任何额外设置**——把要协作的机器人拉进同一个群就行。

- **群里只有你和一个 bot**：直接说话即可，自动响应、无需 @。
- **多个 bot / 多个人的群**：发消息时 @ 你想交给的那个 bot。
- 需要 bot 之间接力（如一个写、一个 review）时，由 bot 用 @ 互相触发，你只管把活交给第一个。

详见 [多机器人协作](/multi-bot)。

## daemon 重启会丢上下文吗？

装了 **tmux** 就不会——tmux 是默认后端，CLI 进程常驻 tmux session，`botmux restart` 后下次消息自动 re-attach，无需 `--resume`。⚠️ 没装 tmux **不会自动降级 pty**，而是硬拦截弹卡让你装 tmux；只有显式 `BACKEND_TYPE=pty`（或 per-bot `backendType:"pty"`）才用 pty，且 pty 会话**不跨 daemon 重启存活**、重启会重载。

## 会话不关会一直跑吗？有自动回收吗？

会一直跑，**目前无空闲 TTL 自动回收**。用 `/close`、Dashboard 批量关闭、或 `botmux delete stopped`/`all` 清理。

## 工作目录 / 仓库选择不对？

- `workingDir` 从该目录**向下**找 git 仓库（最多 3 层），不向上扫。指向集合根（如 `~/projects`）列出全部；指向单仓库只列该仓库（含 worktree）。
- 临时切目录用 `/cd <path>`；想跳过选择卡片直连某仓库用 `defaultWorkingDir`（注意副作用见踩坑）。
- 别把 `workingDir` 设成 `~`，会遍历太多文件夹。`/repo` 编号会漂移，用 `/repo <项目名>` 指定。

## 权限怎么分？谁能操作？

三层：`allowedChatGroups` / `globalGrants` 给**对话权**（群内全员可问）；`allowedUsers` 给**操作权**（owner 才能 `/cd` `/restart` `/close` 点按钮）。配了 `allowedChatGroups` 时 `allowedUsers` 至少要有一个 owner。

## 运行中的会话能临时追问 / 打断吗？

默认不打断当前轮，新消息排队（type-ahead），本轮结束再依次输入。想立即纠偏：先在卡片 / Web 终端点 `Esc` 打断，再提问。

## 能用 ccr / 自定义网关 / 各种 wrapper 启动 CLI 吗？

能。任何"原生 CLI + wrapper / 网关"的组合，写一个把 `"$@"` 透传的 wrapper 脚本，在 `botmux setup` 编辑机器人时把 `cliPathOverride` 配成该脚本路径即可。

## 会话怎么都起不来 / 首条消息报 `zsh: parse error near '\n'`？

多半是你的登录 shell（`$SHELL`，常见 bash）的启动文件里有"切到另一个 shell"的逻辑——最典型是 `~/.bashrc` 里：

```bash
if [ -t 1 ]; then exec zsh; fi   # chsh 不生效时常见的 hack
```

botmux 在 tmux 里用 `<$SHELL> -i -c '… 启动 CLI'` 拉起会话，`-i` 会 source 这个启动文件，于是 `exec zsh` 把 shell 顶替掉，真正启动 CLI 的那条命令没机会执行——pane 停在一个空 shell，首条消息被打进去就报 `zsh: parse error`。

v2.95.0 起 botmux 会检测这种"会话没真正起来"的情况并发一张诊断卡，不再把消息打进空 shell。修复二选一：

- **配 `launchShell`（推荐）**：给该 bot 指定直接用目标 shell 启动，绕开会跳转的启动文件。`/config launchShell zsh`，或 dashboard「机器人默认设置 → 启动 Shell」，或 `bots.json` 加 `"launchShell": "zsh"`。注意 PATH / nvm 等要放进所选 shell 的启动文件（如 `.zshrc`，fish 用户写 `~/.config/fish/config.fish`，fish 已作为一等启动 shell 支持）。
- **改启动文件**：给跳转加守卫，只在手动开终端时切：`[ -z "$BASH_EXECUTION_STRING" ] && [ -t 1 ] && exec zsh`（PATH / nvm 等导出放在它之前）。

改完 `botmux restart`，重发一条消息即可。这会影响需要 shell 包装的持久后端（`tmux` / `zellij` / `zmx`）；`pty` 后端直接启动 CLI，不受影响。

## 把机器人拉进新群能看之前的聊天记录吗？

能。直接跟它说"看下历史聊天"，或引用某条消息。前提是飞书机器人权限开全（含群消息读取）。

## 截图里中文 / emoji 是方块？

缺 CJK 字体。Debian/Ubuntu daemon 会尝试自动装 `fonts-noto-cjk fonts-noto-color-emoji`（需免密 sudo 或 root）；其它 Linux 手动装 Noto CJK + Noto Color Emoji 后重启 daemon。

## 普通群消息太多，能改成话题群吗？

能，但需群主 / 管理员操作：群设置 → 群管理 → 群消息形式 → 选「话题消息」。机器人不能替群改设置。

## Windows 能用吗？

没在原生 Windows 上验证过，WSL2 应该问题不大。

## 怎么升级？

`botmux upgrade`——它会按你的安装方式自动选路：curl 安装的原地换二进制，npm 安装的交回 `npm i -g botmux@latest`。curl 用户也可以直接重跑一遍安装命令（同样是原地升级，不会重复写 PATH）。会话内的 `botmux` wrapper 版本始终跟 daemon 一致，无需单独升级。升级后记得 `botmux restart` 让新版本生效。

## CoCo 忙时发消息丢失？

升级到 **CoCo ≥ 0.120.32**——type-ahead（忙时消息进 CoCo 自己的队列）依赖该版本行为。
