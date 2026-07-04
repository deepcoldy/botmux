# 常见踩坑与规避

> 来自社区交流群的高频实战坑，按出现频率与影响排序。

## 机器人权限 / 应用创建（最常见）

- **复用了旧应用创建的机器人 / 没走最新 `botmux setup` 扫码创建 / 权限没配全**：症状五花八门——CLI 像是"中途退出"、群里收不到消息、`botmux history` 报 400 等，根因大多是机器人权限不全。→ 用最新版 `botmux setup` 扫码**重新创建**应用（会自动配齐全部权限并发版），别复用旧应用创建的机器人，也别手动建时漏了权限。

## 环境 / 安装

- **Node 太老**：v18 等没内置全局 `fetch`，`botmux setup` 会报 `fetch is not defined` / `fetch failed` 且不写 `bots.json`。→ 升级到 **Node ≥ 22**。
- **首次启动卡在人工确认**：CLI（如 Claude Code）首次会弹"信任目录 / bypass 权限"确认，没人工点过会卡住、报 `tmux send-keys` 错。→ 首次手动确认一次，之后不再出现。

## 环境变量丢失（高频）

- **bash 用户把变量写在 `.bash_profile` 拿不到**：新 worker 用 `bash -i` 启动，`bash -i` 只读 `.bashrc`。→ 在 `.bashrc` 里 `source ~/.bash_profile`，或直接把变量写进 `.bashrc`（zsh 用户写 `.zshrc`）。这是 `API Error 403` / 网关 token 报错的常见根因。
- **root 下 Claude 拒绝 `--dangerously-skip-permissions`**：报 "cannot be used with root/sudo privileges"。→ `export IS_SANDBOX=1`（zsh 写 `.zshrc`、bash 写 `.bashrc`；PM2 / systemd / Docker 场景配在对应启动环境）。新版已自动对 root 场景注入。

## 自定义 wrapper / 网关接入

- **wrapper 没透传参数**：用网关脚本包装 CLI 启动时，若没把 `"$@"` 正确透传，CLI 拿不到 `--session-id` 等参数。→ `botmux logs` 找 `Spawning fresh CLI:` 那行，复制完整命令本地复现定位。
- **wrapper 把 botmux 的参数加进黑名单**：例如屏蔽了 `--settings`、报 `unknown option '--images'`，会导致启动失败掉进 shell。→ 本地手动跑那条 spawn 命令定位，放行相关参数。

## 输入 / 提交

- **多行消息被拆成多条提交**：部分 TUI（Codex / CoCo）把多行 prompt 里的 `\n`、`\t` 当成 Enter / 补全键，逐行提交。→ 新版已把 Codex 输入改成 bracketed paste 规避（与 CoCo 一致）。自己写 `botmux send` 多行时也务必用 heredoc。
- **上下文压缩后"忘记"往飞书发消息**：无持久 system prompt 的 CLI（CoCo / Codex / Gemini / OpenCode）只在话题首条注入路由说明，上下文被压缩后 routing 块丢失，模型会直接在终端答而不发飞书。→ 新版已对这类 CLI 每条 follow-up 重注入完整 routing 块；用更强的模型可缓解。
- **弱模型 / 套壳模型不调 `botmux send`**：容易忘记调用、或一直重复调用停不下来。→ 用 SOTA 模型，或加更硬的 prompt 约束。
- **`botmux send --images` ≥ 6 张可能 silent fail**：→ 一次 ≤ 4 张、分批发。

## 进程 / 连接

- **一个飞书 Bot 接了两个抢长连接的应用**：谁先抢到 websocket 就归谁，导致 botmux 时好时坏。→ 一个 Bot 只接一个长连接应用。
- **`tmux kill-session` 后会话又被拉起**：daemon 仍认为 active。→ 走 `botmux delete`。
- **`defaultWorkingDir` 配了之后每发一句就起新 session**：这是"跳过选仓库"的副作用。→ 不想要就删掉该配置。
- **Codex 0.131+ headless 报 desktop attach socket 错**：`features.apps` 默认开启去连 desktop。→ botmux 已对其拉起的 Codex 加 `--disable apps` 规避。
- **在 botmux 自己的 tmux pane 里 `botmux restart`**：会把运行时变量（`TMUX` / `LARK_*` / `BOTMUX_*`）继承污染进 daemon，引发偶发的 token / 网关报错。→ 在**干净的非 tmux shell** 里重启 daemon。
- **`/repo` 仓库编号会漂移**：列表加了新仓库后编号偏移。→ 自动化别写死编号，用 `/repo <项目名>` 或路径唯一指定。

## 磁盘 / 日志

- **`tmux-server-*.log` 撑爆磁盘**：只有用 `tmux -v`/`-vv` 启动才会产生，无自动轮转，长跑能涨到上百 GB。botmux 自身从不带 `-v`，这种文件可安全清理，不影响 botmux 日志。

## 协作

- **两个 bot 互相 @ 死循环**：每条消息底部都"发送给 @对方"会无限循环。→ 通常一方主动停就解；本质是模型多嘴行为，加约束。

## Dashboard / 安全

- **别把带 token 的 dashboard URL 发到群里**（等于公开临时访问凭证）。安全敏感场景把 host 绑本机：`BOTMUX_DASHBOARD_HOST=127.0.0.1`。token 一次性，每跑一次 `botmux dashboard` 重新生成、旧链接立即失效。
- **dashboard 打不开**：先 `curl http://<host>:<port>/__health`，返回 `{"ok":true}` 说明服务正常；问题多在浏览器代理 / host 不对（mac 连内网 IP 会变）/ 打开了旧 token 链接。

## 排查通用手法

任何「本机起不来 / 行为异常」先走这三步：

1. `botmux logs` 找 `Spawning fresh CLI:` 那行，复制完整命令在本地手动跑一遍复现（最快定位权限 / 参数 / 登录态问题）。
2. 进 Web 终端一眼看模型 / 网关的真实报错。
3. 把现象丢给本机的 agent 让它自查；社区欢迎提 PR。
