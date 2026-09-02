# Card Action Plugin Gateway

Botmux 统一持有每个飞书应用的长连接、回调 ACK、传输去重和超时后的卡片更新。插件不建立飞书连接，而是用静态 contribution 声明自己消费的动作，再由 Botmux 把已验证的回调转发到插件的本机服务。

这是一项通用插件能力。Botmux 不理解接入方的表单结构、存储模型、业务幂等或后续任务。

## 插件声明

插件必须同时提供以下三项：

- manifest 中的 `botmux.service`；
- `dist/service/index.js` 服务入口；
- `dist/card-actions/index.json` 静态动作声明。

`card-actions/index.json` 示例：

```json
{
  "schemaVersion": 1,
  "actions": ["example.review.submit"],
  "actionPrefixes": ["example.review."],
  "endpoint": "/botmux/card-actions/v1"
}
```

`actions` 和 `actionPrefixes` 都可省略，但至少一个数组必须非空。selector 必须是最长 256 字符的静态安全字符串，同一数组内不能重复。`endpoint` 只能是以 `/` 开头的相对 HTTP path，不能包含 scheme、host、query、hash、反斜杠或 `..` 路径段。

安装时 scanner 会拒绝缺少 service、schema 错误或路径不安全的声明。registry 和 materialized marker 只记录 `actions`、`actionPrefixes` 和 `endpoint`，不记录回调正文或鉴权信息。

### 路由优先级

路由只查看当前 `larkAppId` 的 global + Bot 级有效插件，并在每次回调时重新读取持久化配置：

1. 精确 `actions` 命中优先于所有 prefix；
2. 没有精确命中时，选择最长的 `actionPrefixes`；
3. 同一作用域内有多个插件声明相同精确 action，或者相同且最终命中的 prefix，当前动作 fail closed；
4. 没有插件命中时，才调用 Botmux 既有卡片 handler；插件已经认领的动作即使服务不可用，也不会回退到内建 handler。

因此，启用范围不会跨 Bot 泄漏，窄 namespace 可以确定性覆盖宽 namespace，安装顺序不能抢占动作。

## 服务与私有鉴权

声明 card action 的 service definition 必须提供固定的整数 `port`（1–65535）。Botmux 启动服务时会在插件自定义 env 合并完成后覆盖注入：

```text
PORT=<service definition port>
BOTMUX_PLUGIN_CARD_ACTION_ENDPOINT=<declared endpoint>
BOTMUX_PLUGIN_CARD_ACTION_TOKEN=<generated token>
```

插件配置不能覆盖这三个值。服务只应监听 `127.0.0.1`，并对 endpoint 上的每个请求验证 `Authorization: Bearer <token>`。

token 是每插件独立的 32-byte 随机值，保存在：

```text
~/.botmux/plugins/<pluginId>/private/card-actions.token
```

private 目录权限为 `0700`，token 文件为非 symlink 的普通 `0600` 文件。普通 restart 和插件更新复用原 token；卸载插件时 token 随插件 home 删除。token 不进入公共 registry、materialized marker、service report、URL 或日志。

Botmux 始终从校验后的 service state 读取 port，并自行构造字面量 `http://127.0.0.1:<port><endpoint>`。请求使用专门的 `loopbackFetch`，不会受代理环境变量影响；不接受插件提供 host 或完整 URL。

## HTTP 协议 v1

请求为一次、不重试的 JSON POST：

```http
POST /botmux/card-actions/v1
Authorization: Bearer <per-plugin-token>
Content-Type: application/json
```

```json
{
  "schemaVersion": 1,
  "eventId": "evt_xxx",
  "larkAppId": "cli_xxx",
  "operator": {
    "open_id": "ou_xxx",
    "union_id": "on_xxx"
  },
  "context": {
    "open_message_id": "om_xxx"
  },
  "actionName": "example.review.submit",
  "action": {
    "name": "submit",
    "value": {
      "action": "example.review.submit"
    },
    "option": null,
    "formValue": {}
  }
}
```

`actionName` 优先取 `action.value.action`，否则取平台原始 `action.name`。`context`、`action.value` 和 `action.form_value` 按回调原样传递；顶层 `open_message_id` 只在 context 缺少该字段时补入。操作者身份只来自飞书 SDK 验证后的 envelope `operator`，绝不能从 `action.value` 推导用户。`open_id` 是应用级身份，插件必须连同 `larkAppId` 解释。

请求 JSON 上限 256 KiB。插件响应上限 1 MiB，网关内部硬超时为 30 秒。一次卡片回调只发送一次 POST，Botmux 不对可能包含副作用的请求自动重试。

合法响应：

```json
{
  "schemaVersion": 1,
  "ack": {
    "toast": {
      "type": "success",
      "content": "已接收"
    },
    "card": {
      "schema": "2.0",
      "body": {}
    }
  }
}
```

`ack` 可以省略或为空。`toast.type` 仅接受 `success`、`info`、`warning`、`error`；`card` 必须是 JSON object。重定向、非 2xx、非法 JSON/schema、超限响应、连接失败、离线状态和超时都会被隔离为合法空 ACK，不会让共享长连接退出。

## ACK、慢响应与幂等

飞书同步回调的 3 秒期限仍由 Botmux dispatcher 管理。每个 Bot 可通过 `/botconfig set cardActionAckTimeoutMs <毫秒>` 设置同步等待时长，合法范围 500–2500ms，默认 2500ms，`unset` 恢复默认且均为热更新；该值统一作用于该 Bot 的内置动作和所有插件，插件不能自行覆盖。处理在期限内完成时，toast/card 直接作为 ACK；超过期限时，Botmux 先返回“后台处理中”，继续等待插件，但插件请求最多 30 秒。插件随后返回 card 时，Botmux 只更新原 `open_message_id` 一次；迟到的 toast 无法再显示，只记录不含正文的状态日志。

Botmux 会用稳定 `eventId` 阻止长连接重推造成的重复投递，并在单进程内抑制同时进行的重复回调。这个传输去重不能替代业务幂等：插件仍须以 `eventId` 保护持久化写入和外部副作用。

## 生命周期与观测

- enable/disable 在下一次回调时生效；disable 只停止能力路由，保持既有 service 生命周期语义；
- service restart 保持 token，新的 state port 会被下一次回调读取，不需要重启 daemon；
- Lark WebSocket reconnect 复用同一 dispatcher，不会注册重复 handler；
- stopped/offline service 快速返回空 ACK；connection refused 等运行态故障独立隔离；
- 日志只记录 app、plugin、action、状态、耗时和固定错误码，不记录 token、operator、表单、请求或响应正文。

插件安装属于受信本机代码边界，但回调 payload 仍是不可信输入。静态 allowlist 只能选择安装时已扫描的插件，不能从 payload 选择 endpoint、pluginId、模块或远程地址。
