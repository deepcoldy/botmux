# 外部交互的当前会话与权限观察

`botmux interaction-context --bot <appId> --session <sessionId> [--actor <openId>]` 通过可信宿主 IPC，只读查询该 daemon 当前活动会话的 chat、scope、原 root、owner 及指定 actor 的当前 canTalk。省略 actor 时查询宿主记录的当前 owner。身份从宿主会话取得；调用者不能指定替代 owner/chat/root。每次使用官方 Ask 卡片点击人的 canTalk 权限判断；不接受调用方自报的 bot/union 身份扩展授权，无额外授权规则、业务枚举或目录暴露。

HTTP 为 `POST /api/sessions/:id/interaction-context`，请求 `{larkAppId, actorOpenId}`。成功返回 `{ok:true,schemaVersion:1,context:{larkAppId,sessionId,status,chatId,rootMessageId,scope,chatType,ownerOpenId,actorOpenId,canTalk,observedAt}}`。错误包括缺失/非活动会话 404、路由或来源不适用 409、生产 IPC 未通过鉴权 401（路由层不具备宿主身份时为 403）、无法观察 503。该路由不开放给会话 relay。

外部 provider 必须在创建、发送和处理回调时重新查询，核对原 bot/session/chat/root/owner 未变。该响应不是可缓存的授权令牌，不保证随后发送的原子性；IM 操作仍需严格目标校验。卡片 actor 必须取官方插件网关提供的真实 operator，禁止从卡片 value 或请求正文自报身份。

只支持拥有确定 owner、scope、chatType 和原锚点的普通 chat/topic。已关闭/未装载的会话、文档、HTTP 和 headless 来源均返回 409，即使它们带有完整 owner；v3 工作流使用独立运行注册表。503 仅表示宿主观察服务异常。此接口不发消息、不恢复会话、不改权限，也不承诺业务执行完成。
