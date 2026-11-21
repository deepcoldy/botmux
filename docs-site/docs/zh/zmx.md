# ZMX 会话后端

[ZMX](https://github.com/neurosnap/zmx) 是一个轻量的终端会话管理工具。把 botmux 的会话后端设成 ZMX 后，CLI 跑在 ZMX 的会话进程里：daemon 重启时 CLI 不会断，你也随时可以在本机终端 `zmx attach` 进去，用完整的终端界面接着操作。

先看它适不适合你：

| 你想要 | 用 ZMX？ |
|---|---|
| CLI 常驻、daemon 重启不丢，同时想在本机终端原生接管 | 适合 |
| 在浏览器里用 botmux 的 Web 终端 | 不行，用 [tmux](/tmux) |
| 用 `/adopt` 接入已有的终端会话 | 不行，用 tmux / Herdr / Zellij |
| 开文件沙盒（`sandbox`） | 不行，用 tmux / PTY |
| 跑 `codex-app`、`mira`、`mir`、`dsh` | 不行，用 tmux / PTY |

ZMX 需要**显式开启**：botmux 不会帮你安装它，`PATH` 里有 `zmx` 也不会被自动选用。

## 1. 安装 ZMX

要求 **zmx 0.7.0 或更新**，官方支持 macOS 和 Linux。

```bash
# Homebrew（macOS / Linuxbrew）
brew install neurosnap/tap/zmx

# 或者用 mise
mise use -g github:neurosnap/zmx@latest
```

其它环境可以到 [ZMX 官方安装说明](https://github.com/neurosnap/zmx#install) 下载对应架构的二进制。

装好后，**用运行 botmux daemon 的同一个系统用户**检查一下：

```bash
zmx version   # 版本要 >= 0.7.0
zmx list      # 能正常列出（哪怕是空的）就说明控制通道可用
```

为什么是 0.7.0：从这个版本起，`zmx send` 只把输入塞进会话，不再抢占终端的「主控客户端」（leader，决定终端尺寸的那个客户端），也不再改终端尺寸。旧版会把 botmux 读到的屏幕搞乱。详见上游 [issue #201](https://github.com/neurosnap/zmx/issues/201)。

:::warning 从 0.6 升级要重建旧会话
替换磁盘上的 `zmx` 不会替换已经在跑的会话进程。升级到 0.7.0+ 后，请手动关闭并重新创建所有 0.6 时期的会话，再重启 botmux。botmux 不会自动迁移它们，光跑 `botmux restart` 不够。

不重建的典型症状：`zmx send` 显示成功，但 CLI 根本没收到输入（0.6 的会话进程会静默丢掉 0.7 的新消息类型）。
:::

## 2. 开启 ZMX

**只给某个 bot 用（推荐）**，两种方式任选：

- Dashboard →「Bot 配置」→ 该 bot 的「后端类型」选 `zmx`。对之后的新会话生效，正在跑的会话保持原来的后端。
- 在 `~/.botmux/bots.json` 里给这个 bot 加 `backendType`：

  ```json
  {
    "name": "codex-zmx",
    "cliId": "codex",
    "backendType": "zmx"
  }
  ```

  改完执行 `botmux restart`。

**整台部署都默认用 ZMX**：在 `~/.botmux/.env` 里设置，然后 `botmux restart`。

```bash
BACKEND_TYPE=zmx
```

单个 bot 的 `backendType` 优先于这个全局默认。

每次新建 ZMX 会话前，botmux 都会检查 `zmx` 能不能执行、版本够不够、`zmx list` 是否正常。任何一项不通过，都会直接拒绝启动并在话题里告诉你原因和安装命令，**不会悄悄换成别的后端**。

## 3. 在本机进入同一个会话

```bash
botmux list
```

列表里会显示每个会话实际用的后端。选中一条 ZMX 会话按 Enter，就会 attach 到它对应的 ZMX 会话。如果那个会话已经不存在，命令会直接拒绝，而不是开一个空 shell 冒充原来的 CLI。

daemon 跑在 **macOS** 上时，还可以从飞书卡片一键打开：

1. Dashboard →「全局设置」→ 打开「启用本机 CLI 直开」（默认关闭）。
2. 「本机 CLI 打开模式」保持「附加当前会话（推荐）」。
3. 之后卡片上会出现「💻 打开 …」按钮（例如「💻 打开 Claude Code」），点击后在 iTerm2 / Terminal 里 attach 到同一个 ZMX 会话，不会另起第二个 CLI。只有有操作权限的人能点。

本机 attach 进去后，你就是这个会话的主控客户端：终端尺寸、全屏界面都由你的终端决定。之后在飞书里继续发消息，也不会把主控权抢走。

## 4. 会话的生命周期

每个会话对应一个固定名字的 ZMX 会话：`bmx-<会话 ID 前 8 位>`。

| 发生了什么 | CLI 会怎样 | botmux 怎么处理 |
|---|---|---|
| `botmux restart` | 继续运行 | 分批重新接上，不重启 CLI |
| 恢复时发现 ZMX 会话没了（比如机器重启） | 已经退出 | 会话记录保留，不当垃圾清掉；下一条消息到来时自动接着之前的对话启动 |
| worker 或输出监听断开 | 继续运行 | 确认 ZMX 会话还在后重新接上 |
| `/close` 或点关闭按钮 | 被结束 | 连同 ZMX 会话一起强制结束，不留无人管的进程 |

ZMX 会话的 socket 目录（ZMX 用来通信的本地目录）在会话第一次创建时就被记录下来。之后即使 daemon 的环境变了（比如 `XDG_RUNTIME_DIR` 不一样了），botmux 仍会到原来的目录找它，不会把活着的会话误判成已消失。

## 5. 和 tmux 相比，有哪些限制

ZMX 的生命周期和 tmux 很像，但 botmux 从 ZMX 拿到的只是**纯文本屏幕**，不是完整的终端画面：

- **没有颜色、光标和全屏界面**：botmux 通过 `zmx history` 读取当前屏幕的纯文本，飞书里看到的是这份文本。要看原始彩色界面，请在本机 `zmx attach`。
- **没有 Web 终端**：会话卡片上不提供 botmux 的浏览器终端。
- **终端尺寸固定**：没有本机 attach 时，botmux 管理的会话固定是 **120×24**，CLI 按 120 列换行，飞书里看到的也是这个宽度。botmux 改不了尺寸；需要别的尺寸，就在本机 `zmx attach`，由你的终端决定。
- **单次输入最多 64 KiB**：ZMX 发送输入时没有送达确认，botmux 会分小块发送；超过 64 KiB 的单次输入会在发送前被拒绝。发送结果不确定时不会自动重发，避免同一段内容被提交两次。
- **历史有上限**：只能读到 ZMX 当前还保留的滚动缓冲，更早的输出会被挤掉。它不是完整录屏，CLI 退出前一瞬间的输出可能读不到。所以 Workflow 的原始终端回放在 ZMX 下不像 tmux 那样完整。
- **屏幕更新有轻微延迟**：输出有变化时会马上去读；即使没收到变化信号（比如纯中文输出），也会定时补读，最慢大约 1.5 秒。每轮结束前还会强制再读一次，保证最终回复完整。

## 6. 不支持的组合

遇到下面的组合，botmux 会在启动时直接拒绝，并在话题里提示怎么改：

- **`/adopt`**：ZMX 会话不能被扫描或接入。要接入已有的外部会话，用 tmux / Herdr / Zellij。
- **`codex-app`、`mira`、`mir`、`dsh`**：这些 CLI 靠隐藏的终端控制序列告诉 botmux「这一轮结束了」，纯文本屏幕里这些信号会丢失。请给它们用 tmux / PTY。
- **文件沙盒**：ZMX 会话里的 CLI 不归 botmux 直接启动，没法套上 botmux 的文件沙盒。只要 `backendType: "zmx"` 和 `sandbox: true`、全局 `BOTMUX_SANDBOX=1` 或旧配置 `readIsolation: true` 同时出现，在所有平台上都会拒绝启动。需要隔离就改用 tmux / PTY；否则关掉对应的沙盒配置。详见 [文件沙盒](/sandbox)。
- **Antigravity 的零注入模式**：Antigravity 在 ZMX 下不能开 `promptInjection: "none"`，见 [bots.json 配置](/bots-json) 里的「零注入模式」一节。

## 7. 排错

| 现象 | 先查什么 |
|---|---|
| 新会话起不来，提示 zmx 不可用 | 用 daemon 的同一用户跑 `zmx version` 和 `zmx list`，确认版本 ≥ 0.7.0、`PATH` 里能找到 `zmx`、socket 目录可写 |
| `zmx send` 成功，但 CLI 没收到输入 | 多半是 0.6 时期的旧会话还在跑，手动关掉重建（见上面的升级提示） |
| 本机 `zmx attach` 找不到 `bmx-*` 会话 | 如果你设过 `ZMX_DIR`，确保 daemon 和你本机 shell 用的是同一个值；或者直接用 `botmux list` 进入，它会自动用会话记录下的目录 |
| 会话卡住、起不来又说不清原因 | 看 `botmux logs`。探测结果不确定时，botmux 会宁可拒绝，也不重复启动 CLI 或误删还活着的会话 |

补充两点：

- botmux 会保留你设的 `ZMX_DIR`，但会清掉从外层继承来的 `ZMX_SESSION` / `ZMX_SESSION_PREFIX`，防止在 ZMX 会话里再嵌套、或会话名前缀把 `bmx-*` 改掉。
- Dashboard 的会话查询接口会返回 ZMX 后端和会话名，但这不代表会话还活着。见 [只读查询接口](/dashboard#只读查询接口)。

## 给贡献者

默认的 `bun run test` 只跑模拟和纯函数单测，本机**不需要装 ZMX**。会启动真实 `zmx` 的用例在 `*.e2e.ts` 里，只在显式跑 E2E 时执行，没装 ZMX 会自动跳过，和 tmux / Herdr 的 E2E 一样。
