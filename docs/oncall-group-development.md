# Oncall 群按钮开发文档

配套 [技术方案](oncall-group-button.md)。本文用于配置接入、定位代码、执行回归和上线验收；仓库示例全部使用占位值，不包含真实账号、群 ID、部署主机或密钥。

## 本次增量与验收范围

新增 `flowMode`、`formDisplay`、`button.timing/minTurns`，默认提供群内普通分类卡，保留原生侧栏与普通群个人临时卡选项。两种交互的真实支持范围及尚未完成的闭环见 [技术说明](oncall-group-button.md)，下文旧直接建群协议继续兼容。不能把原生入口成功、单元测试通过或目标配置存在当成完整提单验收。

业务目标通过当前 Bot 的 `GET/PUT /api/bot-oncall-target` 维护，写入体为 `{ "target": { "tenantId": 123, "typeId": 456, "region": "nation" } }`；分类提单可省略 `typeId` 和 `region`。接口只接受业务字段，网关地址和邮箱域由宿主管理员通过高级设置或部署环境维护；普通业务目标接口不接受连接字段。GET 同时返回 `connectionReady`、可选的 `connectionError`、`credentialActive`，并在平台可读时返回 `tenantName` 和实际读取结果 `connectionOk`；配置文件损坏会报错，不会当作未配置覆盖。`POST /api/bot-oncall-target/check` 只读验证已保存目标的区域/分类访问，不验证代建及入群权限。Dashboard 对应 `/api/bots/:appId/oncall-target` 及 `/check`，保持现有宿主鉴权与写入校验。页面使用底部唯一的“保存配置”按钮，按服务凭据、连接参数、业务目标、交接策略的顺序仅提交有变化的部分；编辑和切换开关只修改本地草稿。各接口不构成事务，部分成功时明确提示，重试仅提交剩余修改。

本次重点回归：

```bash
bun run test test/oncall-group.test.ts test/oncall-group-callback.test.ts \
  test/oncall-session-handoff.test.ts test/oncall-form-callback.test.ts \
  test/turn-reply-card.test.ts test/turn-reply-card-runtime.test.ts \
  test/cli-send-reply-card.test.ts test/dashboard-daemon-proxy-routes.test.ts
bun run build
```

需要 Node 运行 vitest 时使用支持 `node:sqlite` 的 Node 版本；包管理器及构建器仍为 Bun 1.4.4。

## 配置清单

**平台连接和 Secret 由部署统一配置，不需要每个用户、每个群或每个 Bot 重复填写。** 每个 Bot 只配置业务归属，并在 Dashboard「消息卡片 → 转人工 Oncall」打开开关、选择来源群。已有旧版连接配置会继续兼容，无需批量迁移。

| 配置 | 数量 | 位置 | 生效方式 |
| --- | --- | --- | --- |
| `ONCALL_SERVICE_SECRET` | 每套部署一个 | Oncall 页面密码框保存到 `~/.botmux/.env`，或部署 Secret 注入 | 保存后下次 Oncall 操作自动加载 |
| `ONCALL_GROUP_ENDPOINT`、`ONCALL_EMAIL_DOMAIN` | 每套部署一组 | Dashboard「转人工 Oncall → 高级设置」写入宿主 `.env`；也支持部署注入 | 保存后下次 Oncall 操作自动加载 |
| 业务目标 | 每个 Bot 的业务线，直接建群另需区域和分类 | Dashboard「消息卡片 → 转人工 Oncall」；`<dataDir>/oncall-group-targets.json` | 下次需要新建或重试时读取 |
| 开关和来源群 | 每个 Bot 两项 | Bot 配置 `oncallGroup`，推荐由 Dashboard 维护 | 热更新；不会给已发出的无按钮卡片补按钮 |

### 服务凭据

在 Dashboard 的“消息卡片 → 转人工 Oncall → 基础设置”中，业务线与服务凭据左右两列展示，统一由底部“保存配置”提交。服务凭据需联系 Oncall 平台或服务账号管理员申请目标业务线访问及建群权限后获取，问号提示提供该说明。此入口只对具有宿主管理权限的管理员开放，写请求有同源和 CSRF 校验；管理员页面读取已保存的凭据并用 password 输入框遮罩显示，保存后保留新值，未修改时不重复提交；非管理员无法读取。清空已保存的必需凭据不会删除原配置，页面要求填写有效替换值。保存后各进程的后续 Oncall 操作自动加载，无需重启机器人。

旧部署若仅使用工作目录下的 `.env`，页面会拒绝创建会覆盖该配置来源的宿主文件；需先迁移到 `~/.botmux/.env` 并重启。

“已配置”表示保存文件或部署环境提供了服务凭据，不证明平台鉴权通过；保存值优先于进程继承的环境变量。可通过“检测连接”验证平台读取权限。

也可直接配置环境变量：

```dotenv
ONCALL_SERVICE_SECRET="<service-account-service-secret>"
```

将占位值替换为服务账号的 **Service Secret**。它不是个人 JWT，也不是 AK/SK 中的 SK；当前客户端没有 AK/SK 签名或兑换实现，不能直接填 SK。

本地配置文件为 `~/.botmux/.env`，权限应为 `0600`。部署平台则将密钥注入 daemon 的环境，不要仅注入到会话 CLI。宿主 `.env` 的已保存值优先于进程启动时继承的环境变量，管理员轮换后无需再手动重启。

服务账号须获准调用 Oncall 建群接口并访问目标租户。不要将密钥写进 `bots.json`、目标 JSON、命令行参数、日志、截图、文档或 PR；不要要求点击者提供个人 JWT。当前没有后台刷新服务 Secret 的模块，凭据失效由管理员轮换处理。

### 建群目标

网关地址和企业邮箱域由部署方提供，代码不内置任何组织地址。可在高级设置中填写，或写入部署环境：

```dotenv
ONCALL_GROUP_ENDPOINT="https://oncall.example.test/api/v1/oncall_platform/api/inf/v1/chat/"
ONCALL_EMAIL_DOMAIN="example.test"
```

管理员连接接口优先读取保存值，再读取部署环境和该 Bot 旧版配置；都未填写时显示为待配置，不能实际提单。邮箱域不带 `@`，用来验证点击者邮箱后取其本地部分作为平台用户名，不会替代通讯录授权或自动补齐缺失邮箱。

运行时按操作读取宿主安全 `.env`，保存值覆盖进程启动时继承的旧环境；未提供的字段继续回退到部署环境和该 Bot 旧版目标。网关与服务凭据在操作开始时使用同一个读取快照，避免跨请求混用。页面保存业务目标会保留旧字段，但不会把部署变量复制到每个 Bot。新部署需填写连接、业务线和服务凭据；任一缺失时都不能实际提单。保存后自动更新页面上的业务线和连接状态，后续操作无需重启。已经发出的请求保留本次读取快照，后续请求读取新值。 同时修改网关和服务凭据时通过同一接口原子写入宿主文件；失败保留原配置。分类缓存绑定连接和凭据摘要，旧请求晚返回时不会覆盖新配置缓存，缓存不保存明文凭据。

文件为 `<dataDir>/oncall-group-targets.json`，默认通常是 `~/.botmux/data/oncall-group-targets.json`。实际目录以 `config.session.dataDir` 为准，可受 `SESSION_DATA_DIR` 和已有数据目录记录影响，不要另建一份无人读取的配置。

```json
{
  "cli_example": {
    "tenantId": 123,
    "typeId": 456,
    "region": "nation"
  }
}
```

外层键替换为目标 Bot 的真实飞书 App ID。

| 字段 | 填写要求 |
| --- | --- |
| `ONCALL_GROUP_ENDPOINT` | 高级设置/部署环境：HTTPS 建群网关完整地址，支持服务账号 Bearer 鉴权；不得包含用户名、密码、查询串或片段 |
| `tenantId` | 已授权租户的正整数 ID |
| `typeId` | direct 必填，分类提单可不填；该租户下问题分类的正整数 ID，不是群 ID |
| `region` | direct 必填，分类提单可不填；平台接受且与目标匹配的区域标识；`nation` 仅为示例，不由客户端自动探测 |
| `ONCALL_EMAIL_DOMAIN` | 高级设置/部署环境：点击者邮箱域名，不带 `@`；需确认邮箱本地部分就是平台用户名 |

当前每个 App ID 只有一套目标，没有按来源群覆盖或卡片上的区域切换。修改目标不会改变已成功问题复用旧群的行为。

### 来源群

在 Dashboard 的 Bot 配置「消息卡片 → 转人工 Oncall → 交接设置」打开「启用转人工」，通过「生效群」下拉框选择群；日常页面优先显示平台返回的业务线名称和连接状态；“基础设置”内左右两列展示业务线和服务凭据，业务线名称和连接状态附在业务线字段下方，凭据显示遮罩占位与配置状态；网关与邮箱域由默认收起的“高级设置”维护，自动回填已有值。对应 Bot 配置片段为：

```json
{
  "oncallGroup": {
    "enabled": true,
    "chatIds": ["oc_example"]
  }
}
```

默认值是 `enabled: false`、`chatIds: []`。群列表去重，最多接受 500 个符合 `oc_` 格式的群 ID。关闭开关或移除群会让该群旧卡片的建群回调失效，但不会删除已有群或建群记录。

机器人还需能读取点击者邮箱、读取原消息、接收卡片回调并回复消息。身份解析依赖现有通讯录权限和可见范围；邮箱相关 scope 为 `contact:user.base:readonly`、`contact:user.email:readonly`，声明 scope 不等于已授权或对所有用户可见。邮箱缺失或域名不匹配时不会调用平台。

## 代码入口

| 职责 | 入口 |
| --- | --- |
| 开关、群选择和保存 | [bot-defaults-page.tsx](../src/dashboard/web/bot-defaults-page.tsx) 中 `OncallGroupSettings`；Dashboard `PUT /api/bots/:appId/oncall-group` 转发 daemon `PUT /api/bot-oncall-group` |
| 配置归一化、持久化和热更新 | [oncall-group-policy.ts](../src/services/oncall-group-policy.ts)、[bot-config-store.ts](../src/services/bot-config-store.ts)、[bot-registry.ts](../src/bot-registry.ts) |
| 普通最终回答、CLI 最终发送 | [worker-pool.ts](../src/core/worker-pool.ts)、[cli.ts](../src/cli.ts)，共用 `attachOncallGroupButton` 和 `recordOncallGroupDelivery` |
| 统一回复卡与长回答附件 | [turn-reply-card.ts](../src/im/lark/turn-reply-card.ts) 保留建群按钮；来源记录使用实际展示的最终回答，后续 bridge 输出不覆盖已发送的显式回答 |
| 按钮、来源校验及点击处理 | [oncall-group.ts](../src/im/lark/oncall-group.ts)；[card-handler.ts](../src/im/lark/card-handler.ts) 路由 `oncall_group_create` |
| 原反馈重渲染 | [skill-feedback-card.ts](../src/im/lark/skill-feedback-card.ts) 中 `renderFeedbackCard`，保留按钮并恢复 `behaviors` |
| 目标加载、邮箱映射、HTTP 调用 | [oncall-group-client.ts](../src/services/oncall-group-client.ts) |
| 来源索引、文件锁和去重状态 | [oncall-group-store.ts](../src/services/oncall-group-store.ts) |
| CLI 子进程密钥清理 | [child-env.ts](../src/utils/child-env.ts) 中 `REDACTED_CHILD_ENV_KEYS` |
| 页面服务凭据读写 | [oncall-service-secret.ts](../src/dashboard/oncall-service-secret.ts)，复用宿主安全文件、文件锁、同源及 CSRF 校验；`GET/PUT /api/oncall-service-secret` |

后续改动继续复用上述入口。不要单独复制一份反馈状态机、按钮工厂或认证 adapter；修改卡片时同时覆盖普通最终回答和 CLI 最终发送。鉴权只在 Oncall 客户端处理，不改全局 CLI 身份注入。

## 自动化测试

仓库使用 Bun `1.4.4`，具体约束见 [贡献指南](../CONTRIBUTING.md)。已有共享 `node_modules` 的 worktree 不运行 `bun install`，避免影响正在运行的其它 checkout。

针对 Oncall、凭据隔离、原身份逻辑及 Bun runner 的回归：

```bash
bun run test test/oncall-service-secret.test.ts test/oncall-target-settings-ui.test.ts
bun run test test/oncall-group.test.ts test/oncall-group-callback.test.ts \
  test/bytedcli-auth.test.ts test/child-env.test.ts \
  test/turn-cli-identity.test.ts test/bun-runner-selectors.test.ts
```

原反馈和环境隔离回归：

```bash
bun run test test/skill-feedback-card.test.ts test/skill-feedback-callback.test.ts \
  test/feedback-policy.test.ts test/command-handler.test.ts \
  test/cli-identity.test.ts test/dashboard-daemon-proxy-routes.test.ts \
  test/daemon-lifecycle-env.test.ts test/tmux-backend-env.test.ts
```

配置保存或投递入口有变化时，还应跑相关集成回归：

```bash
bun run test test/bot-config-store.test.ts test/dashboard-ipc.test.ts \
  test/bridge-final-output-retry.test.ts test/cli-send-reply-card.test.ts \
  test/turn-reply-card.test.ts test/cli-send-hook-context.test.ts
bun run build
bun run test:bun:self-check
```

主要断言包括：默认关闭、空群列表、跨群和私聊不展示、重复装配不新增按钮、二级反馈后回调仍在、点击者映射、Secret 缺失、401/403 提示、并发去重、超时不重建，以及成功落盘但回复失败后的链接复用。自动化中替换 `fetch` 只用于测试，不是部署中的 mock 接口。

统一回复卡还需验证显式发送和 bridge 最终回答、完成态刷新、长回答转附件后按钮与来源记录仍一致。以上是回归入口，实际执行结果以当前提交的测试输出和 PR CI 为准；Bun runner 自检不代表全量 Bun 测试通过。

## 当前分支验证记录

以下为阶段性验证记录，不代表最终提交已部署。早期基线为 master `dce2c9f603061b0d2266bf928bd36b026c46d0b0`。Bun 1.4.4 构建及类型检查通过；Node 24 执行 9 文件 422 项扩展回归通过，补充修复后的 8 文件 289 项回归通过，`git diff --check` 通过。最终提交的基线及验证结果以 PR 说明为准。

异常探针覆盖：并发用户只能认领一次、管理员在 identity/snapshot 等待期间切换发起方式后不得继续 direct、unknown 结果不能降为 failed、旧请求升级后继续去重、转发成功但回执未落盘时沿用 UUID、去重窗口外停止不确定重发、旧反馈卡不能恢复失效入口。隔离副本移除 unknown 状态保护及普通群消息归属过滤时，探针均失败。

Linux 候选实例已完成实际配置热保存、运行时凭据检查、平台区域/分类读取以及测试群卡片投递。早期仅完成入口联调；现已切换群内普通分类卡并从飞书实际点击提单，平台自动邀请测试机器人，源会话 5 条原文的目标回执逐条回读成功，分类卡被排除。原生侧栏仍只验证入口，不计为完整闭环。测试实例单独切换，其他 Bot 进程与共享启动文件保持不变。

## 部署验收

1. 配齐凭据和目标，确认服务账号授权、通讯录邮箱权限和持久化数据目录。先仅对专用测试群启用按钮。
2. 在准备部署的 checkout 完成测试和构建，再安排重启。仅构建不会切换当前 live 版本；需要切换 checkout 时依次执行 `bun run switch:here`、`bun run daemon:restart`。这会影响该部署管理的全部 Bot，应确认运行实例和测试窗口后再操作。
3. 在来源群发起一个新问题，等待新最终回答。检查按钮出现，原反馈及二级选择正常；在未启用群中确认无按钮。
4. 点击按钮，确认原回答下出现真实群链接，平台只有一条对应流程。核对租户、分类、区域、问题内容和发起人，并实际检查点击者是否已加入群。
5. 同一问题重复或并发点击，确认不重复建群；换另一位用户发起新问题并点击，验证服务账号代建及其实际入群行为，而不是只复用已有链接。
6. 关闭开关，再点击旧卡片应被拒绝。真实请求出现超时或结果不明时先核对平台，不反复点击或删除记录试错。

个人凭据的真实建群记录不能替代服务账号方式和跨用户入群验收；平台连接检测也不能替代真实提单。具体提交、运行凭据方式和真实建群验收结果由交付记录注明。

## 故障处理

| 现象 | 检查和处理 |
| --- | --- |
| 看不到按钮 | 确认运行的是当前构建、目标 Bot 和来源群匹配、开关开启，并查看启用后新发出的最终回答 |
| 旧卡片提示未开启或失效 | 检查群范围与 `<dataDir>/oncall-groups/messages/` 来源索引；不要为旧卡片伪造来源记录 |
| 建群服务未配置或配置无效 | 检查实际数据目录、目标 JSON 外层 App ID、五项参数及 HTTPS 地址 |
| 缺少 `ONCALL_SERVICE_SECRET` | 在基础设置填写 Service Secret 并保存；也可通过部署环境注入，不能只配置在 CLI 会话中 |
| HTTP 401 | 检查凭据类型、有效性及实际进程是否仍使用旧值；必要时轮换后手动重试 |
| HTTP 403 | 检查服务账号的接口、租户及平台代建授权，不反复刷新个人 JWT |
| 无法确认 Oncall 账号 | 检查回调点击者、通讯录邮箱权限、可见范围、邮箱域名和平台用户名映射 |
| 结果待确认 | 查看持久化请求状态，并用原消息 ID 和问题内容核对平台；当前没有自动重试或状态修复入口 |
| 平台已成功但飞书没收到链接 | 若本地已为 `succeeded`，再次点击会复用链接；若本地仍为 `pending/unknown`，先人工核对 |
| 群已创建但点击者不在群 | 核对平台发起人和入群规则；当前代码不补发邀请，不能以 HTTP 成功代替入群验收 |

停用时优先关闭对应 Bot 的按钮开关，保留去重记录；如需回退代码，重新部署已验证版本。排障输出只保留必要状态和错误类别，避免暴露凭据、问题正文或个人信息。


## 群内分类卡与交接恢复

分类卡默认 `formDisplay=thread_card`，以同话题普通消息投递，所有人可见、仅发起人操作；按钮固定最新回复卡右下角。选择先持久化并通过 dispatcher 的 deferredCard 在 ACK 后更新，关闭终态通过 afterAck 发布；闭草稿只允许同身份、同卡片重放终态。不要在 callback ACK 前 PATCH 回调卡，飞书会在 callback 完成时恢复旧视图。

交接清单排除同 session 持久草稿登记的分类卡消息 ID，不能依赖列表 API 返回 callback value。建群确认后保存 session 绑定，实际核验机器人入群再转发；近 24 小时未完成交接每 5 秒重试，配置关闭及停机中止后续发送。目标回执逐条持久化，重试不重复建群。

本轮定向回归覆盖 8 文件 178 项，另有 CLI 退役轮次来源恢复定向用例，构建与资源审计通过。独立异常探针覆盖 ACK 与 PATCH 交叠、丢回执旧版本恢复、取消终态重放、机器人迟入群、转发中停机及 API 省略回调字段；关键守卫的隔离变异均使测试失败。真实飞书验收记录仅存仓外，不写入真实身份、群和凭据。


`forwardMode` 在提单确认时固定为 `individual`（默认）或 `merge`。合并调用飞书原生 mergeForward，最多100条一批，保持来源顺序；批次发送前持久化原消息列表与开始时点，回执按原消息逐项记账。部分无效消息不视为送达，补发只发送缺项；丢回执保留同UUID，超过去重保守窗口停止。已存在的逐条记录保持原UUID，即使管理员中途改配置也不切换方式。

同轮卡片的发布顺序由 session 记录持久保存，旧处理中卡重绘不能抢回最终卡入口。先提交 session 完整来源，再写消息次级索引，半写时可从 session 最新来源恢复。CLI 的原轮次租约退役后，转人工卡仍复用已证明的 session 轮次；这一展示关联不改变发送授权。

## 紧凑入口与等待态

“转人工”使用右侧小号中性按钮，与页脚同排；成功后使用“进入人工 Oncall 群”小号按钮，右侧灰色状态说明表示交接结果。等待机器人入群、待补转等状态仍按实际事实展示，不用成功文案覆盖失败。

动态单卡的初始等待态只保留简洁提示和必要操作；启用原生 CoT 的运行轮次不再在答案卡中重复展示大块状态、耗时或模型信息。同轮 Ask 仍使用原有交互，最终答复与反馈结构保留。

本次定向验证覆盖原生 CoT 首发顺序、慢 create/prologue、早到终态、exact attempt、CLI 首次发布屏障与授权重验、丢回执重试，以及紧凑初始态、页脚按钮和反馈刷新兼容。构建与类型检查通过；仅复验失败项，未重复运行全量测试。指定测试实例的真实消息回读确认原生过程消息早于答案卡，既有已完成转人工卡已更新为小号中性入口并保留原目标链接。客户端视觉截图因工作站锁屏未完成；真实验收任务另遇既有 TRAE transcript 未归档问题，正常最终答复链路没有冒充验收通过。

补充失败路径：structured 轮次在 transcript 起始租约到期后，以带类型的只读通知结束公开 UI；原生 CoT 标为中断，原答案卡承载“状态待确认”和原告警。此路径不将 CLI 推断为未执行，不改变业务任务结算，也不重跑输入。卡片 PATCH 失败时沿用既有告警通知兜底。该路径及兜底均已通过专项测试。

公开 UI 收尾使用独立的 `turn_display_retired` IPC；因此即使同轮已存在提交告警、通知被去重，原生 CoT 与答案卡仍会结束等待态。该消息只在普通结构化轮次的归属租约实际退休时产生，不用于推断底层 CLI 是否执行。

最终实际异常 case 已回读确认：轮次公开卡为 ambiguous，原告警在同一答案卡中，原生 CoT 已以 interrupted 收尾，对应恢复 marker 已清除。此验收证明公开 UI 的失败收尾，不表示修复了 TRAE transcript 未归档的问题。

### 管理员连接设置

`GET/PUT /api/oncall-connection` 仅允许宿主管理员，写入沿用 CSRF 和安全 `.env` 文件校验。GET 可带 `appId` 回填该 Bot 的旧版连接；PUT 只接受 `endpoint`、`emailDomain`，不会改写服务凭据。凭据通过基础设置中的密码框加载和编辑，默认遮罩显示；仅实际修改时随底部唯一保存按钮提交，保存后继续保留。连接配置保存后重启生效；连通性和业务线名称来自已加载配置的只读平台请求，不等同于真实建群权限。

日常页面按基础设置、交接设置排列。未加载服务凭据时无法调用平台；可先输入新凭据并一起保存启用配置，随后需重启加载，页面不会自动重启。部署已提供凭据时无需再次输入。业务线与交接策略保存后用于后续请求，无需重启。保存期间收到其他页面的交接策略更新时停止覆盖并提示重新确认。交接设置在宽屏采用两行两列，窄屏自动纵排。

### Dashboard 高级连接设置

转人工子卡底部提供默认收起的“高级设置”，左右两列编辑网关地址、企业邮箱域。读取复用宿主管理员 `GET /api/oncall-connection?appId=...`，自动带入保存值、部署值或当前 Bot 的旧版值，不在前端内置组织地址。读取失败时禁用这两个输入，不影响其他业务设置保存。

高级设置复用唯一的底部保存按钮；修改只保留在本地草稿，连接有变化时才调用管理员 `PUT /api/oncall-connection`，带 CSRF。顺序为服务凭据、连接参数、业务目标、交接策略；部分失败保留剩余草稿并可重试，不重复写入已成功部分。连接变更后提示重启加载，待保存或待加载期间不允许用旧运行配置检测新连接；不会自动重启机器人。连接参数同一部署共用，仍遵循部署环境的既有加载顺序。
