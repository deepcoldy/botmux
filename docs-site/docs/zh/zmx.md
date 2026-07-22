# ZMX 会话后端

[ZMX](https://github.com/neurosnap/zmx) 是 botmux 的一个可选持久会话后端。它适合希望用轻量会话 daemon 保住 CLI，并在需要完整终端体验时从本机原生 attach 的 macOS / Linux 主机。

ZMX 是**显式 opt-in** 后端：botmux 不会自动安装 ZMX，也不会因为它已在 `PATH` 中就自动选用。

## 安装与探测

botmux 要求 **zmx >= 0.7.1**。这里的版本下限是一项**前置假设**：本集成将 0.7.1 视为假定包含上游 [issue #201](https://github.com/neurosnap/zmx/issues/201) / [PR #202](https://github.com/neurosnap/zmx/pull/202) 修复行为的首个发布版，即 `send` 只排队输入而不抢占 leader 或改写终端尺寸；实际安装的 0.7.1+ build 必须已包含这项修复。ZMX 官方支持 macOS 和 Linux。

> **⚠️ 当前发布前置（截至 2026-07-23）**：ZMX 官方 latest release 与 Homebrew tap 仍为 0.6.0，执行下面的 `brew install` 目前会安装一个**不满足**本集成要求的版本。请等待上游发布实际包含 PR #202 行为的正式 **>= 0.7.1** build 后再启用 ZMX；不要通过伪造版本号绕过门禁。本页安装命令描述的是该正式版本发布后的目标流程。

```bash
# Homebrew（macOS / Linuxbrew；等待 tap 发布包含 PR #202 的 >= 0.7.1）
brew install neurosnap/tap/zmx

# 验证 daemon 用户的 PATH 与控制面
zmx version
zmx list
```

其它环境可从 [ZMX 官方安装说明](https://github.com/neurosnap/zmx#install) 下载对应架构的预编译二进制，并将 `zmx` 放进运行 botmux daemon 的同一系统用户的 `PATH`。

每次启动新 ZMX 会话前，botmux 都会校验可执行文件、版本和 `zmx list` 控制面。任意一项失败都会 **fail closed** 并向会话返回可操作的错误；绝不会悄悄降级到 PTY。

> **⚠️ 从 0.6 升级**：替换磁盘上的 `zmx` 二进制不会替换已经运行的逐会话 daemon；升级到包含 PR #202 的 0.7.1+ build 后，请手动关闭并重新创建所有 0.6 会话，再重启 botmux。botmux **不会自动冷迁移**旧会话，只运行 `botmux restart` 也不够；0.6 daemon 不认识新版 `send` 消息，可能在命令返回成功时仍静默丢弃输入。

开发时，默认 `pnpm test` 只跑 mock / 纯函数单测，**不要求本机安装 ZMX**。会启动真实 `zmx` 的覆盖位于 `*.e2e.ts`，只在显式运行 E2E 时参与，并在 ZMX 不可用时自动跳过；这与仓库现有 tmux / Herdr E2E 的处理方式一致。

## 开启 ZMX

推荐只为需要的 bot 在 `~/.botmux/bots.json` 中配置：

```json
{
  "name": "codex-zmx",
  "cliId": "codex",
  "backendType": "zmx"
}
```

若要让本部署的默认后端都改为 ZMX，也可在 `~/.botmux/.env` 中设置：

```bash
BACKEND_TYPE=zmx
```

修改后运行 `botmux restart`。单 bot 的 `backendType` 会覆盖部署默认值。

## 运行模型

botmux 为每个受管会话使用确定性名称 `bmx-<sessionId 前 8 位>`。ZMX daemon 持有 CLI 的 PTY；botmux 不再常驻一个假的 attach leader，而是使用三个无 leader 的接口：

- `zmx tail`：只作为低延迟的变化 / 存活信号；botmux 会排空其 stdout，但**不会把正文交给 worker**。当前上游 `zmx tail` 的 ANSI 过滤会删除 UTF-8 多字节，中文 / emoji 不能以这里的字节为准。
- `zmx send`：把原始输入字节排进 PTY，不 attach、不切换 leader、也不 resize。
- `zmx history`：唯一权威的纯文本屏幕源。tail / send 会立即唤醒异步采集；即使 tail 对纯中文完全无事件，也有热态 250ms、稳态最迟约 1.5s 的错峰安全轮询。每次 idle 定稿前还会强制补拉一轮（失败时有界重试后使用最后成功快照）。

新会话只在创建时短暂启动一次非交互客户端，随后输出和输入都走上面的接口。这样本地用户执行 `zmx attach` 时可以成为真正的 leader，由本地终端控制尺寸和完整 TUI；botmux 发送飞书输入不会把 leader 抢走。

| 事件 | ZMX session / CLI | botmux 行为 |
|------|-------------------|-------------|
| `botmux restart` | 保持存活 | 恢复时分批重建 worker 与 `tail` 观察者，不重起 CLI |
| 恢复时 backing session 已不存在 | 原进程已不在 | 保留 active / transcript 记录，不当作僵尸销毁；下一条消息时 lazy resume |
| worker / `tail` 观察者断开 | 保持存活 | 确认 ZMX session 仍在后重建观察者 |
| `/close` 或关闭按钮 | 销毁 / 终止 | 执行强制 kill，不会只留一个脱管会话 |

## 显示、输入与终端尺寸边界

这条集成刻意选择最终一致的纯文本屏幕语义，行为更接近 tmux 的持久会话生命周期，但不是 tmux 的完整终端镜像：

- ZMX 向 botmux 提供的是 `history` 的**最终一致纯文本屏幕**，不保留颜色、光标状态、OSC 或 alternate screen。采集单会话 single-flight，并在采集中出现新活动时强制补拉，避免并发 history 风暴或漏掉飞行中的尾段。
- ZMX 后端不提供 botmux 的交互式 Web TUI，也不向 backing PTY 发送 resize。需要 raw ANSI、全屏 TUI 或尺寸协商时，请使用本机 `zmx attach`。
- 本机 attach 的 leader 负责终端尺寸；没有本机 leader 时沿用 ZMX 会话的既有尺寸。botmux 的 `send` 不会改变它。
- 上游 `send` 目前没有投递 ACK / backpressure。botmux 以 1 KiB 分片发送，并在写入任何前缀前拒绝超过 64 KiB 的单次后端输入；结果不确定时不会自动重试，以免把已经入队的输入重复提交。后端会向调用方返回失败，而不是在内部隐藏重试。
- `zmx history` 只能恢复 ZMX / ghostty 当时仍保留的有界 scrollback；超过上游滚动缓冲预算后，较早输出会被淘汰。它构成最终一致的当前可观察状态，不是无损 transcript 或终端录屏；进程退出后才出现且未被最后一次采集命中的瞬态输出也无法补回。Workflow 的 raw PTY replay log 因此不具备 tmux 的无损语义。

## 在本机进入同一会话

```bash
botmux list
```

`botmux list` 会显示每条会话的实际后端。选中 ZMX 会话并按 Enter 会安全 attach 到现有的 `bmx-*` 会话；如果 backing session 已消失，命令会拒绝创建一个空 shell 来冒充原 CLI。

当 daemon 运行在 macOS 上时，还可在 Dashboard 的「设置」中显式开启「本机 CLI 直开」，并保持「附加当前会话」模式。此时飞书卡片的「打开 CLI」按钮会在 iTerm2 / Terminal 中 attach 到同一个 ZMX 会话，而不是启动第二个 CLI。该功能默认关闭，且只允许有操作权限的用户触发。

## 不支持的组合

- **Adopt**：ZMX 不是 `/adopt` 的扫描/接入源；需要 adopt 现有外部会话时，使用 tmux / Herdr / Zellij 支持的路径。
- **依赖隐藏 OSC 完成事件的 runner**：`codex-app`、`mira`、`mir` 的 final / thread 事件会被纯文本 history 消费掉，因此该组合启动时 fail closed；请为这些 CLI 使用 tmux / PTY。
- **文件沙盒与读隔离**：ZMX 子 PTY 属于会话 daemon，当前无法套用 botmux 的 bwrap / Seatbelt 文件边界。因此 `sandbox: true`、全局 `BOTMUX_SANDBOX=1`，或 macOS 上独立生效的 `readIsolation: true` 与 `backendType: "zmx"` 同时出现时会 **fail closed**；worker 会先向会话返回可操作提示，再拒绝启动。Linux 上单独设置旧 `readIsolation` 标志按统一 worker 语义是 no-op，不代表会话已隔离，也不会误拦 ZMX。需要真实隔离时，请启用 sandbox 并改用 tmux / PTY；否则明确关闭相应隔离配置。

## 排错

1. 以运行 daemon 的同一用户执行 `zmx version` 和 `zmx list`，确认版本至少为 0.7.1、`PATH` 和 socket 目录可用。
2. 如果刚从 0.6 升级，手动关闭并重新创建旧会话 daemon；botmux 不做自动冷迁移，仅重启 botmux 不会替换它们。出现 `zmx send` 返回成功但 CLI 没收到输入，优先检查这一项。
3. 如果显式设了 `ZMX_DIR`，确保 daemon 和本地 attach 的 shell 使用同一值。botmux 会保留 `ZMX_DIR`，但会清掉继承的 `ZMX_SESSION` / `ZMX_SESSION_PREFIX`，避免嵌套会话和名称前缀改写 `bmx-*` 目标。
4. 查看 `botmux logs`。探测结果不确定时，botmux 会保守拒绝启动/重建，避免重复启动 CLI 或误删仍存活的会话。

Dashboard 的会话查询可返回 ZMX 后端与确定性会话名，但这些字段不等于存活检查。见 [Dashboard 对外只读查询与安全边界](/dashboard#对外只读查询)。
