# 飞书与企业微信 Bot 配置能力对照

范围：飞书 Bot 配置页的 41 个已注册配置区块，补充页头展示设置与真实持久字段。CLI 专属项只在对应 CLI 下适用；只读探测结果和保存按钮不另算配置项。

共 **243** 个字段或独立操作条目：**164 已实现，79 暂无法支持**。同一字段的可用 CLI、平台、枚举子值与行为差异在限制栏注明；只读运行元数据不重复计数。

限制栏标「A：」「B：」的行来自替代方案复核（A 类 33 项、B 类 43 项）；B 类按下表明确的降级边界计入已实现，不表示飞书原生语义完全等价。C 类 18 项、D 类 13 项保留不支持。

“已实现”依据共享界面到专属 API、配置持久化、core/Worker 或网关实际消费者的组合验证；“暂无法支持”表示当前明确的适配缺口或无等价接口证明，不代表企业微信平台永久没有此能力。CLI、模型、后端、工作目录与沙盒/环境等 core 设置保存后无需重启，运行中的网关把它交给专用 core，供之后新建的会话使用；已在运行的会话不变，只有换 CLI 时 core 会关闭仍在用旧 CLI 的会话（包括正在执行的任务），该聊天的下一条消息自动在新 CLI 上新建会话、上下文不延续；只有身份类设置（BotID、凭据来源、core 地址/端口/身份/状态目录）需重启连接。ACL、角色、路由和消息策略由网关实时读取。旧配置默认不披露过程、思考和工具内容，须显式开启。

## 状态总览

| 当前状态 | 项数 | 阅读位置 |
| --- | --- | --- |
| ⏸ 暂无法支持 | 79 | 下方“暂无法支持”分区，先看剩余缺口与限制 |
| ✅ 已实现 | 164 | 下方“已实现”分区，按原配置组顺序查阅 |
| 合计 | 243 | 每个字段或独立操作只计一次 |

A33+B43 的 76 项已分别计入上面两类，不另行相加。2026-11-25 移除的功能（代答按钮，以及首次触达、群消息入站策略、本地业务模块、授权限制与委托、帮助卡开关、群内改私聊投递、最终思考摘要、回复样式、选项布局、主动发送通道共 47 项）列在“暂无法支持”并注明“已移除”：配置里的旧键解析时丢弃，连接照常启动。手写双端信任改为同机互信（`trustSameOwnerBots`、`botToBotSameDir` 默认开启），审批人即允许用户。107 项复核是上述字段的历史设计与实施证据附录，不是额外能力项。

## ⏸ 暂无法支持（79 项）

| 配置组 | 飞书配置项 | 真实字段 / 操作 | 企业微信对应实现 | 状态 | 验证 / 限制 |
| --- | --- | --- | --- | --- | --- |
| 页头 | 机器人头像 | `avatar` | 当前智能机器人身份不提供已验证的资料写接口 | 暂无法支持 | 飞书头像写入依赖应用appSecret与open-platform接口；企微botId/secret仅长连接鉴权，不能复用该入口 |
| 页头 | 机器人简介 | `description` | 当前智能机器人身份不提供已验证的简介写接口 | 暂无法支持 | 飞书简介由开放平台appSecret修改；企微本地配置没有目标应用资料权限，不伪造成功 |
| 常用 / 工作目录 | 新话题自动启动 | `autoStartOnNewTopic` | 未建立企微原生话题到独立CLI会话的路由 | 暂无法支持 | 当前路由键为chatType+conversationId+userid，无topic/root message标识 |
| 常用 / 工作目录 | 入群自动邀请owner | `autoInviteOwnerOnGroupAdd` | 缺企微owner成员身份与被授权的群成员管理接口 | 暂无法支持 | 飞书实现调用群成员邀请API；当前botId/secret不能复用飞书owner open_id |
| 会话 / 模式 | 文档订阅默认模式 | `docSubscribeDefaultMode` | 缺企微文档订阅事件与文档内容授权适配 | 暂无法支持 | 当前智能机器人长连接不是文档应用授权；无文档对象、订阅回调与评论/权限映射，不复用飞书文档ID |
| 会话 / 模式 | 群负责人共享话题 | `chatManagerSharedTopic` | 缺native话题ID与群负责人话题绑定 | 暂无法支持 | 已实现的群共享chat是同一CLI会话；不等于飞书群负责人共享topic/root message生命周期 |
| 会话 / 模式 | 会话群用户授权 | `sessionGroupTag.authorization` | 飞书个人分组OAuth不适用于企微botId | 暂无法支持 | 缺企微个人客户端会话整理的独立授权协议，不转用飞书个人token |
| 会话 / 管家 | 自动跟随入群 | `steward.autoJoinNewGroups` | 缺企微群管理、跨群事项绑定与native决策账本适配 | 暂无法支持 | 飞书管家直接以群ID、owner open_id和建群/拉群API推进；不能使用botId/secret冒用飞书应用身份 |
| 会话 / 管家 | 单人会话群自动入群 | `steward.autoJoinSoloGroups` | 缺企微群管理、跨群事项绑定与native决策账本适配 | 暂无法支持 | 飞书管家直接以群ID、owner open_id和建群/拉群API推进；不能使用botId/secret冒用飞书应用身份 |
| 会话 / 代答 | 回复模式 | `substituteMode.replyMode` | 缺被代表者的原生身份/授权与第三方提及事件语义 | 暂无法支持 | 当前只认证真实发送者与本bot，不允许配置文字姓名制造代答身份或跨群会话 |
| 会话 / 代答 | 话题群代答 | `substituteMode.topicGroups` | 缺被代表者的原生身份/授权与第三方提及事件语义 | 暂无法支持 | 当前只认证真实发送者与本bot，不允许配置文字姓名制造代答身份或跨群会话 |
| 会话 / 代答 | 活跃话题跟进 | `substituteMode.topicActiveSessionTrigger` | 缺被代表者的原生身份/授权与第三方提及事件语义 | 暂无法支持 | 当前只认证真实发送者与本bot，不允许配置文字姓名制造代答身份或跨群会话 |
| 安全 / 触发人鉴权 | 触发人鉴权开关 | `triggerUserAuth.enabled` | 现有鉴权工具为lark-cli/bytedcli的飞书个人授权 | 暂无法支持 | 企微userid不等于飞书open_id；没有独立授权绑定，不能把企微发送者映射成任意飞书登录态 |
| 安全 / 触发人鉴权 | 鉴权工具 | `triggerUserAuth.tools` | 现有鉴权工具为lark-cli/bytedcli的飞书个人授权 | 暂无法支持 | 企微userid不等于飞书open_id；没有独立授权绑定，不能把企微发送者映射成任意飞书登录态 |
| 安全 / 触发人鉴权 | 鉴权回退策略 | `triggerUserAuth.fallback` | 现有鉴权工具为lark-cli/bytedcli的飞书个人授权 | 暂无法支持 | 企微userid不等于飞书open_id；没有独立授权绑定，不能把企微发送者映射成任意飞书登录态 |
| 安全 / 触发人鉴权 | 个人凭据来源 | `triggerUserAuth.credentialSource` | 现有鉴权工具为lark-cli/bytedcli的飞书个人授权 | 暂无法支持 | 企微userid不等于飞书open_id；没有独立授权绑定，不能把企微发送者映射成任意飞书登录态 |
| 安全 / 触发人鉴权 | 提及转交携带触发人 | `triggerUserAuth.delegateOnMention` | 现有鉴权工具为lark-cli/bytedcli的飞书个人授权 | 暂无法支持 | 企微userid不等于飞书open_id；没有独立授权绑定，不能把企微发送者映射成任意飞书登录态 |
| 安全 / 飞书工具绑定 | lark-cli绑定当前应用 | `larkToolBinding` | 当前通道无飞书应用appId/appSecret | 暂无法支持 | 仅有企微botId/secret，不能以此建立lark-cli应用绑定或透传飞书profile |
| 消息 / 卡片行为 | 置顶流式卡 | `pinStreamingCard` | 长连接SDK无已验证的会话置顶消息命令 | 暂无法支持 | 官方SDK列出的发送/更新消息不等同会话置顶；当前仅支持流式与模板卡更新 |
| 消息 / 卡片行为 | 静默轮次表态 | `silentTurnReactions` | 长连接SDK没有已验证的消息表态命令 | 暂无法支持 | 静默轮次保留零自动消息；不能用普通文字假装原生表态 |
| 消息 / 卡片行为 | 页脚语音 | `replyFooterVoice` | 当前回复链没有语音生成或音频产物绑定 | 暂无法支持 | 官方原生支持媒体发送；缺的是Botmux此通道的语音产物与上传回执，不是平台不支持语音 |
| 消息 / 卡片行为 | 代答按钮 | `hiddenStreamingCardButtons.substitute` | 企业微信任务卡片没有代答按钮，隐藏按钮选项里也不列它 | 暂无法支持 | 原先的代答草稿按钮与 `native.substitutePrompt` 已移除（飞书没有对应能力）；旧卡片上残留的点击静默忽略。业务设置里的显式协助代答（`substituteMode`、/assist）也已于同日随本地业务模块移除 |
| 消息 / 转人工 | 提单人身份来源 | `oncallGroup.identitySource` | 现有业务转人工服务要求飞书群API与提单人邮箱映射 | 暂无法支持 | 当前企微bot身份未获得群创建/成员管理与统一身份应用凭据；不能仅复用飞书oc_/ou_或业务secret来创建企微人工群 |
| 消息 / 转人工 | 业务线ID | `oncallTarget.tenantId` | 现有业务转人工服务要求飞书群API与提单人邮箱映射 | 暂无法支持 | 当前企微bot身份未获得群创建/成员管理与统一身份应用凭据；不能仅复用飞书oc_/ou_或业务secret来创建企微人工群 |
| 消息 / 转人工 | 受理区域 | `oncallTarget.region` | 现有业务转人工服务要求飞书群API与提单人邮箱映射 | 暂无法支持 | 当前企微bot身份未获得群创建/成员管理与统一身份应用凭据；不能仅复用飞书oc_/ou_或业务secret来创建企微人工群 |
| 消息 / 转人工 | 问题分类 | `oncallTarget.typeId` | 现有业务转人工服务要求飞书群API与提单人邮箱映射 | 暂无法支持 | 当前企微bot身份未获得群创建/成员管理与统一身份应用凭据；不能仅复用飞书oc_/ou_或业务secret来创建企微人工群 |
| 消息 / 转人工 | 服务凭据 | `oncallServiceSecret` | 现有业务转人工服务要求飞书群API与提单人邮箱映射 | 暂无法支持 | 当前企微bot身份未获得群创建/成员管理与统一身份应用凭据；不能仅复用飞书oc_/ou_或业务secret来创建企微人工群 |
| 消息 / 转人工 | 人工平台地址 | `oncallConnection.endpoint` | 现有业务转人工服务要求飞书群API与提单人邮箱映射 | 暂无法支持 | 当前企微bot身份未获得群创建/成员管理与统一身份应用凭据；不能仅复用飞书oc_/ou_或业务secret来创建企微人工群 |
| 消息 / 转人工 | 邮箱域 | `oncallConnection.emailDomain` | 现有业务转人工服务要求飞书群API与提单人邮箱映射 | 暂无法支持 | 当前企微bot身份未获得群创建/成员管理与统一身份应用凭据；不能仅复用飞书oc_/ou_或业务secret来创建企微人工群 |
| 消息 / 转人工 | 统一身份应用 | `oncallIdentity.appId` | 现有业务转人工服务要求飞书群API与提单人邮箱映射 | 暂无法支持 | 当前企微bot身份未获得群创建/成员管理与统一身份应用凭据；不能仅复用飞书oc_/ou_或业务secret来创建企微人工群 |
| 消息 / 转人工 | 统一身份凭据 | `oncallIdentity.appSecret` | 现有业务转人工服务要求飞书群API与提单人邮箱映射 | 暂无法支持 | 当前企微bot身份未获得群创建/成员管理与统一身份应用凭据；不能仅复用飞书oc_/ou_或业务secret来创建企微人工群 |
| 消息 / 转人工 | 统一身份平台 | `oncallIdentity.brand` | 现有业务转人工服务要求飞书群API与提单人邮箱映射 | 暂无法支持 | 当前企微bot身份未获得群创建/成员管理与统一身份应用凭据；不能仅复用飞书oc_/ou_或业务secret来创建企微人工群 |
| 常用 / 工作目录 | 入群自动启动 | `autoStartOnGroupJoin` | 首次触达初始化已移除 | 暂无法支持 | 已于 2026-11-25 移除：群里首条已授权消息按普通消息处理；配置里的旧键解析时丢弃，state 里旧的首次触达记录不再读取 |
| 常用 / 工作目录 | 入群启动指令 | `autoStartOnGroupJoinPrompt` | 首次触达初始化已移除 | 暂无法支持 | 已于 2026-11-25 移除：群里首条已授权消息按普通消息处理；配置里的旧键解析时丢弃，state 里旧的首次触达记录不再读取 |
| 常用 / 工作目录 | 入群初始消息 | `autoStartOnGroupJoinSeed` | 首次触达初始化已移除 | 暂无法支持 | 已于 2026-11-25 移除：群里首条已授权消息按普通消息处理；配置里的旧键解析时丢弃，state 里旧的首次触达记录不再读取 |
| 常用 / 工作目录 | 入群命令开关 | `groupJoinCommandEnabled` | 首次触达初始化已移除 | 暂无法支持 | 已于 2026-11-25 移除：群里首条已授权消息按普通消息处理；配置里的旧键解析时丢弃，state 里旧的首次触达记录不再读取 |
| 常用 / 工作目录 | 入群命令 | `groupJoinCommand` | 首次触达初始化已移除 | 暂无法支持 | 已于 2026-11-25 移除：群里首条已授权消息按普通消息处理；配置里的旧键解析时丢弃，state 里旧的首次触达记录不再读取 |
| 常用 / 工作目录 | 自动启动排除群 | `autoStartExcludedChats` | 首次触达初始化已移除 | 暂无法支持 | 已于 2026-11-25 移除：群里首条已授权消息按普通消息处理；配置里的旧键解析时丢弃，state 里旧的首次触达记录不再读取 |
| 会话 / 模式 | 群提及模式 | `regularGroupMentionMode` | 群消息入站策略已移除 | 暂无法支持 | 已于 2026-11-25 移除：投递来的群消息一律处理（原默认行为）；配置里的旧键解析时丢弃 |
| 会话 / 模式 | 群负责人 | `chatManagerEnabled` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 模式 | 群秘书 | `groupSecretaryEnabled` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 模式 | 会话群分组模式 | `sessionGroupTag.mode` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 模式 | 会话群标签名 | `sessionGroupTag.name` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 模式 | 已关闭群标签名 | `sessionGroupTag.closedName` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 模式 | 历史跳转修复 | `sessionGroupTag.repair` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 管家 | 管家开关 | `steward.enabled` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 管家 | 管家群 | `steward.chatId` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 管家 | 拍板卡片 | `steward.decisionCards` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 管家 | 巡检关闭提示 | `steward.closeHints` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 管家 | 子任务进度提示 | `steward.taskHints` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 管家 | 管家指引追加方式 | `steward.guideMode` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 管家 | 管家指引文本 | `steward.guideText` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 代答 | 代答开关 | `substituteMode.enabled` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 代答 | 代答目标与身份 | `substituteMode.targets` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 代答 | 目标群 | `substituteMode.chats` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 代答 | 排除群 | `substituteMode.excludedChats` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 代答 | 代答身份说明 | `substituteMode.disclosure` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 代答 | 禁用控制卡片 | `substituteMode.disableControlCard` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 会话 / 代答 | 触发关键词 | `substituteMode.keywords` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 安全 / 授权 | 限制授权命令 | `restrictGrantCommands` | 授权限制开关已移除 | 暂无法支持 | 已于 2026-11-25 移除：固定只有允许用户能授权；被授权的人不能再给别人授权，带派生关系的旧授权失效 |
| 安全 / 授权 | 委托授权机器人 | `grantDelegateBots` | 委托授权已移除 | 暂无法支持 | 已于 2026-11-25 移除（连同 /delegate）：同机互信只用于同目录拉起与额度耗尽交接，不传递任何权限；带委托来源的旧授权失效 |
| 安全 / 斜杠命令 | 原生斜杠菜单同步与删除 | `slashCommands.sync/delete` | 帮助卡开关已移除 | 暂无法支持 | 已于 2026-11-25 移除开关：/help、/commands 固定回帮助卡（内容由命令表生成），发卡不可用时回文字；不注册企微客户端原生斜杠菜单 |
| 消息 / 卡片行为 | 仅相关人可见卡片 | `privateCard` | 群内任务改私聊投递已移除 | 暂无法支持 | 已于 2026-11-25 移除：群任务的过程、结果与卡片一律发回原群；终端链接、申请卡转投等仍走私聊；带私聊投递标记的旧任务按普通任务发回来源会话 |
| 消息 / 卡片行为 | 原生思考展示 | `replyCardNativeCot` | 最终思考摘要已移除 | 暂无法支持 | 已于 2026-11-25 移除：最终回复不再拼思考摘要；执行过程中的思考仍由 cotEnabled 控制 |
| 消息 / 回复样式 | 主题 | `replyStyle.theme` | 回复样式已移除 | 暂无法支持 | 已于 2026-11-25 移除：最终回答固定为 Markdown 正文；配置里的旧键解析时丢弃 |
| 消息 / 回复样式 | 布局壳 | `replyStyle.layout` | 回复样式已移除 | 暂无法支持 | 已于 2026-11-25 移除：最终回答固定为 Markdown 正文；配置里的旧键解析时丢弃 |
| 消息 / 回复样式 | 回复配方 | `replyStyle.recipes` | 回复样式已移除 | 暂无法支持 | 已于 2026-11-25 移除：最终回答固定为 Markdown 正文；配置里的旧键解析时丢弃 |
| 消息 / 回复样式 | 配方提示 | `replyStyle.recipePrompt` | 回复样式已移除 | 暂无法支持 | 已于 2026-11-25 移除：最终回答固定为 Markdown 正文；配置里的旧键解析时丢弃 |
| 消息 / 回复样式 | 布局颜色 | `replyStyle.layoutColors` | 回复样式已移除 | 暂无法支持 | 已于 2026-11-25 移除：最终回答固定为 Markdown 正文；配置里的旧键解析时丢弃 |
| 消息 / 回复样式 | 布局标签 | `replyStyle.layoutTags` | 回复样式已移除 | 暂无法支持 | 已于 2026-11-25 移除：最终回答固定为 Markdown 正文；配置里的旧键解析时丢弃 |
| 消息 / 询问选项 | 询问选项布局 | `askOptionLayout` | 选项布局已移除 | 暂无法支持 | 已于 2026-11-25 移除：问答选项固定每页 4 个（原紧凑布局） |
| 消息 / 转人工 | 转人工开关 | `oncallGroup.enabled` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 消息 / 转人工 | 启用转人工群 | `oncallGroup.chatIds` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 消息 / 转人工 | 直接或分类建群 | `oncallGroup.flowMode` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 消息 / 转人工 | 表单展示方式 | `oncallGroup.formDisplay` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 消息 / 转人工 | 消息转发方式 | `oncallGroup.forwardMode` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 消息 / 转人工 | 按钮展示时机 | `oncallGroup.button.timing` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 消息 / 转人工 | 最少轮次 | `oncallGroup.button.minTurns` | 本地业务模块已整体移除 | 暂无法支持 | 已于 2026-11-25 移除（群负责人、会话秘书、本地会话目录、事项账本、转交受理、显式协助一并移除，连同 /business、/assist）；配置里的 business 段解析时丢弃，state 里的旧业务数据不读不删，旧卡片上的业务按钮点击静默忽略 |
| 高级 / 回复投递 | send或转写投递 | `replyDelivery` | 主动发送通道已移除 | 暂无法支持 | 已于 2026-11-25 移除（连同 botmux send --wecom-delivery）：固定自动回包；带主动发送记录的旧任务按自动回包处理 |

## ✅ 已实现（164 项）

按原配置组顺序排列。

### 已实现（第 1—100 项）

| 配置组 | 飞书配置项 | 真实字段 / 操作 | 企业微信对应实现 | 状态 | 验证 / 限制 |
| --- | --- | --- | --- | --- | --- |
| 页头 | 备注名 | `displayName` | 企微本地备注名→共享名片身份区 | 已实现 | 独立真实HTTP网络test：编辑名字、PATCH、已提交配置与实际渲染三者一致 |
| 页头 | 开放平台后台链接 | `console` | 固定的企业微信管理后台入口 `https://work.weixin.qq.com/wework_admin/` → 配置页名片链接（无配置项；帮助卡不带此链接） | 已实现 | B：只有官方管理通用入口；需真人登录，不按 botId 推算机器人详情深链；验证：wecom-dashboard-shared-session-ui |
| 常用 / Agent | CLI | `cliId` | managedCore.cli → core-only normal parser → sessionAgentConfig | 已实现 | wecom-bot-profile.test.ts：Codex/Claude真实托管子进程、registry与启动冻结；两CLI通过 |
| 常用 / Agent | 默认模型 | `model` | managedCore.model → BOTMUX_CORE_MODEL → CLI启动模型 | 已实现 | wecom-bot-profile.test.ts：Codex/Claude真实子进程从已保存模型生成launch |
| 常用 / Agent | 思考强度 | `reasoningEffort` | managedCore.botConfig.reasoningEffort → 会话首次启动冻结 | 已实现 | wecom-bot-profile.test.ts：真实子进程launch.reasoningEffort=high |
| 常用 / Agent | 服务等级 | `serviceTier` | managedCore.botConfig.serviceTier → Codex会话启动配置 | 已实现 | wecom-bot-profile.test.ts：真实子进程launch.serviceTier=priority |
| 常用 / Agent | 模型后端版本 | `modelBackendVariant` | TraeX bot级后端变体→实际sessionAgentConfig.modelBackendVariant | 已实现 | 隔离consumer探针保存max并在TraeX launch取到max；共享traex-auto-model测试通过 |
| 常用 / Agent | 单轮执行预算 | `turnTimeoutMs` | 公共CLI特有参数→registry→共享Worker init→对应适配器 | 已实现 | 隔离consumer探针123000ms/qa/tui保持；worker-pool init直接读取，dsh-runner-args与runtime配置测试通过 |
| 常用 / Agent | CLI配置目录 | `cliConfigDir` | managedCore.botConfig.cliConfigDir → Claude配置目录冻结 | 已实现 | wecom-bot-profile.test.ts：Claude真实子进程launch.cliConfigDir匹配已保存目录 |
| 常用 / Agent | 技能注入方式 | `skillInjection` | botConfig.skillInjection→公共技能注入解析 | 已实现 | 配置沿core-only normal parser与Worker传递；skill-injection-mode/session-skill-injection行为测试通过 |
| 常用 / Agent | 自定义运行时ID | `cliRuntime.id` | 结构化CLI运行时→自动downgrade shadow→公共运行时冻结/探测 | 已实现 | 独立policy只传cliRuntime可保存且清除同步清shadow；并发真实probe用指定可执行文件；cli-runtime行为测试通过 |
| 常用 / Agent | 运行时显示名 | `cliRuntime.displayName` | 结构化CLI运行时→自动downgrade shadow→公共运行时冻结/探测 | 已实现 | 独立policy只传cliRuntime可保存且清除同步清shadow；并发真实probe用指定可执行文件；cli-runtime行为测试通过 |
| 常用 / Agent | 运行时可执行文件 | `cliRuntime.executable` | 结构化CLI运行时→自动downgrade shadow→公共运行时冻结/探测 | 已实现 | 独立policy只传cliRuntime可保存且清除同步清shadow；并发真实probe用指定可执行文件；cli-runtime行为测试通过 |
| 常用 / Agent | 更新来源 | `cliRuntime.update.provider` | 结构化CLI运行时→自动downgrade shadow→公共运行时冻结/探测 | 已实现 | 独立policy只传cliRuntime可保存且清除同步清shadow；并发真实probe用指定可执行文件；cli-runtime行为测试通过 |
| 常用 / Agent | 更新npm包名 | `cliRuntime.update.packageName` | 结构化CLI运行时→自动downgrade shadow→公共运行时冻结/探测 | 已实现 | 独立policy只传cliRuntime可保存且清除同步清shadow；并发真实probe用指定可执行文件；cli-runtime行为测试通过 |
| 常用 / Agent | 旧可执行路径 | `cliPathOverride` | 结构化CLI运行时→自动downgrade shadow→公共运行时冻结/探测 | 已实现 | 独立policy只传cliRuntime可保存且清除同步清shadow；并发真实probe用指定可执行文件；cli-runtime行为测试通过 |
| 常用 / Agent | CLI启动前缀 | `wrapperCli` | 选择key由公共CLI resolver解析为底层CLI与wrapper；切回原生清理 | 已实现 | shared Agent→真实WecomDashboardConfig：aiden-x-codex保存为aiden x codex，切回codex无残留；真实child launch消费验证 |
| 常用 / Agent | Forge TraeX启动模式 | `cliLaunchMode` | Forge TraeX选择key→traex+forge-traex模式 | 已实现 | shared Agent→真实service选择forge-x-traex保存底层traex+模式；公共启动解析消费 |
| 常用 / Agent | Codex配置层 | `codexProfile` | 连接专属目录探测→正常Codex配置层→共享会话冻结 | 已实现 | 独立并发source-a/b真实profiles子进程不串源/凭据；codex-profiles行为通过；保留共享launch兼容约束 |
| 常用 / Agent | 子Agent模型继承方式 | `nativeSubagentRuntime.model.mode` | TraeX公共原生子Agent策略：未指定继承，custom按配置重写 | 已实现 | 隔离consumer探针从企微PATCH到registry策略保持；native-subagent-runtime-policy真实rewrite矩阵通过 |
| 常用 / Agent | 子Agent指定模型 | `nativeSubagentRuntime.model.value` | TraeX公共原生子Agent策略：未指定继承，custom按配置重写 | 已实现 | 隔离consumer探针从企微PATCH到registry策略保持；native-subagent-runtime-policy真实rewrite矩阵通过 |
| 常用 / Agent | 子Agent思考强度继承方式 | `nativeSubagentRuntime.reasoningEffort.mode` | TraeX公共原生子Agent策略：未指定继承，custom按配置重写 | 已实现 | 隔离consumer探针从企微PATCH到registry策略保持；native-subagent-runtime-policy真实rewrite矩阵通过 |
| 常用 / Agent | 子Agent指定思考强度 | `nativeSubagentRuntime.reasoningEffort.value` | TraeX公共原生子Agent策略：未指定继承，custom按配置重写 | 已实现 | 隔离consumer探针从企微PATCH到registry策略保持；native-subagent-runtime-policy真实rewrite矩阵通过 |
| 常用 / Agent | dsh配置 | `dshProfile` | 公共CLI特有参数→registry→共享Worker init→对应适配器 | 已实现 | 隔离consumer探针123000ms/qa/tui保持；worker-pool init直接读取，dsh-runner-args与runtime配置测试通过 |
| 常用 / Agent | dsh运行时 | `dshRuntime` | 公共CLI特有参数→registry→共享Worker init→对应适配器 | 已实现 | 隔离consumer探针123000ms/qa/tui保持；worker-pool init直接读取，dsh-runner-args与runtime配置测试通过 |
| 常用 / Agent | Riff服务地址 | `riff.baseUrl` | 共享Riff远程后端配置→Worker/RiffBackend | 已实现 | 连接配置使用normal BotConfig与同名后端；riff-backend行为回归通过；JWT环境变量须由主机/本bot安全配置提供，不使用企微secret |
| 常用 / Agent | Riff模型 | `riff.model` | 共享Riff远程后端配置→Worker/RiffBackend | 已实现 | 连接配置使用normal BotConfig与同名后端；riff-backend行为回归通过；JWT环境变量须由主机/本bot安全配置提供，不使用企微secret |
| 常用 / Agent | Riff思考强度 | `riff.reasoningEffort` | 共享Riff远程后端配置→Worker/RiffBackend | 已实现 | 连接配置使用normal BotConfig与同名后端；riff-backend行为回归通过；JWT环境变量须由主机/本bot安全配置提供，不使用企微secret |
| 常用 / Agent | Riff沙箱集群 | `riff.sandboxCluster` | 共享Riff远程后端配置→Worker/RiffBackend | 已实现 | 连接配置使用normal BotConfig与同名后端；riff-backend行为回归通过；JWT环境变量须由主机/本bot安全配置提供，不使用企微secret |
| 常用 / Agent | Riff鉴权环境变量名 | `riff.jwtEnv` | 共享Riff远程后端配置→Worker/RiffBackend | 已实现 | 连接配置使用normal BotConfig与同名后端；riff-backend行为回归通过；JWT环境变量须由主机/本bot安全配置提供，不使用企微secret |
| 常用 / Agent | Riff系统提示 | `riff.systemPrompt` | 共享Riff远程后端配置→Worker/RiffBackend | 已实现 | 连接配置使用normal BotConfig与同名后端；riff-backend行为回归通过；JWT环境变量须由主机/本bot安全配置提供，不使用企微secret |
| 常用 / Agent | Riff初始化命令 | `riff.setupCommands` | 共享Riff远程后端配置→Worker/RiffBackend | 已实现 | 连接配置使用normal BotConfig与同名后端；riff-backend行为回归通过；JWT环境变量须由主机/本bot安全配置提供，不使用企微secret |
| 常用 / Agent | TraeX自动模型开关 | `traexAutoModel.enabled` | 公共TraeX模型池/负载预检与切换控制器 | 已实现 | 隔离consumer从PATCH池alpha/beta生成launch.model=alpha并保留池/冷却/每轮重选；共享traex-auto-model行为回归通过 |
| 常用 / Agent | 模型优先池 | `traexAutoModel.models` | 公共TraeX模型池/负载预检与切换控制器 | 已实现 | 隔离consumer从PATCH池alpha/beta生成launch.model=alpha并保留池/冷却/每轮重选；共享traex-auto-model行为回归通过 |
| 常用 / Agent | 自动模型触发条件 | `traexAutoModel.trigger` | 公共TraeX模型池/负载预检与切换控制器 | 已实现 | 隔离consumer从PATCH池alpha/beta生成launch.model=alpha并保留池/冷却/每轮重选；共享traex-auto-model行为回归通过 |
| 常用 / Agent | 每模型思考强度与后端版本 | `traexAutoModel.modelSettings` | 公共TraeX模型池/负载预检与切换控制器 | 已实现 | 隔离consumer从PATCH池alpha/beta生成launch.model=alpha并保留池/冷却/每轮重选；共享traex-auto-model行为回归通过 |
| 常用 / Agent | 排队超时 | `traexAutoModel.queueTimeoutMs` | 公共TraeX模型池/负载预检与切换控制器 | 已实现 | 隔离consumer从PATCH池alpha/beta生成launch.model=alpha并保留池/冷却/每轮重选；共享traex-auto-model行为回归通过 |
| 常用 / Agent | 模型切换冷却 | `traexAutoModel.switchCooldownMs` | 公共TraeX模型池/负载预检与切换控制器 | 已实现 | 隔离consumer从PATCH池alpha/beta生成launch.model=alpha并保留池/冷却/每轮重选；共享traex-auto-model行为回归通过 |
| 常用 / Agent | 每轮重选模型 | `traexAutoModel.reselectPerTurn` | 公共TraeX模型池/负载预检与切换控制器 | 已实现 | 隔离consumer从PATCH池alpha/beta生成launch.model=alpha并保留池/冷却/每轮重选；共享traex-auto-model行为回归通过 |
| 常用 / Agent | 模型容量预检 | `traexAutoModel.preflightLoadCheck` | 公共TraeX模型池/负载预检与切换控制器 | 已实现 | 隔离consumer从PATCH池alpha/beta生成launch.model=alpha并保留池/冷却/每轮重选；共享traex-auto-model行为回归通过 |
| 常用 / Agent | 过载阈值 | `traexAutoModel.overloadThresholdPercent` | 公共TraeX模型池/负载预检与切换控制器 | 已实现 | 隔离consumer从PATCH池alpha/beta生成launch.model=alpha并保留池/冷却/每轮重选；共享traex-auto-model行为回归通过 |
| 常用 / Agent | 容量预检超时 | `traexAutoModel.preflightTimeoutMs` | 公共TraeX模型池/负载预检与切换控制器 | 已实现 | 隔离consumer从PATCH池alpha/beta生成launch.model=alpha并保留池/冷却/每轮重选；共享traex-auto-model行为回归通过 |
| 常用 / Agent | 未知负载策略 | `traexAutoModel.unknownLoadPolicy` | 公共TraeX模型池/负载预检与切换控制器 | 已实现 | 隔离consumer从PATCH池alpha/beta生成launch.model=alpha并保留池/冷却/每轮重选；共享traex-auto-model行为回归通过 |
| 常用 / Agent | 全池过载策略 | `traexAutoModel.allOverloadedPolicy` | 公共TraeX模型池/负载预检与切换控制器 | 已实现 | 隔离consumer从PATCH池alpha/beta生成launch.model=alpha并保留池/冷却/每轮重选；共享traex-auto-model行为回归通过 |
| 常用 / 工作目录 | 直接绑定工作目录 | `defaultWorkingDir` | 连接工作目录→core默认工作区→原子创建会话worktree | 已实现 | trigger-session-root-message：apiOnly无Lark调用的worktree创建与持久失败回滚两项通过；真实profile子进程工作目录一致 |
| 常用 / 工作目录 | 仓库选择模式 | `workingDir` | /repo 扫描连接工作目录下的 git 仓库（与飞书 /repo 同一扫描器、深度 3 与扫描上限）→ 序号/名称/相对路径选择 → 可信工作目录 → core 启动 | 已实现 | 仅操作权限且会话空闲时选择；真实路径需在工作根目录内且为本次扫描认出的仓库，符号链接越界拒绝；用已选仓库建新会话前按当前工作根目录再核实一次，不通过则清除选择并提示重选；重名须改用序号或相对路径；群内只显示名称、分支与相对路径；验证：wecom-native-repos |
| 常用 / 工作目录 | 自动worktree | `defaultWorkingDirAutoWorktree` | 连接工作目录→core默认工作区→原子创建会话worktree | 已实现 | trigger-session-root-message：apiOnly无Lark调用的worktree创建与持久失败回滚两项通过；真实profile子进程工作目录一致 |
| 常用 / 角色 | 团队角色 | `teamRole` | 以WecomConfig.role.content保存相同角色文本；不复用飞书团队身份 | 已实现 | wecom-config-live-policy.test.ts：首轮/后续轮与中途改角色行为验证；团队预设另受限制 |
| 常用 / 角色 | 角色注入方式 | `role.injectMode` | WecomConfig.role.injectMode → bridge按会话首轮/每轮冻结instruction | 已实现 | wecom-config-live-policy.test.ts：已准入旧角色不被篡改，新会话once注入新角色 |
| 会话 / 模式 | 私聊模式 | `p2pMode` | native原地私聊会话（chat） | 已实现 | 独立routing/policy验证同一真实userid连续对话；只开放chat，不提供私聊自动建群group子值 |
| 会话 / 模式 | 普通群回复模式 | `regularGroupReplyMode` | native按成员独立user / 全群共享chat两种路由 | 已实现 | 独立routing：旧任务在途换模式不重复派发、本人旧任务仍可stop、共享续话与模式epoch重启隔离通过；不提供话题topic子值 |
| 会话 / 指令触发 | 指令触发开关 | `commandTrigger.enabled` | native网关命令模板独立配置开关 | 已实现 | wecom-command-trigger+独立policy：已接纳模板保持冻结，关闭后新消息不触发 |
| 会话 / 指令触发 | 触发命令 | `commandTrigger.commands[].cmd` | 复用命令schema校验保留命令与透传冲突 | 已实现 | wecom-command-trigger：/stop、原生透传、自定义透传、非法命令都在写边界拒绝 |
| 会话 / 指令触发 | 触发提示词 | `commandTrigger.commands[].prompt` | 命令参数→配置模板→可信gateway持久请求 | 已实现 | 独立policy：保存后修改模板不篡改已接纳输入，{args}保留原大小写；重复messageId不重派 |
| 会话 / 指令触发 | 触发群范围 | `commandTrigger.chats` | 按企微原生chatid限制模板触发范围 | 已实现 | wecom-command-trigger：指定群/其他群/未授权用户场景验证；不使用飞书oc_ |
| 会话 / 指令触发 | 排除群 | `commandTrigger.excludedChats` | native排除群deny-wins | 已实现 | 独立policy与wecom-command-trigger：同群既在允许也在排除时不触发，旧已接纳任务仍完整结算 |
| 会话 / 跨机器人 | 跨机器人同目录 | `botToBotSameDir` | 同机互信（默认开）→ 新会话在受信连接为同一会话选定的仓库里启动 | 已实现 | 互信：对方未关闭「信任同一 owner 的同机 Bot」（默认开），且本连接允许用户全部是对方允许用户；目录须是本连接工作根内扫描到的仓库，冲突时提示 /repo；每步按当时配置重判；验证：wecom-peer-trust / wecom-native-repos |
| 会话 / 驻留 | 最大驻留Worker数 | `maxLiveWorkers` | bot配置→daemon enforce cap与共享idle-worker-sweeper | 已实现 | 真实core registry保留值；idle-worker-sweeper行为测试通过，apiOnly未旁路cap |
| 会话 / 驻留 | 空闲挂起分钟数 | `idleSuspendMinutes` | bot配置→daemon idleTtlMs与共享空闲挂起 | 已实现 | 真实core registry保留值；idle-worker-sweeper与idle-suspend-cli行为测试通过 |
| 会话 / Codex归档 | 关闭时归档Codex原生会话 | `archiveCodex` | core-only本地Codex关闭仍走共享归档控制器 | 已实现 | wecom-bot-profile真实读取+codex-cleanup-archive行为测试通过；仅owned local pty/tmux，采用/远端/scratch不适用 |
| 会话 / 提示缓存 | 缓存TTL | `promptCache.ttl` | 共享Claude配置TTL经core-only加载、Worker init注入promptCacheTtl | 已实现 | wecom-bot-profile真实子进程+prompt-cache-policy/keepalive/gate三组行为测试通过；只对Claude有效 |
| 会话 / 提示缓存 | 空闲缓存保活 | `promptCache.keepalive.enabled` | 共享daemon空闲sweep按bot策略发保活轮 | 已实现 | prompt-cache-keepalive/gate真实策略与空闲状态测试通过；core-only未旁路该sweep |
| 会话 / 提示缓存 | 保活空闲阈值 | `promptCache.keepalive.idleMinutes` | 共享保活控制器空闲窗口 | 已实现 | prompt-cache-keepalive与policy行为测试通过；继承/覆盖同飞书 |
| 会话 / 提示缓存 | 最多保活次数 | `promptCache.keepalive.maxPings` | 共享保活每空闲段次数上限 | 已实现 | prompt-cache-keepalive/gate次数/重入行为通过 |
| 会话 / 提示缓存 | 保活时段 | `promptCache.keepalive.activeHours` | 共享保活控制器本地时间窗口 | 已实现 | prompt-cache-policy/keepalive时段判定行为通过 |
| 会话 / 提示缓存 | 保活最小上下文 | `promptCache.keepalive.minContextTokens` | 共享保活上下文阈值 | 已实现 | prompt-cache-keepalive/gate行为测试通过 |
| 会话 / 启动命令 | 启动后执行命令 | `startupCommands` | 共享文本编辑器↔命令数组双向转换→Worker启动命令 | 已实现 | shared Agent真实service保存两行指令后数组与UI回显一致；真实child launch保留命令 |
| 会话 / 群消息总结 | 总结消息数 | `summaryRange.limit` | /summary → 当前已准入路由的本地观测消息窗口 | 已实现 | B：未配置时与飞书一致取最近 50 条；企微读不到群历史，只总结本机器人经手的对话；验证：wecom-native-platform |
| 会话 / 群消息总结 | 总结时间窗口 | `summaryRange.sinceHours` | /summary → 当前已准入路由的本地观测消息窗口 | 已实现 | B：未配置时与飞书一致取最近 24 小时；不读取未投递的全群历史或其他人的隔离会话；验证：wecom-native-platform |
| 会话 / 群消息总结 | 总结记忆开关 | `summaryMemory` | 本地摘要游标与滚动记忆 → 当前会话实际工作区 Markdown | 已实现 | B：只保存已观测范围摘要；相对路径限制在选定工作区，拒绝路径穿越与符号链接逃逸；验证：wecom-native-platform |
| 会话 / 群消息总结 | 总结记忆路径 | `summaryMemoryPath` | 本地摘要游标与滚动记忆 → 当前会话实际工作区 Markdown | 已实现 | B：只保存已观测范围摘要；相对路径限制在选定工作区，拒绝路径穿越与符号链接逃逸；验证：wecom-native-platform |
| 安全 / 文件沙盒 | 文件沙盒模式 | `sandboxMode` | UI模式转换为botConfig.sandbox → freezeSessionSandboxDecision | 已实现 | wecom-bot-profile.test.ts：真实子进程session.sandbox=true |
| 安全 / 文件沙盒 | 旧沙盒兼容开关 | `sandbox` | 兼容开关转换为共享文件沙盒模式 | 已实现 | wecom-bot-profile.test.ts：已保存sandbox=true被冻结到实际会话 |
| 安全 / 文件沙盒 | Scratch存储 | `scratchStorage` | 公共Scratch存储与拒绝路径→freezeSessionSandboxDecision | 已实现 | 隔离consumer真实冻结scratch/tmpfs128M/deny；Linux tmpfs/disk，macOS保留公共APFS限制；部分API字段飞书也无编辑控件 |
| 安全 / 文件沙盒 | Scratch内存盘大小 | `scratchTmpfsSizeMb` | 公共Scratch存储与拒绝路径→freezeSessionSandboxDecision | 已实现 | 隔离consumer真实冻结scratch/tmpfs128M/deny；Linux tmpfs/disk，macOS保留公共APFS限制；部分API字段飞书也无编辑控件 |
| 安全 / 文件沙盒 | Scratch拒绝路径 | `scratchDenyPaths` | 公共Scratch存储与拒绝路径→freezeSessionSandboxDecision | 已实现 | 隔离consumer真实冻结scratch/tmpfs128M/deny；Linux tmpfs/disk，macOS保留公共APFS限制；部分API字段飞书也无编辑控件 |
| 安全 / 文件沙盒 | 旧跨Bot读取隔离 | `readIsolation` | 旧读取隔离设置由公共CLI/后端能力门控 | 已实现 | normal parser/Worker公共read-isolation消费，保留CLI/平台/wrapper支持限制；不把旧标志当文件沙盒替代 |
| 安全 / 网络策略 | 公网策略 | `sandboxNetworkPolicy.public.mode` | 公共版本化网络策略→会话冻结→网络执行器 | 已实现 | 隔离consumer从企微PATCH到真实freeze保留allowlist/端口/DNS；sandbox-network-policy行为测试通过；Linux执行，macOS能力提示同共享实现 |
| 安全 / 网络策略 | 公网CIDR/协议/端口/拒绝规则 | `sandboxNetworkPolicy.public.rules` | 公共版本化网络策略→会话冻结→网络执行器 | 已实现 | 隔离consumer从企微PATCH到真实freeze保留allowlist/端口/DNS；sandbox-network-policy行为测试通过；Linux执行，macOS能力提示同共享实现 |
| 安全 / 网络策略 | 内网策略 | `sandboxNetworkPolicy.private.mode` | 公共版本化网络策略→会话冻结→网络执行器 | 已实现 | 隔离consumer从企微PATCH到真实freeze保留allowlist/端口/DNS；sandbox-network-policy行为测试通过；Linux执行，macOS能力提示同共享实现 |
| 安全 / 网络策略 | 内网CIDR/协议/端口/拒绝规则 | `sandboxNetworkPolicy.private.rules` | 公共版本化网络策略→会话冻结→网络执行器 | 已实现 | 隔离consumer从企微PATCH到真实freeze保留allowlist/端口/DNS；sandbox-network-policy行为测试通过；Linux执行，macOS能力提示同共享实现 |
| 安全 / 网络策略 | DNS服务器 | `sandboxNetworkPolicy.dnsServers` | 公共版本化网络策略→会话冻结→网络执行器 | 已实现 | 隔离consumer从企微PATCH到真实freeze保留allowlist/端口/DNS；sandbox-network-policy行为测试通过；Linux执行，macOS能力提示同共享实现 |
| 安全 / 网络策略 | 代理出口策略 | `sandboxNetworkPolicy.proxyMode` | 公共版本化网络策略→会话冻结→网络执行器 | 已实现 | 隔离consumer从企微PATCH到真实freeze保留allowlist/端口/DNS；sandbox-network-policy行为测试通过；Linux执行，macOS能力提示同共享实现 |
| 安全 / Codex凭据 | Codex共享或隔离凭据 | `codexAuthSync` | Codex共享/隔离凭据模式→公共Worker身份目录 | 已实现 | core-only profile到normal parser冻结链复用；仅Codex，isolated不读共享登录态，与飞书同语义 |
| 安全 / 沙盒路径 | 读写路径白名单 | `sandboxPaths.readWrite` | 公共沙盒路径白名单→normal parser→会话冻结 | 已实现 | 同deny共享路径消费；sandbox-paths-normalize与路径/预算校验回归通过，继承公共根目录/HOME禁写约束 |
| 安全 / 沙盒路径 | 只读路径白名单 | `sandboxPaths.readOnly` | 公共沙盒路径白名单→normal parser→会话冻结 | 已实现 | 同deny共享路径消费；sandbox-paths-normalize与路径/预算校验回归通过，继承公共根目录/HOME禁写约束 |
| 安全 / 沙盒路径 | 禁止路径 | `sandboxPaths.deny` | botConfig.sandboxPaths.deny → 冻结会话沙盒 | 已实现 | wecom-bot-profile.test.ts：真实子进程session.sandboxPaths.deny包含拒绝目录 |
| 安全 / 授权 | 开放私聊 | `p2pOpen` | native.p2pOpen → 未预授权私聊主体的 talk 准入 | 已实现 | 只授予普通对话能力；禁止自扩权、选仓、写终端和越权管理，封禁优先；验证：wecom-native-core |
| 安全 / 授权 | 自动授权请求卡片 | `autoGrantRequestCards` | native 授权策略 → /grant、/revoke、申请卡 → 持久 talk/operate 授权与任务额度 | 已实现 | 允许用户就是审批人（旧 `approverUsers` 名单解析时并入允许用户）；授权限时限额；验证：wecom-native-core |
| 安全 / 授权 | 请求转发owner私聊 | `grantRequestToOwnerDm` | 申请卡私聊发给私聊过机器人的允许用户 | 已实现 | 没有可私聊的允许用户时仍在原会话提示 /grant-approve；验证：wecom-native-core |
| 安全 / 授权 | 信任同owner机器人 | `trustSameOwnerBots` | 同机互信（默认开），替代手写双端信任 | 已实现 | 接收方未关开关、来源是本机另一条企微连接、来源允许用户非空且全部是接收方允许用户才接受；只用于同目录拉起与额度耗尽交接，不传递权限；无企业标识可比对，不同企业的同名 userid 是已知局限；验证：wecom-peer-trust |
| 安全 / 授权 | 默认授权时长 | `grantDefaultDurationMs` | 「授权与额度」里与飞书同款的下拉（1 小时 / 8 小时 / 1 天 / 7 天）→ /grant、申请卡生成的授权有效期 | 已实现 | 存储键与单位不变；配置里不在四档的旧值如实显示、打开页面不改写；允许用户就是审批人，被授权的人不能再授权；验证：wecom-native-core / dashboard-wecom-native-tiles |
| 安全 / 授权 | 默认消息配额 | `messageQuotaDefaultLimit` | 「授权与额度」里的消息额度覆盖（1–1000）→ 每次授权的任务额度 | 已实现 | 早先版本允许到 1000000：配置里已有的更大值照常解析、连接照常启动，新授权按 1000 执行，Dashboard 不接受新写入超过 1000 的值；验证：wecom-native-core / wecom-config-retired-keys / dashboard-wecom-native-tiles |
| 安全 / 授权 | 固定授权用户 | `allowedUsers` | WecomConfig.allowedUsers → 每次准入、await后及投递前实时校验 | 已实现 | wecom-config-live-policy.test.ts：Dashboard撤权与10秒轮询交叠立即interrupt，重启不重投 |
| 安全 / 黑名单 | 拒绝用户列表 | `blockedUsers` | WecomConfig.blockedUsers → native userid deny-wins | 已实现 | wecom-config-live-policy.test.ts：allowed与blocked重叠时拒绝准入、零trigger/回复 |
| 安全 / 斜杠命令 | 只读用户可用daemon命令 | `canTalkDaemonCommands` | 共用「Slash 命令」格里「额外透传命令」下面的 /status、/stop、/restart 三个勾选框（企业微信专属区块，值存在连接配置里） | 已实现 | 未配置时 /status、/stop 可用；验证：dashboard-wecom-native-tiles |
| 安全 / 斜杠命令 | 自定义透传命令 | `customPassthroughCommands` | native允许自定义斜杠→当前发送者既有会话→core.slash | 已实现 | 独立message：同一回调重放仅执行一次、撤除配置后拒绝；不开放飞书原生命令菜单 |
| 消息 / 卡片行为 | 统一回复卡模式 | `replyCardMode` | native流式统一/独立过程/仅最终结果三种呈现 | 已实现 | wecom-message-config-behavior+独立message真实bridge验证；不复制飞书Card2.0 JSON |
| 消息 / 卡片行为 | 禁用自动流式卡 | `disableStreamingCard` | gateway控制接纳提示与运行过程流式投递 | 已实现 | wecom-message-config-behavior正/负例；关闭仍保留最终结果 |
| 消息 / 卡片行为 | 目标状态卡 | `goalStatusCard` | 当前turn原生目标与累计CLI秒数展示在过程流中 | 已实现 | rememberCoreOnlyGoal+projectCoreOnlyProgress拒旧worker/attempt；bridge实际渲染；无独立周期PATCH卡 |

### 已实现（第 101—164 项）

| 配置组 | 飞书配置项 | 真实字段 / 操作 | 企业微信对应实现 | 状态 | 验证 / 限制 |
| --- | --- | --- | --- | --- | --- |
| 消息 / 卡片行为 | 可写终端链接 | `writableTerminalLinkInCard` | 原生卡动作 → 一次性本人私聊入口 → 独立只读/可写限时终端访问；「消息卡片」页「终端访问」格里的「在卡片中显示可操作终端」（默认关；值存在连接配置里） | 已实现 | 链接地址由 Dashboard 自己推导（`BOTMUX_PUBLIC_URL`，否则本机 Dashboard 地址），不按机器人配置；链接仅当前任务代次与会话有效，绑定真实主体并重验当前权限；写权另行兑换租约，不外发 Dashboard token/core secret；验证：wecom-native-terminal / wecom-terminal-authorization-cancel / wecom-converged-settings-behavior |
| 消息 / 卡片行为 | 耗时展示 | `showReplyTiming` | gateway以持久接纳/完成时间显示耗时 | 已实现 | message行为测试假时钟1.5秒、开关独立验证；为接纳至终态总耗时 |
| 消息 / 卡片行为 | 用量展示模式 | `usageDisplay` | 同源真实usage按过程/页脚/关闭选择展示 | 已实现 | core已接实际session usage snapshot；可用的context/累计/本轮值分别呈现；最终turn计数仍持久，关闭展示不改计数 |
| 消息 / 卡片行为 | 回复操作按钮 | `replyCardActions` | native模板卡按钮：只读终端、申请终端写权（需开启「在卡片中显示可操作终端」）、运行中的停止任务，以及结束后的查看输出、压缩上下文（CLI 支持时）、关闭会话 | 已实现 | native协议帧+独立callback/半写/旧卡控制负例通过；仅原请求者且实时ACL |
| 消息 / 卡片行为 | 思考过程 | `cotEnabled` | 受保护的当前turn进展→native流式思考文本 | 已实现 | message行为与独立隐私post-await变更负例通过；不冒充平台CoT气泡 |
| 消息 / 卡片行为 | 统一卡工具调用 | `replyCardShowTools` | 当前turn工具调用/结果过程展示开关 | 已实现 | message行为验证独立于思考开关；工具关闭后只剩叙述文本 |
| 消息 / 卡片行为 | 页脚开关 | `replyFooterEnabled` | native最终文本页脚总开关 | 已实现 | message行为逐项footer gates测试通过 |
| 消息 / 卡片行为 | 页脚品牌 | `replyFooterBrand` | 页脚品牌字段开关 | 已实现 | message行为distinct-brand独立显隐验证 |
| 消息 / 卡片行为 | 页脚模型 | `replyFooterModel` | 页脚显示当前已知的配置模型标签 | 已实现 | 独立开关显隐验证；仅模型名，未提供CLI内部临时切换的型号证明，不宣称完整飞书模型/推理/后端元数据 |
| 消息 / 卡片行为 | 页脚用量 | `replyFooterUsage` | 页脚真实本轮token用量开关 | 已实现 | message行为usage/footer/off与持久计数验证 |
| 消息 / 卡片行为 | 页脚接收人 | `replyFooterRecipients` | 页脚原生接收者userid字段开关 | 已实现 | message行为alice独立显隐验证；不是飞书open_id |
| 消息 / 卡片行为 | 输出按钮 | `hiddenStreamingCardButtons.output` | 原生卡输出动作 → 当前群已公开输出的有限展开 | 已实现 | B：不是任意 transcript 外链查看器；不扩展可见范围，不披露私聊结果或新受限内容；验证：wecom-card-actions-authority |
| 消息 / 卡片行为 | 终端按钮 | `hiddenStreamingCardButtons.terminal` | 卡片上的「只读终端」按钮随“回复操作按钮”出现；隐藏后网关不再显示它并拒绝点击 | 已实现 | 在「消息卡片」页的隐藏按钮里勾选，随连接配置保存；终端访问本身见“可写终端链接”“回复操作按钮”两行；验证：wecom-native-card-controls / wecom-message-config-protocol / wecom-bot-profile |
| 消息 / 卡片行为 | 可写链接按钮 | `hiddenStreamingCardButtons.writeLink` | 卡片上的「申请终端写权」按钮随“在卡片中显示可操作终端”出现；隐藏后网关不再显示它并拒绝点击 | 已实现 | 在「消息卡片」页的隐藏按钮里勾选，随连接配置保存；隐藏后卡片上不再提供终端写权，只读终端不受影响；验证：wecom-native-card-controls / wecom-message-config-protocol / wecom-bot-profile |
| 消息 / 卡片行为 | 压缩按钮 | `hiddenStreamingCardButtons.compact` | 原生卡压缩动作 → 当前 CLI /compact | 已实现 | 须操作权限、最新已完成任务、当前会话空闲且未锁定，并由 CLI 能力判定支持；旧卡及重放被拒；验证：wecom-card-actions-authority |
| 消息 / 卡片行为 | 停止按钮 | `hiddenStreamingCardButtons.stop` | native停止按钮可隐藏 | 已实现 | 行为测试隐藏stop后callback拒绝；跨bot/user/旧turn无法执行 |
| 消息 / 卡片行为 | 关闭按钮 | `hiddenStreamingCardButtons.close` | native关闭按钮可隐藏 | 已实现 | 原生模板卡close绑定当前会话generation；独立旧卡close负例通过 |
| 消息 / 卡片行为 | 安静预设 | `quietPreset` | 一次原子保存关闭思考、工具过程与自动流式 | 已实现 | dashboard-quiet-preset-ui原生用例验证恰好三个支持字段；不请求原生表态，不宣称飞书完整静默表情语义 |
| 消息 / 反馈 | 反馈开关 | `feedback.enabled` | native模板卡反馈→专用持久状态 | 已实现 | message行为启用/禁用与独立半写/ACK丢失/重启去重通过 |
| 消息 / 反馈 | 反馈受众 | `feedback.audience` | native requester/reviewers/everyone双层受众校验 | 已实现 | 当前gateway ACL且冻结/当前策略同时允许；everyone不授予别人任务控制权 |
| 消息 / 反馈 | 反馈评审人 | `feedback.reviewers` | native userid审核人列表 | 已实现 | 行为验证审核人移除立即拒绝、禁止通配符；不复用飞书ou_/on_邮箱解析 |
| 消息 / 反馈 | 反馈语义 | `feedback.visibleSemantics` | 原生模板卡反馈语义集合 | 已实现 | message行为定制positive/negative语义，实际卡片与允许callback一致 |
| 消息 / 反馈 | 反馈按钮 | `feedback.buttons` | 原生模板卡反馈按钮文字/键/语义/样式 | 已实现 | message行为定制标签与语义验证，协议真实发送button_interaction |
| 消息 / 反馈 | 负向反馈原因 | `feedback.negativeFollowup.reasons` | 原生回调后用户级负向原因卡 | 已实现 | message行为required原因与持久选项验证；事件重放不重复结算 |
| 消息 / 反馈 | 反馈评论规则 | `feedback.negativeFollowup.comment` | 显式/feedback任务ID评论，受当前ACL/冻结策略/长度上限保护 | 已实现 | message行为评论不新建CLI轮；启用/必填/placeholder/最大长度被使用；不冒充原生文本输入组件 |
| 消息 / 反馈 | 允许改选 | `feedback.allowReselect` | 历史已完成答案允许按策略改选反馈 | 已实现 | 独立历史反馈正例通过；旧答案控制动作仍拒绝，replay revision不增长 |
| 消息 / 反馈 | 按钮对齐 | `feedback.buttonAlign` | 固定使用客户端默认按钮布局（无配置项） | 已实现 | B：仅官方模板卡默认排列，不提供飞书任意左右对齐 |
| 消息 / 反馈 | 每聊天反馈覆盖 | `chatFeedbackPolicies` | native chatid 策略 → 本轮冻结规则与回调实时规则双重检查 | 已实现 | 与飞书一样只在配置文件维护，配置页不提供界面、保存其它项时原样保留；按群启停、请求者/指定 userid 审核者/已授权操作者范围；不套用飞书 oc_/ou_ 身份，撤权和旧代次均重验；验证：wecom-native-platform / wecom-card-publish-gates / dashboard-wecom-native-config-kept |
| 消息 / 反馈 | 反馈Webhook扩展 | `feedbackWebhooks` | 原生任务与反馈事件 → 同事务 outbox → 签名 HTTPS 投递 | 已实现 | 与飞书一样只在配置文件维护（含 secretRef 引用的密钥存储），配置页不提供界面、保存其它项时原样保留；校验 DNS/地址并按事件/反馈 revision 重试与去重；验证：wecom-native-platform / dashboard-wecom-native-config-kept |
| 消息 / 本地地址 | 隐藏本地路径与地址 | `hideLocalAddresses` | gateway进度与最终结果统一调用地址清洗器 | 已实现 | 独立message：等待进度时启用隐藏立即生效；本地路径/loopback/页脚均清洗 |
| 消息 / 品牌 | 自定义品牌标签 | `brandLabel` | bot级native页脚品牌标签 | 已实现 | message行为自定义品牌与关闭品牌字段验证；本地地址清洗也覆盖标签 |
| 高级 / 后端 | 会话后端 | `backendType` | 全部公共后端类型与herdr放置参数→core-only→公共Worker后端选择 | 已实现 | CORE_ONLY_BACKENDS与合成路径一致；herdr-placement-config行为测试通过；后端可用性/本机安装与沙盒兼容约束保留 |
| 高级 / herdr | 工作区 | `herdr.workspace` | 全部公共后端类型与herdr放置参数→core-only→公共Worker后端选择 | 已实现 | CORE_ONLY_BACKENDS与合成路径一致；herdr-placement-config行为测试通过；后端可用性/本机安装与沙盒兼容约束保留 |
| 高级 / herdr | 标签页 | `herdr.tab` | 全部公共后端类型与herdr放置参数→core-only→公共Worker后端选择 | 已实现 | CORE_ONLY_BACKENDS与合成路径一致；herdr-placement-config行为测试通过；后端可用性/本机安装与沙盒兼容约束保留 |
| 高级 / herdr | 会话名 | `herdr.sessionName` | 全部公共后端类型与herdr放置参数→core-only→公共Worker后端选择 | 已实现 | CORE_ONLY_BACKENDS与合成路径一致；herdr-placement-config行为测试通过；后端可用性/本机安装与沙盒兼容约束保留 |
| 高级 / herdr | 放置位置 | `herdr.placement` | 全部公共后端类型与herdr放置参数→core-only→公共Worker后端选择 | 已实现 | CORE_ONLY_BACKENDS与合成路径一致；herdr-placement-config行为测试通过；后端可用性/本机安装与沙盒兼容约束保留 |
| 高级 / herdr | 分屏方向 | `herdr.splitDirection` | 全部公共后端类型与herdr放置参数→core-only→公共Worker后端选择 | 已实现 | CORE_ONLY_BACKENDS与合成路径一致；herdr-placement-config行为测试通过；后端可用性/本机安装与沙盒兼容约束保留 |
| 高级 / herdr | 适用会话类型 | `herdr.chatTypes` | 全部公共后端类型与herdr放置参数→core-only→公共Worker后端选择 | 已实现 | CORE_ONLY_BACKENDS与合成路径一致；herdr-placement-config行为测试通过；后端可用性/本机安装与沙盒兼容约束保留 |
| 高级 / Codex App | 输入气泡去信封 | `codexAppCleanInput` | Codex App共享输入/浏览器工具配置→Worker init与浏览器broker | 已实现 | 浏览器布尔wire归一化与auto-approve对象合并已接；codex-browser-config行为测试通过；仅对应CLI适用 |
| 高级 / Codex App | 浏览器工具开关 | `codexBrowser` | Codex App共享输入/浏览器工具配置→Worker init与浏览器broker | 已实现 | 浏览器布尔wire归一化与auto-approve对象合并已接；codex-browser-config行为测试通过；仅对应CLI适用 |
| 高级 / Codex App | 自动批准来源 | `codexBrowserAutoApproveOrigins` | Codex App共享输入/浏览器工具配置→Worker init与浏览器broker | 已实现 | 浏览器布尔wire归一化与auto-approve对象合并已接；codex-browser-config行为测试通过；仅对应CLI适用 |
| 高级 / Codex App | 无进展提醒 | `noProgressNotify.enabled` | Codex App由gateway发一次无进展提醒 | 已实现 | 假时钟与持久重启行为验证，明确未投递失败2秒重试；ACK未知保留uncertain不盲重发 |
| 高级 / Codex App | 无进展阈值 | `noProgressNotify.timeoutMs` | gateway按本轮可见进展时钟判定超时 | 已实现 | 10秒边界测试通过；不从上轮缓存推断进展 |
| 高级 / Codex CLI | CLI执行进展提醒 | `noProgressNotify.cliEnabled` | Codex CLI独立启用执行无进展提醒 | 已实现 | message行为cliEnabled与App enabled互不串；其他CLI不误发 |
| 高级 / 信封注入 | Hook信封注入 | `envelopeInjection` | 公共apiOnly逐轮提示策略与Hook注入路径 | 已实现 | core-only配置传到共享Worker/session prompt；prompt-injection行为回归通过；Hook仅对支持的CLI启用 |
| 高级 / 提示注入 | 禁用Botmux提示注入 | `promptInjection` | 公共apiOnly逐轮提示策略与Hook注入路径 | 已实现 | core-only配置传到共享Worker/session prompt；prompt-injection行为回归通过；Hook仅对支持的CLI启用 |
| 高级 / 发言人标签 | 发言人标签注入 | `senderTag` | native userid标签由gateway逐轮注入 | 已实现 | 独立policy：Dashboard保存false后后续请求rawText不再携带标签，角色与会话不串 |
| 高级 / 发言人标签 | 隐藏发言人邮箱 | `senderTagHideEmail` | 原生发送者只用 userid，不采集和展示邮箱 | 已实现 | A：既有无邮箱数据条件已满足；不新增误导性的邮箱过滤开关，也不把邮箱当授权证明；依据：网关发言人标签只拼 userid（`src/im/wecom/gateway/bridge/inbound.ts`），配置页对企业微信隐藏该开关（`src/dashboard/web/providers/wecom.ts`） |
| 高级 / 额度转交 | 额度转交开关 | `quotaFallbackBot.enabled` | native.quotaFallbackBot.peerId → 结构化限额 → 本机互信连接执行，结果由原机器人发回 | 已实现 | B：交接前按同机互信规则自查（目标网关没在运行也算不满足），不满足就不交接、不中断当前这一轮；目标独立验权与额度，取结果时重判，交接后互信不再成立时这一轮按授权变化收尾；验证：wecom-peer-trust |
| 高级 / 额度转交 | 转交机器人 | `quotaFallbackBot.targetAppId` | 下拉列出会接受本连接的本机企微连接（存储 peerId） | 已实现 | B：下拉只给连接 id 与名字，不下发其它连接的用户名单；已配置目标不再满足互信时如实提示不会交接；验证：dashboard-wecom-native-tiles |
| 高级 / 额度转交 | 用量或限速触发 | `quotaFallbackBot.kinds` | 用量额度耗尽 / 速率限制两个勾选 | 已实现 | B：只接受真实结构化用量/速率限制；结果未知不重复交接；验证：wecom-peer-trust |
| 高级 / 额度转交 | 转交提示 | `quotaFallbackBot.message` | 目标接纳后发回原会话的提示语 | 已实现 | B：留空用默认提示；验证：wecom-peer-trust |
| 高级 / 运行环境 | 启动Shell | `launchShell` | managedCore.botConfig.launchShell → persistent backend启动shell | 已实现 | wecom-bot-profile.test.ts：真实子进程launch.launchShell=bash；PTY无shell包装，延续公共语义 |
| 高级 / 运行环境 | 会话环境变量 | `env` | managedCore.botConfig.env → botInjectedEnv → CLI环境 | 已实现 | wecom-bot-profile.test.ts：真实子进程合成worker环境与MODEL_TOKEN；身份变量不可覆盖 |
| 高级 / 运行环境 | 继承或严格环境 | `envPolicy.mode` | managedCore.botConfig.envPolicy → 共享环境过滤 | 已实现 | wecom-bot-profile.test.ts：strict丢弃SENSITIVE_PARENT且保留显式变量；core-profile不传CLI |
| 高级 / 运行环境 | 允许继承变量 | `envPolicy.inherit` | 共享SessionEnvEditor → revision PATCH → envPolicy | 已实现 | wecom-config-save-http-routes.test.ts：真实HTTP保存；公共envPolicy过滤用同一运行路径 |
| 高级 / 运行环境 | tmux环境操作 | `tmuxEnvironment` | 高级→启动环境→主机 tmux 共享环境 → 既有管理员环境 API | 已实现 | 主机管理员操作影响本机所有 Bot 后续新建 pane；不是企微普通 userid 权限，也不改变已运行进程环境；验证：session-env-api |
| 高级 / Owner提醒 | 会话Owner提醒 | `sessionOwnerReminder.enabled` | native私聊提醒固定会话创建者userid | 已实现 | 独立reminders验证共享会话后来发言者不接管owner；当前ACL、pending/uncertain控制屏障与mode epoch均重验 |
| 高级 / Owner提醒 | 提醒间隔 | `sessionOwnerReminder.intervalMinutes` | 专用持久周期账本按实际等待区间发送 | 已实现 | 独立假时钟验证活动/权限变化重置等待、发送半写与重启不重复、明确拒绝可重试、ACK不明保留当前周期 |
| 高级 / Owner提醒 | 提醒文本 | `sessionOwnerReminder.text` | native owner DM使用当前提醒文本 | 已实现 | 独立reminders：状态查询等待中改text/interval后按新配置判定，不发送旧文本或旧时间窗 |
| 高级 / Owner提醒 | 提醒会话状态 | `sessionOwnerReminder.states` | 真实core状态投影idle/dormant/pending_repo/limited/agent_attention | 已实现 | 签名状态接口与native ledger；pending_repo有真实prelaunch生产者；tui_prompt尚无native生产者，明确拒绝该单值并隐藏 |
| 消息 / 长任务提醒 | 长任务提醒 | `longTaskReminder.enabled` | native当前任务实际执行时钟→原会话提醒 | 已实现 | 独立reminders：接纳/排队时间不能触发；旧worker执行证明拒绝；/stop与控制屏障阻止通知 |
| 消息 / 长任务提醒 | 首次提醒阈值 | `longTaskReminder.thresholdMinutes` | 以真实native执行开始计算首次阈值 | 已实现 | 独立假时钟验证无执行证明与旧generation都零通知；真实开始满1分钟才发送 |
| 消息 / 长任务提醒 | 重复提醒间隔 | `longTaskReminder.intervalMinutes` | 同一执行独立重复提醒周期，终态/替换后清理 | 已实现 | native reminder行为验证首次与重复间隔独立；独立半写/ACK未知/重启与代次守卫变异均咬红 |

## 企业微信原生能力核实

企业微信官方 SDK 提供主动 Markdown/模板卡片/媒体发送、流式回复、模板卡片与卡片更新、媒体上传与解密下载，以及进入会话、卡片点击、反馈事件。模板卡片更新对应事件需在 5 秒内调用，支持指定替换用户。图片、文件、卡片、主动通知与交互回调不能被描述为平台原生缺失。来源：[企业微信官方 Node SDK](https://github.com/WecomTeam/aibot-node-sdk)。

群成员查询、群创建管理、话题线程、置顶、消息表态、机器人资料修改是否存在等价机器人身份接口，本轮尚无官方证据；不得根据 SDK 未列出某方法推断平台没有能力。飞书 `oc_`/`ou_` 标识、飞书卡片 JSON 与 OAuth 不能直接复用。

## 配置与消费依据

- 配置分组：`src/dashboard/web/bot-defaults.ts` 的 `BOT_DEFAULTS_SECTIONS`。
- 页面与子组件：`src/dashboard/web/bot-defaults-page.tsx` 的完整 `BotDefaultsCard` 与各 Section；包括未在导航 fieldKeys 单独列出的子字段。
- 企业微信配置页：`src/dashboard/web/wecom-bot-defaults-card.tsx` 复用上述 Section；出现哪些区块、配置项与卡片按钮由 `src/dashboard/web/providers/wecom.ts` 声明。
- 公共运行配置：`src/bot-registry.ts` 的 `BotConfig`。
- 保存后何时生效：只能重启连接生效的设置列在 `src/im/wecom/config/restart-settings.ts`；其余 core 设置由 `src/im/wecom/gateway/core-profile-sync.ts` 交给运行中的专用 core（`src/core/native-gateway-core-profile.ts`），换 CLI 时由该路由关闭旧 CLI 的会话（`src/core/dashboard-ipc-server.ts`），网关把会话已不存在的聊天转到新会话（`src/im/wecom/gateway/bridge/tick.ts`）。
- 企业微信现有持久入口：`src/im/wecom/config/config.ts`、`src/dashboard/wecom/config.ts`；托管子进程边界：`src/im/wecom/gateway/managed-core.ts`。
- core-only 是 `apiOnly` 身份；公共 Worker 已具备的能力仍要确认其配置能从企业微信到达。飞书投递类功能会受 `larkTransportEnabled` 保护，必须接企微投递才能宣称支持。

## 验收结果

所有验收使用临时配置、假凭据和私有状态；不读写真人权限、不启停真实机器人、不发送企业微信消息。

| 验证 | 实际执行 | 结果 |
| --- | --- | --- |
| 独立配置、消息、探测、提醒、路由 | `bun run test -- test/wecom-config-live-policy.test.ts test/wecom-config-message-timing.test.ts test/wecom-config-probe-env-isolation.test.ts test/wecom-owner-reminder-overlap.test.ts test/wecom-session-mode-switch.test.ts`（5 个文件） | 42 项通过；覆盖真实子进程、假时钟与磁盘半写 |
| 原生安静预设与独立回归 | `bun run test -- test/dashboard-quiet-preset-ui.test.ts test/wecom-config-live-policy.test.ts test/wecom-config-message-timing.test.ts test/wecom-config-probe-env-isolation.test.ts test/wecom-owner-reminder-overlap.test.ts test/wecom-session-mode-switch.test.ts` | 6 文件、48 项通过；安静预设只保存三个已支持字段 |
| 真实 HTTP 界面请求 | `bun run test -- test/wecom-config-save-http-routes.test.ts` | 1 项通过；实际编辑/保存与渲染一致，零飞书 bot/team 路由请求 |
| 共享界面、真实托管子进程与鉴权 | 定向运行 `dashboard-wecom-bot-profile`、`wecom-bot-profile`、`wecom-profile-readonly`、`ipc-native-gateway-progress`、`native-subagent-runtime-ipc-auth` 与上述网络测试 | 6 文件、50 项通过 |
| 公共运行消费者 | 定向覆盖 CLI runtime、TraeX、子Agent、dsh、Riff、网络策略、路径、环境、提示注入、Codex配置层/服务等级 | 12 个通过文件、460 项通过 |
| 公共补充消费者 | idle-worker、Codex归档、herdr放置、浏览器配置、技能注入与消息行为/协议 | 9 文件、200 项通过 |
| 语义守卫变异 | 围栏内临时模块副本，生产源码保持原样 | 新增 9 类守卫全部咬红：控制屏障、发送前持久意图、未知ACK、原生执行代次、稳定创建者、本人旧路由、探测profile隔离、Aiden与通用适配器env传递 |

已覆盖的交叠场景：中途撤权/屏蔽/停用/改配置、状态或进度查询等待、周期 tick、发送成功后账本落盘失败、重启、原生 ACK 不明、旧卡片与新 turn、多人共享会话与模式切换。历史答案反馈仍可按受众策略记录和改选；旧卡片不能操作当前新任务。提醒始终使用真实 native userid，未合成飞书 owner 身份。

探测隔离覆盖原生 Codex、Aiden、CoCo、OpenCode、Doubao、ZCode及不匹配当前选择的 models/availability。真实假可执行文件证明：网关自定义 Secret、企业微信凭据、IPC Secret、完整 core profile 与其他选择的私有 env 均不会进入探测子进程；并发来源目录不串用。匿名、H5 和平台代理身份均无法调用主机专属探测入口。

消息通知的已知边界：原生接口没有可复用的投递幂等键；明确拒绝可重试，写出后 ACK 不明保留当前周期为 uncertain，避免重启重复通知，下一常规周期仍可发送。原生模板卡是辅助消息，失败不会重投已经交付的正文。多段正文发送成功但落盘失败仍存在平台缺乏幂等键带来的重复窗口。
