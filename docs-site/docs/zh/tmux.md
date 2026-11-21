# Tmux 会话常驻

「会话后端」是 botmux 托管 CLI 进程的方式。**默认后端是 tmux**：每个话题的 CLI 都跑在一个 tmux 会话里，botmux 自己重启时 CLI 不会跟着退出。

所以大家最常问的「重启 botmux 会不会丢上下文」，答案是：**不会**。

## 各种情况下会话会怎样

先认识两个词：

- **接回**：CLI 进程一直活着，botmux 重新连上它。上下文完整，不花额外 token。
- **冷恢复**：CLI 进程已经没了，下一条消息到来时，botmux 用 CLI 自己保存的对话记录（比如 Claude Code 的 `--resume`）重新起一个进程。话题和上下文还在，只是要多等几秒。

| 发生了什么 | tmux 会话 | 你会看到 |
|---|---|---|
| `botmux restart` / daemon 重启 | 保留 | 自动**接回**。重启后 botmux 会主动连上还活着的会话（只接管，不会自己开始新一轮回答） |
| 话题里发 `/close`，或点卡片上的关闭按钮 | 销毁 | 会话结束，CLI 一起退出 |
| CLI 自己退出或崩溃 | 随之结束 | 自动重启 CLI。1 分钟内连续崩溃超过 3 次就停止自动重启；退出码 77（身份/凭证问题）或 127（找不到命令）这类确定性失败只重试 1 次。停下来后可以在网页终端看到出错现场，再发一条消息会重新尝试 |
| 会话被「休眠」（超过常驻上限，或空闲太久） | 结束，释放内存 | 话题还在，下一条消息**冷恢复**。规则和设置见 [FAQ](/faq) |
| 机器重启 | 整个 tmux 都没了 | 话题保留，下一条消息**冷恢复** |

## 在本机终端里进入会话

最简单的方式是 `botmux list`：

```bash
botmux list           # 交互式列表
botmux list --plain   # 纯文本表格，适合脚本
```

列表里的按键：

| 按键 | 作用 |
|---|---|
| `↑` / `↓` | 选择会话 |
| `Enter` | 连接到这个会话；已休眠的会话会先恢复再连接 |
| `d` | 删除（关闭）会话，会让你按 `y` 确认 |
| `q` | 退出列表 |

也可以直接用 tmux 命令：

```bash
tmux -L botmux ls                        # 列出 botmux 托管的所有会话
tmux -L botmux attach -t bmx-<会话ID前8位>  # 进入某个会话
```

进去后按 `Ctrl+B` 再按 `D` 就能退出，CLI 继续在后台跑。

进去看到的就是一个普通终端，和你在本地跑 CLI 一模一样。飞书话题、[网页终端](/web-terminal) 和本机 tmux 看到的是**同一个进程**，在哪边操作都会同步。

## 为什么 botmux 用单独的 tmux server

botmux 的会话放在独立的 tmux server（`tmux -L botmux`）上，不和你自己的 tmux 混在一起。这样不管是你手滑，还是某个 bot 在自己的终端里执行了 `tmux kill-server`，都只会关掉默认 server 上你自己的会话，不会把所有 bot 会话一起带走。

- **升级前就在跑的老会话**：留在默认 server 上继续用（`tmux attach -t bmx-…` 照旧可以），等它下次需要重新创建（比如 CLI 重启、冷恢复）时才搬到独立 server。`botmux list`、网页终端和 Dashboard 的终端页会自动找到每个会话所在的位置。
- **`/adopt` 不受影响**：它接管的是你自己在默认 server 上开的终端，见 [会话接入（Adopt）](/adopt)。
- **想换回旧行为**：在 `~/.botmux/.env` 里设 `BOTMUX_TMUX_SOCKET=default`，之后新会话回到默认 server。也可以设成别的名字（只能用字母、数字和 `_` `.` `-`）；写错了会回到 `botmux`，不会悄悄退回默认 server。
- `TMUX_TMPDIR` 照常生效，socket 文件在 `$TMUX_TMPDIR/tmux-<uid>/botmux`。

## 没装 tmux，或者 tmux 用不了

- **自动安装**：`botmux start` / `botmux restart` 找不到 tmux 时会先试着帮你装，装不上会打印手动安装命令并停止启动（除非你显式设了 `BACKEND_TYPE=pty`）。详见 [前置要求](/prerequisites)。
- **不会悄悄换后端**：新会话启动时如果 tmux 用不了，botmux 会拒绝启动，并在飞书里发一张卡片，写明原因和安装命令（macOS 用 `brew install tmux`，Debian/Ubuntu 用 `sudo apt-get install -y tmux`）。
- **tmux 装了却起不来**：常见于容器的 seccomp/沙箱策略禁止了 `clone3` / `clone` 系统调用。这时卡片不会再让你装 tmux，而是提示去放行这两个系统调用。
- **应急办法**：卡片里会提到可以设 `BACKEND_TYPE=pty` 临时绕过，但 pty 会话在 botmux 重启后不能保留。
- 已经在跑的会话不受一次探测失败影响，照样能接回。

## 换别的后端

日常只需要关心 tmux。确实需要换的话，全局用环境变量 `BACKEND_TYPE`，单个机器人用 bots.json 的 `backendType`（见 [bots.json 配置](/bots-json)）：

| 后端 | 什么时候用 | 重启后能接回吗 |
|---|---|---|
| `tmux` | 默认，推荐 | 能 |
| `pty` | 应急：机器上实在跑不了 tmux | 不能，下条消息冷恢复 |
| `herdr` / `zellij` | 你本来就用这两个终端工具，想在里面直接看到 bot 会话 | 能 |
| `zmx` | 想用轻量的 ZMX 托管会话，见 [ZMX 会话后端](/zmx) | 能 |

```bash
# 例：整台机器临时改用 pty（仅应急）
BACKEND_TYPE=pty botmux start
```

几点要注意：

- **只影响新会话**：每个会话记住自己创建时用的后端，改配置后已有会话不会搬家。
- **开了沙盒的机器人**只能用 `tmux` 或 `pty`。`herdr`、`zellij`、`zmx` 不支持沙盒的文件隔离，会在启动前被拦下，见 [沙盒](/sandbox)。
- **远端类 CLI 自带后端**：`riff`、`mojo`、`remote-runner` 这几种 CLI 不在本机跑进程，后端会自动跟 CLI 走，不用也不能单独设置。反过来，普通 CLI 即使配成这几个后端，也会自动换回本地后端。

## herdr：会话放在哪里

用 `herdr` 后端时，默认每个话题在 botmux 自己管理的 herdr 会话 `botmux` 里新开一个工作区。想让 bot 会话出现在你正在用的 herdr 里，可以改放置方式。

| 字段 | 取值 | 说明 |
|---|---|---|
| `sessionName` | 会话名，默认 `botmux` | 放进哪个 herdr 会话。指向别的会话时，这个会话必须已经在运行，botmux 不会替你启动 |
| `placement` | `workspace`（默认）/ `tab` / `split` | `workspace`：每个话题新开一个工作区；`tab`：在目标工作区新开一个 Tab；`split`：在目标 Tab 里分屏 |
| `workspace` | 工作区 id 或标签 | `tab` / `split` 用。找不到时落到当前聚焦的工作区 |
| `tab` | Tab id 或标签 | `split` 时是要分屏的目标 Tab，找不到就按这个名字新建一个；`tab` 时是新 Tab 的标签 |
| `splitDirection` | `right`（默认）/ `down` | 只在 `split` 时生效 |
| `chatTypes` | `group`、`p2p` | 只对这些聊天类型的新会话生效，其它会话照旧放进 `botmux`。不填就对所有会话生效 |

配置有两处，按字段叠加，bots.json 优先：

- **整台机器**：`~/.botmux/.env` 里的 `BOTMUX_HERDR_SESSION_NAME`、`BOTMUX_HERDR_PLACEMENT`、`BOTMUX_HERDR_WORKSPACE`、`BOTMUX_HERDR_TAB`、`BOTMUX_HERDR_SPLIT_DIRECTION`、`BOTMUX_HERDR_CHAT_TYPES`（逗号分隔，比如 `group,p2p`）。
- **单个机器人**：bots.json 里的 `herdr` 块，写了的字段覆盖对应的环境变量，没写的沿用环境变量。

```json
{
  "backendType": "herdr",
  "herdr": {
    "sessionName": "default",
    "placement": "split",
    "tab": "3",
    "chatTypes": ["group"]
  }
}
```

几点要注意：

- **至少要有 `sessionName` 或 `placement`**（两处叠加后算）。只填 `workspace`、`tab` 这些子字段不会生效，会话仍按默认方式在 `botmux` 会话里新开工作区。
- **只影响新会话**，已有会话留在原位。
- **放进你自己的 herdr 会话时**，关闭话题只关掉 bot 自己的那个 pane，不会关掉你的会话。
