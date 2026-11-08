# 5 分钟快速接入

<video src="img/video-v1-quickstart.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

四步就能在飞书里和 AI 编程 CLI 对话：

| 步骤 | 命令 / 操作 | 做了什么 |
|---|---|---|
| 1. 安装 | `curl -fsSL .../install.sh \| sh` | 装一个单文件程序，不需要 Node |
| 2. 配置 | `botmux setup` | 飞书扫一次码：建应用、配权限、发版本全自动 |
| 3. 启动 | `botmux start` + `botmux autostart enable` | 启动后台服务，并设置开机自启 |
| 4. 开聊 | 把机器人拉进群，@ 它发消息 | 选好目录，CLI 就开始干活 |

**开始前**：先看一眼 [前置要求](/prerequisites)。要用的 CLI（如 `claude`、`codex`）得先在终端里装好、登录、能正常对话；默认还需要 tmux。「装完连不上」大多是这里缺了东西。

## 第 1 步 · 安装

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
```

装完**开一个新终端**，`botmux` 命令就能用了。

- 支持 Linux / macOS（x64、arm64），Alpine 这类 musl 系统会自动选对应版本。Windows 请在 WSL2 里装。
- 装到 `~/.botmux/bin/botmux`，想换位置就设 `BOTMUX_INSTALL_DIR`。脚本会校验下载文件的 SHA-256，并把这个目录写进你 shell（zsh / bash / fish）的启动文件。
- botmux 本身不需要 Node。你用的 CLI 如果是 npm 包，装它时照样要 Node。

也可以用 npm 装：`npm install -g botmux`（这一步需要 Node ≥ 22）。npm 包里是同一个程序，装好后和 curl 版完全一样。

在 Mac 上想点一下就启停服务，也可以装 [macOS 桌面版](/desktop)：App 自带运行环境，和命令行版共用同一份 `~/.botmux` 配置。

**以后怎么升级**：

| 想做 | 命令 |
|---|---|
| 升到最新版（任何安装方式都适用） | 重跑上面的 curl 命令，然后开新终端执行 `botmux restart` |
| 已经是 v3.18.0 及以上 | 也可以直接 `botmux update`，然后 `botmux restart` |
| 装指定版本 | `curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh \| BOTMUX_VERSION=v3.18.8 sh` |

> ⚠️ `BOTMUX_VERSION` 要写在管道右边的 `sh` 前面才生效。v3.18.0 之前的老版本请只用 curl 升级，原因见 [FAQ · 怎么升级？](/faq#怎么升级)。

## 第 2 步 · 配置机器人

```bash
botmux setup
```

这是一个交互式向导，用方向键选、回车确认。按 `Esc` 会取消这次 setup，不写入任何配置。第一次运行会依次问你下面几件事：

**① 飞书应用从哪来**

| 选项 | 适合 |
|---|---|
| **一次扫码创建新应用**（推荐） | 第一次用。先给机器人起个名字，再用飞书 App 扫码，botmux 会帮你建应用、取 AppID/AppSecret |
| 选择已有应用 | 你之前建过应用。登录后列出你建的应用，自动取凭证（仅飞书租户） |
| 手动输入 AppID/Secret | 已经在 [飞书开放平台](https://open.larkoffice.com/app) 建好了应用。会先让你选飞书还是 Lark 国际版 |

> 本机扫过一次码之后，登录状态会被记住。下次再添加机器人时确认账号即可，不用重新扫码。

**② 选择 CLI**：选这个机器人要接的 CLI，比如 Claude Code、Codex。可以输入文字搜索。如果本机找不到这个 CLI，会提示你先去装。

**③ 新话题在哪个目录启动**

| 选项 | 效果 | 要填什么 |
|---|---|---|
| **固定默认目录**（推荐） | 新话题直接在这个目录启动，不弹卡片 | 一个已经存在的目录，比如 `~/projects/my-app` |
| 仓库选择卡片 | 每个新话题先弹一张卡片，让你从扫到的 git 仓库里选一个 | 扫描的根目录，比如 `~/projects`（往下找 3 层，多个用逗号分隔） |

> 仓库选择卡片模式下尽量别填 `~`，要扫的文件夹太多。

**④ 管理员（owner）**：扫码创建时，扫码人会自动成为管理员。手动输入凭证时需要自己填，推荐填完整的企业邮箱，也可以填手机号。

填完后 setup 会**自动配置开放平台**：导入全部权限、配置重定向 URL、创建并发布版本，最后打印每一步的结果。

> 🔧 **哪些情况要自己去开放平台补配置**
> - 加了 `botmux setup --no-open-platform-auto`（跳过自动配置），或自动配置失败。
> - 这时 setup 会列出要补的几项（开启机器人能力、长连接事件订阅、权限、重定向 URL、发布版本）和对应链接，完整权限清单写在 `~/.botmux/lark-scopes.json`。
> - 可用范围选「仅自己可见」，版本一般会自动通过审核。

已经配置过的机器上再跑 `botmux setup`，会出现菜单：添加新机器人、编辑现有机器人、删除机器人、重新配置。改完按提示执行 `botmux restart`。

> 想用脚本或 AI agent 配置，不走交互界面？用 `botmux setup add` / `botmux setup list` 等子命令，`botmux setup help` 查看全部参数。

> ➕ **需要内置清单之外的权限？** 脚本化添加时传 `--extra-scopes-file <json>`（仅飞书租户；Lark 需在开放平台手动添加），例如 `botmux setup add --create-app --allowed-users <邮箱> --extra-scopes-file ./scopes.json`；已有机器人用 `botmux setup configure <进程名|AppID> --extra-scopes-file ./scopes.json` 补上。文件格式同 `lark-scopes.json`（`{"scopes":{"tenant":[],"user":[]}}`）；也接受 `{"scopes":[{"scope":"x:y"}]}`，但这种写法一律按 user 权限申请，要申请 tenant 权限请用 `{"scopes":{"tenant":["x:y"]}}`。当前租户目录里没有的权限（包括只有另一种身份才有的权限）会跳过并列在结果里，不会中断流程。文件路径会记到该机器人配置，之后重跑 `configure` 自动沿用；记下的文件读不到时只提示并按内置清单继续，不再需要就跑 `botmux setup configure <进程名|AppID> --extra-scopes-file -` 清除。

> 👋 **上线欢迎语**：`botmux setup add ... --welcome-message "回复 /init 开始配置"`（或 `--welcome-message-file welcome.txt` 从文件读取）会让机器人首次成功上线后主动私聊主人一次；已有机器人用 `botmux setup edit <进程名|AppID> --welcome-message ...` 设置，传 `-` 清空。发送记录在 daemon 数据目录 `welcome-sent/` 下，之后重启不会重发；发送失败不影响启动，下次启动重试。详见 [bots.json 配置 · 上线欢迎语](/bots-json#welcome-message)。

## 第 3 步 · 启动

```bash
botmux start            # 启动后台服务（daemon）
botmux autostart enable # 开机自启（推荐，不需要 sudo）
```

- 开机自启在 Linux 上用 user systemd，在 macOS 上用 launchd。
- 第一次 `botmux start` 会问「反馈存储」用什么，**直接回车选默认的 SQLite** 就行。需要 PostgreSQL 的话可以在这里选，以后也能用 `botmux feedback storage` 迁移（迁移期间会暂停新任务；原 SQLite 会保留，但 PostgreSQL 出故障时不会自动切回）。详见 [反馈数据存储与迁移](/feedback-storage)。
- 看运行状态：`botmux status`；看日志：`botmux logs`。

## 第 4 步 · 建群开聊

1. 在飞书里建一个**话题群**（普通群也可以）。
2. 群设置 → 群机器人 → 添加你刚建的机器人。
3. **@ 机器人**发一条消息，比如「@机器人 看看这个项目怎么构建」。
4. 如果第 2 步选的是仓库选择卡片，会先弹卡片让你选项目；选的是固定目录，CLI 直接在那里启动。

机器人会回一张卡片，边干活边更新进度，做完后显示完整回答：

![回复卡片：处理中与完成后](/img/unified-reply-card-preview.png)

几个常见问题：

- **每次都要 @ 吗？** 群里默认要 @ 机器人才会回。只有你和一个机器人的群，在已开始的话题里接着说可以不 @。想改成免 @，见 [@ 策略](/mention-mode)。
- **不想建群？** 直接**私聊机器人**也能用。
- **想一键建群？** 在任意聊天里发 `/g 群名`，或打开 `botmux dashboard` 的「群组管理」页点「新建群聊」，见 [一键新建会话群](/group)。

## 收不到消息？先自查

大多数「没反应」是本地配置或网络问题。可以让你的 AI CLI 帮你排查：它会读日志、看配置，直接给结论。

先把排查任务存成一个变量：

```bash
DIAG='botmux 在飞书群收不到消息，请只读排查（别改任何东西），依次执行并给出最可能原因+修复步骤：botmux status（daemon 在跑吗）；botmux logs --lines 150 --no-follow（找 WebSocket 连接失败、token 鉴权、权限报错 401/403/411/400、CLI spawn 失败）；cat ~/.botmux/bots.json（确认 AppID/Secret/CLI 配置）；判断长连接是否被公司网/代理/防火墙挡住。最后给结论。'
```

再按你装的 CLI 选一条运行（都是非交互模式，跑完直接打印结论）：

```bash
claude -p "$DIAG" --allowedTools "Bash"   # Claude Code
codex exec "$DIAG"                         # Codex
coco  -p "$DIAG" --yolo                    # TRAE CLI 1.0 / CoCo（旧版）
cursor-agent -p "$DIAG"                    # Cursor
```

> 后面的 `--allowedTools` / `--yolo` 只是让 agent 能执行命令读日志。`botmux logs` 几乎能定位所有问题。

还是没头绪，就手动对一遍：

| 现象 / 怀疑 | 怎么查、怎么修 |
|---|---|
| daemon 没在跑，或改了配置没重启 | `botmux status` 看状态，`botmux restart` 重启 |
| 发消息没 @ 机器人 | 群里默认要 @，见 [@ 策略](/mention-mode) |
| 权限不全，或用了旧应用建的机器人（最常见） | 见 [常见踩坑](/pitfalls)，用最新的 `botmux setup` 扫码重建 |
| 手动建的应用没配全 | 开放平台里：开启「应用功能 → 机器人」；事件用「长连接」接收，订阅 `im.message.receive_v1`，回调订阅 `card.action.trigger`；发布版本 |
| 长连接出不去（公司网络 / 代理 / 防火墙） | `botmux logs` 里会有连接错误 |

改完执行 `botmux restart`。更多见 [FAQ / 排错](/faq)。

### 可选事件：编辑补 @、撤回同步、群解散

下面几个事件缺了**不影响普通消息**，只影响对应的小功能。新建的机器人会自动订阅；老机器人在启动时，botmux 会借本机已有的开放平台登录状态尝试补上。

| 事件 | 用途 |
|---|---|
| `im.message.updated_v1` | 编辑一条之前没 @ 机器人的消息、补上 @ 后触发任务 |
| `im.message.recalled_v1` | 群聊上下文共享（`/context-sharing`）里，撤回的消息同步从记录中标记掉。只在开了这个功能时才会去补 |
| `im.chat.disbanded_v1` | 群被解散后，结束机器人在这个群里的会话（和 `/close` 一样，之后还能恢复，不删 worktree）。缺了的话，要等 daemon 下次重启时才会把这些会话关掉 |

注意几点：

- 启动时补订阅只会在现有的长连接配置里加事件，**不会**改接收方式、改权限或发布版本。日志里「更新请求成功」不代表已经生效。正式应用请到开放平台检查待发布的改动、发布版本，再找一条没触发过的消息编辑补 @ 验证。
- 如果发送者是靠「团队成员」身份获得发言权限的，编辑消息还要查通讯录拿到对方的 `union_id`。这需要应用有通讯录读取权限（默认权限清单里有 `contact:user.id:readonly`），且对方在应用可见范围内。查不到时只按消息原作者的 `open_id` 判断权限，不会借用编辑人的身份。
