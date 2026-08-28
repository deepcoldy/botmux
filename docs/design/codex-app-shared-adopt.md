---
title: Codex App Existing Thread Shared Adopt
type: feat
topic: codex-app-shared-adopt
status: implemented
---

# Codex App Existing Thread Shared Adopt

## 1. 背景

Codex App 可以连接远程开发机上的 App Server，并以 GUI 方式持续使用一个
thread。BotMux 原有的 `/adopt` 主要面向已有 terminal pane：它接入 pane 的
输入/输出，让 IM 成为该终端会话的远程入口。

这两种入口若各自启动一个 Codex App Server 或抢占同一 thread 的写入权，会产生
两个问题：

- 同一个 thread 不能安全地被两个独立 App Server 同时恢复；
- 用户需要在 GUI 与 IM 之间切换时，容易丢失上下文、误建空会话，或中断正在运行的
  本地 Codex App 会话。

本实现为已有 Codex App thread 增加一种 `/adopt` 语义：**共享接入
（shared adopt）**。它让 BotMux 使用官方远程客户端接入同一个 App Server 和同一个
thread，而不是创建第二个服务端或取得/伪造 writer lock。

本文只描述通用协议与边界；不包含机器地址、账号、聊天内容、会话标识或凭证。

## 2. 目标与非目标

### 目标

- GUI Codex App 与 IM/BotMux 使用同一条远程 App Server thread。
- BotMux 通过官方 Codex remote client 接入已有 thread。
- GUI 发起的新 turn 可以同步到 IM；IM 发起的 turn 可以在 GUI 上连续可见。
- 断开 BotMux 只移除 IM 入口，不关闭原 App Server thread。
- BotMux daemon 重启后可重新接入保留的远程 TUI，不杀掉已有 App Server。

### 非目标

- 不修改 Codex App、Codex CLI 或 App Server 源码。
- 不通过删除锁文件、杀掉 App Server、伪造协议或私有 API 抢占 thread。
- 不把 BotMux 变成 GUI IDE 的替代品。
- 不回放 BotMux 断开期间的全部历史到 IM。
- 不承诺两个入口可无序并发地发送用户指令；客户端应避免对同一 thread 同时提交互相
  依赖的操作。

## 3. 架构

```text
Codex App GUI
        │
        │ existing App Server / existing thread
        ▼
  Codex App Server
        ▲
        │ official remote client
        │ codex --remote <endpoint> resume <thread>
        │
BotMux worker ──────── IM / group / direct message
```

共享接入的关键不变量：

1. 仅有原有的 App Server 持有/管理该 thread。
2. BotMux 不启动另一个 App Server。
3. BotMux 不偷取或伪造 writer ownership。
4. BotMux 使用官方 remote client 作为同一服务端的另一个客户端。
5. thread 的服务端顺序化仍由 Codex App Server 决定。

## 4. `/adopt` 语义

`/adopt` 在此模式下表示：

> 将已有、可验证的 Codex App thread 共享接入到 BotMux 的 IM 入口。

它**不是**：

- 把 thread 迁移到 BotMux；
- 关闭或替换 Codex App GUI；
- 接管 tmux pane 的独占所有权；
- 启动第二个 App Server；
- 抢占另一个客户端的写锁。

BotMux 在发现到现有 App Server endpoint 与 thread 后，创建一个受控的远程客户端：

```text
codex --remote <existing-endpoint> resume <thread-id>
```

只有在 endpoint、thread 和运行状态都可验证时才允许共享接入。无法验证时，保持原有
adopt/terminal 行为或明确失败，不退化为对未知 thread 的强行恢复。

## 5. 生命周期与同步边界

### 5.1 接入

1. 用户在 IM 中选择已有 Codex App thread。
2. BotMux 建立远程客户端并订阅/读取该 thread 的实时状态。
3. 接入时之前的历史用于建立上下文，但不批量重发到 IM。
4. 接入完成后的新 turn 才开始双向转发。

### 5.2 IM → Codex App

BotMux 将 IM 输入交给 remote client；Codex App GUI 与该 thread 的其它客户端都能看到
同一上下文推进。已有的输入确认、队列和去重语义保持生效。

### 5.3 Codex App → IM

BotMux 对共享 thread 使用 split-live 边界：

- 接入前 transcript 仅 absorb，用于避免把历史刷屏；
- GUI 侧在接入后产生的 local turn 被识别并转发到 IM；
- IM 发起的 turn 保留既有 marker/去重，避免同一回复回传两次。

### 5.4 断开与重接

断开共享 adopt 会：

- 终止 BotMux 的 remote client/IM 桥接；
- 保留 Codex App Server、thread 和 GUI 会话；
- 不重放断开期间的历史。

再次 `/adopt` 同一 thread 时，新的接入时刻成为新的 split-live 边界。

## 6. 安全与恢复

### 6.1 不抢占

当 thread 已被另一个 App Server 管理时，BotMux 不通过 writer-lock 绕过方式恢复它。
共享模式仅在能连接**同一个** App Server 时启用。

### 6.2 Daemon 重启

共享 adopt 的 remote TUI 与原 App Server 是不同生命周期：

- BotMux daemon 重启不应停止已有 App Server；
- tmux 等持久后端中，已保留的 remote TUI 可被新 worker 重新 attach；
- `pty` 后端的 daemon 重启会带走 remote TUI 进程，但 BotMux 不会主动关闭
  server-side thread；后续连接会创建新的官方 remote client；
- worker 关闭时需要保留远程 TUI，避免把 GUI 仍依赖的会话误杀。

## 7. 兼容性与影响范围

| 场景 | 预期行为 |
|---|---|
| 普通 Codex CLI 会话 | 保持原有 spawn、resume 与 terminal 行为 |
| 传统 tmux adopt | 保持原有 adopt 语义 |
| 已有 Codex App Server thread | 可走 shared adopt，不启动第二个 App Server |
| 非 Codex CLI | 不进入 shared App Server 分支 |
| BotMux daemon 重启 | 重新接入保留的 remote TUI，不停止外部 App Server |

## 8. 验证矩阵

| 验证项 | 结果 |
|---|---|
| IM → 现有 Codex App thread | 通过 |
| Codex App local turn → IM | 通过 |
| 断开后重新 shared adopt | 通过，历史不回放 |
| daemon 重启后保留 remote TUI / App Server | 通过 |
| shared `/close` / 历史 close 卡片 | 只断开 BotMux，不关闭源会话；拒绝/残留不报成功 |

## 9. 后续演进

- 将 shared adopt 在 UI 中更明确地标为“共享接入已有 Codex App thread”，避免用户把它理解
  成迁移或抢占。
- 为不同 IM 平台复用相同的 shared-thread 生命周期，而不是耦合到某一聊天产品。
- 继续把外部 App Server 的可验证能力限制在公开、稳定的 Codex client 协议范围内。
