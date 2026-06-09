# FAQ / 排错

> 综合自 README 与社区交流群高频问题，持续补充中。更多坑见 [常见踩坑](/pitfalls)。

## 机器人完全收不到消息怎么办？

按顺序自查（PersonalAgent 默认配好，正常不用动）：

1. **事件订阅**：开放平台 → 事件与回调 → 应订阅 `im.message.receive_v1` + `card.action.trigger`，方式为「长连接 (WebSocket)」，且 daemon 已在跑。
2. **机器人能力**：开放平台 → 应用功能 → 机器人 应已开通。
3. **发版**：应用要创建并发布过版本（可用性「仅自己可见」自动通过）。
4. **长连接独占**：确认这个 Bot 没被别的应用同时抢长连接。
5. 确认后 `botmux restart`（在干净 shell 里）。

## 机器人在终端有输出，但没发到飞书？

终端 stdout ≠ 已发飞书。必须显式执行 `botmux send`（并带 `--mention-back` / `--mention` / `--no-mention` 之一），群里才看得到。模型只 `echo`/`print` 或忘了调 `botmux send` 就不会发出。多行内容用 heredoc，别写成 `"第一行\n第二行"`。

## `botmux history` 报 400 / 飞书网关 411？

- **400**：通常是飞书机器人权限缺失（如缺 `im:message.group_msg`）→ 把权限 JSON 全开。
- **411**：飞书网关对"带空 body 的 GET"更严格，旧版 SDK 给 GET 带 `{}` body 触发 → 升级到新版已修。

## `Please run /login · API Error: 403` 怎么解？

先分清是哪个 `/login`：

- **飞书侧 App Token 调 API 被拒**：话题里发 `/login` → 点授权链接 → 把浏览器跳转的 callback URL（`http://127.0.0.1:9768/callback?...`，页面打不开是正常的）复制回话题。
- **模型网关侧 403**：跟飞书授权无关，多为环境变量 / 网关 token 问题，常见根因是 bash 用户把变量写在 `.bash_profile` 没被 `bash -i` 读到（见 [常见踩坑](/pitfalls)）。

## 支持 Lark 国际版（larksuite.com）吗？

支持。飞书 (feishu.cn) 和 Lark 国际版 (larksuite.com) 都能用：扫码建应用时**自动识别**租户类型（国内 / 国际）并记住，手动粘 AppID/Secret 时会让你选一次。每个机器人按所属版本独立连对应域名，同一台机器可同时跑飞书和 Lark 机器人，登录凭证按应用隔离、互不干扰。

## 多个机器人怎么互相协作？

先 `@botA @botB /introduce` 互相登记 open_id；之后用 `botmux send --mention <对方 open_id>` 显式触发对方。不 `--mention` 对方 bot 不会被触发。

## daemon 重启会丢上下文吗？

装了 **tmux** 就不会——CLI 进程常驻 tmux session，`botmux restart` 后下次消息自动 re-attach，无需 `--resume`。没装 tmux 则走 pty 模式，重启会重载。

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

## 把机器人拉进新群能看之前的聊天记录吗？

能。直接跟它说"看下历史聊天"，或引用某条消息。前提是飞书机器人权限开全（含群消息读取）。

## 截图里中文 / emoji 是方块？

缺 CJK 字体。Debian/Ubuntu daemon 会尝试自动装 `fonts-noto-cjk fonts-noto-color-emoji`（需免密 sudo 或 root）；其它 Linux 手动装 Noto CJK + Noto Color Emoji 后重启 daemon。

## 普通群消息太多，能改成话题群吗？

能，但需群主 / 管理员操作：群设置 → 群管理 → 群消息形式 → 选「话题消息」。机器人不能替群改设置。

## Windows 能用吗？

没在原生 Windows 上验证过，WSL2 应该问题不大。

## 怎么升级？

`botmux upgrade`。会话内的 `botmux` wrapper 版本始终跟 daemon 一致，无需单独升级。

## CoCo 忙时发消息丢失？

升级到 **CoCo ≥ 0.120.32**——type-ahead（忙时消息进 CoCo 自己的队列）依赖该版本行为。
