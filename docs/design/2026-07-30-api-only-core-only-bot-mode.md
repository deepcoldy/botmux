# PR D · API-only (core-only / headless) bot mode — 设计方案

> ⚠️ **阅读顺序**：下面「架构现状 / 需要 gate 的耦合点」是**首版初稿**，其中「核心控制回路已完全 Feishu-free、只需 gate boot 三点」的判断**经 codex 两轮复审已被推翻**。真正落地的设计以文末 **两个「修订」段** 为准（中央 `larkTransportEnabled` 会话边界 + bot 级 `assertLarkTransport` 原语边界）。初稿保留仅作演进记录。

## 目标
让 botmux 作为 **core-only 控制 Server**：riff 在 Sandbox 里纯 HTTP API 驱动 botmux → botmux 直接控 CLI Agent，**全程无需真实飞书 Bot 凭证**。

## 架构现状（已核实）
- **一个 daemon 进程 = 一个 bot**。pm2 ecosystem 有 botmux-0..3（`BOTMUX_BOT_INDEX` 经 `loadBotConfigAtIndex` 选 config）+ botmux-dashboard。
- dashboard（:3000，内网 IP 可达）代理 `/api/trigger` + `/api/sessions/:id/trigger-result` 到 per-bot daemon（`registry.getByAppId(larkAppId)`）。riff 用 dashboard `activeToken` 鉴权。
- ~~**核心控制回路走 `asyncReturnSessionId` 时已完全 Feishu-free**，只需 gate boot 层~~ ← **首版误判，已被 codex 推翻**：final_output 之前还有 roster 探测、worker 辅助 UI、botmux ask、doc 轮询、allowedUsers 解析等多条飞书链路；且 apiOnly 只是 boot hint、trigger 仍可指向真实 chat。正确设计见文末修订段。

## 需要 gate 的耦合点（全部在 boot 层）
| # | file:line | 作用 | 处理 |
|---|-----------|------|------|
| 1 | bot-registry.ts:1874 | `larkAppSecret` 必填 throw | apiOnly 时豁免（允许缺省/占位） |
| 2 | daemon.ts:17878 `probeBotOpenId` | 调 `/bot/v3/info` 探 open_id | apiOnly 时跳过（已 `.catch` 非致命，但省掉无谓请求） |
| 3 | daemon.ts:17949 `startLarkEventDispatcher` | 建 + start WSClient 长连接 | apiOnly 时跳过（核心：不订阅飞书事件） |
| 4 | daemon.ts:17907 `checkRequiredScopes` | 校验飞书权限 scope | apiOnly 时跳过（已 `.catch` 非致命） |

运行时（per-turn）：`larkAppSecret` 作为 env 传给 worker（worker-pool.ts:2303 等），仅 worker.ts:4442 图片上传用到，**已优雅降级**（`lark credentials missing` skip）。无需额外改。

## 设计

### 1. 配置：`apiOnly?: boolean`（BotConfig）
按仓库现有 idiom（`disableCliBypass` / `codexRpcInput`）：
- `bot-registry.ts` BotConfig 接口加 `apiOnly?: boolean`（line ~914 附近）
- 解析：`apiOnly: entry.apiOnly === true`（line ~2108 附近）
- **合成身份**：apiOnly bot 的 `larkAppId` 用 `local_<slug>` 形式（非 `cli_` 前缀）。`larkAppSecret` 允许缺省——解析时若 apiOnly 且缺 secret，填空串占位（下游 env 传空、上传自然 skip）。

### 2. 校验豁免（bot-registry.ts:1874）
```
if (!entry.larkAppSecret || typeof entry.larkAppSecret !== 'string') {
  if (entry.apiOnly !== true) {
    throw new Error(`Bot config [${i}]: larkAppSecret is required and must be a string`);
  }
  // apiOnly: secret 可缺省，占位空串
}
```
`larkAppId` 仍必填（作为合成身份 + cachedLarkAppId gate + registry key）。

### 3. boot 跳过（daemon.ts，per-bot init 块 ~17860–17950）
在 probe/scope-check/startLarkEventDispatcher 外层加 `if (!cfg.apiOnly)`：
- `probeBotOpenId` + `writeBotInfoFile` 链（17878）→ apiOnly 跳过；`botOpenId` 用合成值（如 `bot_local_<slug>`）直接 set，避免下游读 undefined。
- `checkRequiredScopes`（17907）→ apiOnly 跳过。
- `startLarkEventDispatcher`（17949）→ apiOnly 跳过（**不建 WSClient**）。仍保留 `botHandlers.set` 以防其它路径读取（评估）。
- `setLarkAppId(cfg.larkAppId)`（17684）**保留**——合成 id 满足 `/api/trigger` 的 cachedLarkAppId gate。
- `writeDaemonDescriptor` **保留**——dashboard `getByAppId(合成id)` 靠它路由。

### 4. autoStartOnGroupJoin / VC / doc-comment 等飞书专属功能
apiOnly bot 天然不订阅事件 → 这些入口永不触发，无需额外禁用（评估确认无主动轮询飞书的路径）。

## 影响面（CLAUDE.md 要求）
- **跨平台**：改动纯 TS 逻辑分支，Linux（daemon 实跑）/macOS 一致。
- **跨 CLI**：apiOnly 与 cliId 正交；20+ adapter 经 worker spawn，spawn 不依赖真 `larkAppSecret` 运行时值（仅上传用、已降级）。canary 用 codex-app 验，另需在**一个非 codex** CLI 上确认 spawn 正常。
- **跨后端**：PTY / tmux 均不受影响（apiOnly 只改 boot 的飞书订阅，不碰 backend）。
- **零回归红线**：普通飞书 bot（`apiOnly` 缺省/false）boot 路径**字节级不变**——所有跳过都在 `if (!cfg.apiOnly)` 内，默认分支＝原逻辑。现网 4 bot 照跑。

## 测试
1. 单测：apiOnly bot 注册（缺 secret 不 throw）；普通 bot 缺 secret 仍 throw（护栏）。
2. 单测/集成：apiOnly daemon boot 不调 startLarkEventDispatcher（source-lock 或 mock 断言）。
3. 集成：`asyncReturnSessionId` trigger → trigger-result completed，全程无飞书调用（复用现有 http_async fixture）。
4. 回归：普通 bot boot 仍 probe + WSClient（断言默认分支不变）。
5. `pnpm build` + `pnpm test` 绿。

## 部署
rebase master → 开 PR（中文 + 影响面）→ 发 canary → 配一个 `apiOnly:true` + `cliId:codex-app` 的 bot（合成 larkAppId）→ 把 baseUrl + 合成 botId 进群、dashboard token 私密给 riff。

---

## 修订（codex 复审后）：从「boot 三点」升级为「中央 transport 能力边界」

首版只 gate 了 boot 的 3 个飞书订阅/探测点，误判「运行时零飞书」。codex 复审指出：final_output 前仍有多条飞书链路未 gate，且 apiOnly 只是 boot hint。修订按中央能力边界收口：

**核心不变量** `larkTransportEnabled(ds)`（core/types.ts）：apiOnly bot 或 HTTP virtual session（http_async_*/http_wait_*）→ 返回 false = 该会话禁止一切飞书副作用。所有 seam fail-closed 于此，新增无飞书 surface 自动被覆盖。

**运行时 gate（新增）**：
1. `sessionReply`（daemon.ts）中央投递入口 fail-closed → 覆盖所有 worker 辅助 UI（ready/screen/tui/stuck/startup+exit），不再往 http_async_* 发 sendMessage。
2. `getAvailableBots` roster 探测：no-transport 会话跳过（trigger-session.ts）。
3. `botmux ask`（/api/asks）：no-transport 会话返回 unsupported，不落 Lark dispatcher。
4. `/api/trigger` apiOnly 请求形态 fail-closed：拒真实 chatId/rootMessageId、必须带 HTTP response mode、sessionId 只能绑本 bot 的 virtual session。

**boot gate（新增）**：
5. `restoreDocSubscriptions` + 5s `pollWatchedDocComments` 文档轮询 → apiOnly 跳过（否则非 pristine dataDir 会主动打飞书）。
6. allowedUsers 联系人解析（email/union_id → 飞书 contact API）→ apiOnly 跳过。

**跨 bot 回归修复**：
7. `getAllBotClients`/strict resolver 过滤 apiOnly——否则普通飞书 bot 探 roster 会连带探 apiOnly 合成 appId/空 secret，给健康 bot 引入认证失败+延迟。

**校验类型洞修复**：apiOnly secret 规则改为「可省略；若提供必须是 string」——42/{}/[]/false 不再穿进 string 字段。

**测试**：新增 api-only-transport-boundary.test（行为：larkTransportEnabled 真值表 + apiOnly 请求形态 fail-closed）+ 扩展 api-only-mode-wiring.test（source-lock 锁 7 处 gate，负向验证删 gate 即红）。

---

## 修订 2（codex 第 3 轮复审后）：bot 级原语边界

会话级 `larkTransportEnabled` 仍不够——它只覆盖「知道自己在哪个 session」的调用方。codex 指出还有 3 类旁路：
1. **sessionReply 返回伪 messageId**：no-op 返回 `http_async_*` 被存进 streamCardId，下一条 screen_update 走 `updateMessage` 仍直调飞书 → 改为返回 `''`（空 id，falsy guard 天然跳过 patch）。
2. **agent 直接 `botmux send`**：CLI 无 capability 门 → apiOnly 配了真 secret 会真发飞书。
3. **非 session 全局路径**：v3 distillation / runtime-update / restart-report / overload DM 等直接 send/update，不经会话。

**根治**：在 `im/lark/client.ts` 所有出站原语（sendMessage / replyMessage / updateMessage / deleteMessage / addReaction / removeReaction / sendUserMessage / sendEphemeralCard）的共同底座加 `assertLarkTransport(larkAppId, op)`——apiOnly bot 抛 `LarkTransportDisabledError`。这是**bot 级硬门**：无论调用方是谁（会话内/外、CLI/daemon），apiOnly bot 的任何飞书写操作都在原语处 fail-closed。

**分层防御**：
- bot 级原语 `assertLarkTransport`（client.ts）——authoritative，覆盖全部出站写
- 会话级 `larkTransportEnabled`（worker-pool `managedAuxUiSuppressed` + `scheduleCardPatch` + trigger roster/ask）——在原语抛错前就静默 no-op，避免噪音日志 + 覆盖「普通 bot 的 virtual session」（此时 bot 非 apiOnly，原语不拦）
- CLI 级 `botmux send` 早拒（cli.ts `currentBotIsApiOnly`）——给 agent 清晰反馈，不落深层 stack

**测试**：新增 bot-level transport 原语抛错测试 + apiOnly card-patch 零飞书调用回归（真 scheduleCardPatch + FakeLarkClient 记账，负向验证过）。

---

## 最终架构（canonical，codex 7 轮复审收敛）

前面「初稿 / 修订 / 修订2」记录演进；**以本节为准**。核心契约：**apiOnly bot 或 HTTP virtual session（http_async_/http_wait_）= 零飞书网络（读+写）**。分层：

**1. bot 级唯一门 `getBotClient()`（bot-registry）** — 所有飞书调用在此解析 client（client.ts 11 出站原语 + downloadMessageResource + doc-comment driveApiCall + identity-cache）→ apiOnly 抛 `LarkTransportDisabledError`，读写全拦。

**2. 会话级 `larkTransportEnabled(ds)`（core/types）** — daemon 侧：sessionReply（返 '' 不返伪 id）、managedAuxUiSuppressed（所有 worker 辅助 UI）、scheduleCardPatch、trigger roster、/api/asks。覆盖「普通 bot 的 virtual session」（getBotClient 不抛的那格）。

**3. secret 从源头冻结** — 三条 spawn 路径的 secret 都从单一 `cfg.larkAppSecret` 冻结：
   - init IPC 字段（forkWorker/forkAdoptWorker）
   - CLI 进程 env `LARK_APP_SECRET`（forkWorker/forkAdoptWorker，独立于 IPC）
   - riff mergedEnv：合并后**再冻结**（backendConfig.env 合并在最后，防覆盖）
   - send-cred 文件（写空 secret + apiOnly 身份）
   no-transport session 的 secret 根本不进 worker/沙箱进程。

**4. CLI 中央 session-capability 硬门 `assertTurnTransportOrExit`（cli.ts）** — 所有飞书 CLI 命令（写：send/dispatch；读：history/quoted/bots list）统一 consult，键于 apiOnly bot OR 虚拟 `BOTMUX_CHAT_ID`。关闭「非 sandbox 本地 CLI 重载 bots.json 拿真 client」路径（普通 bot virtual session 的唯一防线）。

**5. boot / dashboard 解耦** — apiOnly 跳过：open_id 探测、scope 校验、WSClient 订阅、doc 订阅+轮询、allowedUsers 联系人解析、开放平台 rename/avatar handler 注册（fail-closed 到本地 rename）；VC listener 选项排除 apiOnly + validator/sync 入口早拒 + fetchGrantedScopesForBot 拒。

**6. 跨 bot 零回归** — getAllBotClients 过滤 apiOnly，普通 bot 探 roster 不连带探合成 appId。

**已证伪并纠正的初稿判断**：①「运行时零改动、只 gate boot 三点」❌——final 前有大量飞书链路。②「getBotClient 是唯一门就够」❌——doc-comment/开放平台/worker uploader/CLI reload 各有旁路。③「send 单点早拒 = 中央 capability」❌——history/quoted/bots/dispatch 各自可达飞书。④「rename/avatar 是 setup-only」❌——是 dashboard runtime 路由。⑤「apiOnly boot hint 足够」❌——secret 若下发到 worker/env/cred 可被恢复。

**7. 沙箱文件层 no-transport host-authority profile（fs-policy.ts，codex 提权复审收敛）** — HTTP trigger 默认 `workingDir=~`，policy 把整个 home 设 RW；若只 deny 几个 exact 文件，`.dashboard-secret`（daemon IPC 的 trusted-host HMAC，配合 `dashboard-daemons` 端口表可直签 sibling normal-bot daemon 路由绕过全部 gate）、`bots.json.bak/.tmp`、`feishu-session.json`、legacy send-cred 等仍 readWrite；且 policy 语义是 **deepest-prefix wins**，`mandatory deny` 会被更深的 user `sandboxPaths.readWrite` 重开。收口成**权威目录根 profile**：

   - **权威根 = 目录，不是 exact 文件黑名单**（`computeNoTransportAuthorityRoots`，纯函数 + 导出可单测）：**始终冻结 configured（`dirname(dataDir)`）+ default `~/.botmux` 双根**（custom SESSION_DATA_DIR 时 default 根仍存 HMAC/bots.json，二选一会漏），外加 `~/.lark-cli` / `~/.lark-cli-bots` / macOS lark-cli store。整根 deny 自动吸收 `.dashboard-secret/token`、`feishu-session`、bots.json 的 bak/tmp/未来 sidecar、dashboard-daemons 端口表、legacy send-cred。
   - **深层重开 fail-closed**：`workingDir` / `userPaths.readWrite/readOnly` / `extraWritePaths` / `readonlyRoots` 落在权威根内的（own BOT_HOME 除外）在进规则集**前** `dropAuthority` 过滤，被抑制项**记录并由 worker 日志**（不静默）。`workingDir` 若 **IS**（或落在）权威根内（own BOT_HOME 除外）→ 抛 `FsPolicyConfigError`（不 silent drop 后 spawn 进未授权 cwd）；`workingDir=~`（仅是权威根的祖先）保留，深层 parent deny 自然盖住。
   - **外置 BOTS_CONFIG fail-closed**：daemon 用 `getLoadedConfigPath()` **冻结实际 loaded config path** 传 worker（不让 worker 用 BOTS_CONFIG env 重猜）。落在**任何根外** → 抛 `FsPolicyConfigError('external-bots-config')`（不静默 mask `dirname`，否则 `/tmp/bots.json` 遮 `/tmp`、`/etc/bots.json` 遮 `/etc`、`project/bots.json` 遮项目根，废掉 core CLI）。**「落在根内」是必要非充分**——white-in-black + deepest-prefix-wins 下，root 内更深的可信 carve-out（own BOT_HOME RW / bin RO / attachments RW / outbox / install-root）会把落其下的 config 重新开放（连 `.bak/.tmp` sidecar 一并暴露）。故 buildFsPolicy 在**完整 rules merge 后**再用 `accessForPath` 自检：loaded config **自身和 dirname 都必须 deny**，任一 RO/RW → 抛 `FsPolicyConfigError('bots-config-in-carveout')`（dirname 检查顺带覆盖同目录 sidecar，且未来新增 carve-out 自动 fail-closed，无需枚举文件名）。worker 把该异常（及上面两类）统一转成 hard spawn-abort + 诊断，绝不 fail-open。
   - **carve-out 最小**：own BOT_HOME RW（除 send-cred deny）+ own bots-info/sessions-self/bot-openids-self RO + own turn-sends RW + CLI 运行必需（.data-dir/.dashboard-port/bin/claude-plugin/lark-scopes/install root）。**模型 CLI 的 authPaths（如 codex-app 的 `~/.codex`）始终保留 RW**——那是模型自己的登录态，不是飞书凭证；混淆会击穿核心功能（本轮 codex 抓到的回归）。redirect 到 BOT_HOME 的 CODEX_HOME 走 `resolveRedirectedAdapterAuthPaths` 单一真源：redirected 丢宿主 `~/.codex`（防泄漏，BOT_HOME 副本已 provision），cold-start 未 redirect 时保留宿主登录源。

   **测试**：fs-policy.test 60 测含 no-transport 矩阵（双根冻结 / `~/.lark-cli` 敌意 nested RW/RO 拦截 / 外置 config `/tmp` `/etc` `project` 三形态 `external-bots-config` fail-closed + kind 断言 / **config 落 carve-out（BOT_HOME/bin/attachments/outbox/install 5 形态）`bots-config-in-carveout` fail-closed，denied 子目录（`conf/`、`data/`）config + dirname + sidecar 全 deny 正向** / workingDir=权威根 抛错、workingDir=~ 保留 / `computeNoTransportAuthorityRoots` 去重 / **真 codex-app adapter redirect→own CODEX_HOME 可用 + 宿主 ~/.codex 按 redirect 语义 drop/keep**）；api-only-mode-wiring 补 worker 真实装配 source-lock（worker 传双根 + frozen loaded config + FsPolicyConfigError→spawn-abort + 日志抑制项；daemon 冻结 getLoadedConfigPath）——负向验证删 worker freeze / 禁用 carve-out 自检 即红（关闭 codex「删 freeze 仍全绿」缺口）。
