# hc 会话后端（herdr-core）

[herdr-core](https://github.com/herdrdev/herdr-core)（命令名 `herdr-core` / `hc`）是一个无界面的终端服务：终端由一个常驻的 core 进程托管，客户端通过本地 socket 创建、读取和接入它们。把 botmux 的会话后端设成 `hc` 后，CLI 跑在 hc 的终端里：daemon 重启时 CLI 不会断，浏览器里照样有 Web 终端，你也可以用 `botmux list` 在本机终端接入同一个会话。

先看它适不适合你：

| 你想要 | 用 hc？ |
|---|---|
| 一台机器上跑很多会话，tmux server 占满了一个 CPU 核 | 适合 |
| CLI 常驻、daemon 重启不丢，浏览器里用 Web 终端 | 适合，和 tmux 一样 |
| 开文件沙盒（`sandbox`） | 可以，和 tmux 一样 |
| 用 `/adopt` 接入已有的终端会话 | 不行，用 tmux / Herdr / Zellij |
| daemon 跑在 macOS 上 | 可以，需自备 herdr-core |

hc 需要**显式开启**：默认后端仍然是 tmux，botmux 不会帮你安装 hc，机器上有 `hc` 也不会被自动选用。

## 为什么要换

tmux 的所有会话都由一个单线程的 tmux server 处理，botmux 还要定时抓屏来读取画面。会话一多，这个 server 进程就成了瓶颈：在 200 个终端、每个每秒刷新 5 次的压测里，tmux server 约占 32% 个 CPU 核，算上 botmux 的轮询抓屏约 59%；同样负载下 hc 分别约为 8% 和 11%。每秒 20 次刷新时，tmux 在 66% 左右封顶，hc 约 33%–36%。

hc 把输出主动推给 botmux，botmux 在本地维护一份屏幕镜像，读屏不再需要逐个会话轮询。会话不多时两者没有明显差别，继续用 tmux 即可。

## 1. 准备 herdr-core

支持 **Linux 和 macOS**，需要 **herdr-core 0.1.19 或更新**。

botmux 按下面的顺序找可执行文件，用第一个找到的：

1. 环境变量 `BOTMUX_HC_BIN` 指定的绝对路径。设置了它就只认它，不再往下找。
2. `~/.botmux/bin/herdr-core`（botmux 数据根下的 `bin/herdr-core`；改过数据目录时跟着变）。
3. `PATH` 里的 `herdr-core`。
4. `PATH` 里的 `hc`。

找到的文件必须能执行 `--version`，输出 `hc X.Y.Z` 且版本不低于 0.1.19，否则视为不可用。推荐把二进制放到第 2 个位置，这样不会和你自己用的 `hc` 混在一起：

```bash
mkdir -p ~/.botmux/bin
cp /path/to/herdr-core ~/.botmux/bin/herdr-core
chmod +x ~/.botmux/bin/herdr-core
~/.botmux/bin/herdr-core --version   # 要输出 hc 0.1.19 或更高
```

用运行 botmux daemon 的**同一个系统用户**操作。只查版本不会启动任何 core；不要用这个二进制随手跑别的子命令，原因见下面的「botmux 的私有 core」。

## 2. 开启 hc

**只给某个 bot 用（推荐）**，两种方式任选：

- Dashboard →「Bot 配置」→ 该 bot 的「后端类型」选 `hc`。对之后的新会话生效，正在跑的会话保持原来的后端。
- 在 `~/.botmux/bots.json` 里给这个 bot 加 `backendType`：

  ```json
  {
    "name": "codex-hc",
    "cliId": "codex",
    "backendType": "hc"
  }
  ```

  改完执行 `botmux restart`。

**整台部署都默认用 hc**：在 `~/.botmux/.env` 里设置，然后 `botmux restart`。

```bash
BACKEND_TYPE=hc
```

单个 bot 的 `backendType` 优先于这个全局默认。

每次新建 hc 会话前，botmux 都会检查 herdr-core 能不能执行、版本够不够。不通过时直接拒绝启动，并在话题里说明原因和该把二进制放在哪里，**不会悄悄换成别的后端**。

daemon 启动时也会检查一次：只要有 bot 用 hc，就会打印找到的版本，找不到时给出警告。只有在 herdr-core 完全找不到、而且所有 bot 和所有活跃会话都用 hc 时，daemon 才会拒绝启动；还有别的后端在用时只警告，不影响它们。

:::warning 切换前确认旧会话
每个会话记住自己创建时用的后端，改 bot 的 `backendType` 不会搬动已有会话。例外是很早期版本创建、没有记录后端的会话：它们会跟随 bot 的新设置，原来的 tmux 会话就接不回来了，下一条消息会冷启动。
:::

## 3. botmux 的私有 core

botmux 只用它自己的 hc core，和你自己在用的 hc 完全分开：

| 项目 | botmux 的 core |
|---|---|
| core 名（`HC_SESSION`） | `botmux` |
| socket | 优先用 `$XDG_RUNTIME_DIR/herdr-core/botmux.sock`。未设置时，Linux 用 `/run/user/<uid>/herdr-core/botmux.sock`，macOS 默认用 `~/.botmux/hc/botmux.sock`（随 botmux 数据根目录变化） |
| 配置目录 | `~/.botmux/hc/config`，其中的 `herdr-core/config.toml` 由 botmux 写入 |
| 状态目录 | socket 同目录下的 `botmux.state` |

- 你自己的 core（通常是 `default`）和 `~/.config/herdr-core` 里的配置不会被 botmux 读取、连接或修改。
- botmux 调用 hc 时会去掉继承来的 `HC_*` 变量，再显式指定上面这几项，所以你 shell 里的 `HC_SESSION`、`HC_SOCKET` 不会把会话带到别的 core。
- 同一个系统用户下的所有 bot daemon 共用这一个 core。每个终端都带着所属会话的完整 ID 作为标签，botmux 在接回、关闭之前都会核对标签，不会动别的会话的终端。
- 终端里的 CLI 看到的 `XDG_CONFIG_HOME` / `XDG_STATE_HOME` 是 daemon 原来的值，不是 botmux 给 core 用的私有目录。
- socket 路径最长 107 字节。`XDG_RUNTIME_DIR` 太长时，新会话会被拒绝并提示换一个更短的目录。

:::warning 不要手动对 botmux 的 socket 跑 hc 命令
hc 的任何命令在连不上 core 时都会自己启动一个，而新 core 会把启动它的那个进程的环境带给之后的每个终端。手动对 botmux 的 socket 执行 hc 命令，就可能用你 shell 的环境（包括其中的 `HC_*` 设置）拉起 botmux 的 core。查看或接入会话请用 `botmux list`：它调用 hc 时会去掉 `HC_*` 变量并固定 botmux 的私有配置，接入前还会确认终端属于这个会话。
:::

## 4. 在本机进入同一个会话

```bash
botmux list
```

列表会显示每个会话实际用的后端，hc 会话显示为 `hc: bmx-xxxxxxxx`。选中一条按 Enter 即可接入，按 **Ctrl+\\** 断开（断开不影响会话）。会话正在休眠时，会先恢复再接入。

接入前 botmux 会直接查询 core，确认这个终端还活着、标签属于这个会话，再按核对过的终端地址接入。下面几种情况会直接拒绝，而不是开一个空 shell 冒充原来的 CLI：

- botmux 的 core 没在运行；
- 终端已经结束或不存在；
- 同名终端属于别的会话。

macOS 上，飞书卡片的「💻 打开 …」可用时，也会通过同样的所有权核对接入 hc 会话。

在 Dashboard 的 **Bot 配置 → 高级 → 会话后端** 开启 **自动创建 Herdr 标签页**，或在对应的 `bots.json` 条目中设置 `"hcHerdrTabs": true`。该开关按 bot 设置，默认关闭，仅对 hc 会话生效。下次启动会话或由新 worker 重新接入时，botmux 会在私有 core 上按工作目录登记原生 Space，每个话题一个 Tab。

标签页使用 Botmux 的会话标题。没有标题时显示 hc 会话名（`bmx-<会话 ID 前 8 位>`）。登记时 Herdr App 可以尚未连接。把私有 core 添加为 Herdr App 的 Machine 后即可查看已登记的标签页。关闭开关会停止后续登记，现有标签页可在 Herdr App 中管理。终端恢复由 botmux 管理。

## 5. 会话的生命周期

每个会话对应一个固定名字的 hc 终端：`bmx-<会话 ID 前 8 位>`，标签里记着完整的会话 ID。

| 发生了什么 | CLI 会怎样 | botmux 怎么处理 |
|---|---|---|
| `botmux restart` | 继续运行 | 重新接上，不重启 CLI |
| hc core 重启或崩溃 | 继续运行 | 自动重连，确认终端还是这个会话的之后接回并刷新画面 |
| 机器重启，终端没了 | 已经退出 | 会话记录保留；下一条消息到来时自动接着之前的对话启动 |
| `/close`、关闭按钮或 `botmux delete` | 被结束 | 核对标签后结束并移除这个终端；标签不符的终端不会被动 |

daemon 不在线时执行 `botmux delete`，如果终端标签不符、herdr-core 不可用或查询没有结果，会拒绝删除并保留会话，而不是把会话标成已关闭、留下无人管的 CLI。

终端所在的 core（socket）在会话第一次创建时就被记录下来。之后即使 daemon 的环境变了（比如 `XDG_RUNTIME_DIR` 不一样了），botmux 仍会到原来的 core 找它。

Linux 上，`XDG_RUNTIME_DIR` 是 `/run/user/<uid>` 时，hc 会用 systemd 用户单元托管 core 和终端。macOS 本地会话由 hc 通过 launchd 启动 core。

:::warning 升级 herdr-core
替换磁盘上的二进制不会替换已经在跑的 core。如果正在运行的 botmux core 低于 0.1.19，新会话会被拒绝，错误信息里有这个 core 的 socket 和 pid。botmux 不会自动重启它，因为结束 core 会结束里面所有的终端；确认没有要保留的会话后，结束这个进程再重试。
:::

## 6. 和 tmux 相比的差别与限制

- **不支持 `/adopt`**：botmux 不扫描 hc 里的终端，要接入已有的外部会话，用 tmux / Herdr / Zellij。
- **没有 tmux 的 copy mode**：Web 终端的滚动由浏览器保留的回滚缓冲提供；worker 重新接上时，最多补回约 3000 行历史。
- **空窗期的终端尺寸**：没有 worker 接着时（比如 daemon 重启的那几秒），终端保持 160×50，不会被拉成别的尺寸。
- **严格进程环境、`launchShell`、会话环境变量的「去掉」**：和 tmux 一样，都在终端启动脚本里生效。

## 7. 尚待上游修复的问题

botmux 已经绕开了下面这些问题，上游修好后可以去掉相应的规避：

- 观察者接入或断开时，会把终端尺寸打回 core 的默认尺寸（[herdrdev/herdr-core#199](https://github.com/herdrdev/herdr-core/pull/199)）。
- 状态目录不同的 core 在绑定 socket 前会无条件删掉已有的 socket，抢走正在服务的 core（[herdrdev/herdr-core#200](https://github.com/herdrdev/herdr-core/pull/200)）。botmux 因此把状态目录固定在 socket 旁边。
- 接入时带历史，历史和屏幕接缝处会多出一行空行。
- 还在和上游讨论的功能：关闭「连不上就自动启动 core」、创建终端时删除环境变量、不抢尺寸的输入客户端。

## 8. 排错

| 现象 | 先查什么 |
|---|---|
| 新会话起不来，提示 herdr-core 不可用 | 用 daemon 的同一用户执行 `~/.botmux/bin/herdr-core --version`（或你放的位置），确认输出 `hc 0.1.19` 以上；设置了 `BOTMUX_HC_BIN` 时只会用它 |
| 提示 core 版本低于 0.1.19 | 见上面的「升级 herdr-core」 |
| 提示运行目录不存在或 socket 路径过长 | 检查 daemon 环境里的 `XDG_RUNTIME_DIR`：目录要存在，路径要足够短 |
| `botmux list` 接入时提示终端已结束或不存在 | 在飞书里给这个会话发一条消息，会话会接着之前的对话启动，然后再接入 |
| 用自己的 `hc ls` 看不到 `bmx-*` 终端 | 正常：它们在 botmux 的私有 core 里，不在你的 `default` core |

## 给贡献者

默认的单元测试不需要 herdr-core。会启动真实 hc 的用例需要用 `BOTMUX_HC_TEST_BIN` 指定一个 0.1.19 以上的二进制，没有时自动跳过；这些用例都在私有的临时 `XDG_RUNTIME_DIR` 里运行，不会碰到 `/run/user/<uid>` 下的真实 socket。
