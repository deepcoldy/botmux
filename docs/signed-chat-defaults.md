# 可信建群服务的默认免 @ 模式

自助建群服务创建普通群后，可以声明该应用在该群的默认回复模式为 `ambient`：用户不 @ 机器人也能触发对话；只 @ 其他成员时，机器人仍保持安静。该声明仅影响寻址，不授予对话或操作权限，发送者仍须通过现有权限检查。

本功能默认关闭，仅影响飞书普通群的人类消息。私聊、话题群、机器人间路由，以及 CLI、PTY/tmux 和远端后端的执行逻辑不变。

## 配置与优先级

在对应机器人的 `bots.json` 条目中配置：

```json
{
  "signedChatDefaults": true,
  "signedChatDefaultsRegistryUrl": "https://registry.example/lookup"
}
```

注册表地址可省略，省略后仅验证群描述中的签名。地址由部署管理员配置，必须使用 HTTPS，不能含用户名或密码；请求不跟随重定向。建群服务必须是已受信任、可持有该应用 Secret 的服务端，不能把 Secret 交给浏览器或普通建群用户。

优先级：群级 `chatMentionModes[chatId]`（`/mention-mode`）→ 已验证的 `ambient` 默认 → 机器人全局 `regularGroupMentionMode`。启用本功能后，即使群级设置与全局默认相同，也会保留该显式设置，避免签名缓存重新生效后意外恢复免 @。

## 群描述签名

群描述中使用独立一行：

```text
BOTMUX1:<signature>
```

`signature` 为以该应用 `larkAppSecret` 作密钥的 HMAC-SHA256，消息为 `botmux-chat-defaults-v1:<appId>:<chatId>:ambient`，输出为无填充 base64url。应用、群或模式不匹配时验证失败；复制签名到另一群无效。普通描述文本没有授权意义。

该静态签名在同一应用、同一群内可重复使用，没有时间戳或独立撤销机制。撤销时移除群描述签名并清除注册表记录，或用 `/mention-mode` 显式覆盖；如需立即停用整个功能，关闭 `signedChatDefaults`。

## HTTPS 注册表协议

普通群上下文读取成功、群描述未通过签名验证时，才会查询配置的注册表。这样建群服务可以把元数据保存在服务端，不必修改群描述。

客户端发送 JSON POST：

```text
{ app, chatId, ts, nonce, mac }
binding = app + ':' + chatId + ':' + ts + ':' + nonce
mac = HMAC-SHA256(secret, 'bca-registry-v1:request:' + binding)
```

`ts` 是毫秒时间戳，`nonce` 是每次请求新生成的 16 字节随机数的十六进制字符串。所有 HMAC 均使用无填充 base64url。`bca-registry-v1` 是既有建群服务使用的兼容协议前缀。

注册表须验证请求签名、时间窗口、应用与群绑定，并按自己的重放策略处理 nonce，再返回：

```text
{ ok: true, ambient: true | false, mac }
mac = HMAC-SHA256(secret, 'bca-registry-v1:response:' + binding + ':' + ambient)
```

Botmux 验证响应签名，并绑定本次请求的应用、群、时间戳和 nonce。旧请求的有效响应不能复用于新请求。Secret 不进入请求正文或 URL。查询超时为 8 秒；非成功 HTTP、无效响应、网络错误和群上下文不可读均不会产生新的免 @ 默认。

## 缓存与运行限制

- 首条有权操作的人类消息在寻址前读取可信默认，因此不依赖入群事件是否送达；未授权发送者不会触发外部查询。
- 同一应用、群的并发读取合并。有效正结果缓存 60 秒，成功查询得到的负结果缓存 2 秒；群上下文、注册表查询失败则按负结果缓存 10 秒后重试。缓存采用 LRU，最多 2000 项。
- 缓存只在内存中；重启恢复和 bot 发送方路径不会主动查询，冷缓存会先按更严格的全局模式处理，下一条有权操作的人类消息再从群描述或注册表读取。正结果过期后，查询失败同样回退到全局模式。
- 签名、Secret 或注册表记录变更不立即清除既有正缓存，最多保留到 60 秒缓存到期；显式群模式和关闭功能即时优先。
- 注册表服务端不包含在本 PR 中，需要按上述协议独立实现。
