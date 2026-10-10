# 全局消息监听设计

## 目标

将群消息监听从「角色管理」中的群级编辑能力提升为「数字员工 > 消息监听」独立入口，按 Bot 管理。每个 Bot 可以配置一套默认的全局消息监听规则；该规则默认对 Bot 当前加入的所有群生效。群级设置只负责声明例外：继承全局、关闭监听或使用完整的自定义规则。

本设计必须保留监听的回复位置能力：监听命中后既可以在原消息下创建话题，也可以直接发到群聊顶层。

## 已确认的产品规则

### 配置层级

```text
Bot
├─ 全局消息监听规则
│  └─ 完整 MessageListenerConfig
└─ 群级覆写（按 chatId）
   ├─ 无记录 / inherit：复用全局规则
   ├─ disabled：此群完全关闭监听
   └─ custom：使用该群完整自定义规则
```

- 新加入的群默认没有覆写记录，即 `inherit`；无需写入冗余配置。
- 全局规则开启时，所有 `inherit` 群立即使用它；全局规则关闭时，所有 `inherit` 群不监听。
- 群级 `custom` 可在全局规则关闭时独立开启并生效。
- 只在 Bot 当前已加入的群中展示群级设置。Bot 离群后，覆写记录保留并隐藏；重新入群时恢复。
- 当前监听器的匹配语义不变：已配置的发送者、消息类型、内容过滤条件均需通过；关键词继续支持任一/全部命中。

### 群级模式切换

| 当前模式 | 目标模式 | 行为 |
| --- | --- | --- |
| inherit | custom | 从当前全局规则复制完整草稿；修改后独立保存。 |
| disabled | custom | 从当前全局规则复制完整草稿；可独立启用。 |
| disabled | inherit | 直接恢复继承，不需确认。 |
| custom | inherit | 二次确认；确认后删除自定义规则。 |
| custom | disabled | 二次确认；确认后删除自定义规则并关闭该群。 |
| inherit | disabled | 直接关闭该群，不需确认。 |

未保存的自定义草稿切换模式、切换群、切换 Bot 或离开页面时，必须提示确认，避免数据丢失。

### 规则字段

全局规则和群级 `custom` 必须复用线上完整表单和相同的 `MessageListenerConfig` 字段：

- `enabled`、名称、回复卡片标题、工作目录、监听提示词；
- 发送者范围、发送者类型、排除当前 Bot；
- 消息类型（text、post、image、interactive）；
- 内容关键词与任一/全部匹配方式；
- 回复位置 `replyPolicy.mode`：`thread` 或 `chat`。

`thread` 表示在原消息下新开话题；`chat` 表示直接发送到群顶层。群级 custom 首次复制全局规则时必须复制该字段；inherit 在运行时始终读取当前全局值。

## Dashboard 体验

### 信息架构

在「数字员工」侧栏新增同级页面「消息监听」，位于「自定义」之后、「Bot 配置」之前。现有「角色管理」移除消息监听编辑页签，但在群/Bot 视图中保留已有监听状态标识。

新页面按 Bot 管理：

1. 左侧显示可用 Bot 列表，选择一个 Bot。
2. 右侧上半部显示该 Bot 的全局监听完整表单，独立保存。
3. 全局表单可从该 Bot 已加入的群中选择一个预览样本群。样本仅决定历史预览和试运行的数据来源，不影响规则覆盖范围。
4. 右侧下半部列出该 Bot 当前已加入的群，并显示 `复用全局`、`已关闭` 或 `自定义` 状态。
5. 点击群条目后，在该条目正下方原地展开编辑区；不跳转到独立详情页。
6. 仅 custom 展示完整规则表单及独立保存按钮；inherit 与 disabled 只显示模式说明和切换控制。

全局表单、每个群级自定义表单各自独立保存。保存失败必须保留草稿并给出错误提示，不能将未落盘状态显示为已保存。

## 数据模型与迁移

Bot 配置新增如下字段：

```ts
interface GroupMessageListenerOverride {
  mode: 'disabled' | 'custom';
  listener?: MessageListenerConfig; // mode === 'custom' 时必填
}

interface BotConfig {
  globalMessageListener?: MessageListenerConfig;
  groupMessageListenerOverrides?: Record<string, GroupMessageListenerOverride>;
}
```

没有 `groupMessageListenerOverrides[chatId]` 等同 `inherit`。持久化时不得主动写入 `{ mode: 'inherit' }`。

迁移遵循不扩大既有监听范围的原则：

- 旧 `messageListeners[chatId]` 迁为 `groupMessageListenerOverrides[chatId] = { mode: 'custom', listener }`；
- 新 `globalMessageListener` 初始为空或关闭；
- 旧 `messageListeners` 保留为降级影子与旧端点兼容读取；新运行时优先读取 `groupMessageListenerOverrides`，写入覆写变更时同步维护或清理对应影子，避免降级或滚动发布期间丢失既有群级规则；
- 历史规则未携带 `replyPolicy` 时默认 `thread`，保证与既有行为一致。

需要保证 registry 的规范化、Dashboard API 写入、配置持久化和运行时读取共同支持新旧形态；对格式异常的覆写或规则 fail-closed，跳过监听并记录可诊断日志。

## 运行时与 API

新增唯一的有效规则解析入口：

```ts
resolveEffectiveMessageListener(bot, chatId): MessageListenerConfig | undefined
```

规则顺序：

1. 群覆写为 `disabled`，返回 `undefined`；
2. 群覆写为 `custom`，返回群级完整规则；
3. 否则返回 `globalMessageListener`；
4. 最终规则 `enabled !== true` 时不监听。

实时 WS 消息、bot 发送者消息、历史轮询补偿、Dashboard 历史预览和试运行必须共用该解析和现有 `evaluateMessageListener` 匹配逻辑，防止不同入口对同一群得到不同结果。

`replyPolicy.mode` 必须继续影响路由上下文：

- `thread`：thread scope，anchor 为触发消息 ID；
- `chat`：chat scope，anchor 为 chat ID。

Dashboard 代理接口拆为按 Bot 的资源：

```text
GET/PUT /api/message-listeners/:botId/global
GET     /api/message-listeners/:botId/groups
GET/PUT /api/message-listeners/:botId/groups/:chatId
```

群级读取返回模式及 custom 规则（仅 custom）。预览/试运行沿用现有能力：全局预览提交全局规则和样本群，群级预览提交该群的有效规则。

## 验收与测试

### 单元与配置测试

- 有效规则解析覆盖 inherit、disabled、custom、全局关闭、custom 独立启用和异常配置。
- 旧 `messageListeners` 正确迁移为 custom，未监听的旧群不被意外启用。
- 新群无覆写时继承全局；离群覆写保留，重新入群恢复。
- `replyPolicy.mode` 在全局、inherit、custom 与旧默认规则中均正确解析。

### 运行时回归

- WS 实时事件和历史轮询补偿对同一有效规则产生相同命中结果。
- 发送者、消息类型、关键词、任一/全部匹配和排除自身语义保持不变。
- `thread` 和 `chat` 两种回复位置保持既有的锚点与会话语义。
- disabled 不产生会话、轮询唤醒或回复；custom 不受全局开关和后续全局修改影响。

### Dashboard 测试

- 新侧栏入口、按 Bot 选择、全局完整表单、样本群预览与试运行。
- 群状态列表、行内展开、custom 全量表单、独立保存和保存失败保留草稿。
- 所有模式迁移、两类删除确认、切换/离页未保存确认。
- 角色管理不再提供编辑入口，但保留监听状态标识。

## 影响范围

- 公共配置层：`bot-registry`、持久化与迁移逻辑；需要保证所有 Bot 的配置读取兼容。
- 飞书消息路径：人、bot、实时 WS、轮询补偿、普通群/话题群以及 `thread/chat` 两种回复位置。
- Dashboard：侧栏路由、角色管理入口移除、监听页面、预览/试运行代理 API。
- 未改变私聊监听范围：消息监听仍只处理群聊顶层消息。
