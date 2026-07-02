# ZMX 会话后端

[ZMX](https://github.com/neurosnap/zmx) 是 botmux 的一个可选持久会话后端。它适合希望保留原生终端特性，又只需要 attach / detach 与会话常驻能力的 macOS / Linux 主机。

ZMX 是**显式 opt-in** 后端：botmux 不会自动安装 ZMX，也不会因为它已在 `PATH` 中就自动选用。

## 安装与探测

botmux 要求 **zmx >= 0.6.0**。ZMX 官方支持 macOS 和 Linux。

```bash
# Homebrew（macOS / Linuxbrew）
brew install neurosnap/tap/zmx

# 验证 daemon 用户的 PATH 与控制面
zmx version
zmx list
```

其它环境可从 [ZMX 官方安装说明](https://github.com/neurosnap/zmx#install) 下载对应架构的预编译二进制，并将 `zmx` 放进运行 botmux daemon 的同一系统用户的 `PATH`。

每次启动新 ZMX 会话前，botmux 都会校验可执行文件、版本和 `zmx list` 控制面。任意一项失败都会 **fail closed** 并向会话返回可操作的错误；绝不会悄悄降级到 PTY。

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

botmux 为每个受管会话使用确定性名称 `bmx-<sessionId 前 8 位>`。worker 在 node-pty 中运行一个真实的 `zmx attach` 客户端，由这一条双向链路承载原始 ANSI 输出、键盘输入、粘贴和 resize；不使用 `zmx tail` + `zmx send` 的分离旁路。重连时，ZMX 自己的终端快照也通过同一 attach 链路恢复。

| 事件 | ZMX session / CLI | botmux 行为 |
|------|-------------------|-------------|
| `botmux restart` | 保持存活 | 恢复时分批重建 worker 并 attach 原会话，不重起 CLI |
| 恢复时 backing session 已不存在 | 原进程已不在 | 保留 active / transcript 记录，不当作僵尸销毁；下一条消息时 lazy resume |
| worker / attach 客户端断开 | 保持存活 | 确认 ZMX session 仍在后自动重连 |
| `/close` 或关闭按钮 | 销毁 / 终止 | 执行强制 kill，不会只留一个脱管会话 |

## 在本机进入同一会话

```bash
botmux list
```

`botmux list` 会显示每条会话的实际后端。选中 ZMX 会话并按 Enter 会安全 attach 到现有的 `bmx-*` 会话；如果 backing session 已消失，命令会拒绝创建一个空 shell 来冒充原 CLI。

当 daemon 运行在 macOS 上时，还可在 Dashboard 的「设置」中显式开启「本机 CLI 直开」，并保持「附加当前会话」模式。此时飞书卡片的「打开 CLI」按钮会在 iTerm2 / Terminal 中 attach 到同一个 ZMX 会话，而不是启动第二个 CLI。该功能默认关闭，且只允许有操作权限的用户触发。

## 不支持的组合

- **Adopt**：ZMX 不是 `/adopt` 的扫描/接入源；需要 adopt 现有外部会话时，使用 tmux / Herdr / Zellij 支持的路径。
- **文件沙盒与读隔离**：ZMX 子 PTY 属于会话 daemon，当前无法套用 botmux 的 bwrap / Seatbelt 文件边界。因此 `sandbox: true`、全局 `BOTMUX_SANDBOX=1`，或 macOS 上独立生效的 `readIsolation: true` 与 `backendType: "zmx"` 同时出现时会 **fail closed**；worker 会先向会话返回可操作提示，再拒绝启动。Linux 上单独设置旧 `readIsolation` 标志按统一 worker 语义是 no-op，不代表会话已隔离，也不会误拦 ZMX。需要真实隔离时，请启用 sandbox 并改用 tmux / PTY；否则明确关闭相应隔离配置。

## 排错

1. 以运行 daemon 的同一用户执行 `zmx version` 和 `zmx list`，确认版本、`PATH` 和 socket 目录可用。
2. 如果显式设了 `ZMX_DIR`，确保 daemon 和本地 attach 的 shell 使用同一值。botmux 会保留 `ZMX_DIR`，但会清掉继承的 `ZMX_SESSION` / `ZMX_SESSION_PREFIX`，避免嵌套会话和名称前缀改写 `bmx-*` 目标。
3. 查看 `botmux logs`。探测结果不确定时，botmux 会保守拒绝启动/重建，避免重复启动 CLI 或误删仍存活的会话。

Dashboard 的会话查询可返回 ZMX 后端与确定性会话名，但这些字段不等于存活检查。见 [Dashboard 对外只读查询与安全边界](/dashboard#对外只读查询)。
