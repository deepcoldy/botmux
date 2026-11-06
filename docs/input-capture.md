# 精确话题输入接管（通用插件候选）

仅可信宿主可为一个现有活动会话注册接管。身份从 daemon 活动会话解析，精确绑定 bot/session/chat/anchor/答题人；providerRef 是由插件解释的不透明引用。可通过 `--input-anchor <message-id>` 指定该 chat 内由宿主核验的原消息或插件卡片话题；sourceAnchor 仍固定为真实来源会话的 anchor。使用已启用、已安装并声明 card-actions 的插件，以复用其现有私有服务凭据。无需平台枚举、业务提示词或私有数据目录接口。

```
botmux input-capture register --bot <app> --session <session> --plugin <installed-plugin> --request <stable-key> --ref <opaque-ref> [--actor <ou_openId>]
botmux input-capture inspect --bot <app> --session <session> --binding <binding-id>
botmux input-capture revoke --bot <app> --session <session> --binding <binding-id> --revision <revision>
botmux input-capture revoke-set --bot <app> --session <session> --bindings '<conditions-json>'
```

对应 `POST /api/sessions/:sessionId/input-capture`，body 包含 larkAppId、operation 与命令字段。注册支持 `actorOpenId`（CLI 为 `--actor`）：省略时使用已有会话 owner；显式指定也必须等于该 owner。无个人 owner 的普通群必须显式指定合法答题人，且来源会话必须满足 `scope=chat`、`chatType=group`、`anchor=chatId`；无 owner 的 thread/p2p 或不一致的来源 anchor 均拒绝登记。上述来源限制不妨碍使用不同的、已核验的 `--input-anchor` 接收插件卡片回复。

绑定回执中的 `ownerOpenId` 字段保存所选答题人，不会改写会话 owner；无 owner 群的交互上下文仍返回 `ownerOpenId:null`。登记和每条新输入均检查该答题人的原生 canTalk。相同群和 anchor 的不同 actor 可以用不同 request 建立并存绑定，消息按真实 sender 进入各自输入流；同一 bot/chat/anchor/actor 的第二个活动绑定冲突。同一 request 不能通过换 actor 改绑。

注册还支持可选布尔值 `captureAttachments`（CLI 为 `--capture-attachments true|false`），默认关闭；同一 request 的订阅能力固定，重试不得改变。路由必须通过当前宿主 HMAC；不加入 session relay allowlist。register 同一身份幂等。撤销后保留墓碑，同一个 request 不会重新激活。

`revoke-set` 的 `conditions-json` 是 1–32 个 `{bindingId, expectedRevision, expectedInputCount}` 对象。
宿主在同一个日志事务内核验所有绑定都属于原 session、revision 匹配且已接收输入总数等于预期，然后一起撤销。
任一入口在检查后新收了消息，整个操作返回 409，所有绑定保持原状；非法条件返回 400。
已接收数量包括尚未收到插件 ACK 的输入，ACK 的保存不会改变这个数量。
返回 `result.bindings[]`，每项包含撤销后的 `binding` 和 `inputCount`，没有删除输入或消费回执。
响应丢失时先 inspect 原绑定；墓碑和输入仍在，不能换 request 重新激活。

消费者应先核对 inspect 返回的全部原 input ID、内容和连续序号已经持久化，再用它们的数量发起条件撤销。
这个接口只建立输入接管的结束边界；它不证明插件已处理输入、业务已完成或下一步已获授权。

接管在飞书 SDK 回调返回 ACK 之前同步执行，并排除 slash/回调命令与话题控制头；不会经过先 ACK 再异步执行的普通消息调度队列。未订阅的附件、workflow grill、机器人和其他答复者继续走现有路由。命中后重新检查当前原生 talk 权限及会话身份，再将完整正文、订阅的资源引用、真实 messageId、sender 和单调序号 fsync 到宿主日志，才返回已接收。持久化失败不返回成功，也不转投普通 Worker；需要排查保存故障，不能假定上游一定重投。

宿主异步向该插件的现有服务 `POST /botmux/inputs/v1`。沿用官方插件服务注册、固定 loopback 端口和 `BOTMUX_PLUGIN_CARD_ACTION_TOKEN`，不接受调用者提供 URL 或凭据：

```
{schemaVersion: 1, binding: {id, larkAppId, sessionId, chatId, anchor, ownerOpenId, pluginId, requestId, providerRef, ...},
 input: {id, bindingId, sequence, messageId, senderOpenId, text, receivedAt, delivery: "pending"}}
```

插件必须先按 input.id 幂等持久化，再返回 `{schemaVersion:1, bindingId, acceptedInputId}`。输入是已接收事实，不能视作未来执行的授权。相同 ID 的不同内容必须拒绝，禁止改写历史消息。服务离线、错误 ACK、超时或宿主保存 ACK 失败，均保留原条目并按原顺序重试；不得 fallback 普通 Worker，也不得假定飞书重投。

重启恢复 pending；撤销接管保留并继续交付已经接收的输入。移除插件启用配置会暂停交付，保留记录。inspect 不消费、不 GC。当前不自动清理绑定、已确认输入或墓碑；历史数据归档/清理由未来显式迁移处理。接口只接管已经通过消息入口到达原会话的输入，不声称覆盖飞书未投递的消息；仅有 thread_id 而无 root_id 时，仅从下述已核验映射恢复；没有证据的消息保持原路由。

此能力不调度模型、不解释答案、不维护业务阶段。平台负责原会话续执行、scope/专业回执与副作用校验。没有完成平台 consumer 和旧数据迁移前不能切换生产来源。

## 可选附件订阅

注册时传 `--capture-attachments true` 后，绑定回执包含 `captureAttachments:true`。既有默认文字绑定保持原行为，不允许同一 request 静默切换能力。消费者必须核对能力回执，不能把旧宿主忽略参数当作支持。

已捕获输入可包含 `attachments:[{messageId,type,key}]`；类型为 `image|file|audio|media|merge_forward`。图片、文件、音视频和富文本资源只传稳定引用；合并转发保留原消息引用（key 等于 messageId）。单条最多 100 个引用，字段只允许上述三项，不提供本地下载路径、URL 或凭据。正文仍限制为 64 KiB。资源内容由插件使用自己的授权读取，此接口不下载或解释附件。

附件输入的 text 仅保留原作者正文，去除图片/文件占位标签、文件名和转发内容；纯附件输入允许空正文。上传资料本身不是批准。纯文字旧输入不补写空 attachments，读取不改变历史字节。重复消息必须同时匹配正文和完整资源引用；撤销、保存失败、断连与恢复沿用相同日志和 ACK 规则。

首次注册附件订阅时，宿主内部日志原子升级为 schemaVersion 2，旧 reader/writer 必须拒绝该日志；没有附件订阅的文字日志仍为 v1，读取和幂等注册不改写。HTTP/插件事件仍为 schemaVersion 1。回退运行版本前必须排空并核对能力，不能降低日志版本或拿旧文件覆盖新输入。


## 原生话题锚点恢复

可信宿主可在注册时传 `--input-thread-id <omt_id>`（HTTP `inputThreadId`）。宿主必须先通过原消息 API 核对精确 messageId、chat 和 threadId；该参数只适用于 om_ 消息锚点，不适用于 oc_ 群锚点。不能只根据字符串格式声称原话题已核验。绑定的映射固定，同一个 request 重试不得改变；同一群和答复者的活动绑定不能指向同一个原生话题。

未显式提供映射时，宿主也可从同时携带精确 root_id 和 thread_id、通过原绑定及实时身份权限检查的已接收真人输入建立证据。threadId 随该条原始输入持久化，不增设第二个索引或数据库。后续缺 root_id 的输入可据此恢复，包括宿主重启后的输入；原事件本身不被改写。

恢复仍为 ACK 前的同步路径，不等待网络查询。它不覆盖未知映射，不将原生话题根消息本身当作回复，不覆盖矛盾的显式 root_id，不跳过命令、机器人、群/答复者、关闭会话与当前权限检查。历史已接收消息沿原绑定去重；新的撤销后输入不能重新激活绑定。

首次保存映射或原始 threadId 时，日志升级为 schemaVersion 3；附件 v2 和纯文字 v1 历史仍可读。旧 writer 必须拒绝 v3，后续附件注册也不能将日志降回 v2。HTTP/插件事件仍为 v1，可选的 input.threadId 是来源证据，不是业务批准。消费者如需用它读取缺 root_id 的材料，必须完整保存并核对该字段；平台接入及旧单写者迁移仍是独立门禁。


## 长输入历史分页

`input-capture inspect --bot <app> --session <session> --binding <id> --after 0` 返回第一批完整输入，附加 `throughSequence` 和 `nextSequence`。后续请求传 `--after <nextSequence> --through <首次 throughSequence>`，直到 `nextSequence:null`。首次上界为读取时已接收数量；其后新输入不进入这个固定前缀。`through` 必须与 `after` 一起提供，且满足非负安全整数和 `after ≤ through ≤ 当前数量`，否则 HTTP 400。

每页最多 64 条，按完整输入 JSON 的实际字节数控制约 128 KiB；单条可能因转义超出该预算，仍完整返回且游标前进。消费者应支持 512 KiB 响应以容纳一条合法最大正文及附件引用，不无限提高整段历史的响应上限。空前缀/末页返回空数组和 null；不截断内容，不消费数据，不升级日志 schema。

消费者逐页核对同一个 binding 身份、revision/active、固定 throughSequence、连续序号和游标，汇总到完整 snapshot。分页期间绑定生命周期变化须重读；输入追加可保留原前缀，但稍后 `revoke-set expectedInputCount` 必须拒绝变化后的总数。pending 和 acknowledged 都在前缀内。未传分页参数时维持旧 `{binding,inputs}` 格式；新集成要求显式分页回执，不能把旧宿主忽略参数的响应当作已经完整分页。

Topic header detection uses the same native parser as command routing, including titled lifecycle aliases and `/repo wt`. Both valid and invalid recognized headers remain with the native router (including rich posts with attachments), so command errors cannot silently become captured answers. Ordinary replies remain eligible for their original exact binding.
