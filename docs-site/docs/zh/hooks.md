# 生命周期 Hooks

botmux 可以在关键生命周期事件发生时调用外部命令。默认是**异步**的：命令失败、超时或不存在只会写日志，不阻塞 botmux 主流程。

另有一类**同步前置校验闸**（`mode: "sync"`）：`prompt.submit` 可决定消息是否提交给 CLI；`chat.bot_added` 可决定已开启的入群自动开工是否继续。见下文[同步前置校验闸](#同步前置校验闸)。

## 配置位置

按优先级从高到低：

1. `BOTMUX_HOOKS_JSON` 环境变量（直接传 JSON 数组）
2. `BOTMUX_HOOKS_FILE` 指定的文件路径
3. 默认 `~/.botmux/data/hooks.json`

## 快速验证：写入本地日志

仓库内置示例脚本，复制即用：

```bash
chmod +x examples/hooks/echo-to-log.sh
HOOK_CMD="$(pwd)/examples/hooks/echo-to-log.sh"
mkdir -p ~/.botmux/data
cat > ~/.botmux/data/hooks.json <<JSON
[
  {
    "event": "session.requires_attention",
    "command": "$HOOK_CMD",
    "timeoutMs": 5000
  }
]
JSON

tail -f /tmp/botmux-hook.log
```

触发任意 hook 事件后即可在日志里看到 JSON payload。`examples/hooks/` 还附带 macOS Notification Center（`osascript-notify.sh`）和 HTTP webhook（`http-webhook.sh`）示例。

## 配置字段

```json
[
  {
    "event": "session.requires_attention",
    "command": "/absolute/path/to/your-hook --flag value",
    "timeoutMs": 5000,
    "filter": { "chatId": "oc_xxx" },
    "redact": { "fullContentEvents": ["session.requires_attention"] }
  }
]
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `event` | string | 必填。订阅的事件名（见下表） |
| `command` | string | 必填。外部可执行命令；支持参数，但不经 shell 执行 |
| `timeoutMs` | number | 可选。默认 5000；超时先 `SIGTERM`，再兜底 `SIGKILL` |
| `mode` | `"sync"`｜`"async"` | 可选。默认 `async`（通知，不阻塞）。`sync`（等裁决、可拦截）**仅 gate 事件支持**（当前为 `prompt.submit`、`chat.bot_added`）；其它事件写 `sync` 会降级为 `async` 并在日志告警。**gate 事件同样支持 `async`**——同一事件上可以既挂通知又挂裁决 |
| `onError` | `"allow"`｜`"deny"` | 可选，仅 `mode:"sync"` 有意义。hook 自身失败（超时/找不到命令/崩溃）时的兜底方向，默认 `allow`（fail-open） |
| `filter.larkAppId` | string｜string[] | 可选。只匹配指定 Bot 应用；同义字段 `lark_app_id` 只作兼容输入，归一化后统一使用 camelCase |
| `filter.chatId` | string｜string[] | 可选。只匹配指定飞书群 / 话题所在 chat |
| `filter.senderOpenId` | string｜string[] | 可选。只匹配指定发送者 open_id；不适用于只有 `operatorOpenId` 的 `chat.bot_added` |
| `redact.fullContentEvents` | string[] | 可选。默认截断长文本；列入 allowlist 的事件透传全文 |

> **`outbound.send` / `outbound.reply` 不能用来拦截。** 它们的发射点在飞书 API 调用**成功之后**（需先拿到 `messageId`），那一刻消息已经在群里了；加 `mode:"sync"` 也只能事后撤回，不是拦截。这两个事件写 `sync` 会降级为 async 并告警。

## 支持事件

| 事件 | 触发时机 |
|------|----------|
| `chat.bot_added` | bot 被拉进一个群（需在飞书后台订阅 `im.chat.member.bot.added_v1`）。异步观察 payload 含 `larkAppId`、`chatId`、`operatorOpenId`；同步 gate 还会收到宿主读取的 `chatName`、`chatDescription`、`chatMode`、`chatFetchStatus`，并在入群自动开工创建会话／seed 前裁决。只想给某个 bot 配独立入群脚本时，也可以用 bots.json 的 `groupJoinCommand`（Dashboard 主动开工里可编辑） |
| `topic.new` | 收到新话题 / @mention |
| `thread.reply` | 收到已有话题回复 |
| `prompt.submit` | 消息通过内置权限校验、**即将提交给 CLI 之前**。既可当普通通知（默认 `async`），也可用 `mode:"sync"` 前置拦截 |
| `outbound.send` | botmux 发送普通消息成功 |
| `outbound.reply` | botmux 回复话题消息成功 |
| `schedule.fired` | 定时任务的前置检查与提交结束（成功、跳过或报错） |
| `session.start` | worker / adopt worker 启动成功 |
| `session.exit` | worker 退出、崩溃或会话被关闭（daemon shutdown 默认静音） |
| `session.idle` | session 进入或离开 idle，按 session + 状态 10s 去重 |
| `session.requires_attention` | TUI prompt 或 worker `user_notify` 需要用户处理 |

## Payload 字段

所有 payload 通过 stdin 写入 hook 命令，同时设置环境变量 `BOTMUX_HOOK_EVENT`。每份 payload 都包含 `event`、`emittedAt`；事件上下文可包含 `sessionId`、`chatId`、`chatType`、`larkAppId`、`scope`、`anchor`、`title`、`cliId`、`workingDir`、`hasHistory`、`spawnedAt`、`lastMessageAt`。

不同事件额外携带：

| 事件 | 额外字段 |
|------|----------|
| `chat.bot_added` | 观察通知：`larkAppId`、`chatId`、`operatorOpenId`；同步 gate 另含 `chatName`、`chatDescription`、`chatMode`、`chatFetchStatus` |
| `topic.new` | `messageId`、`senderOpenId`、`senderType`、`msgType`、`content` |
| `prompt.submit` | `messageId`、`chatId`、`chatType`、`anchor`、`senderOpenId`、`senderUnionId`、`memberUnionId`、`botSender`、`talkReason`、`content`、`attachments`（`[{type,name}]`，仅元信息） |
| `thread.reply` | `messageId`、`rootId`、`parentId`、`senderOpenId`、`senderType`、`msgType`、`content` |
| `outbound.send` | `messageId`、`msgType`、`uuid`、`content` |
| `outbound.reply` | `messageId`、`replyId`、`msgType`、`replyInThread`、`uuid`、`content` |
| `schedule.fired` | `id`、`name`、`schedule`、`status`、`error`、`rootMessageId`、`runAt` |
| `session.start` | `reason`、`pid`、`adoptedFrom` |
| `session.exit` | `reason`、`code`（worker 退出路径；`dashboard_close` 为 `null`） |
| `session.idle` | `prevState`、`newState`、`transition`、`source` |
| `session.requires_attention` | `reason`、`description`、`optionsCount`、`optionsPreview`、`multiSelect`、`message` |

`schedule.fired.status` 与任务的 `lastStatus` 使用 `ok`、`error`、`skipped`：`ok` 表示已交给执行器，不代表模型已完成或消息已送达；`error` 表示前置检查或提交报错；`skipped` 表示前置条件未通过、未调用模型。跳过不消耗重复次数，也不删除任务、前置配置或执行日志。已启用的一次性任务跳过后保持启用，等待至少 30 秒后由调度器重新检查；若提前手动运行被跳过，后续自动检查不会早于原定执行时间。周期任务仍按原周期检查。

`skipped` 是新增状态，旧任务无需迁移；只接受 `ok/error` 的自定义 Hook 需增加该分支，不能把它当作执行成功。

默认会把 `content`、`message`、`description`、`finalOutput`、`lastScreenContent` 截断到 **600 字符**，并补充 `xxxLength` / `xxxTruncated`；只有 `redact.fullContentEvents` 内的事件透传全文。

## 同步前置校验闸

`chat.bot_added` 可用 `filter.larkAppId`、`filter.chatId` 限定范围；邀请人判断应在 gate 命令内读取 `operatorOpenId`。不要用 `filter.senderOpenId` 过滤入群事件：它不会匹配邀请人，且在 `autoStartOnGroupJoinGateRequired: true` 时会使自动开工静默停止。

`<botmux_group_join>` 块、邀请人 `<sender>` 与首轮可信 caller **仅在 `autoStartOnGroupJoinGateRequired: true` 时注入**；未开启该开关时，入群首轮与历史行为逐字一致（同步 gate 的放行/拒绝仍按配置生效）。

可信 `botmux_group_join` 块只证明宿主观察到的入群生命周期、opening 上下文及 turn 归属，**不证明首轮 caller 已认证为真人**。没有平台 bot 证据时，首轮 caller 不带 `senderType`，因此不会获得要求 user caller 的自动续跑租约、用户级派发、失败恢复及 `schedule:create` 直连等特权。下游仍须在需要时独立核验身份和授权；一次 contact 查询不能替代这些 turn 级检查。事件缺少 `operatorOpenId` 时，只要 gate 放行仍可自动开工，但 opening 不含 `<sender>`、`operator_open_id`，也没有可信 caller。

独立的会话 controller 仍按用户 owner 语义登记 operator（既有 `trustedSessionController` 行为），operator 是应用时也不例外；这不是对首轮 caller 的真人认证。显式开启实验性 `crossPrincipalInterruption`（默认关闭）后，该应用后续以 bot 身份发言不会匹配用户型 owner，会进入跨主体处理。基于 owner 的展示与确认行为也保留既有 user 语义；入群 gate 不收紧这套独立机制。

普通 hook 是「通知」——跑完没人看结果。gate 事件 + `mode: "sync"` 是「裁决」：daemon 等它、读它、按它放行或拒绝。`prompt.submit` 用于消息进入 CLI 前的自定义权限校验；`chat.bot_added` 只裁决 `autoStartOnGroupJoin`，不会阻止异步观察 hook、`groupJoinCommand` 或 owner 自动入群。

对需要“非目标群零可见副作用”的入群自动化，建议同时设置 Bot 的 `autoStartOnGroupJoinGateRequired: true`，并给 gate 配 `onError: "deny"`。这样 hook 缺失、无匹配、超时或崩溃都不会退化为对全部新群开工。显式 `forcePrompt` 的人工入口不走这道入群 gate。

```json
[
  {
    "event": "prompt.submit",
    "mode": "sync",
    "command": "/root/bin/prompt-gate.sh",
    "timeoutMs": 3000,
    "onError": "allow"
  }
]
```

仓库内置可直接改的示例：`examples/hooks/prompt-gate.sh`。

### 触发时机

**闸跑在「prompt 还没送进 CLI 之前」——不是「已经输进输入框、按 Enter 之前」。**

后一种时机在 botmux 里**不存在**：写文本与按 Enter 是**同一次适配器调用中的原子动作**（`writeInput` 逐行打字、末尾那个 Enter 即提交），中间没有可插入的停顿。

```
飞书消息 → 内置权限校验 → 🚦 prompt.submit 闸 → 扣额度 → 下载附件
        → createSession/forkWorker → IPC 到 worker → writeInput（打字+Enter，原子）→ CLI
```

闸执行于 **daemon 进程**，此时 CLI 子进程尚未拿到这一轮输入（新话题下 CLI 甚至还没 fork）。被拒的消息，CLI 完全不知道它存在过。

### 也可以只当通知用（`async`）

这个事件**不强制**你写 `mode:"sync"`。不写 `mode`（或显式写 `async`）时它就是一个普通通知 hook：daemon 不等它、它的结果不影响放行，适合做审计流水、统计、告警。

```json
[
  { "event": "prompt.submit", "command": "/root/bin/audit-log.sh" },
  { "event": "prompt.submit", "mode": "sync", "command": "/root/bin/prompt-gate.sh", "timeoutMs": 3000 }
]
```

两条可以**同时存在**：上面那条只记录，下面那条真拦截。几条约定：

- **通知在裁决之前投递**，所以**即使这条消息最终被拒，通知 hook 仍会收到它**——「谁的消息被拦了」正是审计想知道的事实。
- **通知拿到的是截断后的正文**（默认 600 字符，与其它事件一致）。只有做裁决的 `sync` hook 才豁免截断——通知型 hook 不因为订阅了这个事件就拿到完整正文。
- 通知型 hook 的退出码和 stdout **一律不参与裁决**。

### 怎么表达裁决

两种写法，**stdout 的 JSON 优先于退出码**：

| 方式 | 写法 | 说明 |
|------|------|------|
| JSON（推荐） | stdout 打印 `{"decision":"deny","reason":"原因"}` | `reason` 会回给用户；`decision` 取 `allow`｜`deny` |
| 退出码 | 不打印 JSON，`exit 0` / `exit 非0` | 0 放行，非 0 拒绝；stderr 内容当作原因 |

stdout 必须是**整段 JSON 对象**才会被当作裁决。打印一行普通日志不会被误判成裁决——那种情况回退到看退出码。

### 边界与保证

- **只能收紧，不能放宽**：内置权限模型（`allowedUsers` / `grant` / oncall / 额度）先跑，全部通过后才会问这个 hook。hook 说 `allow` 不会让内置闸拒掉的人进来。
- **拒绝不扣额度**：闸排在扣费之前，被拒的消息不消耗用户的消息额度。
- **拒绝会明确告诉用户**（附 `reason`），不静默丢弃——有权限却消息凭空消失是最难排查的形态。
- **多个 sync hook 是 AND**：任一 `deny` 即拒绝，第一个 `deny` 之后的 hook 不再执行。
- **hook 坏了不等于拒绝**：超时、找不到命令、崩溃都走 `onError`，默认 `allow`——校验器挂掉不该让整个 bot 变砖头。要反过来就显式写 `onError: "deny"`。
- ⚠️ **`timeoutMs: 0` 不是「不限时」，而是「立即超时」**：闸会瞬间走 `onError`（默认 `allow`）＝**这道闸等于没装**。加载时会打一条 warn 提醒。要不限时是做不到的（闸在收信主路上），请写一个真实预算如 `3000`。
- **延迟直接加在收信路径上**：`timeoutMs` 建议设小（1-3s）。bot 级并发不会因此卡死整个 daemon，但慢闸会拖住两类东西：①**同一话题**的续聊持有顺序锁 ⟹ 该话题后续消息排队；②闸运行在该 Bot 的 admission lease 内 ⟹ **该 Bot 的 Dashboard 运维操作**（关闭/清理会话、改 Agent 配置等）在闸返回前可能超时。别指望用大超时兜住一个慢服务。没配 sync hook 时零开销，不会给每条消息加 spawn。
- **消息监听器（message listener）命中的第三方内容也会过闸**：那类内容来自告警 bot 等外部来源、同样会进 CLI，正是最该校验的。该路径本来就不扣额度，被拒时只记日志、不回消息（没有可回复的真人发送者）。
- **闸拿到的是完整正文，不受 600 字符截断影响**：截断是为通知类 hook 设计的，而闸的判断依据就是内容本身——截断会让它对超长输入结构性失明（把恶意内容垫到 600 字符之后即可绕过）。
  ⚠️ **隐私含义**：配了 sync 闸就等于把**完整消息正文**交给那个命令。异步 hook 仍按原规则截断，未受影响。
- **闸看得到附件的元信息，但看不到附件内容**：`attachments` 字段给出本轮的 `[{type,name}]`（如 `[{"type":"file","name":"prod.env"}]`），足以写「禁止上传 .env」「只许图片」这类策略；但闸跑在**附件下载之前**（下载必须排在授权之后，否则未授权者也能让 bot 去拉文件），所以**无法按文件内容判断**。
- **覆盖范围：只管「人/外部消息进 CLI」这条入口**。新话题、话题续聊、斜杠命令冷启动、会话群出生轮、消息监听器命中——都过闸。**定时任务自动跑出来的 prompt 不过闸**（那是运维自己预先授权的自动化，不是外部输入）。**v3 saved workflow 会过闸，但不传正文**——`senderOpenId` 等发送者级规则仍然生效，内容级规则对它失明。别把它当成「所有进 CLI 的文本都查过了」。
- 同一条 hook 配置**只会跑一次**：作为闸执行后，不会再作为异步通知重复触发。

### 快速验证

```bash
cat > /tmp/gate.sh <<'SH'
#!/bin/bash
cat >/tmp/gate-payload.json
echo '{"decision":"deny","reason":"闸测试：暂时不放行"}'
SH
chmod +x /tmp/gate.sh

cat > ~/.botmux/data/hooks.json <<'JSON'
[{ "event": "prompt.submit", "mode": "sync", "command": "/tmp/gate.sh", "timeoutMs": 3000 }]
JSON
```

在飞书里发一条消息：应当收到「本条消息被前置校验拦截」的回复，且 `/tmp/gate-payload.json` 里能看到本轮 payload。验证完记得清空 `hooks.json`。

## 实践：用 session.start hook 自动更新 Skills

botmux 原生集成了 agentbuddy 作为 skill 来源（`botmux skills install <agentbuddy命令>` 安装，`botmux skills update <name>` 更新）。配合 `session.start` hook，可以在每次新会话启动时自动检查并更新已安装的 skills，等效于 Relay / Claude Code settings.json 中的 SessionStart Hook。

### 更新单个 skill

```json
[
  {
    "event": "session.start",
    "command": "botmux skills update my-skill-name",
    "timeoutMs": 60000
  }
]
```

### 更新全部已安装 skills

`botmux skills update` 只接受单个 skill 名称，不支持 `*` 或正则。更新全部需要脚本循环：

```bash
#!/bin/bash
# ~/bin/botmux-update-all-skills.sh
botmux skills list | cut -f1 | while read -r name; do
  [ -n "$name" ] && botmux skills update "$name"
done
```

```json
[
  {
    "event": "session.start",
    "command": "/root/bin/botmux-update-all-skills.sh",
    "timeoutMs": 120000
  }
]
```

### 直接调用 agentbuddy CLI 更新用户全局 Skills

如果想直接运行 `npx agentbuddy update`（更新用户全局 skills，而非 botmux 管理的 skills），需要注意 botmux hook 的执行环境限制：`shell: false`（不支持重定向、管道）、环境变量被清洗（只保留 PATH/HOME/TMPDIR/SHELL/USER 等基础项）。建议写成包装脚本：

```bash
#!/bin/bash
# ~/bin/agentbuddy-update.sh
export npm_config_registry="https://your-registry.example.com"  # 如使用私有 npm 源
npx -y agentbuddy update -y 2>/dev/null
```

```json
[
  {
    "event": "session.start",
    "command": "/root/bin/agentbuddy-update.sh",
    "timeoutMs": 120000
  }
]
```

### 注意事项

- **超时**：默认 `timeoutMs` 为 5000ms，agentbuddy update 涉及网络请求通常需要更久，必须显式加大（建议 60s+）。超时后 botmux 会先 `SIGTERM` 再 `SIGKILL` 整个进程组。
- **fire-and-forget**：hook 是异步执行，不会阻塞会话启动；skill 更新完成后需新会话才生效。
- **filter 过滤**：可用 `filter` 限定只对特定 `chatId` 或 `senderOpenId` 生效，避免所有会话都跑更新。
- **推荐方式**：优先使用 `botmux skills update`（方式一），它经过 botmux 的 telemetry 清理（`clearAgentbuddyTelemetry`），更新的是 botmux 注入的 skill 版本，与 botmux skill 生命周期一致。

## 写自己的 hook

hook 命令可以是任意 executable：bash / Python / Node / Go 二进制、公司内部 CLI、HTTP 转发器都行。命令 `exit 0` 视为成功；非 0 / 超时 / 找不到命令只写 botmux 日志，不会影响收发消息、定时任务或 session 生命周期。
