# 前置要求

装 botmux 之前，先花一分钟确认下面几样东西都准备好了。「装完连不上」「会话起不来」，大多是这里缺了东西：CLI 没登录、tmux 没装、PATH 里找不到命令。

- **需要看这页**：要在自己的机器（开发机 / devbox / 服务器）上跑 botmux daemon（后台常驻进程）的人。
- **不需要看**：只是在别人搭好的群里 @ 机器人聊天。这种情况本机什么都不用装。

## 一览表

| 要准备的 | 是否必需 | 怎么确认 |
|---|---|---|
| Linux 或 macOS（x64 / arm64） | 必需 | `uname -sm` |
| 至少一种 AI 编程 CLI，已装好并登录 | 必需 | 在终端直接运行它（如 `claude`），能正常对话 |
| tmux | 默认必需 | `tmux -V` |
| 飞书 / Lark 账号 | 必需 | 用来扫码创建机器人 |
| Node ≥ 22 | 只有用 npm 安装时才需要 | `node -v` |

## 操作系统

- 支持 **Linux 和 macOS**，x64 与 arm64 都行。Alpine 这类 musl 系统，安装脚本会自动选 musl 版。
- 在 Mac 上也可以用 [macOS 桌面版](/desktop)：App 自带运行环境，双击就能启动。
- **Windows**：daemon 只能跑在类 Unix 系统上，请在 **WSL2** 里安装。

## botmux 本身：不需要 Node

默认的 [curl 安装方式](/quickstart) 装的是一个自包含的单文件程序，运行环境已经打包在里面，装和跑都不需要 Node。

只有两种情况会用到 Node（≥ 22）：

- 你选择用 `npm i -g botmux` 安装。这是 npm 本身的要求，跑起来之后和 curl 版完全一样。
- 你要开发插件，`botmux plugin init` 这类命令会调用 npm。

## AI 编程 CLI：至少一种，先自己跑通

botmux 只是「飞书 ↔ CLI」的桥，**不负责帮你登录 CLI**。所以：

1. 先装好你要用的 CLI，比如 `claude`（Claude Code）、`codex`、`cursor-agent`（Cursor）、`opencode`、`traex`（TRAE CLI 2.0）、`agy`（Antigravity）、`hermes` 等。完整列表见 [多 CLI 适配器](/adapters)。
2. 确认它的命令在 `PATH` 里（终端直接输名字能找到）。
3. **在终端里手动运行一次，确认能正常对话**，再接 botmux。

> 注意：「botmux 不需要 Node」说的是 botmux 自己。很多 CLI（比如 `claude`、`codex`）是 npm 包，装它们还是要 Node，按各自的安装说明来。

## tmux：默认的会话后端

「会话后端」是 botmux 用来托管 CLI 进程的方式。默认就是 tmux，它的好处是 CLI 会话常驻，daemon 重启后还能接回来（见 [tmux 会话常驻](/tmux)）。

- **自动安装**：运行 `botmux start` / `botmux restart` 时，如果没找到 tmux，botmux 会先试着帮你装（依次尝试 brew、conda、系统包管理器；需要 sudo 密码时只在有终端交互的情况下才会问）。装不上就会打印一条手动安装命令。
- **装不上会怎样**：如果确实没有 tmux，而你的机器人又在用 tmux 后端，`botmux start` 会直接拒绝启动并提示安装；tmux 装了但用不了时，会话会被拦下并在飞书里发卡片提示。**不会悄悄换成别的后端**。
- **版本**：常见发行版自带的 tmux 3.x 即可。

不想用 tmux？可以显式换一个后端，全局用环境变量 `BACKEND_TYPE`，或给单个机器人在 bots.json 里设 `backendType`：

| 后端 | 说明 |
|---|---|
| `pty` | 不需要额外软件，但 daemon 重启后会话不保留 |
| `herdr` | 需要 herdr，botmux 可以帮你装 |
| `zellij` | 需要你自己装好 zellij |
| `zmx` | 需要你自己装好 zmx（≥ 0.7.0），见 [ZMX 会话后端](/zmx) |

## 推荐部署在哪

推荐部署在**一直开着的开发机 / devbox** 上，而不是笔记本。这样 daemon 一直在线、会话一直在，用手机也能随时遥控。装好后再执行 `botmux autostart enable`，机器重启后 botmux 会自己起来。

## 常见问题

| 现象 | 原因和解决 |
|---|---|
| 装完提示 `botmux: command not found` | 安装脚本已经把 `~/.botmux/bin` 写进了 shell 启动文件，但要**开一个新终端**才生效。还不行就看 [常见踩坑](/pitfalls) |
| npm 安装失败，`node -v` 小于 22 | 用 nvm / fnm 升级到 Node 22+，或者直接改用 curl 安装，完全不碰 Node |
| 会话起不来，或者第一条消息没反应 | 多半是 CLI 不在 PATH 或没登录。先在终端手动跑通 CLI，再看 [FAQ](/faq) |
| 终端里 CLI 能用，botmux 却找不到 | botmux 会借你的登录 shell 去找命令，装在特殊位置时可能仍找不到。在 bots.json 里把 `cliPathOverride` 设成 CLI 的绝对路径，见 [多 CLI 适配器](/adapters) |
| `botmux start` 提示缺 tmux | 按提示的命令装好 tmux，或按上表换一个后端 |

**下一步**：都准备好了，去 [5 分钟快速接入](/quickstart)。
