# Known Issue: daemon restart 后存活 CLI 会话的 `botmux send` 失效

> 状态：**已知问题，待修复**（已有可靠绕过，不阻塞）
> 记录：claude-loopy ｜ 2026-06-08 ｜ 发现于 v3 edge-activation dogfood
> 严重度：低（窄场景 + 有绕过）｜ 影响面：运维/协作可见性

## 现象

在一个 **已存活的 CLI 会话进程内**执行 `pnpm daemon:restart` 之后，该会话里再调用
全局 `botmux send`（甚至 `botmux send --help`）会立即失败：

```
未找到 session {"sessionId":"<session-uuid>","turnId":"<turn-message-id>"}
```

- 报错里的 `sessionId` 在 `botmux list` 里**确实存在且 status=online**；
- `turnId` 是该会话**首条消息**的 turn id（进程环境 `BOTMUX_TURN_ID`，整个进程生命周期不变），
  而非当前正在处理的那条入站消息的 turn；
- 所有需要会话上下文的全局 `botmux` 子命令（send / history 等）同样被这层校验拦截。

复现于：全局 `botmux` **2.52.0**；daemon 跑本地 `feat/v3-workflow` 分支 dist。

## 复现步骤

1. 一个由 daemon 拉起的 CLI 会话正在运行（飞书话题里的 agent 会话）。
2. 在该会话内执行 `pnpm daemon:restart`（daemon 主进程被重建，已 fork 的 CLI 子进程
   **不被杀**——`botmux list` 里它们的 uptime 不归零）。
3. 该会话内执行 `botmux send "..."` → 报上面的「未找到 session」。

## 影响范围

- **仅**「restart daemon 时有存活 CLI 会话」这一窄场景。restart 之后**新建**的会话不受影响。
- 后果：存活会话在飞书侧**失去主动发消息能力**，agent 算出了结果也推不出去（用户在飞书端看不到）。

## 根因分析（分层，区分观察 / 推断 / 待核实）

**观察（已确认）**
- 全局 send 失败而本地 dist 的 `cmdSend` 成功（见下「绕过」），二者差异在于**是否依赖 daemon 运行时态**。
- `cmdSend`（`src/cli.ts`）的实现是：`loadSessions()` 直读磁盘 session → 取 `larkAppId`/`chatId`/
  `rootMessageId` → 经 lark client **直接 reply/send**，不经 daemon IPC。
- daemon 侧的会话路由 `trigger-session.ts` 用**内存** `activeSessions`（`activeBySessionId`）查活跃会话，
  查不到即返回 `session_not_found`。

**推断（合理但未逐行定位）**
- 全局 `botmux` 2.52.0 的 send 走的是「先经 daemon 校验活跃会话/turn」的路径；daemon restart 清空了
  内存里的 active session/turn 注册表，且匹配键里带 `turnId`；存活会话的 turn binding 要等该会话
  **收到下一条真实入站飞书消息**时才会被 daemon 重建——于是用进程里 cached 的旧 `turnId` 去查必然失配。

**待核实**
- 报错字符串 `未找到 session {"sessionId","turnId"}`（JSON 形态）在当前 `feat/v3-workflow` 分支
  **grep 不到**（本地只有纯字符串 `未找到 session ${sid}`）。该确切报错来自全局 **2.52.0** 的代码路径，
  需在 2.52.0 源码里定位产生它的精确位置，确认是否就是上面推断的 daemon-IPC + turnId 匹配路径。
- 确认 daemon restart 的会话恢复逻辑是否**完全不恢复 turn-level binding**，还是只是延迟到首条新入站消息。

## 当前绕过（已验证可靠）

用**本地 dist 的 send**（直读磁盘 session + 直发飞书，不经 daemon IPC）：

```bash
node dist/cli.js send --mention-back "消息"
# 或 echo "消息" | node dist/cli.js send --no-mention
```

dogfood 当场用此法恢复了飞书可见性，全程正常发送（含 `--mention-back` / heredoc 多行）。

## 建议修复方向（择一或组合）

1. **send 容错回退**：当 `(sessionId, turnId)` 在 daemon 侧匹配失败时，回退到 session 级
   `rootMessageId`（即 `cmdSend` 已有的磁盘 fallback 语义）再发，而不是直接 `process.exit`。
   ——成本最低、最对症。
2. **restart 恢复 turn binding**：daemon 重建会话时，从持久化里一并恢复每个会话的 last reply target
   （rootMessageId/turnId），而不是等下一条入站消息才重建。
3. **解除对 turnId 的强匹配**：会话路由用 `sessionId` 找当前 reply target 即可，`turnId` 仅作辅助/审计，
   不作为存在性判定键。

## 关联

- 发现于 v3 edge-activation dogfood（`docs/design/2026-06-06-v3-edge-activation-design.md`）；
  与 v3 workflow 改动**无关**，是 daemon ↔ CLI 会话基础设施在 restart 场景的边界。
