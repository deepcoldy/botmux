# P1 方向 B：UserPromptSubmit hook 注入 per-turn envelope — 详细落地方案

> 状态：Phase 1 已实现（2026-08-14，仅 claude-code）。实现清单见 §12。
> 分支：`feat/794-hook-envelope-injection`（基于 upstream/master @ ade903ac）
> 关联：#794（本提案）、#795（P0 泄漏拦截，PR 仍 OPEN，A/B 指标依赖它合入）

## 0. 目标与非目标

**目标**

1. 把 per-turn envelope 中「认知噪音最大」的两块——`botmux_reminder`（命令式指令）和 `whiteboard`（长操作指南）——从 user message 文本挪到 `UserPromptSubmit` hook 注入的 `<system-reminder>`。
2. 按 CLI 能力分级：只有「hook 注入且 UI 不可见」的 CLI 走新路径，其余 20+ CLI 保持 inline envelope 完全不变。
3. webui 提供 per-bot 开关：`auto`（默认，按能力+preflight 自动）/ `off`（强制 inline 回退）。
4. 双路径并存、可按 bot 灰度、可秒级回退。

**非目标**

- 不动 P0 拦截器（#795）——与注入格式正交，继续兜底。
- 不做 codex 的可见 developer-message 注入（codex 把 additionalContext 渲染成可见消息，与目标相悖，能力位直接关闭）。
- 不动 `<user_message>` 骨架：`resumable-session-discovery.ts:104` 的主模式 `^<user_message>...</user_message>` 是 required capture，10 条发现正则里 6 条依赖它。
- 不动 `<sender>` / `<mentions>`：`insight/prompt.ts:56-91` 的 `extractBotmuxPromptSource` 靠它们做发送者/提及人归因，且它们是短元数据不是认知噪音。**只移 reminder + whiteboard**，影响面最小。
- adopt 会话不参与：adopt 走 `buildBridgeInputContent`（session-manager.ts:1244），本来就是纯文本无 envelope。

## 1. 能力分级

| 层级 | 含义 | CLI |
|---|---|---|
| `invisible-hook` | UserPromptSubmit + additionalContext，注入为不可见 system-reminder | claude-code（已实测 stdin 协议，见 §8）；seed 等 claude fork 待 spike 验证 |
| `visible-context` | 支持 hook 但渲染可见 | codex（openai/codex#16933 修复前）→ 不启用 |
| `none` | 无 hook 机制 | gemini / cursor / opencode / 其余 |

在 `CliAdapter` 接口加能力位（沿用 `supportsReadIsolation` / `supportsTypeAhead` 既有模式，types.ts:370-392）：

```ts
/** UserPromptSubmit hook 能否把 per-turn 上下文注入为不可见 system-reminder。
 *  仅对已实测「TUI 不可见 + JSONL 形态正确」的 CLI 置 true。 */
readonly supportsInvisiblePromptHook?: boolean;
```

只对 claude-code 置 true。seed 复用 `createClaudeFamilyAdapter`（seed.ts:49-68），spike 验证后单独开。

## 2. 数据流（双路径）

```
Lark 消息 → daemon buildFollowUpCliInput（session-manager.ts:1198，唯一漏斗）
  │
  ├─ effective 模式判定（§4）
  │
  ├─ hook 模式：
  │   1. buildFollowUpParts 拆出 { ptyParts, hookParts }
  │      ptyParts  = user_message + sender + mentions（现状其余块保留）
  │      hookParts = botmux_reminder + whiteboard（文案按 §7 改造）
  │   2. 写 sidecar：$SESSION_DATA_DIR/prompt-ctx/<sessionId>/<sha256>.json
  │      指纹 = sha256(normaliseForFingerprint(ptyText))
  │   3. IPC 发 worker → PTY 写 ptyText（worker 零改动）
  │   4. CLI 触发 UserPromptSubmit hook → botmux user-prompt-hook
  │      stdin.prompt 算同指纹 → 读 sidecar → stdout additionalContext
  │
  └─ inline 模式（现状）：完整 envelope 写 PTY，不写 sidecar
```

**为什么 daemon 写 sidecar 而不是 worker**：envelope 在 daemon 构建（`buildFollowUpContent`，session-manager.ts:1142），daemon 有 SESSION_DATA_DIR 和 sessionId，在 `buildFollowUpCliInput` 里写 sidecar 后再走现有 `sendWorkerInput`（worker-pool.ts:5691）——worker/IPC 协议零改动。type-ahead 时 daemon 串行处理 per-session 消息（pendingFollowUps），每条先落 sidecar 再发 IPC；且指纹匹配是内容对齐不是时序对齐，顺序无关。

**已确认的并发安全性**：claude-code `supportsTypeAhead: true`（claude-code.ts:765）但**未设** `mergeQueuedInput`（全仓仅 pi.ts 注释提及并明确不用）——每条排队消息保持独立 turn，各自指纹各自 sidecar，不会合并错配。

## 3. 组件设计（文件级）

### 3.1 sidecar 存储（新文件 `src/services/prompt-context-store.ts`）

- 路径：`$SESSION_DATA_DIR/prompt-ctx/<sessionId>/<sha256-hex>.json`，沿用 `pi-initial-prompts` 先例（pi-initial-prompt.ts:36-38：目录 0700、文件 0600）。
- 内容：
  ```json
  { "version": 1, "fingerprint": "<sha256-hex>",
    "envelope": "<reminder+whiteboard 拼好的 markdown>",
    "createdAt": 1723600000000 }
  ```
- 指纹：**不复用** `makeFingerprint`（bridge-turn-queue.ts:103，只取前 30 字符，会撞）——用 `normaliseForFingerprint`（claude-transcript.ts:474，空白折叠+trim）后全量 sha256。两端（daemon 写、hook 读）同一算法，容忍 PTY 写入的空白差异。
- 清理：写入时 best-effort prune（删 24h 前）；session 删除时随 `turn-sends/` 一起清（session-store.ts:520 同路径模式）。
- 同内容重发：指纹相同 → 覆盖写同一文件，天然幂等。

### 3.2 hook 子命令 `botmux user-prompt-hook`（cli.ts 新 case）

- dispatch：cli.ts:13165 附近（`session-ready` case 旁）。
- 实现仿 `cmdSessionReady`（cli.ts:11792-11860）：
  1. 5s 超时读尽 stdin（防管道阻塞），JSON.parse 取 `prompt`；失败/无 `prompt` → 空 stdout exit 0。
  2. `BOTMUX_SESSION_ID` 或 `SESSION_DATA_DIR` 缺失 → exit 0（非 botmux 会话/用户手输）。
  3. `sha256(normaliseForFingerprint(prompt))` → 读 sidecar；不存在 → exit 0。
  4. stdout：`{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":<envelope>}}`
  5. **任何异常 → 空 stdout + exit 0**；末尾显式 `process.exit(0)`，结构性保证永不 exit 2。
- 纯文件读，无网络无 IPC——比 `session-ready`（还要 HTTP 打 daemon）更简单更可靠。

### 3.3 安装器扩展（`src/adapters/hook-installer.ts`）

- `HookInstallConfig`（types.ts:294-304）加 `userPromptSubmitCommand?: string`。
- `hook-command.ts` 加 `userPromptHookCommand()`（仿 `sessionReadyHookCommand`，hook-command.ts:50-53：`"node" "<pkg>/dist/cli.js" user-prompt-hook`）。
- `installClaudeSettings`（hook-installer.ts:243-314）在现有 ask hook + SessionStart 之外，幂等合并 `hooks.UserPromptSubmit` group（无 matcher，timeout 10s）。
- 幂等识别新增 `isBotmuxPromptHookGroup`（仿 `isBotmuxReadyHookGroup`，hook-installer.ts:195-204：命令含 `cli.js` 且尾签名 `user-prompt-hook`）+ 对应 remove 函数。
- **两条安装路径都要覆盖**：
  - 全局 `~/.claude/settings.json`（claude-code.ts:1188 的 `hookInstall.configPath`）——aiden wrapper 剥 `--settings`（cli-selection.ts:281-290），全局是唯一可靠渠道；
  - read-isolation 的 per-bot BOT_HOME settings.json（worker.ts:11802-11807 `effectiveReadyHookInstall` 改写 + `provisionIsolatedBotHome`）——`installClaudeSettings` 是共用函数，扩展即覆盖。
- 安装时机：沿用 `ensureCliSkills`（worker-pool.ts:2056-2059，per-cliId per-daemon 一次）。**无条件安装**（与 SessionStart hook 同策略）：hook 在无 sidecar 时空输出 no-op，开关纯运行时行为，toggle-on 零等待。

### 3.4 daemon 侧分叉（`src/core/session-manager.ts`）

- 新增 `buildFollowUpParts(content, sessionId, opts)`：返回 `{ ptyText, hookEnvelope? }`。
  - inline：`ptyText = buildFollowUpContent(...)`（现状函数不动）。
  - hook：`ptyText` = 去掉 reminder/whiteboard 两块的 join 结果；`hookEnvelope` = 这两块的 join。
- `buildFollowUpCliInput`（session-manager.ts:1198-1229）调 `buildFollowUpParts`，hook 模式时写 sidecar，返回 `{content: ptyText}`（**返回类型不变，10 个调用点零改动**：daemon.ts:16345/18995/19133/19528/19618、doc-comment-prompt.ts:120,284、session-manager.ts:1398/2939、trigger-session.ts:687）。
- 10k 保护：`hookEnvelope` 序列化 > 8000 字符 → 该 turn 降级 inline（不写 sidecar）。whiteboard 是唯一可能超限的块。

### 3.5 preflight（新 `hasInstalledPromptHook`，hook-installer.ts）

- 仿 `hasInstalledSessionReadyHook`（hook-installer.ts:218-231）但**用结构化匹配**（现有 preflight 是精确字符串匹配，换 checkout 路径就 false——测试 hook-installer.test.ts:132 已记录此坑，新 preflight 别重蹈）。
- 读 effective settings.json（全局或 BOT_HOME，与安装路径一致），检查 `hooks.UserPromptSubmit` 存在 botmux group。
- 缓存：per-(sessionId) 60s TTL；bot 配置变更时失效（`applyConfigField` 写后清缓存）。

## 4. 开关设计（webui）

### 4.1 配置模型

per-bot `bots.json` 新字段（`BotConfig`，bot-registry.ts:1105）：

```jsonc
"envelopeInjection": "auto" | "off"   // 默认 auto
```

- `auto`：`adapter.supportsInvisiblePromptHook && preflight OK && envelope ≤ 8k` → hook 模式；否则 inline。
- `off`：强制 inline（回退阀；已装的 hook 保留不卸，无 sidecar 时 no-op）。
- 注册进 `CONFIG_FIELDS`（bot-config-store.ts:67），`effect: 'immediate'`——写后内存 `bot.config` 同步更新，下一个 turn 判定即生效，**已运行 session 无需重启**（模式判定在每 turn 的 `buildFollowUpCliInput` 里现读）。
- 不做全局开关、不做 `on` 强制档：auto 已是「能用就用」，全局开关会让「哪个 bot 走哪条路」不可推断。

### 4.2 UI（bot-defaults-page.tsx，per-bot 设置页）

- 加一个 select：「上下文注入方式」：自动（推荐）/ 始终内联。
- 仅 `supportsInvisiblePromptHook` 的适配器显示；其余灰态提示「该 CLI 不支持 hook 注入」。
- 帮助文案：自动模式把每轮操作提醒/白板以系统提醒注入，终端输入框只显示消息本身；不支持的 CLI 自动回退内联。
- 写路径：`PUT /api/bots/:appId/...` → `applyConfigField`（bot-config-store.ts:209），沿用现有 per-bot 字段链路。
- i18n：i18n.ts 加 zh/en 两个 key。

### 4.3 生效与回退

- 生效：`effect: 'immediate'`，下一 turn 即新路径。
- 回退：webui 拨 off → 下一 turn 回 inline，无需重启、无需卸 hook。

## 5. 受影响消费方清单（勘探结论）

| 消费方 | 影响 | 处理 |
|---|---|---|
| `resumable-session-discovery.ts:99-141` 10 条正则 | 主模式 `^<user_message>` 仍匹配（user_message 保留）；模式 #5 `^<botmux_reminder>` 不再匹配 hook 会话（无碍，#1 兜底）。**风险**：JSONL 中 system-reminder 若前置于 user 事件文本，`^` 锚定可能失效 → spike 必查（§8-Q1） | spike 验证，必要时补模式 |
| `insight/prompt.ts:6-20` `extractBotmuxUserText` | strip `<botmux_reminder>` 变 no-op（user turn 里没了） | 不改，no-op 无害 |
| `insight/prompt.ts:56-91` `extractBotmuxPromptSource` | 靠 sender/mentions 归因——**这两块保留在 user turn** | 零影响 |
| `dashboard/web/insights.ts:464-478` `cleanPromptText` | 已会整剥 `system-reminder` 块 | 零影响（前提是 JSONL 形态如预期，spike 验证） |
| `session-title.ts:47`、`submit-notification.ts:5`、`mir-prompt.ts:146` | 都只依赖 `<user_message>` | 零影响 |
| `prompt-builder.test.ts` 等 ~20 个测试 | inline 路径行为不变 | 现有测试全绿；新增 hook 路径测试 |

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| exit 2 阻塞 prompt | 子命令结构性 exit 0 + try/catch 全包 + stdin 5s 超时；spike 实测 kill/超时 |
| 只覆盖 claude 系 | 能力位 + auto 回退，其余 CLI 路径字节级不变；双路径分别测试 |
| type-ahead 错配 | 内容指纹（非时序）；claude 未开 mergeQueuedInput 已确认；spike 连发 5 条验证 |
| 10k 上限（whiteboard） | per-turn 8k 阈值降级 inline |
| JSONL 污染/发现正则失效 | 理论安全（system-reminder 挂 user turn，fallback 只读 assistant）；spike 真实会话验证形态 |
| 沙盒内 hook 读不到 SESSION_DATA_DIR | spike 必查 bwrap bind；读不到则 preflight 失败 → auto 回退 inline |
| 与用户自装 UserPromptSubmit hook 冲突 | additionalContext 是合并注入；与 superpowers 等共存测试 |
| aiden 剥 --settings | 只写全局 settings.json（与 SessionStart 同既定路径） |
| 指纹不一致（hook 看到的 prompt ≅ 写 PTY 文本） | 两端都过 `normaliseForFingerprint`（空白折叠）；spike 量真实 JSONL |
| read-isolation 会话漏装 | `installClaudeSettings` 共用，BOT_HOME 路径自动覆盖；preflight 读同路径 |

## 7. 文案改造（prompt-injection 防御）

现 reminder 是命令式（「必须 botmux send」）。out-of-band 系统指令形态可能触发 Claude 注入防御被表面化（issue 风险 4）。注入版改为**描述式**：

- 现：`你必须通过 botmux send 发送回复…`
- 改：`本会话通过 botmux 桥接飞书。会话约定：回复经 botmux send 发送到飞书话题；终端输出用户看不到。`

whiteboard 块本就是操作指南（陈述句式），基本平移。spike 对比两版文案的模型遵守度。

## 8. 已完成的实测与 spike 清单

**已实测（本机 claude-code 2.1.232）**：
- UserPromptSubmit hook 在 `-p` 模式正常触发；stdin payload 确认为 `{session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name, prompt}`，`prompt` 字段即提交文本原文。
- 本机全局 `~/.claude/settings.json` 无现存 UserPromptSubmit hook（无冲突）。

**spike 待办（Phase 1 验收项）**：
1. Q1：真实会话 JSONL 中 additionalContext 的形态（content 数组？拼接串？system-reminder 是否前置于 user 文本破坏 `^` 锚定）——需真实认证会话（本次 403 未跑完）。
2. Q2：TUI 中注入内容确实不可见。
3. Q3：沙盒（bwrap）内 hook 子进程能否读 `$SESSION_DATA_DIR/prompt-ctx/`。
4. Q4：type-ahead 连发 5 条的指纹匹配正确率。
5. Q5：seed（claude fork）hook 行为一致性。
6. Q6：文案改造后模型对 `botmux send` 约定的遵守度。
7. Q7：与 superpowers 等第三方 UserPromptSubmit hook 共存。

## 9. 分阶段计划

**Phase 1 — spike（claude-code only，开关手动改 bots.json）**
- `prompt-context-store.ts` + `user-prompt-hook` 子命令 + 安装器扩展 + preflight + `buildFollowUpParts` 分叉。
- 单测：指纹/sidecar/fail-open/安装幂等/preflight/10k 回退。
- 真实验收：Q1-Q4、Q7。

**Phase 2 — webui 开关**
- `BotConfig.envelopeInjection` + `CONFIG_FIELDS` 注册 + bot-defaults-page UI + i18n。
- 生效/回退验证。

**Phase 3 — 灰度与推广**
- 1-2 个 bot 开 auto；A/B 指标 = 每千 turn `end_turn` 形态 leak 命中数（依赖 #795 的 `looksLikeLeakedToolCall` 合入）+ 提交延迟增量 + 漏发回归。
- 数据支持 → seed/genius 逐个验证开通；不支持 → 拨 off 回退，改动面收敛在 hook/session-manager 两条路径。

## 10. 改动文件清单（预估）

| 文件 | 改动 |
|---|---|
| `src/services/prompt-context-store.ts` | 新增：sidecar 读写/prune |
| `src/cli.ts` | 新增 `user-prompt-hook` case + 实现 |
| `src/adapters/hook-command.ts` | 新增 `userPromptHookCommand()` |
| `src/adapters/hook-installer.ts` | 安装/识别/移除/preflight 四函数 |
| `src/adapters/cli/types.ts` | `HookInstallConfig.userPromptSubmitCommand` + `CliAdapter.supportsInvisiblePromptHook` |
| `src/adapters/cli/claude-code.ts` | 能力位 + hookInstall 新字段 |
| `src/core/session-manager.ts` | `buildFollowUpParts` + `buildFollowUpCliInput` 分叉 |
| `src/bot-registry.ts` | `BotConfig.envelopeInjection` |
| `src/services/bot-config-store.ts` | `CONFIG_FIELDS` 注册 |
| `src/dashboard/web/bot-defaults-page.tsx` + `i18n.ts` | UI |
| `test/` | 新增 hook 路径测试；inline 路径回归 |

## 11. 实现状态（Phase 1，2026-08-14）

**已实现（仅 claude-code，默认 off，bots.json 配 `envelopeInjection: "auto"` 开启）**

| 组件 | 文件 | 状态 |
|---|---|---|
| sidecar 存储 | `src/services/prompt-context-store.ts` | ✅ sha256(normalise) 指纹、24h/100 个 prune、0700/0600 权限 |
| hook 子命令 | `src/cli.ts` `user-prompt-hook` | ✅ 5s stdin 自限、全路径 fail-open exit 0、永不 exit 2 |
| 命令构造 | `src/adapters/hook-command.ts` `userPromptHookCommand()` | ✅ |
| 安装器 | `src/adapters/hook-installer.ts` | ✅ 安装/幂等/移除/`hasInstalledPromptHook`/60s TTL preflight；全局 + BOT_HOME 两路径自动覆盖 |
| 能力位 | `types.ts` + `claude-code.ts` | ✅ `supportsInvisiblePromptHook`（仅 `variant.id === 'claude-code'`，seed 不开） |
| daemon 分叉 | `session-manager.ts` | ✅ `buildFollowUpBlocks` 重构 + `buildFollowUpCliInput` 按模式分叉；8k 回退 |
| 配置 | `bot-registry.ts` + `bot-config-store.ts` | ✅ `envelopeInjection: auto/off`，effect: immediate |
| 沙盒 | `fs-policy.ts` + `worker.ts` | ✅ `prompt-ctx/<sid>` 目录 readOnly bind + 预创建 |
| 测试 | 3 个测试文件 | ✅ 新增 20 用例（store 8 + installer 5 + 分叉 7），全量 15197 通过（4 个失败为 base 既有的环境问题：bwrap 不可用/proc comm/超时 flaky） |
| E2E | 构建产物手测 | ✅ hook 命中/空白容错/无 sidecar/无 env/坏 JSON 五路径；安装器写入+preflight+幂等 |

**与原方案的差异**

1. 默认 `off`（方案写的 auto）：首次实现保守上线，验证后翻默认值是一行改动。
2. 能力位用 `variant.id === 'claude-code'` 门控，seed 即使共用 factory 也不开。
3. preflight 只查全局 settings.json（read-isolation 的 BOT_HOME 路径保守回退 inline）。

**Phase 2 待办**

- [x] webui 开关（bot-defaults 高级标签页，仅 claude-code 显示；`PUT /api/bots/:appId/envelope-injection` → daemon `/api/bot-envelope-injection` → applyConfigField）
- [x] 文案改造（新增 `ai.followup.reminder_hook` 描述式文案，hook 模式专用）
- [ ] 真实会话验证（Q1 JSONL 形态、Q2 TUI 不可见、Q3 沙盒可读、Q4 type-ahead、Q7 共存）
- [ ] 默认值翻 auto（灰度后）

**Phase 3 待办**

- [ ] A/B 指标（依赖 #795 合入）
- [ ] seed/genius 等 fork 验证后开能力位
