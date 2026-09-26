# 连接器交接实时卡

连接器可在 `/api/trigger` 请求中设置 `presentation.liveCard: "on-start"`，并通过 `presentation.title` 设置标题。仅飞书群内的 chat 会话支持该展示；省略选项时沿用现有行为。

卡片在对应 `turnId` 的输入被 Worker 确认提交后开始更新，不把 HTTP 接收成功或其他群消息当作执行开始。私密卡、静默轮次及禁用实时卡仍服从原有展示设置。

## 阶段与完成事件

使用现有 Dashboard 写入鉴权，向 `POST /api/sessions/:sessionId/live-stage` 发送 JSON。请求由 Dashboard 路由至拥有该会话的 daemon，只读访问不能写入。

阶段事件示例：

```json
{"turnId":"trg_example","sequence":1,"kind":"stage","title":"等待验证结果"}
```

连接器在**确认结果消息已成功送达原目标**后，才发送完成事件：

```json
{"turnId":"trg_example","sequence":2,"kind":"complete","resultMessageId":"om_example"}
```

`resultMessageId` 是连接器声明的送达证据，Botmux 校验格式但不查询消息内容。阶段名称与业务顺序由调用方定义；接口不要求经过需求、开发或测试等固定步骤，也不自动派发业务任务。

## 重试与恢复

- `sequence` 是同一轮次内递增的正整数。旧事件不回退阶段；同序号、同内容的重试保持幂等，同序号不同内容返回冲突。
- `complete` 先持久化关闭状态，再撤回对应实时卡；结果消息保留。撤回失败可重试同一完成事件，无需重跑业务。
- 关闭状态抑制迟到的屏幕更新；SQLite 重建嵌套对象后仍按轮次、序号及卡片身份清理。异步撤回结束时不能清理后继回合的卡片。
- 已切换轮次或关闭的会话拒绝旧轮次事件。`live_stage_unavailable` 表示会话类型不适用；`stale_live_stage` 表示轮次失效；`live_stage_sequence_conflict` 需要调用方检查事件序号。
- 临时阻塞可作为 `stage` 上报；详细原因和需用户处理的事项仍由连接器发送。此接口不推断业务是否成功，也不替代结果或阻塞通知。

## 展示示意

下图是离线流程示意，非飞书客户端实测截图。复用已有实时卡布局。

![交接卡示意](assets/handoff-live-card-preview.png)
