# botmux Herdr Web Terminal 尺寸同步修复 Plan

**Goal:** 修复 botmux 管理的 Herdr/OpenCode 会话在只读 Web Terminal 中仍按 Herdr headless 默认小 pane（现场为 `54x23`）渲染、内容只占页面左上角的问题，并在给定 live URL 上通过浏览器验收。

**Root cause:** 浏览器已经由 FitAddon 计算并发送真实终端网格；`src/worker.ts:5387-5392` 也把 resize 交给 backend。但 `HerdrBackend.resize()` 在 `src/adapters/backend/herdr-backend.ts:281-284` 只更新本地 `cols/rows`，没有建立 Herdr 官方 direct attach 客户端，因此真实 agent terminal 不接收 resize。现场用 `herdr agent attach botmux` 的 `120x36 -> 150x42` PTY 验证后，OpenCode 立即由左上角小块扩展到页面全宽。

**Architecture:** 继续保留 HerdrBackend 当前 JSON API 的输入、轮询和 snapshot 路径；仅在 botmux 管理的 Herdr 会话存在 WebSocket viewer 时，创建一个共享的 `herdr agent attach <pane>` node-pty 作为 resize controller。首个完成 resize 的 viewer 成为尺寸 owner；其他 viewer 固定到 owner 的 authoritative grid，不触发 pane 抖动。owner 断开时保持原 pane 尺寸，promotion 最早仍在线 viewer；新 owner 解除固定、重新 fit 并上报后才执行一次 resize/broadcast。最后一个 viewer 断开即释放。external/adopt 会话不创建 attach，也不使用 `--takeover`，避免抢占用户自己的 Herdr 终端。

## Agent / Model 分工

- **Primary executor:** 当前 GPT-5 主 agent，负责 plan、TDD、实现、部署、浏览器验收与 PR 操作；主 agent 独占文件写入，避免共享 working tree 冲突。
- **Implementation analyst:** reasoning-heavy GPT-5 子 agent，只读审查 Herdr lifecycle、测试面和跨 backend 风险。
- **Code reviewer:** 全新上下文的 GPT-5 子 agent，按 plan 与 commit range 独立审查；所有 Critical/Important 必须修复并复验后才能推送。
- 当前协作接口不提供单独覆盖子 agent 型号的参数，因此使用平台统一的 GPT-5，并通过角色、上下文隔离和任务边界匹配工作负载。

## Acceptance Criteria

- [ ] 新增回归测试先在未实现 production API 时以预期原因失败（RED），不是测试配置或语法错误。
- [ ] 首个 managed Herdr web viewer 建立一个 direct agent attach，初始 PTY 尺寸直接等于该 viewer 首次上报的浏览器 `cols/rows`，不使用 backend 的旧缓存。
- [ ] 同一会话多个 web viewer 只共享一个 attach；仅尺寸 owner 的 resize 调用 attach PTY resize。
- [ ] 非 owner viewer 关闭不影响 attach；owner 关闭后保持原 grid 并 promotion 继任者，待其重新 fit/上报后再 resize；最后一个 viewer 关闭后 attach 被 kill 并释放 ownership。
- [ ] owner 已存在时，新 follower 必须在 seed 之前收到当前 authoritative grid，保证初始 ANSI snapshot 不按 follower viewport 二次 wrap。
- [ ] owner 尺寸变化时，所有 follower xterm 被固定到同一 authoritative grid；owner 转交时，新 owner 解除固定、重新 FitAddon 并上报当前 viewport，避免不同 viewport 对同一 ANSI frame 二次 wrap/crop。
- [ ] backend/agent 退出时 attach 必须被清理；意外 attach exit 有可观测日志，且不伪装成 CLI 退出。
- [ ] external/adopt Herdr 会话永不创建 direct attach，永不 `--takeover`。
- [ ] 改动对所有 managed Herdr CLI 生效且不做 OpenCode 特判；external/adopt Herdr、PTY、tmux、zellij 路径保持现有行为，并用至少一个非 OpenCode Herdr fixture 回归验证。
- [ ] 给定只读 URL 显示 `connected` 与只读 banner；在 `1280x720` viewport 下，OpenCode 主内容不再局限于约 `424x414` 的左上角小块，而是按浏览器网格重绘到接近全宽。
- [ ] 移动 viewport 下页面仍使用真实 device width，没有恢复 `width=1100`。
- [ ] `pnpm build`、相关 unit/e2e 测试、独立 code review 均通过后才 push/reopen PR #419。

## Implementation Steps

### 1. RED：锁定 Herdr web attach lifecycle

**Files:**
- Modify: `test/herdr-backend.test.ts`
- Modify: `test/herdr-backend.e2e.ts`

- [ ] 变更前先运行并记录 `test/herdr-backend.test.ts`、`test/herdr-backend.e2e.ts`、Web Terminal seed/listen 与 backend selector 相关测试 baseline。
- [ ] mock `node-pty`，构造可观察的 fake PTY（spawn args、resize、kill、onData、onExit）。
- [ ] 测试 managed session 第一位 viewer 的首个 resize 只 spawn 一次 `herdr --session <name> agent attach <pane>`，且初始 PTY 尺寸直接使用浏览器网格。
- [ ] 测试第二位 viewer 不重复 spawn、不能抢 owner；owner resize 转发到 fake PTY。
- [ ] 测试 owner release 后按仍在线 viewer 的最近尺寸转交；最后 release 与 backend kill 均清理 attach。
- [ ] 测试 attach 输出被订阅并 drain、意外 exit 清理状态且下次 owner resize 可重试。
- [ ] 测试 external/adopt acquire 不 spawn attach。
- [ ] real Herdr E2E 使用确定性 fixture：bash 安装 `WINCH` trap 后先输出 `READY`；测试等待 READY，再以 `80x24` direct attach，等待 `24 80`，随后 resize 到 `150x42` 并等待 `42 150`，消除 trap 安装竞态。
- [ ] 运行 `pnpm vitest run test/herdr-backend.test.ts`，确认仅因缺少 lifecycle API 而 RED。
- [ ] 由 reviewer 子 agent 审查测试 diff；只 stage 测试文件并提交 RED checkpoint：`test(herdr): 覆盖网页终端 attach 与 resize 生命周期`。

### 2. GREEN：实现共享 direct attach，并接入 WebSocket 生命周期

**Files:**
- Modify: `src/adapters/backend/herdr-backend.ts`
- Modify: `src/worker.ts`

- [ ] `HerdrBackend` 增加一个 node-pty direct attach handle、viewer→最近尺寸表与当前 owner。
- [ ] `acquireWebTerminal(viewer)`：managed session 登记 viewer；不在未知浏览器尺寸下提前 spawn；若 owner/authoritative grid 已存在，返回该 grid 供 worker 在 seed 前 pin 新 follower。
- [ ] `resizeWebTerminal(viewer, cols, rows)`：保存最近尺寸；首个 resize 确立 owner 并按该尺寸 spawn；后续仅 owner 可 resize。
- [ ] `releaseWebTerminal(viewer)`：非 owner 只删除；owner 退出时保持原尺寸并返回 promotion viewer，不使用 follower 的旧缓存 resize；归零时 kill attach。external/adopt 全部 no-op。
- [ ] attach `onData` 只 drain 不转发，防止与现有 poll/relay 双写；意外 exit 清空 handle 并允许后续 owner resize 重试。
- [ ] 扩展 botmux OSC 1989 为 Herdr owner/follower 模式：follower 接收 authoritative grid 后 `term.resize` 并禁止 FitAddon 上报；owner 接收 promotion 后解除固定、执行 `fit.fit()`、清空 resize dedup 并重新上报。
- [ ] owner resize 后 worker 把 authoritative grid 广播给该 backend 的所有 follower；新 follower 在 seed 前先收到 pin；owner 关闭时只向继任者发送 promotion，待其重新 fit 后再广播新 grid。
- [ ] `kill()` 与内部 exit path 统一清理 attach；意外退出记录带 session/pane 的日志。
- [ ] `src/worker.ts` shared relay 分支仅对 managed `HerdrBackend` acquire；WebSocket close 对捕获的同一 backend release。
- [ ] 不改变现有输入授权过滤、seed、scroll、tmux/zellij attach 分支。
- [ ] 运行同一 unit target，确认 RED 用例转 GREEN。
- [ ] 由 reviewer 子 agent 审查 implementation diff；只 stage 本任务 hunk，保留 `src/worker.ts` 现有未提交滚轮修改，提交 GREEN checkpoint：`fix(herdr): 同步网页终端尺寸到 agent pane`。

### 3. Automated verification

- [ ] `pnpm vitest run test/herdr-backend.test.ts`
- [ ] `pnpm vitest run --project e2e test/herdr-backend.e2e.ts`
- [ ] real Herdr E2E 断言 `WINCH + stty size` 的确定性尺寸变化；测试 session 使用独立 `bmx-e2e7777` 并清理。
- [ ] 运行 Web Terminal seed/listen 与 backend selector 相关回归测试。
- [ ] real Herdr bash fixture 作为非 OpenCode CLI 回归，证明 resize controller 与 CLI 类型无关。
- [ ] `pnpm build`
- [ ] `git diff --check`，确认 staged/unstaged 边界，确保滚轮修改未误入本 PR commit。
- [ ] 独立 reviewer 对 base..HEAD 做最终审查；修复全部 Critical/Important 后重新运行上述命令。

### 4. Live deploy and browser acceptance

- [ ] 执行 `pnpm switch:here && botmux restart`，确认全局 shim 与 live daemon 都来自当前 checkout。
- [ ] 在无浏览器 viewer 时，用一次短命 direct attach 把测试会话缩回已知小尺寸，建立可复现的验收前置状态。
- [ ] 浏览器打开 `http://10.92.191.86:8802/s/a9edf38b-55c1-4056-bcc5-4a307e17672b`。
- [ ] 机器判定 DOM：`#terminal`、`.xterm`、`.xterm-screen` 的 bounding box 各覆盖 viewport 宽高至少 95%；banner 为只读，状态为 connected。
- [ ] 机器判定尺寸：读取页面主 world 的 `term.cols/rows`，必须与 Herdr server 最新 `TerminalAnsi` attach/resize 的 cols/rows 完全一致。
- [ ] 机器判定截图：以非页面背景像素计算 OpenCode 内容 bounding box，宽度至少占 viewport 90%（修复前现场约 33%）；`agent read` 行宽仅作辅助证据。
- [ ] 截取桌面 viewport 验收截图；再用移动 viewport 验证页面没有固定桌面宽度缩放。
- [ ] 同时打开 desktop + mobile 两个 viewer：promotion 前两者 `term.cols/rows` 都等于 desktop owner 的 authoritative grid；关闭 desktop 后 mobile 被 promotion，其 grid 改为移动 FitAddon 结果，并与新的 Herdr server resize 完全一致。
- [ ] 关闭页面后验证 direct attach 已释放；重新打开仍能再次 acquire 并铺满。

### 5. Push and PR

- [ ] 确认 branch `fix/web-terminal-mobile-fullscreen` 只包含本任务 commits 与原 `b236545f`。
- [ ] push 到 `fork/fix/web-terminal-mobile-fullscreen`。
- [ ] 更新 PR #419 中文标题/描述：根因、direct attach lifecycle、影响面、完整测试命令与关键结果、浏览器验收证据。
- [ ] PR 影响面明确写为“所有 managed Herdr CLI；external/adopt Herdr、PTY、tmux、zellij 不受影响”。
- [ ] reopen PR #419；若 GitHub 拒绝 reopen，创建同 head/base 的新 PR。
- [ ] 不打 tag、不发布版本。

## Risks and Mitigations

- **Herdr direct attach 是单 owner：** 只在有 Web viewer 时持有；不使用 `--takeover`；最后一个 viewer 离开立即释放。
- **多 viewer 尺寸竞争：** 首个 resize viewer 持有尺寸 ownership；其他 viewer 只记录最近尺寸，owner 关闭时有序转交，避免桌面/手机互相抖动。
- **同一 ANSI frame 的 viewer 网格不一致：** Herdr 专属 owner/follower OSC 把 follower 固定到 authoritative grid；promotion 显式解除固定并重新 fit。
- **attach 意外退出：** 记录明确日志；保留 JSON API polling/input，CLI 会话不因展示 attach 失败被误杀。
- **adopt 所有权：** external/adopt 明确 no-op，继续使用现有固定尺寸 OSC 路径。
- **共享 worker 文件已有 dirty hunk：** 使用交互式/精确 staging，提交前逐项检查 cached diff。
- **现场误判：** 验收前主动恢复小 pane，再观察浏览器连接触发放大；同时使用截图、Herdr attach resize 日志和 pane 读取宽度三项证据。

## Stop Conditions

- direct attach 会抢占现有用户 attach、需要 `--takeover`、或 Herdr 版本不支持该命令：停止实现并报告，不做静默 fallback。
- baseline tests 已有失败：记录具体失败并区分，不把它们归因于本修复。
- browser 验收只能证明 CSS 全屏但 Herdr pane 仍未扩展：不得 push/reopen PR。
