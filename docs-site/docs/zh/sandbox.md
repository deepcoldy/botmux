# 文件沙盒（Sandbox）

把 AI 编程 CLI 安全地开放给**半可信**用户的隔离机制——常配合 [Oncall 模式](/oncall) 一起用。

开了沙盒后，话题里的人让机器人改代码、跑命令，**所有写操作都被隔离**：真实文件一个字节都不会被改动；机器人却照常读取真实的项目 / 配置 / 登录态、原生干活（它根本不知道自己在沙盒里）。改完之后由 **owner 审阅 diff 卡片**，确认无误再「应用到磁盘」落回真实仓库，或直接丢弃。

适合把 oncall / 值班机器人开放给不完全信任的群成员、外部协作者：既让他们用 AI 改东西，又不怕真实仓库被误改、搞乱。

## 它做什么 / 不做什么

| | |
|---|---|
| ✅ **写隔离** | 机器人的所有写入（改 / 建 / 删文件、跑 build）都落到一个隔离层，真实文件**永不被修改** |
| ✅ **原生读** | 机器人读到的是**真实**文件系统——真实项目、真实 CLI 配置 / 代理 env，所以依赖、工具链全部照常，CLI「开箱即用」 |
| ✅ **登录态持久** | CLI 的鉴权目录是**真实绑定**的——在沙盒里登录、刷新 token 都对真实生效、不会丢登录；项目改动依旧隔离 |
| ✅ **零拷贝、省磁盘** | 基于 overlayfs，**不 clone 项目**；只有被改动的文件才占额外磁盘 |
| ✅ **审阅后落盘** | owner 审 diff + patch 文件，确认再 `git apply` 回真实仓库，或丢弃 |
| ✅ **额外只读输入** | 可用 `sandboxReadonlyPaths` 把兄弟仓库、生成文档、共享源码快照等只读暴露给机器人 |
| ❌ **不隔离读** | 默认机器人能读**本机所有文件**（含 `bots.json`、`~/.ssh`、各种凭证）。要挡敏感路径需 per-bot 显式配置（见下「隐私屏蔽」） |
| ⚠️ **默认不隔离网络** | 沙盒内默认可访问网络 / 代理；设 `sandboxNetwork: false` 可让会话进入独立网络命名空间 |

> **一句话定位**：这是「**防误改 + 改动可审**」的隔离，不是「防一切」的安全沙箱。它保证真实仓库不被沙盒里的写操作污染、且每一笔改动都要 owner 点头才落盘；它**不**阻止机器人读取本机文件或访问网络——敏感内容请用下面的屏蔽机制挡住。

## 开启方式

> **前置要求**：**Linux**（依赖 bubblewrap + overlayfs）。**root / 非 root 都支持**——root 用更快的内核 overlayfs，非 root 自动回退到 fuse-overlayfs。**依赖（bubblewrap / fuse-overlayfs）在开启沙盒时自动安装**，无需提前装；环境缺自动安装权限时会提示一条手动安装命令。Mac（sandbox-exec）在路线图上、暂未支持。

### 方式一：bots.json

给某个 bot 加配置：

```jsonc
{
  "name": "oncall-bot",
  "cliId": "claude-code",
  "sandbox": true,                          // 开启文件沙盒
  // 可选：屏蔽不想让机器人读到的敏感路径（默认空 = 全部可读）
  "sandboxHidePaths": ["~/.ssh", "~/.botmux/bots.json"],
  // 可选：额外暴露只读路径
  "sandboxReadonlyPaths": ["/srv/source-snapshots/service-a"],
  // 可选：关闭沙盒内网络出口
  "sandboxNetwork": false
}
```

详见 [bots.json 配置](/bots-json)。

### 方式二：Dashboard

进 Dashboard 的「**Bot 配置**」页，打开「**文件沙盒**」开关、保存即可。

> **按会话固化**：开 / 关沙盒只对**新话题**生效。已经在跑的老会话保持原样——重启 daemon **不会**把历史会话无脑拖进沙盒模式。

## 落盘（`/land`）

机器人在沙盒里改完后，由 **owner** 在话题里发：

```
/land
```

会收到一张「**沙盒改动落盘**」卡片：

- **改动统计**：N 个文件（+x / −y），以及落盘目标仓库路径
- **diff 预览**：项目相对路径 + 真实增删行；过长自动截断
- **完整 `.patch` 文件附件**：可 `git apply`，适合大改动离线 / 逐行审阅
- **「应用到磁盘」/「丢弃」按钮**：**仅 owner 可点**

点「**应用到磁盘**」→ 把隔离层里的改动集 `git apply` 回真实仓库；点「**丢弃**」→ 扔掉这次改动。**应用之前真实仓库不受任何影响**。

> 实测过最硬的场景：让沙盒里的机器人改了 botmux **自己的运行源码**并重新编译，线上正在跑的进程毫发无损——改动全在隔离层，`/land` 后才落回。

## 隐私屏蔽（`sandboxHidePaths`）

默认沙盒**不限制读**——机器人能看到本机所有文件。如果某些路径不想让半可信的 oncall 机器人读到（私钥、密钥配置、其它项目等），在 `bots.json` 里 per-bot 配置：

```jsonc
"sandboxHidePaths": ["~/.ssh", "~/.aws/credentials", "/etc/some-secret"]
```

被列的路径在沙盒里会被**空目录 / 空文件**遮罩。**没有默认值**——不配就是全可读（包括 `bots.json`）。按你对群成员的信任级别自行决定要挡哪些。

## 额外只读路径（`sandboxReadonlyPaths`）

当机器人需要查看额外本地上下文、但不应该修改这些内容时，配置 `sandboxReadonlyPaths`：

```jsonc
"sandboxReadonlyPaths": ["/srv/source-snapshots/service-a", "~/docs/runbooks"]
```

每个已存在路径会以只读方式挂到沙盒里的同一路径（`~` 会展开为家目录）；不存在的项会被忽略。适合共享源码快照、参考仓库、生成文档、运行手册等不应进入 `/land` 改动集的输入。

两条护栏：`sandboxHidePaths` 遮罩永远优先——与遮罩路径重叠的只读项不会重新暴露被隐藏的内容；等于或包含家目录 / 会话工作目录的项会被忽略并告警（否则会整体顶掉写隔离 overlay），工作目录*之下*的子路径不受影响。

## 网络策略（`sandboxNetwork`）

默认沙盒保留网络访问，用于包安装、API 调用和 CLI 正常联网。配置：

```jsonc
"sandboxNetwork": false
```

会添加 `--unshare-net`，让 CLI 在无宿主网络的命名空间里运行。这个开关很硬：模型/API 访问、包管理器、git remote、代理都可能不可用，除非该 CLI 能完全依赖已经挂载好的本地输入工作。

## 分区目标 IP 网络策略（显式启用）

`sandboxNetworkPolicy` 将公网与内网分开管理。未配置时，`sandboxNetwork` 布尔值和历史会话行为保持不变；显式策略优先于该布尔值。新策略仅适用于 **Linux x64/arm64、本地 PTY、oncall 文件沙箱**。Docker 容器还必须允许创建用户/网络/PID 命名空间及命名空间内 nftables。macOS、scratch、持久终端、远程后端、adopt 和外部 App Server 均拒绝启动，不能给已有进程补装边界。

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

| 模式 | 行为 |
|---|---|
| `allow` | 放行该区域全部目标地址 |
| `block` | 阻断该区域全部目标地址 |
| `allowlist` | 仅放行任一规则匹配的目标；空列表全部阻断 |
| `denylist` | 阻断任一规则匹配的目标，其余放行；空列表全部放行 |

两个区域可独立组合。先按实际目标地址分区，再执行该区域规则；规则之间为“任一匹配”，没有最长前缀覆盖或后项反转。跨区域 CIDR（如 `0.0.0.0/0`）只在所属区域内匹配。只接受 IP 和 CIDR，主机位会规范化；IPv4 映射 IPv6 地址与对应 IPv4 共用规则。规则省略 `protocol`/`ports` 时匹配全部协议/端口；`protocol` 仅接受 `tcp`/`udp`，`ports` 为 1–65535 整数列表，必须同时指定协议。域名、URL、通配符、端口范围及其它协议选择器会报错。

“内网”采用保守的非公网分类：IPv4 的 RFC1918、回环、链路本地、CGNAT、未指定、文档/测试、保留、组播空间；IPv6 的 `2000::/3` 之外全部空间，以及 `2001::/23`、`2001:db8::/32`、`2002::/16`、`3fff::/20`。这包含 ULA、回环、链路本地、组播、IPv4 翻译/过渡地址。IPv4 的完整集合见 `src/core/sandbox-network-policy.ts` 的 `PRIVATE_V4`；此静态分类保守处理特殊用途，不实时推导路由或 DNS 后缀。

执行边界是任务实际发出的 **IP 数据包目标地址**。nftables 安装在新的网络命名空间中，随后才用通用 `slirp4netns` 接通网络；不依赖 HTTP_PROXY，也不修改宿主防火墙、Docker 或任何代理产品配置。直接 socket、改写/删除代理变量、IPv4 映射地址均受同一规则约束；DNS 结果变化、HTTP 重定向到另一个地址会重新受目标规则约束。模型 API 需要的目标 CIDR、端口和 DNS 必须获准。

该策略不解释加密流量或允许地址提供的应用功能。**不支持受限策略经上游代理再次解析目的地**：继承的 HTTP/HTTPS/ALL proxy 配置会被拒绝，环境变量不会被悄悄改写。允许的服务器或隧道端点本身是授权出口；请不要将可转发到任意目的地的服务列为可信目标。需要按代理后的业务地址、域名或 HTTP 请求控制访问时，本策略不能兑现该保证，不能将代理地址白名单等同于最终地址白名单。

命名空间自己的 `127.0.0.1`/`::1` 为本地进程通信保留，与宿主回环不同。宿主回环映射、转发器网关别名及宿主 DNS 转发始终关闭；IPv6 邻居发现只开放必要的链路控制报文。任务不能创建宿主 Unix socket，不能调用 setns/unshare 或 io_uring 绕过过滤，也没有网络管理能力；`socketpair` 等进程内部 IPC 保留。宿主 MCP Gateway/Unix IPC 无法同时兑现该边界时，启动会明确拒绝；文件 outbox 中转仍保留。

`dnsServers` 是独立、显式的 DNS 能力：这些 IP 的 TCP/UDP 53 优先于区域规则放行，最多 8 个；不能使用回环或转发器别名。缺省为空，不委托宿主 DNS。DNS 服务收到查询本身属于获准访问；最终业务连接仍按解析出的实际地址过滤。阻断所有外部通信时不要配置此能力。

需自行提供 iproute2 的 `ip`、`nft`、带 `--disable-host-loopback` 和 `--disable-dns` 的 `slirp4netns`，以及支持 `--disable-userns`/`--add-seccomp-fd` 的 bwrap。不会自动安装新网络工具。依赖缺失、命名空间/nft/转发器初始化失败均拒绝任务；转发器退出会终止该任务生命周期。无未过滤的回退路径。

Dashboard 的安全页可保存 JSON 策略；状态表示“已配置，下个新会话采用”，不代表正在运行的会话已经切换。也可在宿主 CLI 使用：

```bash
botmux sandbox-network-policy check policy.json
botmux sandbox-network-policy set <appId> policy.json
botmux sandbox-network-policy clear <appId>
```

`set`/`clear` 经目标在线 daemon 的认证配置接口原子写入；沙箱/会话内不得修改宿主策略。IM 的 `/config sandboxNetworkPolicy <JSON>` 使用同一校验/持久化入口。策略深拷贝到会话和 workflow 快照，fork/重启/恢复继续使用原策略；编辑机器人配置只影响新会话。清除后新会话回到原 `sandboxNetwork` 行为。

### 隔离 Linux 验证

先 `bun run build`，然后在专用测试目录的外层网络命名空间中准备测试地址。网关测试在外层 loopback 的 `10.0.2.3` 及主机 loopback 地址监听服务，确保删除网关拒绝规则时能观察到实际连接。下面只修改新命名空间，不修改宿主网络：

```bash
unshare -Urn sh -c '
  set -e
  ip link set lo up
  ip addr add 93.184.216.34/32 dev lo
  ip addr add 10.77.0.1/32 dev lo
  ip addr add 10.0.2.3/32 dev lo
  ip -6 addr add 2606:4700::100/128 dev lo nodad
  ip -6 addr add fd55::1/128 dev lo nodad
  BOTMUX_NETWORK_POLICY_INTEGRATION=1 bun run test test/sandbox-network-linux.test.ts
'
```

测试默认跳过；显式启用后，依赖或内核能力缺失会失败，不能把跳过当作边界验证通过。设置 `BOTMUX_NETWORK_TEST_BINARY` 为 `build:bun` 产物的绝对路径后，还会验证单文件自重执行；未设置时仅该编译态用例跳过。`Sandbox network boundary` CI 在相关 PR 中构建真实二进制并执行全部边界用例。模型请求用隔离 HTTP 测试服务，不调用真实供应商。

## 注意事项

1. **仅 Linux**：依赖 bwrap + overlayfs（非 root 自动用 fuse-overlayfs，依赖开沙盒时自动装）；Mac（sandbox-exec）暂未支持。
2. **读不隔离**：默认全可读，挡敏感凭证要主动配 `sandboxHidePaths`（见上）。
3. **网络默认开放**：只有确认机器人能接受无网络 / 无代理时，才设置 `sandboxNetwork: false`。
4. **build 产物会进改动集**：如果机器人在沙盒里跑了 `pnpm build` / 编译，产物（如 `dist/`）也会出现在 `/land` 的改动集里。落盘前**看清 diff**，别把编译产物 `apply` 覆盖真实仓库。
5. **机器人无感**：它看到的是 overlay 合并视图，以为改的就是真文件、照常工作；「隔离」对它完全透明。
6. **`botmux send` 照常**：沙盒里 `botmux send` 通过 daemon 中转正常发消息、附图、附件、自定义卡片 JSON（应用凭证不进沙盒环境）。

## 配合 Oncall 起飞

文件沙盒 + [Oncall 模式](/oncall) 是绝配：oncall 把机器人开放给一群人随时 @，沙盒保证这群人的改动**不会动到真实仓库**、且**每笔改动 owner 审阅后才落盘**。半可信、多人、随时改的 oncall 场景的标准搭配。
