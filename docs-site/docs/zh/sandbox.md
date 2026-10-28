# 文件与网络沙盒（Sandbox）

Botmux 提供多层次的运行隔离机制，保护你的宿主开发机免受意外写污染与敏感数据泄露。

文件沙盒提供**两种正交模式（一个开关三档）**，同时支持 **Linux** 与 **macOS**：

| 模式 | 核心目标 | 可读范围 | 写入行为 | 典型场景 | 支持平台 |
|---|---|---|---|---|---|
| `off` | 关闭沙盒 | 全部宿主文件 | 直达宿主真实文件 | 完全信任的个人本地环境 | 全平台 |
| `oncall`（默认沙盒） | **保密防泄露** | `fs-policy` 严格白名单（非白名单路径不可见） | 仅限白名单路径直达；可配合 `/land` 审阅落盘 | 开放给群成员、外部协作者的 Oncall 值班 | Linux + macOS |
| `scratch`（草稿沙盒） | **防写污染（完全可弃）** | 宿主真实文件系统原生可读 | 全根 Copy-on-Write（COW），**宿主零写入** | 个人进行高风险实验、编译构建、防误操作 | Linux + macOS |

> 💡 **如何选择？**
> - **要把机器人分享给半信任的人（比如飞书群里所有人）** → 用 **`oncall`**。它默认屏蔽私钥、Token、凭证与其它代码库，防探针与信息泄露。
> - **你自己用，但要执行复杂构建、跑未验证脚本或重构** → 用 **`scratch`**。无需配置白名单，所有工具和依赖原生可用；改坏随时丢弃，宿主磁盘毫发无损。

---

## 1. Oncall 模式（保密型白名单沙盒）

将 CLI 限制在一个**按会话隔离的文件白名单**中，常与 [Oncall 模式](/oncall) 配合使用。群成员无论如何诱导模型，都只能访问项目所需的文件，**碰不到你的磁盘私钥、其它代码库或飞书应用凭证**。

### 工作原理

- **全新文件系统根**：沙盒根为全新 `tmpfs`，`/tmp`、`/run`、`/dev`、`/proc` 均为隔离挂载。**不将 `$HOME` 整体挂入**。
- **deny-by-default 白名单**：只有策略显式声明的路径才会被 bind 进沙盒：
  - 项目工作目录（`workingDir`）、CLI 运行必需的工具与动态库；
  - 默认硬阻断 `~/.ssh`、`~/.aws`、`bots.json` 以及共享的 `~/.lark-cli`。
- **底层实现**：
  - **Linux**：基于 bubblewrap（bwrap）用户命名空间 + 细粒度只读/读写挂载；
  - **macOS**：基于 Seatbelt（`sandbox-exec`）统一编译落地白名单规则。

### 隐私遮罩与额外输入

在 `bots.json` 中可针对特定 Bot 定制路径：

```jsonc
{
  "sandbox": "oncall", // 或 true（向后兼容）
  // 额外在沙盒内遮罩的敏感路径（空源挂载）
  "sandboxHidePaths": ["~/.kube", "/opt/confidential"],
  // 额外只读挂载的已存在路径（共享源码快照、只读文档等）
  "sandboxReadonlyPaths": ["/srv/shared-libs", "~/docs/runbooks"]
}
```

### 多账号与凭证隔离

- **Codex 独立登录态（`codexAuthSync`）**：
  设置为 `"isolated"` 时，Bot 会将 `CODEX_HOME` 指向独立的 `<BOTMUX_HOME>/bots/<appId>/codex`，从不读取或污染全局 `~/.codex`。
- **Claude per-bot 账号（`credentialsSourceDir`）**：
  配置凭证来源目录后，可在每次冷启动时为该 Bot 独立注入 OAuth 凭证，多个沙盒 Bot 互不串号。

### 改动审阅与落盘（`/land`）

在需要人工确认改动的场景下，修改完成后由 **owner** 在话题中发送：

```text
/land
```

会收到一张**沙盒改动落盘**卡片：
- 展示受影响的文件列表与 diff 统计；
- 提供完整的 `.patch` 补丁附件供离线审阅；
- 仅 owner 可点击**「应用到磁盘」**（执行 `git apply`）或**「丢弃」**。在确认应用前，宿主工作区保持不变。

---

## 2. Scratch 模式（一次性草稿沙盒）

**2026-09 全新引入**。为开发者自己提供的一个完全独立、可随时丢弃的轻量执行沙盒。

### 核心特性

1. **原生读、零额外配置**：机器人看到的是**完整的真实文件系统**。所有编译器、全局 npm/pip 包、`~/.gitconfig` 等照常读取，CLI 开箱即用。
2. **全根 COW（Copy-on-Write）**：
   - 容器内无论修改 `/etc`、安装全局软件包、修改 `$HOME` 还是改动项目文件，所有写操作都会被重定向到专用的 upper 隔离层；
   - **真实宿主磁盘零修改**，彻底消除环境污染和误删误改风险。
3. **实现机制**：
   - **Linux**：基于 overlayfs（`lowerdir=/`）。root 采用内核高性能 overlayfs，非 root 自动采用 `fuse-overlayfs`；子挂载点（如独立挂载的数据盘）递归创建专属 overlay 视图。
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

- **`scratchStorage: "tmpfs"`**：数据完全驻留内存，关盒或系统重启后瞬间清空，极致干净。
- **`scratchStorage: "disk"`**：upper 层落在磁盘缓存中，daemon 重启后仍能通过冷恢复重新挂载续跑；会话正常关闭时自动清扫释放空间。

---

## 3. 配置方式

### 方式一：Dashboard 一键切换

在 Dashboard「**Bot 配置**」→ 选中 Bot →「**文件沙盒**」，提供三选一分段控件：
- **关闭（Off）**
- **Oncall（白名单保密）**
- **Scratch（全盘草稿 COW）**（可进一步选内存即焚或磁盘持久）

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
    "sandboxHidePaths": ["~/.ssh"]
  }
]
```

环境变量覆盖（适合测试或全局守护）：`BOTMUX_SANDBOX=1`（启用 oncall）或 `BOTMUX_SANDBOX=scratch`。

---

## 4. 网络沙盒（Network Sandbox）

除文件隔离外，Botmux 还支持对网络访问进行限制。

### 基础完全阻断（`sandboxNetwork`）

```jsonc
"sandboxNetwork": false
```

为沙盒添加 `--unshare-net`，CLI 将在没有外部网络接口的命名空间中运行。适合纯本地离线任务。

### 分区目标 IP 过滤（`sandboxNetworkPolicy`）

为支持访问特定内网 API 或可信代理，可配置高级目标 IP 策略（Linux + PTY）：

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

---

## 5. 安全设计与关键边界

1. **`botmux send` 零凭证安全中转（Outbox 机制）**：
   沙盒内的 CLI 调用 `botmux send` 发送卡片、文字或附件时，不会直接读取飞书凭据，而是将载荷写入每会话专用的 `outbox` 目录；宿主 daemon 监听该目录并在**沙盒外部**代为完成鉴权和投递。**飞书 App Secret 全程不注入沙盒环境**。
2. **零注入模式兼容性**：
   - `oncall` 模式与零注入（`promptInjection: "none"`）完全兼容，Cursor 和 Antigravity 的转写目录以目录级 bind 穿透直挂；
   - `scratch` 模式因结构化转写桥与全根 merged 视图的限制，暂不支持 Cursor 与 Antigravity 的零注入转写（其余 CLI 均正常支持）。
3. **后端支持边界**：
   - 支持 PTY、tmux 等本地持久后端；
   - ZMX、Riff 远端 Runner 等因无法在宿主建立对称文件边界，不支持开启沙盒模式（fail-closed 拒绝启动）。
