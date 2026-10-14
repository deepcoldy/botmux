# 插件斜杠指令与卡片操作者权限（设计稿，待评审）

> 状态：设计已评审通过（2026-10-14），实现中。分支 `feat/plugin-slash-commands`。
> 首个使用方：Work Ledger 插件的 `/work-bind`（群绑定工作项 + inject/sync 模式选择）。本文只描述 Botmux 通用能力，不含任何 Work Ledger 业务逻辑。

## 1. 背景与目标

今天插件能贡献 Skill / MCP / 本机 CLI / Dashboard / Service / 卡片回调，但**不能注册飞书斜杠指令**：飞书指令只来自 `src/core/command-schema.ts` 的内置表，认不出的 `/xxx` 会被当普通消息转给 CLI（`command-router.ts` ⑥ `unknown_slash`）。插件想要一个确定性的群内入口，只能靠 `customPassthroughCommands` 透传进 CLI 再指望 agent 执行，这在 codex-app 等运行时上不可靠，也需要群里已有活会话。

同时，插件处理卡片回调时只拿到飞书验签后的 `operator` 身份，**拿不到 Botmux 对该身份的权限判定**。插件若要「只有 bot 管理员能改配置」，只能自己读 `bots.json` 复刻 `allowedUsers` 解析，既接触凭证文件又会与宿主判定漂移。

目标（两项通用能力，一起交付）：

1. **插件斜杠指令**：插件静态声明指令名，daemon 确定性路由到插件服务，由宿主把插件返回的卡片/文本发回群里。
2. **宿主权限证明**：插件指令请求和插件卡片回调请求都附带宿主计算的 `canOperate` / `canTalk`，插件据此做管理操作校验。

非目标：插件指令不建会话、不进 CLI、不参与透传/级联；不提供插件改写内置指令的能力；不做插件指令的多行语法。

## 2. 插件声明

插件提供 `dist/commands/index.json`，并且必须同时声明 `botmux.service`（复用 cardActions 的服务前置条件）：

```json
{
  "schemaVersion": 1,
  "endpoint": "/botmux/commands/v1",
  "commands": [
    { "name": "/work-bind", "description": "绑定/查看本群的工作项" }
  ]
}
```

安装期 scanner 校验（失败即拒绝安装，错误码风格同 cardActions）：

- `name` 满足 `SLASH_COMMAND_SHAPE`（`/^\/[a-z0-9][a-z0-9:_-]*$/`），小写；同一文件内不重复；1–16 条。
- 不得与内置命令及别名（`command-schema.ts` 全表，含 `cliId` 专属命令）、`PASSTHROUGH_COMMANDS`、`ROUTE_SPECIAL_COMMANDS` 冲突。
- `description` 可选，≤ 120 字符，无控制字符。
- `endpoint` 规则与 `readCardActionEndpoint` 相同（相对路径、无 query/hash/反斜杠/`..`），直接复用该函数。
- registry / materialized marker 只记录 `name`、`description`、`endpoint`。

类型：`PluginContributions.commands?: PluginCommandsContribution`（`src/core/plugins/types.ts`）。

### 冲突与作用域

- 只看当前 `larkAppId` 的有效插件（global + Bot 级，`resolveEffectivePluginIds`），每条消息实时读取 registry，enable/disable 下一条消息即生效，不需要重启 daemon。
- 同一 bot 上两个已启用插件声明同名指令 → 该指令 fail closed（回一句固定文案「插件指令冲突，请联系管理员」并记日志），不按安装顺序抢占。
- 内置命令与固定透传命令永远优先：即使旧 registry 或手改文件含冲突声明，路由器 ⑤½ 仍对 `isBuiltinSlashCommandName` / `PASSTHROUGH_COMMANDS` 命中的名字拒绝插件（codex-app 的透传集为空，没有这道栅栏 `/compact` 会落到插件手里——差分测试实测抓到）。
- bot 的 `customPassthroughCommands` 若包含同名指令：显式 bot 配置优先，走透传（路由顺序天然如此，见 §3），并在 daemon 启动时 warn 一次。

## 3. 路由

`SlashRouteInput` 新增可选字段：

```ts
/** 当前 bot 有效插件声明的指令名 → pluginId（同名冲突的指令映射为 null）。缺省 = 空。 */
pluginCommands?: ReadonlyMap<string, string | null>;
```

`SlashRouteDecision` 新增：

```ts
| { kind: 'plugin'; cmd: string; content: string; pluginId: string | null }
```

判定位置：在 ⑤（daemon / cliCommand）之后、⑥（`unknown_slash`）之前插入 ⑤½：

```ts
const pluginId = input.pluginCommands?.get(cmd);
if (pluginId !== undefined) return { kind: 'plugin', cmd, content, pluginId };
```

因此 bot 门（①）、多行/讨论文本（②）、special（③）、透传（④）、内置 daemon 命令（⑤）全部先于插件指令，语义不变。

**差分测试**：`pluginCommands` 缺省为空 Map，现有 ≈269 万组输入的决策逐字不变，`command-router-oracle-diff.test.ts` 不需要改 oracle。新增一组输入维度「`pluginCommands` 非空」：老 oracle 给出 `forward/unknown_slash`，新路由给出 `plugin`，作为有意变化登记进 `INTENTIONAL`，并同步到 `2026-09-11-command-router.md` §9 有意变化表。

`isCommandDecision` 不包含 `plugin`：插件指令不进 `handleCommand`，由两条入口单独执行（§4）。`command-schema.test.ts` 不受影响（内置表未改）。

## 4. 入口执行

`handleNewTopicAdmitted` 与 `handleThreadReplyAdmitted` 在 `classifySlash` 之后各加一个分支，抽成共用函数 `executePluginCommand(decision, ctx)`：

1. **准入**：插件指令按 `canTalk` 准入（与 `/sessions` 同级），未通过回复与 `/sessions` 相同的「仅允许的用户可用」文案；`grantRestrictedSlashCommandText` 照查（受限成员的命令限制对插件指令同样生效）。bot 发送方由路由 ① 处理。
2. **不扣额度、不建会话**：与 `skipCharge` 的控制类消息一致；不调用 `enforceMessageQuotaForCliInput` 的扣费段，也不触发 `prompt.submit` 闸（不进 CLI）。
3. **冲突**（`pluginId === null`）：回固定文案，结束。
4. **转发**：POST 到插件服务（§5），超时或失败回固定文案「插件暂不可用」，不回退成普通消息、不转给 CLI。
5. **回复**：把插件返回的 `reply` 发到当前锚点（`sessionReply(anchor, …)`）；新话题入口在话题群里即形成一个新话题，普通群里为普通回复。

## 5. HTTP 协议 v1（插件指令）

沿用 cardActions 的传输与鉴权：Botmux 从 service state 读端口，自行拼 `http://127.0.0.1:<port><endpoint>`，`loopbackFetch`，`Authorization: Bearer <per-plugin token>`。token 与 cardActions 是**同一把**（`~/.botmux/plugins/<id>/private/card-actions.token`）；`service-manager.ts` 的注入条件从「声明 cardActions」放宽为「声明 cardActions 或 commands」，env 名保持 `BOTMUX_PLUGIN_CARD_ACTION_TOKEN` 不变以兼容已有插件，并新增 `BOTMUX_PLUGIN_COMMANDS_ENDPOINT`。

请求（≤ 64 KiB，一次、不重试，硬超时 10 s）：

```json
{
  "schemaVersion": 1,
  "eventId": "om_xxx",
  "larkAppId": "cli_xxx",
  "command": "/work-bind",
  "args": "bind",            // 已去掉开头的指令 token
  "chat": { "chatId": "oc_xxx", "chatType": "group", "anchor": "om_xxx" },
  "sender": { "openId": "ou_xxx", "unionId": "on_xxx" },
  "privileges": { "canOperate": true, "canTalk": true },
  "locale": "zh"
}
```

- `eventId` 取触发消息的 messageId，插件以它做幂等。
- `sender` 只来自飞书事件 envelope，`privileges` 由宿主用 `canOperate(...)` / `evaluateTalk(...)` 当场计算，**插件不得从 args 推导身份或权限**。
- `chat` 来自宿主路由上下文，不来自消息正文。

响应（≤ 1 MiB）：

```json
{ "schemaVersion": 1, "reply": { "card": { "schema": "2.0", "body": {} } } }
```

`reply` 可为 `{ "text": "…" }`（≤ 4000 字符）或 `{ "card": {...} }`，也可省略（静默）。卡片里的 callback 只能使用**该插件已声明的 cardActions selector**，`key` / `root_id` 等内部路由字段禁止——直接复用 `parsePluginCardActionResponse` 的 `callbackPolicy`。重定向、非 2xx、非法 JSON/schema、越权 callback、超限、超时、离线一律隔离为「插件暂不可用」回复，不影响 daemon。日志只记 app、plugin、command、状态码、耗时，不记 args、sender、响应正文。

## 6. 卡片回调附带权限证明

`PluginCardActionRequest` 新增可选字段（schemaVersion 仍为 1，向后兼容，老插件忽略即可）：

```json
"privileges": { "canOperate": true, "canTalk": true }
```

由卡片网关在转发前用回调 `operator.open_id` / `union_id` 与回调 `context.open_chat_id` 计算；任一身份缺失时 `canOperate=false`、`canTalk=false`（fail closed）。插件仍须对每次点击重新校验，不能把发卡时的权限当作点击时的授权。

## 7. Help

`/help` 末尾追加「插件指令」一节，列出当前 bot 有效插件的 `name — description`（实时读取，冲突项标注不可用）。内置 help 文案与顺序不变。

## 8. 影响面

| 范围 | 影响 |
|---|---|
| 未安装/未启用声明 commands 的插件的 bot | 路由输入 `pluginCommands` 为空，行为逐字不变（差分测试守护） |
| 已有 cardActions 插件 | 请求多一个可选 `privileges` 字段；token、env、协议版本不变 |
| CLI 适配器 / 后端 / 沙盒 | 不涉及：插件指令不进 CLI、不建会话 |
| 话题群 / 普通群 / 私聊 | 三者都走同一执行函数；私聊里 `chatType=p2p` 原样告知插件 |
| 编译态二进制 | 只新增 JSON 声明读取与 loopback 调用，不涉及 `__dirname` 路径 |

## 9. 验证计划

- 单测：scanner 声明校验（合法/冲突/越权 endpoint）；`classifySlash` 新分支；有效插件解析与冲突 fail closed；协议请求构造与响应解析（text/card/越权 callback/超限/超时）；卡片网关 `privileges` 计算（身份缺失 fail closed）。
- 差分测试：缺省输入全量通过；新维度登记 `INTENTIONAL`。
- 集成：`test/plugin-supervisor.integration.test.ts` 风格起一个最小插件服务，覆盖指令 → 卡片 → 点击 → `privileges` 往返。
- live：`bun run switch:here && bun run daemon:restart`，在测试群用最小示例插件验证 `/xxx` 出卡、非管理员点击被插件拒绝。

## 10. 评审决策（2026-10-14 已定）

1. 插件指令准入用 `canTalk`；管理操作由插件凭 `privileges.canOperate` 在卡片点击时把关。
2. 与 `customPassthroughCommands` 同名时 bot 配置优先，走透传，daemon 启动时 warn 一次。
3. `/help` 展示当前 bot 有效插件的指令。
