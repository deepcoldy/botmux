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

## 接线状态

- ✅ **托管模式**已全链路接进 worker：`BACKEND_TYPE=zellij` → selector 选 `ZellijBackend`，worker 当作非 tmux/pty 路径（截图走 headless renderer、web 终端走 relay），但内部持有持久 zellij 会话。
- ⏳ **/adopt 守护进程流**未接：发现模块（基础件）已就绪+实测，但把它接进 `worker-pool` 的扫描/`adopt-route`/各 CLI 的 bridge watcher 是更大的一块，留作下一步。
- ⏳ 未跑整 daemon 出真实 Lark 卡片：渲染路径与现有 pty 后端一致（已被生产验证），但端到端 Lark 卡片验证留作集成步。

## 已知 caveat（供 review）

- pty-under 模型里 `kill()` 会触发 `onExit`（杀的是 attach 客户端 pty）——与旧 `TmuxBackend` 行为一致，但与生产 `TmuxPipeBackend`（pipe 不触发）不同。仅在 worker 主动 teardown 时调，影响面待 review 确认。
- pane_id↔CLI 的 join 按文档顺序，常规单/少 pane 稳；极端多 tab/浮动布局需叠加几何/proc 交叉校验。
- 每会话一个 zellij server 进程（tmux 是单 server 托管全部）→ 几十会话时资源开销高于 tmux。
- 一个 CLI 一会话单 pane 的前提下 `getChildPid` 取「server 的唯一非 zellij 子进程」；多 pane 需细化。

## 手动验证

```bash
pnpm build   # 或 tsc
node_modules/.bin/tsx scripts/zellij-harness.ts   # 托管模式全生命周期
# 真实联调：某个 bot 配 backendType=zellij（或 BACKEND_TYPE=zellij），重启 daemon，话题里发消息
```
