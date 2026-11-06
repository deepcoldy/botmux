# LinkRef 来源链接完整性设计

## 背景与根因

某会话的来源上下文中存在一条带查询参数的业务页面链接，但最终消息只发送了：

```text
https://<source-host>/preview_platform/problem
```

Rollout 记录表明，模型生成最终 `botmux send` 命令时，正文和 `--expected-link` 已经同时变成上述 base URL。发送记录也只收到并投递了这个 base URL。因此，本次问题不是 Botmux 或飞书在传输时截断 URL，而是参数在模型整理最终答案、重新书写来源链接时已经丢失。

现有 `--expected-link` 只能验证“正文是否包含调用者传入的 URL”。当模型把错误的短链接同时写入正文和 `--expected-link` 时，校验仍会通过。发送层此时已经没有完整 URL，无法可靠恢复参数。

过去围绕 URL 文本做补丁难以彻底解决，是因为发送层无法区分两种合法意图：

- 模型意外把来源 URL 的查询参数丢失；
- 模型有意只输出同域名、同路径的 base URL。

仅比较同域名、同路径后自动补参会篡改第二种合法输出；发现疑似短链接就拒发，则会丢失用户本来要发送的内容。本设计不猜测两个 URL 的关系，而是让来源 URL 以不可变引用跨越模型生成阶段。

## 目标

- Botmux 能拦截的模型可见来源中，HTTP(S) URL 以原始字节串登记到当前 turn 的不可变账本。
- 模型引用来源链接时使用 LinkRef；所有对外消息出口在任何外部副作用前由宿主将 LinkRef 精确展开为原始 URL。
- 保留查询参数顺序、重复参数、空值、fragment、大小写和百分号编码，不经过解析重建。
- 普通手写 URL 继续原样发送，不自动补参，也不因与某个来源 URL 同域同路径而拒发。
- 覆盖用户消息、群上下文、卡片、history、quoted、附件文本、结构化工具和 MCP 结果。
- 授权链接属于可操作业务链接，即使携带 `code`、`token`、`signature` 等参数，也必须能够完整引用。
- 默认关闭时与当前线上行为完全一致，并支持按 Bot 稳定灰度。

## 非目标与保证边界

- 不判断模型写出的两个普通 URL 是否语义相同。
- 不尝试修复没有通过 LinkRef 引用的普通 URL。
- 不登记模型凭空生成的新 URL；它仍可作为普通 URL 输出。
- 不扫描普通终端 stdout 或 CLI 私有工具结果来推断来源。第一版的强完整性保证仅覆盖 Botmux 能在交给模型前拦截的输入和工具结果。
- ask 卡、CoT、report、dispatch 和 `lark-cli` 直发通道不属于 LinkRef 自动展开出口；除非后续显式接入同一套可信 turn 身份与宿主解析协议，否则这些通道只保留原有普通 URL 语义，不得注入 LinkRef companion。
- 不把 LinkRef 当作主机级安全机制。非沙箱 Agent 与 Botmux 使用同一系统用户时，主动篡改宿主文件属于现有主机信任边界。本设计防止的是模型在文本生成中意外改写来源 URL。
- LinkRef 不能让模型必然选择引用某条来源。只有最终内容使用 LinkRef 时，Botmux 才能提供来源 URL 的强完整性保证；普通 URL 始终保留原有自由表达语义。

## 方案取舍

### 采用：turn 级不可变 LinkRef

Botmux 为来源 URL 分配形如 `lr_<128-bit-random-id>` 的引用。模型需要引用该来源时输出：

```text
{{botmux_link:lr_0123456789abcdef0123456789abcdef}}
```

发送前由可信宿主按当前应用、会话和 turn 查询账本，并将占位符逐字替换为登记时的原始 URL。

这一方案把“是否保留原 URL”变成显式引用语义，既不需要猜参数，也不影响有意输出 base URL 的场景。

### 不采用：同域名、同路径自动补参或拒发

该方案无法区分意外截断与有意输出 base URL。自动补参会改变内容，拒发会导致内容丢失。

### 不采用：业务严格模式

要求用户或业务 Skill 判断“哪些场景必须保留链接”会把底层完整性责任暴露给用户，且很容易漏配。LinkRef 在来源层登记，由 Agent 在引用时表达意图，不引入任何业务专属开关。

### 保留但不依赖：`--expected-link`

`--expected-link` 继续作为调用者已持有正确 URL 时的额外校验。LinkRef 展开后的正文参与该校验，但 `--expected-link` 不再承担恢复来源 URL 的职责。

## 总体架构

```text
用户消息 / 群上下文 / 卡片 / history / quoted / 附件 / 工具与 MCP 结果
                                  │
                                  ▼
                     URL 提取与敏感叶子过滤
                                  │
                  原始内容不解析、不重建、不改写
                                  │
                                  ▼
             LinkRefLedger(appId, sessionId, turnId, attempt)
                                  │
                                  ▼
                    原内容 + LinkRef companion block
                                  │
                                  ▼
                               模型
                                  │
                  ┌───────────────┴───────────────┐
                  │                               │
               普通 URL                        LinkRef
         原样发送，不提供来源保证          宿主按账本精确展开
                  │                               │
                  └───────────────┬───────────────┘
                                  ▼
                渲染、校验、幂等指纹、附件上传、平台发送
```

公共组件边界如下：

- `UrlSourceExtractor`：从文本或结构化结果中找出 HTTP(S) URL 的原始 span，应用敏感叶子过滤。
- `LinkRefLedger`：负责 turn 级登记、批量解析、结算、过期和会话删除。
- `LinkRefPresenter`：在不改变原始来源内容的前提下生成 companion block。
- `OutboundLinkRefResolver`：在宿主侧解析正文、内容文件和卡片 JSON 中的 LinkRef，并返回展开后的内容。
- 各输入适配器和发送出口只调用这些公共组件，不实现自己的 URL 猜测或替换逻辑。

## 配置与灰度

LinkRef 是 Botmux 管理员控制的基础设施能力，不向普通飞书用户、群命令或模型提供切换入口。

配置模式：

```ts
type LinkRefMode = 'disabled' | 'observe' | 'enabled';

interface LinkRefConfig {
  mode?: LinkRefMode; // 缺省等同 disabled
}
```

控制优先级：

1. 管理员环境变量紧急总开关；用于部署级关闭或诊断，不向模型进程授予修改权限；
2. 单 Bot `linkRefs.mode`；用于按 Bot 灰度；
3. 全局 `linkRefs.mode`；
4. 未配置时为 `disabled`。

三种模式：

- `disabled`：不扫描 URL、不创建 LinkRef 账本、不注入 companion block、不解析 LinkRef、不增加数据库访问；表现与当前线上完全一致。
- `observe`：扫描并记录脱敏指标，但不创建可用引用、不向模型注入 LinkRef、不改变任何发送内容。
- `enabled`：登记、注入和所有发送出口的宿主解析整体启用。

不得出现“已注入但发送端不解析”的中间状态，避免占位符泄漏给用户。推荐发布顺序为全局 `observe`、少量 Bot `enabled`、扩大 Bot 范围、最后全局 `enabled`。不按请求随机百分比灰度，避免同一会话前后行为不一致。

每个 turn 在接纳时固定当时的有效 mode，后续输入登记和发送解析都使用该固定值。管理员在 turn 进行中修改全局或单 Bot 配置，只影响之后接纳的新 turn。紧急关闭同样停止新 turn 的登记和注入；已经按 `enabled` 启动且可能持有 LinkRef 的 turn 仍必须使用账本展开。如果账本不可用则拒发，不能把占位符原样发送。这样配置切换不会制造“前半轮注入、后半轮不解析”的状态。

## 数据模型与存储

新增独立的宿主侧 SQLite `LinkRefLedger`。它不复用当前可供沙箱发送流程使用的 turn-send ledger，避免模型进程具备修改引用映射的文件权限。

### Turn 记录

```ts
interface LinkRefTurnRecord {
  appId: string;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  mode: 'enabled';
  state: 'open' | 'settled' | 'expired';
  createdAtMs: number;
  lastActivityAtMs: number;
  settledAtMs?: number;
  expiresAtMs: number;
}
```

### Link 记录

```ts
type LinkRefSourceType =
  | 'user_message'
  | 'group_context'
  | 'card'
  | 'history'
  | 'quoted'
  | 'attachment'
  | 'tool'
  | 'mcp'
  | 'public_system_doc';

interface LinkRefRecord {
  refId: string;
  appId: string;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  originalUrl: string;
  urlHash: string;
  sourceType: LinkRefSourceType;
  sourceId?: string;
  createdAtMs: number;
}
```

存储规则：

- 键空间绑定 `appId + sessionId + turnId + dispatchAttempt`。LinkRef 不得跨应用、会话、turn 或 dispatch attempt 使用。
- `originalUrl` 保存从输入中切出的原始 UTF-8 字符串。允许用 URL parser 做协议和语法验证，但不得保存 parser 规范化后的 `href`。
- 同一 turn 中相同原始 URL 复用同一 ref；同路径但参数、参数顺序、编码或 fragment 不同的 URL 分别登记。
- 映射只追加，不允许修改已登记 ref 的 URL。
- ref ID 使用不可预测的 128-bit 随机值，不从 URL 内容直接派生。
- 单 turn 最多登记 128 个不同 URL；单 URL 最大 8 KiB；原始 URL 合计最大 512 KiB。
- 一个输入或工具结果中的 URL 使用单次事务批量登记，避免逐链接写库。

完整 URL 仅存在权限受控的账本中。普通日志、指标和诊断只记录 ref、来源类型、数量、结果与 URL 哈希。

## 生命周期与权限

- turn 建立时创建 `open` 记录；初始来源登记完成后才把 prompt 交给模型。
- 当前 turn 的宿主输入适配器、MCP Gateway 和受信工具结果桥可以追加登记。
- 模型和沙箱进程只看到 ref，不挂载或直接打开账本，也没有修改映射的接口。
- `history`、`quoted` 在沙箱内通过现有宿主 relay/IPC 请求登记，不能直接写库。
- final、失败或取消后把 turn 标记为 `settled`，不再接受新登记。
- settled turn 默认保留 7 天；异常未结算且最后活动超过 7 天的 turn 标记为 `expired` 并清理。
- daemon/worker 重启不丢失账本；同一 turn 可继续解析已登记 ref。
- 删除会话时同步删除该会话的 LinkRef 记录。
- 过期、未知或越界 ref 确定性拒绝，不回查历史记录，也不按域名和路径猜测。

## 来源登记与模型呈现

### 初始输入

以下 Botmux 已掌握的模型可见来源在 prompt 组装时统一登记：

- 当前用户消息；
- 群上下文和群描述；
- 触发消息及卡片可见正文；
- 附件中的有界文本内容；
- Botmux 注入、允许最终引用的公开系统说明和文档 URL。

隐藏系统指令、Skill 内部文档、认证配置和其它不应向最终用户引用的内部内容不登记。

原始内容保持不变，随后追加 companion block：

```text
原始内容：
问题地址：https://example.test/problem

<botmux_link_refs>
lr_0123456789abcdef0123456789abcdef = https://example.test/problem
引用或转发这个来源链接时，请输出
{{botmux_link:lr_0123456789abcdef0123456789abcdef}}。
如果有意只讨论域名或 base URL，可以直接输出普通 URL。
</botmux_link_refs>
```

Companion block 是模型协议，不会直接发送给用户。模型需要逐字引用来源链接时必须使用 LinkRef；有意输出 base URL 或自行构造 URL 时使用普通 URL。

### `botmux history` 与 `botmux quoted`

命令结果在返回模型前登记其中的 URL，并在结果末尾追加仅属于当前 turn 的 companion block。旧消息通过 history 进入新 turn 时重新分配 ref，不复用旧 turn 的 ref。

### 结构化工具与 MCP

第一版纳入 Botmux 能拦截的结构化工具和 MCP 返回结果：

- `text` 内容块扫描其文本；
- `resource` 的模型可见文本内容扫描正文；
- JSON 递归遍历模型可见字符串叶子；
- 二进制和非文本 blob 不尝试解码；
- 原始结果结构、字段和值保持不变；引用表通过额外 companion text block 返回，避免破坏工具协议。

旧工具没有“可向用户展示”标记时，默认登记模型实际可见的 HTTP(S) URL，再应用敏感叶子和元数据排除规则。普通终端 stdout 暂不自动登记，除非适配器明确声明该输出可供最终引用。

工具可通过以下元数据显式减少登记范围：

```json
{
  "_meta": {
    "botmux/linkRefPolicy": "exclude"
  }
}
```

标记所在内容块或子树不登记。该标记只能减少登记范围，不能强制登记明确的凭证叶子。

## URL 提取

公共 `extractHttpUrlSpans` 返回输入字符串中的原始起止位置，不直接返回规范化 URL。规则如下：

- 只识别 `http://` 和 `https://`；
- 正确处理 Markdown 链接、尖括号链接、括号嵌套和句尾中英文标点；
- 查询参数、重复参数、空值、fragment、大小写和百分号编码全部保留；
- `new URL()` 或等价 parser 仅用于验证协议和基本语法；保存和展开始终使用原始 span；
- JSON/MCP 逐个扫描字符串叶子，不对整个序列化 JSON 使用一条正则；
- 带 `user:password@host` 的 URL 不登记；
- 去除的只能是可以从语法确定不属于 URL 的外部标点，不能凭参数名裁剪 URL。

例如：

```text
https://a.test/p#x
```

必须以相同字符串登记和展开，不能重建或排序参数。

## 敏感信息与授权链接

过滤依据是结构化字段路径和确定的值形态，不检查 URL 查询参数名，也不因父对象名称含 `authorization` 或 `credential` 就排除整个子树。

### 必须过滤的凭证叶子

字段名大小写不敏感，并将 `-` 与 `_` 视为等价。以下明确凭证叶子不登记：

- HTTP header 中的 `authorization`、`proxy-authorization`、`cookie`、`set-cookie`；
- `password`、`passwd`；
- `secret`、`client-secret`；
- `access-token`、`refresh-token`、`id-token`、`session-token`；
- `api-key`、`apikey`；
- `private-key`；
- 确定为 Bearer、Basic 或其它认证 header 值的字符串。

只做完整字段名或确定值形态匹配，不能因为 `documentation_url`、`token_help_url` 等名字中包含某个单词而排除。

### 必须保留的用户操作链接

以下链接正常登记，并保留其全部查询参数：

- 文本结果中的“请打开以下链接授权”；
- `authorization.url` 中的 HTTP(S) URL；
- `authorization_url`、`auth_url`、`login_url`、`verification_uri`、`consent_url`；
- bytecli、bytedcli 等工具在权限不足时返回的登录或授权链接；
- 查询参数含 `code`、`token`、`signature`、`state`、`redirect_uri` 的授权链接。

如果字段本身名为 `authorization`：值是 Bearer 等凭证时过滤；值是 HTTP(S) URL 且不是 HTTP header 时作为用户操作链接登记；位于 headers 下时始终按凭证过滤。

## 发送展开

所有可能向外部用户呈现消息的出口统一经过宿主侧 `OutboundLinkRefResolver`：

- 自动转发的最终 assistant message；
- `botmux send` 的 progress、final 和 auxiliary；
- 正文参数和 `--content-file`；
- 自定义卡片 JSON 的字符串值；
- 沙箱 outbox relay；
- Remote Runner 的 `final` 和 `outbound_message`。

处理顺序固定为：

```text
确认可信 session/turn/attempt 身份
→ 解析正文中的 LinkRef
→ 一次查询批量读取全部映射
→ 从账本逐字展开
→ Markdown/卡片渲染
→ --expected-link 校验
→ 计算 turn 幂等指纹
→ 联系人解析、附件上传或平台调用
```

展开后的最终呈现正文参与现有 turn-send 幂等指纹。这样重试和 relay 重放得到同一个身份，既不会把 ref 文本当成最终内容，也不会因展开时机不同重复发送。

沙箱 outbox 只运输 ref 和原始正文。宿主 watcher 在验证来源 turn 后展开；沙箱不能自行提供 `ref → URL` 映射。Remote Runner 同样由 Botmux 宿主解析，不把账本复制给 provider。

## LinkRef 语法与字面量

仅解析严格格式：

```text
{{botmux_link:lr_<32个小写十六进制字符>}}
```

以下内容按字面量处理：

- Markdown 行内代码中的 LinkRef；
- Markdown fenced code block 中的 LinkRef；
- 前面带反斜杠的 `\{{botmux_link:...}}`，发送时只去掉用于转义的反斜杠；
- 不满足完整语法的相似文本。

这允许用户和模型在文档、代码或说明中讨论 LinkRef，而不触发展开或拒发。

## 失败语义与恢复

### 登记阶段

- URL 登记失败不得阻断用户输入或工具结果；原内容仍交给模型，只是不为失败 URL 附加 LinkRef。
- 数据库忙执行有界重试；仍失败时记录不含 URL 的诊断。
- 超过单 URL、数量或总容量限制时，超限 URL 不生成 ref，原始内容仍可见，工具调用本身不失败。

### 发送阶段

- 当前 turn 的合法 LinkRef：展开后继续发送。
- 未知、损坏、过期、跨应用、跨会话、跨 turn 或跨 attempt 的 LinkRef：在任何外部副作用前拒绝。
- 账本不可用或有界重试后仍无法解析：拒绝发送，不把残缺正文或原始占位符发给用户。
- 自动 final 失败时保留可重试的待发送草稿并返回可诊断错误；同一 turn 重试继续受现有幂等围栏保护。
- 普通 URL 和有意输出的 base URL：不替换、不拒绝。
- 解析失败时不得回退为按同域名、同路径猜测来源 URL。

## 性能

- `disabled` 完全不进入 LinkRef 代码路径，不扫描、不建库、不查库。
- `enabled` 下，输入和工具结果只做与文本长度线性相关的扫描；没有 URL 时不写数据库。
- 一个来源结果使用一次批量事务。
- 最终正文不含 LinkRef 时不查询账本。
- 含 LinkRef 时一次批量查询解析所有 ref，不增加网络请求。
- 有界数量和字节限制防止异常文本放大 CPU、内存和账本体积。

因此普通发送在 `disabled` 下与线上完全一致；`enabled` 下无 LinkRef 的发送也不增加数据库查询，含 LinkRef 的发送仅增加本地解析与一次批量读取。

## 可观测性

允许记录：

- LinkRef mode、来源类型、扫描字符串字节数；
- 找到、登记、去重、过滤和超限的 URL 数量；
- ref ID、URL 哈希、解析结果和失败类别；
- 每次发送包含的 ref 数及解析耗时。

禁止记录：

- 原始完整 URL；
- companion block 全文；
- 被过滤的凭证叶子值；
- 授权链接的查询参数。

`observe` 只产生上述脱敏计数和耗时，不创建可用 ref，不改变模型输入和最终输出。

## 测试与验收

### 提取与原样保持

- 重复参数、空值、fragment、百分号编码、中文参数和大小写；
- Markdown、尖括号、括号嵌套和中英文句尾标点；
- 相同路径但不同参数、顺序、编码和 fragment 分配不同 ref；
- 登记和展开结果逐字等于原始 span。

### 授权与敏感信息

- bytecli/bytedcli 风格权限错误中的授权链接；
- `authorization.url`、`authorization_url` 和文本授权说明；
- 携带 `code`、`token`、`signature`、`state` 的授权 URL；
- Bearer header、cookie、密码、私钥、API key、access/refresh token 不登记；
- 元数据 `exclude` 的内容块不登记。

### 来源覆盖

- 用户消息、群描述、群上下文和触发卡片；
- `botmux history`、`botmux quoted`；
- 附件文本；
- MCP `text`、文本 `resource` 和 JSON 字符串叶子；
- 公开系统文档登记，隐藏系统指令和 Skill 内部文档不登记。

### 隔离与生命周期

- 跨应用、跨会话、跨 turn、跨 dispatch attempt、过期和未知 ref；
- 并发工具结果批量登记；
- daemon/worker 重启；
- turn final、失败和取消后禁止追加；
- 会话删除与 7 天过期清理。

### 发送出口

- 自动 final；
- `botmux send` 的正文参数和内容文件；
- 自定义卡片 JSON 字符串值；
- 沙箱 relay；
- Remote Runner `final` 和 `outbound_message`；
- 展开先于渲染、`--expected-link`、幂等指纹和所有外部副作用。

### 兼容与字面量

- 普通 URL 原样发送；
- 有意发送 base URL 不被替换或拒绝；
- 无 URL 正文；
- 代码块、行内代码、转义和相似语法中的字面 LinkRef；
- `disabled` 下不扫描、不访问账本、不改变 prompt、send 参数或输出；
- `observe` 下只产生脱敏指标；
- 旧会话没有账本时普通消息继续发送。

### 横向回归

公共路径至少验证：

- Codex 与 Claude Code；
- PTY 与 Tmux 后端；
- 沙箱开启与关闭；
- 普通话题、群会话和恢复会话；
- 一个非飞书发送适配器或明确证明当前能力只在 Lark 边界启用且其它 IM 保持原行为。

## 验收标准

1. 来源中的带参数 URL 通过 LinkRef 引用后，最终用户收到的 URL 与登记时原始字符串逐字相同。
2. `--expected-link` 在 LinkRef 展开后校验，不能再由未展开占位符绕过。
3. 有意输出的普通 base URL 正常发送，不被补参或拒绝。
4. 未知或越界 LinkRef 在任何网络、上传或平台副作用前失败。
5. bytecli/bytedcli 授权链接可以完整登记、展开并打开；认证 header 和凭证值不进入账本或日志。
6. 所有已列出的消息出口共用一个宿主解析器，没有某个出口绕过展开。
7. 未配置模式时为 `disabled`，运行表现、发送内容和性能路径与当前线上一致。

## 影响范围

- 公共配置和 Bot 配置规范化：新增 LinkRef mode 及管理员紧急覆盖。
- turn 生命周期：创建、重启恢复、结算、取消、失败和会话删除。
- prompt 组装：用户输入、群上下文、卡片、附件和公开说明。
- CLI helper：`history`、`quoted` 的当前 turn 登记和 companion 输出。
- Plugin MCP Gateway 与其它结构化工具结果桥。
- 公共发送链路：自动 final、CLI send、内容文件、卡片、sandbox relay 和 Remote Runner。
- turn-send 幂等与 `--expected-link` 的执行顺序。
- 数据保留、清理、脱敏日志和灰度指标。

本改造位于 Botmux 公共层，影响所有 CLI、后端和会话类型。实现时必须让每个入口复用公共提取、账本和解析模块，并按上述横向矩阵验证，不能只针对单个业务场景或单个 CLI 打补丁。
