# 文件与网络沙盒（Sandbox）

Botmux 提供多层次的运行隔离机制，保护你的宿主开发机免受意外写污染与敏感数据泄露。

文件沙盒是**一个开关三档**，每个 Bot 单独配置，同时支持 **Linux** 与 **macOS**：

| 模式（配置值） | 核心目标 | 可读范围 | 写入行为 | 典型场景 | 支持平台 |
|---|---|---|---|---|---|
| 关闭（`off`，缺省） | 不隔离 | 全部宿主文件 | 直达宿主真实文件 | 完全信任的个人本地环境 | 全平台 |
| 白名单隔离（`oncall`，原「oncall 分享」；`sandbox: true` 即此档） | **保密防泄露** | 只有白名单路径可见，其余不存在（另有少量运行必需的只读挂载，见下） | 只有白名单里的可写路径能写，写入直达宿主 | 把 Bot 开放给群成员、外部协作者 | Linux + macOS |
| 一次性草稿（`scratch`） | **防写污染（完全可弃）** | 宿主真实文件系统原生可读（botmux 凭证除外） | Linux：全根 Copy-on-Write（COW），**宿主零写入**；macOS：克隆树 COW、系统路径只读，但 `~/Library/Caches` 等缓存 / 偏好目录和系统临时目录仍写真实磁盘 | 自己做高风险实验、编译构建、防误操作 | Linux + macOS |

`bots.json` 里不写 `sandbox`（或写 `false`）就是关闭；写 `true` 等价于 `"oncall"`。旧字段 `readIsolation: true` 现在也按白名单隔离处理，daemon 启动时会自动迁移。

> 💡 **如何选择？**
> - **要把机器人分享给半信任的人（比如飞书群里所有人）** → 用**白名单隔离**。私钥、Token、凭证与其它代码库默认不可见，防探针与信息泄露。
> - **你自己用，但要执行复杂构建、跑未验证脚本或重构** → 用 **`scratch`**。无需配置白名单，所有工具和依赖原生可用；改坏随时丢弃，宿主磁盘毫发无损。scratch 能读到宿主上的大部分文件，**不适合**开放给不信任的人。

---

## 1. 白名单隔离（配置值 `oncall`）

将 CLI 限制在一个**按会话编译的文件白名单**中，读和写都走白名单，常与 [Oncall 模式](/oncall) 配合使用。群成员无论如何诱导模型，都只能访问项目所需的文件，**碰不到你的磁盘私钥、其它代码库或飞书应用凭证**。

### 工作原理

- **全新文件系统根**：沙盒根是一个空的 `tmpfs`，`/proc`、`/dev` 重新挂载，`/tmp`、`/run`、`/var/tmp`、`/dev/shm` 都是会话私有的 `tmpfs`。Linux 上私有 `/run` 里另有少量运行必需的只读挂载：命令中转目录 `/run/sbxbin`、启用 MCP 插件网关时的 socket 目录、`/etc/resolv.conf` 软链到 `/run` 下时宿主的 resolver 文件（策略 deny 时不挂），以及位于 `/run` 下的 CLI / 解释器可执行目录（如 fnm、nvm 的 multishell 目录）。**不将 `$HOME` 整体挂入**。
- **deny-by-default 白名单**：只有策略显式声明的路径才会挂进沙盒，读写档位逐条区分（可写 bind / 只读 bind / 空遮罩）：
  - 项目工作目录（`workingDir`）可写，CLI 运行必需的工具与动态库只读；
  - 默认硬阻断 `~/.ssh`、`~/.aws` 以及共享的 `~/.lark-cli`；
  - `~/.botmux`（以及自定义的 botmux 数据目录）始终按白名单处理：即使 `workingDir` 是 `~`（缺省值）或更上层的目录，沙盒里也只能访问本会话需要的那部分（本 Bot 自己的 `bots/<appId>/`、`botmux` 命令和插件目录、本会话的记录文件），`bots.json`、Dashboard 密钥、其它 Bot 的目录都不可读写。工作目录不能设在 botmux 数据目录里面（本 Bot 自己的 `bots/<appId>/` 除外），否则会话拒绝启动；
  - botmux 安装目录只读挂入，用来运行 `botmux` 命令。安装目录是 git 仓库时，其中没被 git 跟踪的文件（如 `.env`、Bot 配置、登录态、`data/`）和 `.git` 会被遮住，构建产物 `dist/`、`node_modules/` 照常可读；工作目录本身就在安装目录里时，工作目录下面的部分不遮；`sandboxPaths` 里授予安装目录或其上层目录不会解除遮罩。
  - `workingDir` 缺省是 `~`，此时家目录里其它未遮罩的内容都可写，建议把工作目录指到具体项目目录（如 `~/proj`）。
- **CLI 数据目录按 Bot 重定向（Claude 家族与 Codex）**：Claude Code（含同源的 Seed）和 Codex 的配置、会话记录、记忆写到该 Bot 的专属目录 `<BOTMUX_HOME>/bots/<appId>/`（`.../claude`、`.../codex`），不读写你全局的 `~/.claude`、`~/.codex`，这也是旧字段 `readIsolation` 的实际含义。其它 CLI（Cursor、Gemini、Grok、Kimi 等）不做重定向，仍用宿主上的全局数据目录，按各自适配器声明的路径挂进沙盒（有的整目录可写，有的只挂凭证文件）。
- **网络默认不隔离**：白名单只管文件。不配 `sandboxNetwork: false` 或 `sandboxNetworkPolicy` 时，沙盒内网络与宿主一致，见[网络沙盒](#4-网络沙盒network-sandbox)。
- **底层实现**：
  - **Linux**：基于 bubblewrap（bwrap）用户命名空间 + 细粒度只读/读写挂载；
  - **macOS**：基于 Seatbelt（`sandbox-exec`）统一编译落地白名单规则。

### 自定义路径（`sandboxPaths`）

在 `bots.json` 中可针对特定 Bot 增加白名单或遮罩：

```jsonc
{
  "sandbox": "oncall", // 或 true
  "sandboxPaths": {
    // 额外可写挂载的已存在路径
    "readWrite": ["~/shared-output"],
    // 额外只读挂载的已存在路径（共享源码快照、只读文档等）
    "readOnly": ["/srv/shared-libs", "~/docs/runbooks"],
    // 额外在沙盒内遮罩的敏感路径（空源挂载）
    "deny": ["~/.kube", "/opt/confidential"]
  }
}
```

尚不存在的 `readWrite` / `readOnly` 路径会在启动时被过滤掉；要放行一个还没创建的文件，请放行它已存在的父目录。旧字段 `sandboxHidePaths`、`sandboxReadonlyPaths` 仍可读，daemon 启动时会自动迁移到 `sandboxPaths.deny` / `sandboxPaths.readOnly`。

### 多账号与凭证隔离

- **Codex 独立登录态（`codexAuthSync`）**：
  设置为 `"isolated"` 时，Bot 会将 `CODEX_HOME` 指向独立的 `<BOTMUX_HOME>/bots/<appId>/codex`，从不读取或污染全局 `~/.codex`。这一项在关闭沙盒和白名单隔离下生效；不能与 `scratch`、`wrapperCli` 同时配置（这两种组合会拒绝启动会话）。会话绑定了非旧式 Codex 实例（`cliInstanceBinding`）时，`bots.json` 里的这一项不参与，以实例自身的认证方式为准，会话照常启动。
- **Claude per-bot 账号（`credentialsSourceDir`）**：
  配置凭证来源目录后，沙盒 Bot 每次冷启动都从该目录为自己注入 OAuth 凭证，多个沙盒 Bot 互不串号。对未开沙盒的 Bot 无效；不能与 `codexAuthSync: "isolated"` 同时配置。
- **lark-cli 按 Bot 配置**：沙盒 deny 了共享的 `~/.lark-cli`，沙盒里要用 lark-cli，机器需先做按 Bot 拆分配置，见 [lark-cli 按 bot 隔离配置](https://github.com/deepcoldy/botmux/blob/master/docs/lark-cli-per-bot.md)。

---

## 2. Scratch 模式（一次性草稿沙盒）

**2026-09 引入**。为开发者自己提供的一个完全独立、可随时丢弃的轻量执行沙盒。

### 核心特性

1. **原生读、零额外配置**：机器人看到的是**完整的真实文件系统**。所有编译器、全局 npm/pip 包、`~/.gitconfig` 等照常读取，CLI 开箱即用。
2. **全根 COW（Copy-on-Write）**：
   - 容器内无论修改 `/etc`、安装全局软件包、修改 `$HOME` 还是改动项目文件，所有写操作都会被重定向到专用的 upper 隔离层；
   - Linux 上**真实宿主磁盘零修改**，彻底消除环境污染和误删误改风险；macOS 上 `~/Library/{Caches,Application Support,Logs}` 与 `/private/tmp`、`/private/var/folders` 等系统临时目录仍写真实磁盘，不在「即焚」保证内。
3. **实现机制**：
   - **Linux**：基于 overlayfs（`lowerdir=/`）。root 采用内核 overlayfs，非 root 自动采用 `fuse-overlayfs`；子挂载点（如独立挂载的数据盘）递归创建专属 overlay 视图。
   - **macOS**：基于 APFS clonefile 软链农场 + Seatbelt。核心 CLI 配置与项目目录通过 APFS COW 秒级克隆；大体积依赖与系统目录以符号链接 + write-seal 保护，保证即焚且秒级启动。

### 存储模式与参数配置

```jsonc
{
  "sandbox": "scratch",
  // 存储模式：tmpfs（默认，内存即焚）或 disk（磁盘持久，跨重启可冷恢复）
  "scratchStorage": "tmpfs",
  // tmpfs 最大容量限制（MB，0 = 内核默认约半内存）
  "scratchTmpfsSizeMb": 4096,
  // 额外遮罩路径（botmux 凭证已默认强制遮罩）
  "scratchDenyPaths": ["~/.ssh"]
}
```

- **`scratchStorage: "tmpfs"`**：数据完全驻留内存，关盒或系统重启后瞬间清空，极致干净。Linux 上要挂 tmpfs，**需要 daemon 以 root 运行**；非 root 主机请用 `disk`。
- **`scratchStorage: "disk"`**：upper 层落在磁盘缓存中，daemon 重启后仍能通过冷恢复重新挂载续跑；会话正常关闭时自动清扫释放空间。

---

## 3. 配置方式

### 方式一：Dashboard 一键切换

在 Dashboard「**Bot 配置**」→ 选中 Bot →「**文件沙盒**」，提供三选一分段控件：
- **关闭**
- **白名单隔离**（配置值是 `oncall`；更名前的界面显示为「oncall 分享」）
- **Scratch 一次性**（可进一步选内存即焚或磁盘持久）

> 💡 **按会话固化**：修改沙盒配置对**新创建的会话**生效，存量运行中的会话保持原配置运行，重启 daemon 不会强制变更已有会话的沙盒形态。

### 方式二：`bots.json`

在 `~/.botmux/bots.json` 中配置：

```json
[
  {
    "name": "worker-bot",
    "cliId": "claude-code",
    "sandbox": "scratch",
    "scratchStorage": "tmpfs"
  },
  {
    "name": "public-oncall",
    "cliId": "codex",
    "sandbox": "oncall",
    "sandboxPaths": { "deny": ["~/.kube"] }
  }
]
```

环境变量覆盖（适合测试或全局守护，对本机所有 Bot 生效）：`BOTMUX_SANDBOX=1`（白名单隔离）或 `BOTMUX_SANDBOX=scratch`。

优先级：`BOTMUX_SANDBOX` 取 `1` / `oncall` / `scratch` 时强制所有 Bot 用该模式；未设、空、`0`、`false` 表示不强制，各 Bot 按自己的 `sandbox` 配置（旧配置 `readIsolation: true` 按白名单隔离），**不会关掉 Bot 自己开的沙盒**；其它取值报错拒绝启动。这个环境变量只能强制开，不能全局关。

---

## 4. 网络沙盒（Network Sandbox）

文件沙盒默认**不限制网络**：沙盒内 CLI 的网络与代理访问和宿主一致。需要限制时，额外配置以下任一项。

### 基础完全阻断（`sandboxNetwork`）

```jsonc
"sandboxNetwork": false
```

为沙盒添加 `--unshare-net`，CLI 将在没有外部网络接口的命名空间中运行。适合纯本地离线任务。

### 分区目标 IP 过滤（`sandboxNetworkPolicy`）

为支持访问特定内网 API 或可信代理，可配置高级目标 IP 策略（仅白名单隔离 + Linux + PTY 后端）：

```json
{
  "sandbox": true,
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

- **公网（public）与内网（private）分区控制**：每区支持 `allow`（全部放行）、`block`（全部阻断）、`allowlist`（白名单）、`denylist`（黑名单）。
- **内核级 IP 过滤**：基于网络命名空间内的 nftables + slirp4netns，直接过滤实际数据包目标 IP，不依赖脆弱的环境变量。
- **可信代理出口（`proxyMode: "trusted-egress"`）**：仅允许向已授权的代理地址发送流量。
- **主机依赖**：`PATH` 上需要 `slirp4netns`（支持 `--disable-host-loopback`、`--disable-dns`）、`nft`、`ip`、`unshare`（支持 `--kill-child`、`--mount-proc`），且 bwrap 需支持 `--add-seccomp-fd` 与 `--disable-userns`。不会自动安装，缺任何一项会话都拒绝启动。

启用前确认两个前提，否则会话「能启动但上不了网」或「直接起不来」：

1. **DNS 必须显式填 `dnsServers`。** 配了策略后，沙盒里的 `/etc/resolv.conf` 只包含 `dnsServers` 里的地址，slirp4netns 自带的 DNS 转发也关闭；不填就没有任何 DNS，所有域名解析失败（`getaddrinfo EAI_AGAIN`），**全放行的策略也一样**。填宿主 `/etc/resolv.conf` 里的 nameserver 即可（宿主用 systemd-resolved 时那里是 `127.0.0.53`，沙盒访问不到，要填 `/run/systemd/resolve/resolv.conf` 里的上游地址）；这些地址即使在 `private` 段被阻断，也只放行它们的 53 端口。Dashboard 未配置时的默认模板会自动带上宿主当前的 nameserver。
2. **宿主或 Bot 环境有代理变量时要设 `proxyMode`。** daemon 或 Bot 的 `env` 里有 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（含小写）时，非全放行的策略默认拒绝启动会话：代理会替 CLI 解析并转发目标，内核规则看到的只是代理地址。确认代理出口本身可信后加 `"proxyMode": "trusted-egress"`，内核规则仍只放行到代理自身的 IP；或者去掉这些代理变量。

其它限制：

- 只支持 Linux、**pty 后端**、oncall 沙盒。Bot 没单独设后端时，新会话用 daemon 的默认后端（tmux），需要在 Dashboard「会话后端」里显式改成 pty。配了策略后切换沙盒模式或后端会被拒绝，要先「清除网络策略」。
- 策略在话题创建时随会话冻结。清除或修改后，已有话题（包括 daemon 重启后恢复的话题）仍按创建时的策略启动，需要新开话题才生效。

---

## 5. 安全设计与关键边界

1. **`botmux send` 零凭证安全中转（Outbox 机制）**：
   沙盒内的 CLI 调用 `botmux send` 发送卡片、文字或附件时，不会直接读取飞书凭据，而是将载荷写入每会话专用的 `outbox` 目录；宿主 daemon 监听该目录并在**沙盒外部**代为完成鉴权和投递。**飞书 App Secret 全程不注入沙盒环境**。
2. **零注入模式兼容性**：
   - 白名单隔离与零注入（`promptInjection: "none"`）完全兼容，Cursor 和 Antigravity 的转写目录以目录级 bind 穿透直挂；
   - `scratch` 模式因结构化转写桥与全根 merged 视图的限制，暂不支持 Cursor 与 Antigravity 的零注入转写（其余 CLI 均正常支持）。
3. **后端支持边界**：
   - 支持 PTY、tmux 两种本地后端；
   - zellij、herdr、zmx 等其它本地持久后端无法建立同样的文件边界，开沙盒会**拒绝启动**会话；
   - Riff、remote-runner 等远端后端在远端机器上执行，本地沙盒开关**不生效**（会话照常启动，隔离由远端环境自己负责）；但这类后端如果同时配了 `sandboxNetworkPolicy`，会拒绝启动。
   - mojo 视配置而定：能确认整个在远端执行时同上，本地沙盒不生效；会在本机执行时按本地后端处理，开沙盒拒绝启动。

---

## 6. 开启沙盒后的通用限制

以下限制对白名单隔离和 scratch 都适用：

- **不能 adopt**：沙盒只能包住一个从头启动的 CLI，套不到已经在跑的进程上，沙盒 Bot 的 `/adopt` 会被拒绝，请改用新会话。
- **Codex RPC 输入不启用**：任何沙盒下，Codex 都走普通终端输入，不走 RPC 输入通道（`codexRpcInput`）。
- **动态单卡不启用**：沙盒会话沿用默认卡片模式，即使 Bot 配置了动态单卡也不会创建动态答复卡，详见[卡片](/cards)。
- **Skill 是启动时的快照**：会话启动时，botmux 把已启用的受管 skill（skill 商店、插件里的）复制一份给该会话。之后更新 skill，正在运行的会话看不到，需要 `/restart` 或新开会话。链接安装（`local-link`）和 CLI 原生 skill 目录里的 skill 不会复制，在白名单隔离下不可用，`botmux skill show` 会提示改用复制安装。
- **沙盒里装的东西不落到宿主**：在会话里让 CLI 安装全局 skill、全局包或改全局配置，白名单隔离下这些目录不可写或写到 Bot 专属目录，scratch 下写进一次性的 upper 层。需要全局生效的安装请在宿主上做（Dashboard 或宿主 shell）。
- **子代理同样在沙盒里**：CLI 自己派生的子代理和子进程都是同一个沙盒进程的后代，继承同一套文件与网络限制。

---

## 7. 容器 / 受限主机上的前置条件 {#linux-namespace}

Linux 沙盒依赖内核命名空间，在 Docker 等容器或加固过的主机里经常被默认策略挡住。按模式核对：

- **用哪个 bwrap**：优先用系统包的 `/usr/bin/bwrap`、`/bin/bwrap`；两者都没有时才用 PATH 上的 bwrap，并在 daemon 日志里打一次警告。Codex 会在 `~/.local/bin/bwrap` 放一份自带定制版，它排在 PATH 前面时会让沙盒会话一启动就退出，警告里会点名；用系统包管理器装 `bubblewrap` 即可。
- **软链的系统目录**：`/opt` 等基线目录本身是软链时，沙盒会在内部重建同样的软链，并把真实路径只读挂进去。
- **不会靠去掉 PID namespace 降级运行**：普通部署即使新 PID namespace 里挂不上 procfs 也拒绝启动（仅核心专用部署 `BOTMUX_CORE_ONLY=1` 允许去掉 `--unshare-pid`）——同机其它 bot worker 的环境变量里有明文凭据，去掉 PID 隔离后沙盒内可经 /proc 读到。

| 需要的能力 | 白名单隔离 | scratch | 网络策略 |
|---|---|---|---|
| bwrap + 非特权 user namespace + mount / PID namespace | ✅ | ✅ | ✅ |
| root：内核 overlayfs；非 root：`fuse-overlayfs` + `/dev/fuse` | | ✅ | |
| root（`scratchStorage: "tmpfs"` 时；非 root 用 `"disk"`） | | ✅ | |
| bwrap 支持 `--add-seccomp-fd`、`--disable-userns`，及上节的网络工具 | | | ✅ |

botmux **不会**在沙盒起不来时裸跑 CLI，而是拒绝启动会话。日志里常见的报错：

- `sandbox requested but could not be established (bwrap missing or setup failed)`：白名单隔离起不来。
- `scratch sandbox requested but could not be established (overlay/bwrap setup failed, or the tmpfs upper was lost in a reboot)`：scratch 起不来；如果是重启后 tmpfs 层丢了，只能新开会话。
- `scratch sandbox (macOS) could not be established (clonefile/Seatbelt setup failed ...)`：macOS scratch 起不来，检查同卷与剩余空间。
- `[scratch-sandbox] tmpfs upper slot mount failed (non-root host? use scratchStorage "disk")`：非 root 主机用了 tmpfs 存储。
- `[scratch-sandbox] missing deps (...)`：缺 bubblewrap 或 fuse-overlayfs，且无法自动安装（只在 root 或免密 sudo 时尝试）。
- `bubblewrap cannot establish the required user/mount/PID namespaces`：主机探测失败，常见于容器。
- `[device-credential-isolation] ... credential-only bubblewrap could not be established`：已接入托管平台、持有设备凭据的机器，无论 Bot 是否开沙盒都会用 bwrap 遮罩凭据；这条说明 bwrap 在这台机器上不可用。

### 排查步骤

1. 直接试 bwrap：

   ```bash
   bwrap --unshare-user --unshare-pid --bind / / --proc /proc true && echo ok
   ```

   失败就说明命名空间被挡，先解决这一步，botmux 侧不用动。
2. 检查非特权 user namespace 是否被关：
   - `cat /proc/sys/user/max_user_namespaces`，为 `0` 表示禁用；
   - 部分发行版还有 `/proc/sys/kernel/unprivileged_userns_clone`，为 `0` 表示禁用；
   - 较新的 Ubuntu 可能由 AppArmor（`kernel.apparmor_restrict_unprivileged_userns`）限制非特权 user namespace。
3. 在容器里时，容器的 seccomp 默认配置可能拦截 `clone` / `unshare` 创建 user namespace，AppArmor / SELinux 也可能拦截 `mount`。按你的容器运行时放宽：例如为容器指定允许这些系统调用的 seccomp 配置（`--security-opt seccomp=...`），必要时放宽 AppArmor 配置。
4. scratch 非 root：确认 `ls -l /dev/fuse` 存在且 `fuse-overlayfs` 已安装；容器需要把 `/dev/fuse` 设备传进去（如 `--device /dev/fuse`）。scratch 以 root 用内核 overlayfs / tmpfs 时，容器还需要挂载能力（如 `--cap-add SYS_ADMIN`）。
5. 网络策略：`bwrap --help` 里要能找到 `--add-seccomp-fd` 和 `--disable-userns`，版本太旧请升级 bubblewrap。

放宽容器隔离会降低容器本身的安全边界，请按你的环境评估。

---

## 8. 容易混淆的三件事

- **Oncall 目录 ≠ 沙盒**：`/oncall bind <目录>` 只是把 Bot 在本群锚定到一个工作目录，并让群成员能直接对话；它**不限制** CLI 能读写哪些文件。要限制文件访问，另开白名单隔离。
- **CLI 免审批 ≠ 关闭沙盒**：botmux 默认给 CLI 追加的免审批参数（`--dangerously-*`、`--yolo` 等，可用 `disableCliBypass` 关掉）只关掉 CLI **自带**的审批 / 沙盒；botmux 的文件沙盒在 CLI 外层，照样生效。
- **`/grant` 只给对话权**：`/grant` 让成员能和 Bot 对话，不给 `/cd`、`/restart` 等操作权，也不改变 Bot 的沙盒与凭证。详见[权限与授权](/permissions)。

---

## 9. 多人共用时的隔离分层

一个 Bot 给多人用时，隔离是叠出来的，没有单独一项能全包。

| 层 | 隔离什么 | 不隔离什么 | 在哪配 |
|---|---|---|---|
| 会话 | 每个话题一个独立 CLI 进程、独立上下文与会话记录 | 文件：各会话看到的是同一份宿主文件，指向同一目录时互相能看到对方的改动；账号：共用 Bot 的模型账号与凭证 | 自动（每个新话题一个会话） |
| worktree | 每个话题在独立 git worktree / 分支上改代码，互不覆盖 | 文件访问范围不变，仍能读写 worktree 之外的宿主文件 | `/tw`、`/repo wt <仓库> [分支]`，见[斜杠命令](/slash-commands) |
| 文件沙盒：关闭 | 无 | 全部 | `sandbox` 缺省 / `false` |
| 文件沙盒：白名单隔离 | 白名单之外的文件读写；凭证、其它仓库、其它 Bot 的数据；Claude 家族与 Codex 的 CLI 数据目录按 Bot 分开 | 白名单内的文件（包括工作目录）写入直达宿主，`workingDir` 缺省为 `~` 时整个家目录都在白名单内；其它 CLI 仍用宿主全局数据目录；网络默认不隔离；同一 Bot 的会话共用 Bot 的模型账号和 CLI 数据目录（能看到同一 Bot 其它会话的记录） | `sandbox: "oncall"` + `sandboxPaths` |
| 文件沙盒：scratch | 写入（落在一次性 COW 层），botmux 凭证 | 读：宿主大部分文件可读；macOS 上缓存 / 偏好与系统临时目录仍写真实磁盘；网络默认不隔离 | `sandbox: "scratch"` + `scratchStorage` |
| 按人工具凭据 | lark-cli 等受管工具按**本轮发送者**的个人授权执行，未授权时拒绝，不借用 owner 或他人的登录 | 模型账号、文件访问和其它未受管工具仍是机器 / Bot 身份 | `triggerUserAuth`；飞书侧个人授权用 `/login`，其它受管工具未授权时会收到授权链接 |
| 模型账号 | 不同 Bot 用不同模型账号（Claude：`credentialsSourceDir`，需开沙盒；Codex：`codexAuthSync: "isolated"`） | 按 Bot 分，不按人分：同一 Bot 的所有使用者共用一个模型账号 | `bots.json` 对应字段 |
| OS 用户 | 系统级文件权限、进程、家目录完全分开 | botmux 不提供这一层：一个 daemon 下所有 Bot 和会话都以同一个系统用户运行 | 每个系统用户各自部署一套 botmux（各自的 `~/.botmux`） |
