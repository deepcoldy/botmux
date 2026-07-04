# zellij 后端 PoC（BACKEND_TYPE=zellij）

把 zellij 作为 tmux 之外的第三种会话后端，验证「能否对齐 botmux 全部功能与体验」。

## 路线：PTY-under-zellij（B 路线）

zellij 生产命脉对照 tmux：botmux 当前生产用 `TmuxPipeBackend`，靠 `tmux pipe-pane` 复刻**原始 ANSI 裸字节流**喂流式卡片/截图/xterm。zellij 的 `subscribe` 给的是「整屏快照」不是裸字节增量，对不上这条管线。

所以本 PoC 走 **pty-under-zellij**（旧 `TmuxBackend` 的 zellij 版）：

- node-pty 跑 `zellij … --new-session-with-layout`（新建）/ `zellij attach`（重连），node-pty 是**唯一** zellij 客户端 → `onData`/`onExit` 拿到裸渲染流，绕开 subscribe 快照模型。
- 输入：zellij 以 **locked mode + 清空 keybinds** 启动（生成的 config），`pty.write` 的每个字节（含 Ctrl-C / 方向键 / 括号粘贴）直透聚焦的 CLI pane，零键位拦截 —— 等价于 tmux 只保留一个 prefix，但这里一个保留键都没有。所以 `write/sendText/sendSpecialKeys/pasteText` 全部收敛成 `pty.write`，跟 `TmuxBackend` 一致。
- `resize()` = `pty.resize()`：客户端尺寸决定 pane 尺寸 → headless 默认 25 列的坑不存在（pty 就是尺寸）。
- `kill()` 仅 detach（杀 pty 客户端），zellij server 保活 CLI → daemon 重启用 `zellij attach` 重连。
- `destroySession()` = `zellij delete-session -f`（杀+清 resurrect 残骸），仅 `/close` 时调。

## 已实测跑通（真机 zellij 0.44.1，见 `scripts/zellij-harness.ts`）

| 链路 | 结果 |
| --- | --- |
| 新建会话、CLI 启动 | ✅ |
| 输入往返（`sendText`+`Enter` → CLI 回显） | ✅ |
| `getChildPid` + /proc cwd | ✅（拿到 CLI pid 与 cwd） |
| `kill()` detach 后会话存活 | ✅ |
| 新 backend 重连并驱动存活中的 CLI（=daemon 重启恢复） | ✅ |
| `destroySession()` 清除会话 | ✅ |

## /adopt 发现（核心诉求：「找到 zellij 里启动的 CLI」）

`list-panes --json` 不给 command/cwd/pid；突破点是 zellij **resurrection** 机制持续自省每个 pane 的前台进程命令+cwd，经 `zellij action dump-layout` 暴露。

`src/core/zellij-session-discovery.ts`：
1. `dump-layout` → 每 pane `{command, args, cwd}`（纯解析，单测覆盖真机 fixture）
2. `list-panes --json` → `terminal_<n>` pane_id（驱动目标）
3. 按文档顺序 join → 把 CLI 绑到 pane_id

**实测**：在一个用户会话里「手敲 `claude`」（非 `zellij run`），`discoverSessionClis` 正确识别出 `command="claude"`、`cwd`、`terminal_0` —— 即 list-panes 给 null 的最难场景。

## 测试

- `test/zellij-session-discovery.test.ts`：dump-layout/list-panes 解析 + order-join（真机 fixture）
- `test/zellij-backend-helpers.test.ts`：键位映射、KDL 转义、layout 生成、版本门
- 17 单测全绿；`tsc --noEmit` 全仓干净

## Codex review 已修的 3 个 blocker

1. **daemon 退出删 zellij session（破坏重启 reattach）** → `daemon.ts` 把 zellij 纳入 persistent backend：shutdown 走 `w.kill('SIGTERM')`（worker SIGTERM→`backend.kill()` 仅 detach），不再走 `killWorker`→close→`destroySession`→`delete-session`。`session-manager.ts` 的 restore 也泛化为 zellij eager-reattach + CLI mismatch guard。
2. **CLI pid marker 竞态**（zellij CLI 子进程异步起，`getChildPid()` spawn 后立刻为 null，~120ms 才有）→ worker 加非阻塞异步重试（120ms×25≈3s 预算）写 marker + 接 claude pid。**不能同步阻塞**：实测 node-pty 不缓存 listener 注册前的输出，sync 等待会丢 zellij 初屏。
3. **`kill()` 触发 onExit 误报 CLI 退出** → `ZellijBackend` 加 `intentionalExit` 标志，`kill()/destroySession()` 置位后抑制这一轮 pty-client exit 回调；真实 CLI 退出（pane 关→会话终）照常上报。对齐 `TmuxPipeBackend` 语义。harness 实测 `exited after kill: false`。

外加：`botmux setup`/help 接受 zellij；补 KDL 转义解析 fixture。

## 接线状态

- ✅ **托管模式**全链路：`BACKEND_TYPE=zellij` → selector 选 `ZellijBackend`，worker 当非 tmux/pty 路径（截图走 headless renderer、web 终端走 relay），内部持有持久 zellij 会话。
- ✅ **daemon 重启持久化**：shutdown detach + restore eager-reattach（含 mismatch guard），与 tmux 持平。
- ✅ **/adopt 全链路已接**（见下）。

## /adopt（zellij）

非侵入观测/驱动 + 全链路接进守护进程，对标 tmux pipe-pane adopt。

- **观测后端** `ZellijObserveBackend`（对标 `TmuxPipeBackend`）：轮询 `dump-screen --ansi`（变化才 emit，前缀 clear+home 让 xterm 重绘当前屏）当 onData 流；`action write/write-chars/paste --pane-id` 定向驱动；`resize` no-op；`kill/destroySession` 只停轮询不碰用户会话；liveness 轮询 list-panes，pane 消失→onExit。实测：观测/驱动往返、liveness→onExit、非侵入全过。
- **发现** `zellij-adopt-discovery.ts`：复用 session-discovery 的进程树 CLI 识别 + sessionId 解析（多路复用器无关），zellij 侧用 dump-layout 枚举 pane 的 command+cwd，**pane→pid 按 (cliId, cwd) 匹配 server 子进程树，歧义(>1)或无匹配则拒绝**（Codex 建议）。实测：claude/codex 各自 projA/projB 正确绑定 paneId+pid+cwd。
- **抽象** `ObserveBackend` 接口 + `isObserveBackend()` duck-type guard 取代散落的 `instanceof TmuxPipeBackend`（worker web seed、transient-snapshot 截图）。
- **接线**：`/adopt` 命令按 bot backend 分派 tmux/zellij 发现；select 卡片 + card-handler + `startAdoptSession` + `forkAdoptWorker` + worker adopt 分支 + `adoptedFrom` 持久化 + restore 全部加 zellij 分支。bridge watcher（claude/codex/coco/mtr transcript 回传）多路复用器无关，原样复用。
- **tradeoff**：画面 ~700ms 级快照延迟（非字节级）；对话内容走 transcript bridge 即时权威。

## 已知 caveat / /adopt 接线前待办（供 review）

- discovery 的 order-join 按文档顺序，常规单/少 pane 稳；极端多 tab/浮动/乱序布局需叠加 tab/geometry/title/terminal_command/cwd/proc 多信号校验，歧义时应拒绝 adopt（留给 /adopt 阶段）。
- dump-layout 用 regex/KDL 子集解析，已加转义 fixture；生产前可换正式 KDL parser。
- `ZellijBackend` 的 `paneId` 构造参数当前仅 managed 单 pane 用焦点语义；/adopt 需走 `zellij action --pane-id` 定向输入 + 定向观测（subscribe/dump-screen 快照路径，需适配 renderer/idle），不能靠焦点。
- 每会话一个 zellij server 进程（tmux 单 server 托管全部）→ 几十会话资源开销高于 tmux。
- `getChildPid` 取「server 唯一非 zellij 子进程」，单 pane 成立；多 pane 需 pane→pid 可靠映射。

## 手动验证

```bash
pnpm build   # 或 tsc
node_modules/.bin/tsx scripts/zellij-harness.ts   # 托管模式全生命周期
# 真实联调：某个 bot 配 backendType=zellij（或 BACKEND_TYPE=zellij），重启 daemon，话题里发消息
```
