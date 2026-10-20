# 机器人状态通知与执行输入的边界

机器人发布阶段结果、排队状态或交接说明时，消息监听与新话题自动开工可能把通知再次派给机器人。普通的无 @ 文案不足以声明不执行。

发布者可在 Schema 2.0 卡片 `body.elements` 顶层包含 `{ "tag": "hr", "element_id": "botmux_notice_v1" }`，显式声明整张卡片仅作状态通知。Botmux 不理解平台角色、阶段、任务或审批，只消费这项通用投递语义；平台继续从自身原任务账本生成内容和真实派发。

接收端只对已认证的 app/bot 发送者识别该结构。通知在实时入口的监听、@ 和自动开工路由之前退出；历史监听在匹配订阅后、领取消息和派发之前退出。机器人编辑事件沿既有规则不触发任务。群上下文仍可记录通知供查看。真人直接发送或转发的消息、正文提到同名字符串、折叠面板中的引用以及普通机器人指令均保留原路由。

飞书 WebSocket/历史列表可能只返回扁平正文或“请升级客户端”。此时按原 message ID 请求 user_card_content 并校验原 chat、发送者类型和未撤回状态，不能将占位正文当成可执行消息。读取失败不继续派发：持久入口保留原重试责任，历史扫描由原扫描重试；没有新增调度器。该行为也意味着机器人卡片监听需具备读取完整原消息的现有 IM 权限。

发布顺序：先部署接收端 Botmux 并验证，再启用平台通知标记；旧 Botmux 不识别此合同。验证覆盖实时完整卡、占位回读、自动开工、历史监听、人类转发、嵌套引用、普通卡片和读取失败。真实飞书回读验证了标记保留及默认正文缺少标记；多角色真实群的整体交付仍需单独验收，不能用分类器测试冒充。

Legacy WS ingress now holds the SDK acknowledgement only through bot-card
classification. Before a successful read it has no persistent seen-message
claim. Concurrent copies share the same acknowledgement/rejection; after a
failed read the same message can be redelivered. The existing raw-anchor FIFO
still orders its routing with ordinary messages. After classification, the
normal persistent claim prevents duplicate dispatch. Primary Inbox and history
polling retain their own existing recovery paths.
