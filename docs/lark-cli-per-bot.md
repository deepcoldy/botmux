# lark-cli 按 bot 隔离配置（沙盒前置条件）

开启文件沙盒（`sandbox: true` / `BOTMUX_SANDBOX=1`）或读隔离（`readIsolation: true`）后，**agent 在会话里跑 `lark-cli` 要求这台机器已经做过「按 bot 拆分 lark-cli 配置」**。

这不是可选优化，是**前置条件**：沙盒基线 deny 了 lark-cli 的共享配置目录，没做这步的机器上，沙盒内所有 lark-cli 命令都会以 `not configured` / `config_file: operation not permitted` 失败（[#683](https://github.com/deepcoldy/botmux/issues/683)）。

## 为什么

lark-cli 默认从 `~/.lark-cli/config.json` 读配置，macOS 上把密钥落在 `~/Library/Application Support/lark-cli`。这两处都是**全机共享**的：一份配置 = 一个飞书 app 身份，而 keystore 里躺着**每个** bot 的 appsecret 密文 + 解密用的 master key。

沙盒的三档白名单因此这样切（真源 `src/adapters/cli/fs-policy.ts`）：

| 路径 | 沙盒里的档位 | 为什么 |
|---|---|---|
| `~/.lark-cli` | **deny** | 共享配置 = 共享 app 身份，等于跨 bot 越权 |
| `~/Library/Application Support/lark-cli`（macOS，整目录） | **deny** | 每个 bot 的 appsecret 密文 + master key 都在这儿 |
| `~/Library/Application Support/lark-cli/master.key.file`<br>`…/appsecret_<自己appId>.enc`（macOS） | **readOnly** carve-out | 本 bot 解自己那份密文所必需。兄弟的 `.enc` 仍 deny——master key 单独解不了它读不到的东西 |
| `~/.lark-cli-bots/<自己appId>` | **readWrite** | 本 bot 专属的 lark-cli 配置目录——沙盒给 agent 预留的那扇门 |

也就是说：**沙盒已经按「每个 bot 用自己的配置目录」这个前提设计好了放行规则**。缺的只是把目录建出来，并让 lark-cli 真的去用它。

> Linux（bwrap）把密钥直接放在 per-bot 目录里，不需要 macOS 那两条 keystore carve-out；但「配置目录按 bot 拆」这个前提两平台一样。

顺带的收益（跟沙盒无关，但同一套配置换来的）：每个 bot 用**自己的飞书 app** 访问飞书，权限可以按 bot 独立管控，bot 建的文档作者也是它自己，而不是所有 bot 共用一个 app 身份。

## 原理链路

```
bot 会话
  └─ BOTMUX_LARK_APP_ID = cli_xxx                       botmux 注入
       └─ ~/.zshenv 据此设置
            LARKSUITE_CLI_CONFIG_DIR = ~/.lark-cli-bots/cli_xxx
                 └─ lark-cli 读该目录的 config.json
                      └─ 用 cli_xxx 这个 app（bot-only 身份）
                           └─ 落在沙盒 readWrite 白名单内 → 沙盒里可用
```

两个现成的钩子对接即可，**不需要改 botmux**：botmux 已经给每个 bot 会话注入 `BOTMUX_LARK_APP_ID`，lark-cli 已经支持用 `LARKSUITE_CLI_CONFIG_DIR` 覆盖配置目录。

## 配置步骤

### 1. 一次性：把 `BOTMUX_LARK_APP_ID` 映射成 lark-cli 的配置目录

```bash
# ~/.zshenv
if [ -n "$BOTMUX_LARK_APP_ID" ]; then
  export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-bots/$BOTMUX_LARK_APP_ID"
fi
```

**必须写在 `~/.zshenv`，不是 `~/.zshrc`**：agent 的 Bash 工具起的是**非交互** shell，只加载 `.zshenv`。写错文件 = 静默不生效（这是实际踩过的坑）。默认 shell 是 bash 的机器，等价位置是 `$BASH_ENV` 指向的文件——非交互 bash 同样**不**读 `.bashrc`。

沙盒基线专门把 `.zshenv` / `.zprofile` / `.zshrc` / `.profile` / `.bashrc` / `.bash_profile` 放行成 readOnly，就是为了让这段映射在沙盒里读得到。

普通终端里 `BOTMUX_LARK_APP_ID` 为空 → 自动回退到默认 `~/.lark-cli`，手动使用不受影响。

### 2. 每个 bot：建自己的配置目录，绑自己的飞书 app

用该 bot 在 `~/.botmux/bots.json` 里的 `larkAppId` / `larkAppSecret`：

```bash
APPID=cli_xxx
DIR="$HOME/.lark-cli-bots/$APPID"
mkdir -p "$DIR"
printf '%s' "$APPSECRET" | LARKSUITE_CLI_CONFIG_DIR="$DIR" \
  lark-cli config init --app-id "$APPID" --app-secret-stdin --brand feishu
LARKSUITE_CLI_CONFIG_DIR="$DIR" lark-cli config default-as bot
```

- `--app-secret-stdin` 而非命令行传参：避免 secret 进 `ps` 的进程列表。
- `default-as bot` = 只用 bot 身份，不冒充个人。沙盒下这也是**唯一可用**的身份（见下「边界」）。
- 如果你是**在某个 bot 会话里**跑这段（而不是在自己的终端），`config init` 会因为检测到 agent workspace 而拒绝，需要加 `--force-init`。

**bot-only 身份的含义**：这个 bot 只能访问**显式分享给它那个 app** 的文档 / 表格，碰不到任何人的私人云空间、日历、邮箱。这正是按 bot 隔离权限的基础。

### 3. 在开放平台给每个 app 开 scope

scope 决定「这个 bot **能做哪类**飞书操作」。到开发者后台逐个 app 开通，**开完创建版本并发布**才生效：

权限页地址：`https://open.feishu.cn/app/<appId>/auth`

按需勾选，例如 `im:message`（发消息）、`im:chat:read`（群信息）、`docx:document:readonly`（云文档）、`drive:file:download`（云盘）等。

## 验证

会话里（agent 视角）：

```bash
lark-cli config show    # appId = 本 bot；Config file path 指向 ~/.lark-cli-bots/<appId>/config.json
lark-cli auth status    # identities.bot.status = "ready"
lark-cli im +chat-list --as bot     # 实测 bot 身份能力
```

macOS 上还可以用该会话线上的 Seatbelt profile 做内核级读探测（profile 落在 `<dataDir>/read-isolation/<sessionId>.sb`，沙盒与读隔离共用这个目录）：

```bash
SB=~/.botmux/data/read-isolation/$SID.sb
sandbox-exec -f $SB cat ~/.lark-cli-bots/<自己appId>/config.json   # → 正常
sandbox-exec -f $SB cat ~/.lark-cli/config.json                    # → Operation not permitted
sandbox-exec -f $SB ls ~/Library/Application\ Support/lark-cli     # → Operation not permitted
```

## 边界与已知问题

- **给 node / codex 开「完全磁盘访问权限」没有用。** macOS 有两套互相独立的强制访问控制层：TCC（系统设置 → 隐私与安全性）和 Seatbelt（`sandbox-exec` 施加的内核级 MAC）。botmux 用的是后者，deny 在 vnode 层由内核拦，**和 TCC 完全无关**。这是 #683 里最费时间的误判：报错不指向根因，人会一路走到 Full Disk Access 上去。

- **沙盒下只有 bot 身份可用。** 用户登录态（keystore 里的 `<appId>_<openId>.enc`）不在 carve-out 内，`--as user` 及一切依赖用户 token 的命令在沙盒里读不到。要用用户身份就得在沙盒外跑。

- **不要用 `sandboxPaths.readOnly` 整目录开洞。** 把 `~/Library/Application Support/lark-cli` 整个放行确实能让命令跑起来（user 源 rank=3 > baseline rank=0，能覆盖 baseline 的 deny），但等于把**所有** bot 的 appsecret 密文 + master key 交给当前 bot 的 agent——正是这条 deny 存在的原因，属于安全回退。

- **`lark-cli` 没有 `whoami` 子命令**（实测 1.0.56）。自查身份用 `auth status` / `config show`。

- **no-transport 会话下 lark-cli 一律不可用。** `apiOnly` bot / HTTP 虚拟会话这类没有飞书 transport 的 turn，会把整个飞书授权面（`~/.botmux`、`~/.lark-cli`、`~/.lark-cli-bots`、macOS keystore）整体冻结成 deny，本 bot 的 per-bot 目录与 keystore carve-out 都**不发放**。这是有意的：这类 turn 本就不该持有飞书凭证。

- **scope ≠ 具体文件访问权。** 开了 scope 只是有了「能力」；要让 bot 真能读**某份**文档，那份文件还得分享给对应 app（或放进 bot 所在的群 / 知识库）。

- **换 app 后旧文档会读不到。** 之前分享给共享 app 的文档，bot 换成自己的 app 后需要重新分享。这是隔离生效的正常表现。

## 排错

| 症状 | 原因 | 处置 |
|---|---|---|
| `not configured` / `config_file: operation not permitted` | 没做步骤 1/2，lark-cli 落回被 deny 的 `~/.lark-cli` | 按上面两步配好，重开会话 |
| `config show` 里 Config file path 仍是 `~/.lark-cli/config.json` | 映射没生效：写进了 `.zshrc`，或默认 shell 不是 zsh | 挪到 `~/.zshenv`（bash 走 `$BASH_ENV`） |
| `keychain Get failed … operation not permitted` | keystore carve-out 没命中 | 确认 `~/Library/Application Support/lark-cli/appsecret_<本bot appId>.enc` 存在（该 bot 在**本机**用自己的 appId init 过） |
| 命令能跑但读不到某份文档 | scope 有了、文件没分享 | 把文件分享给这个 app，或把 bot 拉进群 / 知识库 |
| 沙盒外手动跑 lark-cli 用错了身份 | 终端里 `BOTMUX_LARK_APP_ID` 为空，回退到 `~/.lark-cli` | 显式 `LARKSUITE_CLI_CONFIG_DIR=~/.lark-cli-bots/<appId> lark-cli …` |

## 新增 bot 时怎么扩展

重复**步骤 2 + 3** 即可：用新 bot 的 App ID / Secret 建好它的配置目录，在开放平台给新 app 开 scope 并发布。步骤 1 的 `~/.zshenv` 映射是通用的，**不用动**。

## 相关

- [文件沙盒](./file-sandbox.md) — 沙盒模型与白名单机制
- [隔离 bot 部署指南（macOS）](./isolated-bot-deploy.md) — 读隔离部署与覆盖面
- 白名单真源：`src/adapters/cli/fs-policy.ts`
