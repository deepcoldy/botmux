# 文件与网络沙盒（Sandbox）

沙盒用来限制 Bot 背后的 CLI 能碰到宿主机上的哪些东西：防止它读到不该读的密钥，或者把你的环境改坏。每个 Bot 单独设置，**Linux 和 macOS 都支持**。

## 先选一档

文件沙盒只有一个开关，分三档：

| 档位（配置值） | 一句话 | 能读什么 | 写到哪里 | 适合谁 |
|---|---|---|---|---|
| 关闭（`off`，缺省） | 不隔离 | 全部宿主文件 | 直接写宿主 | 只有你自己用、完全信任的环境 |
| 白名单隔离（`oncall`） | **防泄密** | 只有白名单里的路径，其余文件在沙盒里根本不存在 | 白名单里的可写路径，写入直接落到宿主 | 把 Bot 分享给群成员、外部协作者 |
| scratch 一次性（`scratch`） | **防改坏** | 整个真实文件系统（只遮住 botmux 自己的凭证） | 写进一次性副本，会话结束就丢弃，宿主不受影响 | 你自己跑高风险命令、试验性重构、编译不可信代码 |

怎么选：

- **会有别人用这个 Bot**（群成员、Oncall 值班、多人授权）→ 选**白名单隔离**。私钥、Token、其它代码库、其它 Bot 的数据默认都看不到。
- **只有你自己用，但担心命令把机器搞乱** → 选 **scratch**。不用配白名单，所有工具照常可用，改坏了直接丢。
- ⚠️ **scratch 只隔离写入，不隔离凭据**：agent 仍能读到这台机器上的密钥，以及其他人的 token 和登录态（如 `~/.botmux/data/` 下的 `user-token-*`、`lark-cli-home/`）。多人共用的 Bot 不要用 scratch。

> 沙盒只管「CLI 能访问哪些文件」，不管「谁能和 Bot 对话」。谁能对话由 [Oncall 模式](/oncall) 和 [权限与授权](/permissions) 决定。

## 怎么开启

### 在 Dashboard 里切换（推荐）

1. 打开 Dashboard →「Bot 配置」→ 选中要改的 Bot。
2. 找到「**文件沙盒**」，在「关闭 / 白名单隔离 / scratch 一次性」里选一个。
3. 切到白名单隔离或 scratch 时，确认弹窗会再说明一次这一档的效果，点「切换」。切回关闭不弹窗。
4. 选 scratch 时还可以选存储方式：「内存即焚」或「磁盘」。

Dashboard 会顺手帮你检查：

- 这个 Bot 被多人使用（开了 Oncall 值班、整群授权、多个 `allowedUsers`，或开了按触发人鉴权）却没开白名单隔离时，会提示「建议开启白名单隔离」，并告诉你当前 CLI 是否已验证可用。
- 选 scratch 时，会按这台机器的条件提示「不能用 scratch」或「只能用磁盘存储」，以及缺哪些依赖、怎么装。

### 在 `bots.json` 里写

```json
[
  {
    "name": "public-oncall",
    "cliId": "codex",
    "sandbox": "oncall",
    "sandboxPaths": { "deny": ["~/.kube"] }
  },
  {
    "name": "my-scratch",
    "cliId": "claude-code",
    "sandbox": "scratch",
    "scratchStorage": "tmpfs"
  }
]
```

- 不写 `sandbox`，或写 `false`，就是关闭；写 `true` 等于 `"oncall"`。
- 旧字段 `readIsolation: true` 按白名单隔离处理，daemon 启动时会自动迁移。

### 改了之后什么时候生效

**只对新会话生效。** 会话在第一次启动时把沙盒模式记下来，之后一直用这一份。已经在跑的会话保持创建时的模式，`/restart` 或重启 daemon 都不会改。想马上用新模式，新开一个话题。

怎么确认当前会话开没开沙盒：

- 飞书里的会话卡片会多一行小字「🛡️ 沙盒：白名单隔离」或「🛡️ 沙盒：scratch 一次性」。没开沙盒就没有这一行。
- Dashboard 会话列表和看板里，如果会话记下的沙盒模式和 Bot 当前配置不一样，会标「沙盒与配置不一致」，鼠标悬停能看到两边分别是什么（例如「会话为 关闭，当前配置为 白名单隔离」）。

「沙盒与配置不一致」不是报错，意思是：你在会话启动后改了这个 Bot 的沙盒模式，这个会话还在按旧模式跑。

| 想要 | 怎么做 |
|---|---|
| 这个会话也用新模式 | 新开一个话题。`/restart` 不会切换模式，标记也不会消失 |
| 保持旧模式继续用 | 不用处理，会话照常工作 |

还没启动过的会话（比如还在选仓库）不会显示这个标记。

### 用环境变量强制开（整台机器）

`BOTMUX_SANDBOX` 适合测试或统一加固，对本机所有 Bot 生效：

| 取值 | 效果 |
|---|---|
| `1` 或 `oncall` | 所有 Bot 强制白名单隔离 |
| `scratch` | 所有 Bot 强制 scratch |
| 不设、空、`0`、`false` | 不强制，每个 Bot 按自己的 `sandbox` 配置 |
| 其它值 | 报错，拒绝启动 |

这个变量**只能强制开，不能全局关**：设成 `0` 不会关掉 Bot 自己开的沙盒。

---

## 白名单隔离（`oncall`）

CLI 被关在一个按会话生成的文件白名单里，读和写都只能碰白名单里的路径。群成员怎么诱导模型，也碰不到你的私钥、其它代码库或飞书应用凭证。常和 [Oncall 模式](/oncall) 一起用。

### 沙盒里能看到什么

| 路径 | 沙盒里的样子 |
|---|---|
| 工作目录（`workingDir`） | 可读写，改动直接落到宿主 |
| 系统工具、动态库、CLI 本身 | 只读 |
| `/tmp`、`/run`、`/var/tmp`、`/dev/shm` | 会话私有的空目录，和宿主不通 |
| `~/.ssh`、`~/.aws`、共享的 `~/.lark-cli` | 遮住，看不到 |
| `~/.botmux`（botmux 数据目录） | 只露出本会话需要的部分（本 Bot 自己的 `bots/<appId>/`、`botmux` 命令和插件、本会话的记录）；`bots.json`、Dashboard 密钥、其它 Bot 的目录都不可读写 |
| botmux 安装目录 | 只读，用来运行 `botmux` 命令；如果是 git 仓库，没被 git 跟踪的文件（`.env`、登录态、`data/` 等）和 `.git` 会被遮住 |
| 家目录其它内容 | **不会整体挂进来**，除非它在工作目录里 |
| 网络 | 默认**不限制**，和宿主一样，见[网络沙盒](#网络沙盒) |

几个要注意的地方：

- **把工作目录指到具体项目**（如 `~/proj`）。`workingDir` 缺省是 `~`，这时家目录里其它没被遮住的内容都在白名单里、都可写。
- 工作目录不能放在 botmux 数据目录里面（本 Bot 自己的 `bots/<appId>/` 除外），否则会话拒绝启动。
- Linux 上私有的 `/run` 里还有几项运行必需的只读挂载：命令中转目录 `/run/sbxbin`、MCP 插件网关的 socket 目录（启用网关时）、软链到 `/run` 下的 `/etc/resolv.conf`、位于 `/run` 下的 CLI / 解释器目录（如 fnm、nvm 的 multishell 目录）。

### 加白名单或加遮罩（`sandboxPaths`）

想让沙盒多看到几个目录，或多遮住几个敏感路径：

```jsonc
{
  "sandbox": "oncall",
  "sandboxPaths": {
    // 额外可读写的目录
    "readWrite": ["~/shared-output"],
    // 额外只读的目录（共享源码、文档等）
    "readOnly": ["/srv/shared-libs", "~/docs/runbooks"],
    // 额外遮住的敏感路径
    "deny": ["~/.kube", "/opt/confidential"]
  }
}
```

规则：

- **必须写绝对路径**（以 `/` 或 `~/` 开头）。相对路径会按会话工作目录解析，`..` 可能就指到了家目录，所以三类里都不接受。
- **「可读写」里不能放根目录 `/`、家目录、botmux 数据目录，以及它们的上级目录**：这等于把整个磁盘或所有凭据交给沙盒。`~/projects/foo` 这种具体目录没问题。
- **Linux 上「只读」里不能放 `/` 或 `/run`**：沙盒需要的挂载点会建不出来，会话一启动就退出。改成具体目录，如 `/usr`、`/opt/工具目录`、`/run/lock`。
- Dashboard 保存时会直接拒绝上面这些写法并说明原因。手改 `bots.json` 写进去的旧配置，启动时会自动降级：家目录 / 数据目录从可读写降为只读，可读写里的 `/` 和相对路径直接忽略；Linux 上只读里的 `/`、`/run` 也会忽略。
- 还不存在的 `readWrite` / `readOnly` 路径启动时会被忽略；要放行一个还没创建的文件，放行它已存在的父目录。
- 旧字段 `sandboxHidePaths`、`sandboxReadonlyPaths` 仍能读，daemon 启动时会自动迁移到 `deny` / `readOnly`。

### 各 CLI 的数据目录放在哪

- **Claude Code（含同源的 Seed）和 Codex**：配置、会话记录、记忆写到这个 Bot 的专属目录 `<BOTMUX_HOME>/bots/<appId>/`（`.../claude`、`.../codex`），不读写你全局的 `~/.claude`、`~/.codex`。Dashboard 会显示「增强 CLI 数据隔离」。
- **其它 CLI**（Cursor、Antigravity、Grok、Kimi 等）：仍用宿主上的全局数据目录，按各自适配器声明的路径挂进沙盒（有的整个目录可写，有的只挂凭证文件）。
- 配了 `wrapperCli` 时不做这一步重定向，CLI 用自己原本的数据目录。

### 哪些 CLI 已验证可用

以下 CLI 在 Linux 上实测过白名单隔离（tmux 和 pty 后端都测了启动、对话、shell 工具、工作目录读写、联网、`botmux send` 和凭证隔离）：

Claude Code、Codex、Antigravity、OpenCode、Pi、oh-my-pi、Grok、Kimi。

- **Codex App** 在 Linux 上不支持白名单隔离，会拒绝启动，请改用 Codex。
- 其它 CLI 没有逐一验证，开启前先在测试会话里试一下。

### 和 `wrapperCli` 一起用

配了启动前缀 `wrapperCli` 的 Bot 也能开沙盒（pty / tmux 后端）。wrapper 本身在沙盒里运行，受同一套白名单约束：

- botmux 只自动放行 wrapper 的可执行文件本身，以及它要调用的 CLI。
- wrapper 依赖的其它目录（安装目录、解释器、配置）要自己加进 `sandboxPaths`：只读放 `readOnly`，需要写的放 `readWrite`。
- 缺路径时，会话会在启动前点名缺了什么；如果 wrapper 启动后马上退出，话题里也会提示去补 `sandboxPaths`。scratch 下则提示检查 `scratchDenyPaths`。

### 多账号与凭证

- **Codex 独立登录态（`codexAuthSync: "isolated"`）**：`CODEX_HOME` 指向 `<BOTMUX_HOME>/bots/<appId>/codex`，不读也不改全局 `~/.codex`。关闭沙盒和白名单隔离下都能用；**不能和 `scratch` 或 `wrapperCli` 一起配**（会拒绝启动）。会话绑定了非旧式 Codex 实例时，以实例自己的认证方式为准。
- **Codex 的 `config.toml`**：Codex 用 Bot 专属目录时（白名单隔离，或 `codexAuthSync: "isolated"`；scratch 和配了 `wrapperCli` 时不算），里面的 `config.toml` 在第一个新会话启动时从宿主 `~/.codex/config.toml` 复制一次，之后宿主改动不会自动同步。Dashboard「Codex 登录凭证」里会显示路径，可以点「从宿主重新同步」（旧文件先备份为 `config.toml.bak-<时间>`），下个新会话生效。
- **Claude 按 Bot 分账号（`credentialsSourceDir`）**：沙盒 Bot 每次冷启动都从这个目录取 OAuth 凭证，多个沙盒 Bot 互不串号。对没开沙盒的 Bot 无效；不能和 `codexAuthSync: "isolated"` 同时配。
- **lark-cli**：沙盒遮住了共享的 `~/.lark-cli`。想在沙盒里用 lark-cli，机器要先按 Bot 拆分配置，见 [lark-cli 按 bot 隔离配置](https://github.com/deepcoldy/botmux/blob/master/docs/lark-cli-per-bot.md)。

#### 一机多账号：给 Claude Bot 配独立账号 {#credentials-source-dir}

默认情况下，同一台机器上的沙盒 Bot 都从本机共享登录（`~/.claude/.credentials.json` 或钥匙串）取凭证，等于大家用同一个 Claude 账号。想让某个 Bot 用另一个账号：

1. 准备一个账号目录，按 CLI 分子目录放凭证，例如：

   ```text
   ~/accounts/acct-b/
   └── claude/
       └── .credentials.json
   ```

2. 给这个 Bot 配 `credentialsSourceDir`：`bots.json` 里写 `"credentialsSourceDir": "~/accounts/acct-b"`，或在飞书里发 `/botconfig set credentialsSourceDir ~/accounts/acct-b`。
3. 新会话生效（已有会话 `/restart`）。之后每次冷启动，botmux 都把这个目录里的凭证复制进 Bot 自己的数据目录。

限制：

- **目前只支持 `claude-code`**，而且 Bot 必须开着文件沙盒。完全没开沙盒的 Bot 配了也不生效（仍用全局登录，日志里会告警）；开了沙盒但数据目录重定向不了（比如配了 `wrapperCli`）会拒绝启动。
- 来源目录不存在、不可读或凭证无效时**拒绝启动**，不会悄悄退回共享登录。
- 不能和 `codexAuthSync: "isolated"` 同时配。Codex 分账号用 `codexAuthSync: "isolated"`，见上一条。
- botmux 只在冷启动时复制，**不负责刷新**来源目录里的 token。来源目录要由你自己（或外部脚本）保持有效。
- `/botconfig unset credentialsSourceDir` 恢复用共享登录。

---

## scratch 一次性沙盒

给你自己用的「可随时丢弃」的执行环境。

### 它是怎么工作的

- **读：零配置**。看到的是完整的真实文件系统，编译器、全局 npm / pip 包、`~/.gitconfig`、项目配置都照常可用。
- **写：全部落进副本**。改 `/etc`、装全局包、改家目录或项目文件，都写到一层独立的副本（Copy-on-Write，写时复制）里，会话结束就丢弃。
- **Linux**：基于 overlayfs，宿主磁盘**零写入**。daemon 是 root 时用内核 overlayfs，不是 root 时自动改用 `fuse-overlayfs`。单独挂载的数据盘（如 `/data00`）：root 下各自套一层副本；非 root 下在沙盒里只读，**工作目录要放在根文件系统上**，否则会话拒绝启动。
- **macOS**：用 APFS 克隆复制家目录和项目（只占改动的空间），系统路径只读。但 `~/Library/{Caches,Application Support,Logs}` 和 `/private/tmp`、`/private/var/folders` 等系统临时目录**仍写真实磁盘**，不在「即焚」范围内。

### 存储方式和参数

```jsonc
{
  "sandbox": "scratch",
  // tmpfs（默认，放内存）或 disk（放磁盘）
  "scratchStorage": "tmpfs",
  // tmpfs 容量上限，单位 MB；0 = 内核默认，约一半内存
  "scratchTmpfsSizeMb": 4096,
  // 额外遮住的路径（botmux 自己的凭证已默认遮住）
  "scratchDenyPaths": ["~/.ssh"]
}
```

| 存储 | 特点 | 要求 |
|---|---|---|
| `tmpfs`「内存即焚」（默认） | 放内存，会话关闭或机器重启就清空 | Linux 上 **daemon 必须以 root 运行**；非 root 请用 `disk` |
| `disk`「磁盘」 | 放磁盘，daemon 重启后能续跑；会话正常关闭时自动清理 | 无 |

macOS 上固定用 APFS 克隆，没有内存 / 磁盘之分。

---

## 网络沙盒

文件沙盒**默认不限制网络**，沙盒里的网络和代理与宿主一样。要限制，加下面任一项。

### 完全断网（`sandboxNetwork: false`）

```jsonc
"sandboxNetwork": false
```

CLI 在一个没有外部网络的命名空间里运行。适合纯本地、离线的任务。

### 按目标 IP 放行（`sandboxNetworkPolicy`）

只想让沙盒访问特定的内网接口或代理时用。**只支持 Linux + pty 后端 + 白名单隔离。**

```json
{
  "sandbox": "oncall",
  "backendType": "pty",
  "sandboxNetworkPolicy": {
    "version": 1,
    "public": { "mode": "allow" },
    "private": {
      "mode": "allowlist",
      "rules": [{ "cidr": "10.20.0.0/16", "protocol": "tcp", "ports": [443] }]
    },
    "dnsServers": ["1.1.1.1"]
  }
}
```

- 公网（`public`）和内网（`private`）分开设，每区可选 `allow`（全放行）、`block`（全阻断）、`allowlist`（只放行规则里的）、`denylist`（只阻断规则里的）。
- 规则只认 IP / CIDR，可以限定 TCP / UDP 端口；不支持域名。
- 过滤在内核里做（nftables + slirp4netns），看的是真实数据包的目标 IP。
- 在 Dashboard 里：「Bot 配置」→「目标 IP 网络策略」，编辑后点「保存策略」，不用了点「清除网络策略」。

**启用前确认两件事**，否则会话「能启动但上不了网」或「直接起不来」：

1. **必须填 `dnsServers`**。配了策略后，沙盒不再用宿主的 DNS，不填就解析不了任何域名（`getaddrinfo EAI_AGAIN`），全放行也一样。填宿主 `/etc/resolv.conf` 里的地址即可；如果那里是 `127.0.0.53`（systemd-resolved），沙盒访问不到，要填 `/run/systemd/resolve/resolv.conf` 里的上游地址。这些地址只放行 53 端口。Dashboard 的默认模板会自动带上宿主当前的 DNS。
2. **有代理变量时要加 `proxyMode`**。daemon 或 Bot 的 `env` 里有 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（含小写）时，代理会替 CLI 转发，内核规则只看得到代理地址，所以非全放行的策略会拒绝启动。确认代理出口可信后加 `"proxyMode": "trusted-egress"`（只放行到代理自身 IP），或者去掉代理变量。

其它限制：

- 宿主 `PATH` 上要有 `slirp4netns`（支持 `--disable-host-loopback`、`--disable-dns`）、`nft`、`ip`、`unshare`（支持 `--kill-child`、`--mount-proc`），bwrap 要支持 `--add-seccomp-fd` 和 `--disable-userns`。不会自动安装，缺任何一项会话都拒绝启动。
- Bot 没单独设后端时用 daemon 默认后端（tmux），要在 Dashboard「会话后端」里改成 pty。
- 配了策略后，切换沙盒模式或后端会被拒绝，要先「清除网络策略」。
- 策略在话题创建时就定下来。清除或修改后，已有话题（包括 daemon 重启后恢复的）仍按旧策略，要新开话题才生效。

---

## 沙盒里能做什么、不能做什么

### `botmux send` 照常可用，凭证不进沙盒

沙盒里的 CLI 调 `botmux send` 发文字、卡片、图片或附件时，不会拿到飞书凭证。请求先写进会话私有的中转目录，由沙盒外的 daemon 代为发送，**飞书 App Secret 全程不进沙盒**。

发到本话题以外的地方（`--top-level` 发群顶层、`--chat-id` 跨群、`--into` 发到某条消息的话题）也可以，但目标由 daemon 重新核实：

- 本会话所在的群总是允许；
- 其它群必须是这个 Bot 在里面的普通群（不是单聊、不是外部群），并且本轮发消息的人（没有真人时是会话 owner）也在那个群里、有和 Bot 对话的权限；
- 查不到这些信息时一律拒绝。

### 宿主管理命令要回宿主执行

沙盒看不到宿主上的 supervisor / daemon 进程。在沙盒里跑 `botmux status / logs / start / stop / restart / start-bot / stop-bot` 时，会提示「当前在 botmux 沙盒内」，请到宿主终端执行。**fleet 多半正常运行，不要因此重启。**

### 通用限制（两种沙盒都适用）

- **不能 adopt**：沙盒只能包住从头启动的 CLI，`/adopt` 会被拒绝，请新开会话。
- **Codex RPC 输入不启用**：沙盒下 Codex 走普通终端输入（不用 `codexRpcInput`）。
- **动态单卡不启用**：沙盒会话固定用默认卡片模式，见[卡片](/cards)。
- **Skill 是启动时的快照**：会话启动时把已启用的受管 skill 复制一份给它，之后更新 skill 要 `/restart` 或新开会话。链接安装（`local-link`）和 CLI 原生 skill 目录里的 skill 在白名单隔离下不可用，`botmux skill show` 会提示改用复制安装。
- **沙盒里装的东西不落到宿主**：让 CLI 装全局 skill、全局包或改全局配置，白名单隔离下要么写不进去、要么写到 Bot 专属目录；scratch 下写进一次性副本。要全局生效的安装请在宿主上做（Dashboard 或宿主 shell）。
- **子代理也在沙盒里**：CLI 派生的子代理和子进程继承同一套文件和网络限制。
- **零注入（`promptInjection: "none"`）**：白名单隔离完全支持；scratch 下 Cursor 和 Antigravity 不支持（转写写在一次性副本里采集不到），其它 CLI 正常。

### 支持哪些会话后端

| 后端 | 开沙盒后 |
|---|---|
| pty、tmux | 正常支持 |
| zellij、herdr、zmx 等其它本地持久后端 | 建不出同样的文件边界，**拒绝启动**，请换成 pty 或 tmux |
| Riff、remote-runner 等远端后端 | CLI 在远端执行，本地沙盒**不生效**（会话照常启动，隔离由远端负责）；但同时配了 `sandboxNetworkPolicy` 会拒绝启动 |
| mojo | 确认整个在远端执行时同远端后端；在本机执行时同本地后端，开沙盒拒绝启动 |

---

## 容器 / 受限主机上的前置条件 {#linux-namespace}

Linux 沙盒依赖内核命名空间（namespace），Docker 等容器和加固过的主机经常默认挡住。按档位核对：

| 需要的能力 | 白名单隔离 | scratch | 网络策略 |
|---|---|---|---|
| bwrap + 非特权 user namespace + mount / PID namespace | ✅ | ✅ | ✅ |
| root：内核 overlayfs；非 root：`fuse-overlayfs` + `/dev/fuse` | | ✅ | |
| root（用 `scratchStorage: "tmpfs"` 时；非 root 用 `"disk"`） | | ✅ | |
| bwrap 支持 `--add-seccomp-fd`、`--disable-userns`，及上节的网络工具 | | | ✅ |

补充说明：

- **用哪个 bwrap**：优先用系统包的 `/usr/bin/bwrap`、`/bin/bwrap`，都没有才用 `PATH` 上的并在日志里警告一次。Codex 会在 `~/.local/bin/bwrap` 放一份自带版本，它排在前面时沙盒会话会一启动就退出；用系统包管理器装 `bubblewrap` 即可。
- **软链的系统目录**：`/opt` 这类目录本身是软链时，沙盒会在里面重建同样的软链，并把真实路径只读挂进去。
- **不会去掉 PID 隔离降级运行**：同机其它 Bot 的进程环境里有明文凭据，没有 PID 隔离时沙盒能通过 `/proc` 读到。所以普通部署挂不上 procfs 就拒绝启动（仅核心专用部署 `BOTMUX_CORE_ONLY=1` 允许）。

botmux **不会**在沙盒起不来时裸跑 CLI，而是拒绝启动会话。常见报错：

| 报错 | 意思 |
|---|---|
| `sandbox requested but could not be established (bwrap missing or setup failed)` | 白名单隔离起不来 |
| `scratch 沙箱没能建立：<原因>。<修法>` | scratch 起不来，话题里直接给出原因和修法（缺依赖、非 root 用了内存存储、`/dev/fuse` 不可用、存储设置与会话不一致等）。只有机器重启导致内存存储丢失这一种要新开会话 |
| `[scratch-sandbox] tmpfs upper slot mount failed (non-root host? use scratchStorage "disk")` | 非 root 主机用了内存存储 |
| `[scratch-sandbox] missing deps (...)` | 缺 bubblewrap 或 fuse-overlayfs，且没法自动安装（只有 root 或免密 sudo 时才会尝试） |
| `bubblewrap cannot establish the required user/mount/PID namespaces` | 主机探测失败，常见于容器 |
| `[device-credential-isolation] ... credential-only bubblewrap could not be established` | 接入了托管平台、持有设备凭据的机器，不管开没开沙盒都会用 bwrap 遮住凭据；这条说明 bwrap 在这台机器上用不了 |

### 排查步骤

1. 直接试 bwrap：

   ```bash
   bwrap --unshare-user --unshare-pid --bind / / --proc /proc true && echo ok
   ```

   失败说明命名空间被挡了，先解决这一步，botmux 这边不用改。
2. 看非特权 user namespace 是否被关：
   - `cat /proc/sys/user/max_user_namespaces`，为 `0` 表示禁用；
   - 部分发行版还有 `/proc/sys/kernel/unprivileged_userns_clone`，为 `0` 表示禁用；
   - 较新的 Ubuntu 可能用 AppArmor（`kernel.apparmor_restrict_unprivileged_userns`）限制。
3. 在容器里：默认 seccomp 配置可能拦截 `clone` / `unshare`，AppArmor / SELinux 可能拦截 `mount`。按容器运行时放宽，例如 `--security-opt seccomp=...`。
4. scratch 非 root：确认 `ls -l /dev/fuse` 存在、`fuse-overlayfs` 已安装；容器要把设备传进去（如 `--device /dev/fuse`）。scratch 以 root 运行时，容器还需要挂载能力（如 `--cap-add SYS_ADMIN`）。
5. 网络策略：`bwrap --help` 里要有 `--add-seccomp-fd` 和 `--disable-userns`，太旧就升级 bubblewrap。

放宽容器隔离会削弱容器本身的安全边界，请按你的环境权衡。

---

## 容易混淆的三件事

- **Oncall 目录 ≠ 沙盒**：`/oncall bind <目录>` 只是把 Bot 在本群锚定到一个工作目录、让群成员能直接对话，**不限制** CLI 能读写哪些文件。要限制，另开白名单隔离。
- **CLI 免审批 ≠ 关闭沙盒**：botmux 默认给 CLI 加的免审批参数（`--dangerously-*`、`--yolo` 等，可用 `disableCliBypass` 关掉）只关掉 CLI **自带**的审批 / 沙盒；botmux 的文件沙盒在 CLI 外层，照样生效。
- **`/grant` 只给对话权**：它让成员能和 Bot 对话，不给 `/cd`、`/restart` 等操作权，也不改变沙盒和凭证。详见[权限与授权](/permissions)。

---

## 多人共用一个 Bot 时，隔离是叠出来的

没有哪一层能全包，按需要叠加：

| 层 | 隔离了什么 | 没隔离什么 | 在哪配 |
|---|---|---|---|
| 会话 | 每个话题一个独立 CLI 进程、独立上下文和会话记录 | 文件：各会话看到同一份宿主文件，指向同一目录时能看到彼此的改动；账号：共用 Bot 的模型账号与凭证 | 自动（每个新话题一个会话） |
| worktree | 每个话题在独立的 git worktree / 分支上改代码，互不覆盖 | 文件访问范围不变，仍能读写 worktree 外的宿主文件 | `/tw`、`/repo wt <仓库> [分支]`，见[斜杠命令](/slash-commands) |
| 文件沙盒：关闭 | 无 | 全部 | `sandbox` 不写 / `false` |
| 文件沙盒：白名单隔离 | 白名单以外的读写；凭证、其它仓库、其它 Bot 的数据；Claude 家族与 Codex 的数据目录按 Bot 分开 | 白名单内（含工作目录）的写入直接落宿主，`workingDir` 为缺省 `~` 时整个家目录都在白名单里；其它 CLI 仍用宿主全局数据目录；网络默认不限；同一 Bot 的会话共用模型账号和 CLI 数据目录 | `sandbox: "oncall"` + `sandboxPaths` |
| 文件沙盒：scratch | 写入（落在一次性副本里）；botmux 自身凭证 | 读：宿主大部分文件可读，包括他人的 token；macOS 上缓存 / 偏好和系统临时目录仍写真实磁盘；网络默认不限 | `sandbox: "scratch"` + `scratchStorage` |
| 按人工具凭据 | lark-cli 等受管工具按**本轮发消息的人**自己的授权执行，未授权就拒绝，不借用 owner 或别人的登录 | 模型账号、文件访问和其它未受管工具仍是机器 / Bot 身份 | `triggerUserAuth`；飞书侧个人授权用 `/login`，其它受管工具未授权时会收到授权链接 |
| 模型账号 | 不同 Bot 用不同模型账号（Claude：`credentialsSourceDir`，需开沙盒；Codex：`codexAuthSync: "isolated"`） | 按 Bot 分、不按人分：同一个 Bot 的使用者共用一个模型账号 | `bots.json` 对应字段 |
| 系统用户 | 系统级文件权限、进程、家目录完全分开 | botmux 不提供这一层：一个 daemon 下所有 Bot 和会话都是同一个系统用户 | 每个系统用户各自部署一套 botmux（各自的 `~/.botmux`） |
