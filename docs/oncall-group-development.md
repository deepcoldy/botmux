# Oncall 群按钮开发文档

配套 [技术方案](oncall-group-button.md)。本文用于配置接入、定位代码、执行回归和上线验收；仓库示例全部使用占位值，不包含真实账号、群 ID、部署主机或密钥。

## 配置清单

**需要一个 Secret，不需要每个用户或每个群各配一个。** 全新接入还需为每个 Bot 配一套五项建群目标，并在 Dashboard 打开开关、选择来源群。已有目标和群范围时，只补凭据及平台授权。

| 配置 | 数量 | 位置 | 生效方式 |
| --- | --- | --- | --- |
| `ONCALL_SERVICE_SECRET` | 每套 daemon 环境一个 | Oncall 页面密码框保存到 `~/.botmux/.env`，或部署 Secret 注入 | 更新实际进程环境并重启 |
| 建群目标 | 每个 Bot 五项 | `<dataDir>/oncall-group-targets.json` | 下次需要新建或重试时读取 |
| 开关和来源群 | 每个 Bot 两项 | Bot 配置 `oncallGroup`，推荐由 Dashboard 维护 | 热更新；不会给已发出的无按钮卡片补按钮 |

### 服务凭据

推荐在 Dashboard 的 Oncall 设置旁填写 Service Secret 并保存。此入口只对具有宿主管理权限的管理员开放，写请求有同源和 CSRF 校验；页面只显示配置状态，保存后清空输入框，不回显密钥。空输入不会删除原凭据。保存后需重启 BotMux，页面不会自动重启机器人。

旧部署若仅使用工作目录下的 `.env`，页面会拒绝创建会覆盖该配置来源的宿主文件；需先迁移到 `~/.botmux/.env` 并重启。

“已配置”表示宿主 `.env` 中存在该项，不证明平台鉴权通过；仅由外部进程环境注入的凭据不在该文件状态的统计范围内。外部注入的旧值仍可能优先于文件，需由部署方同步更新。

也可直接配置环境变量：

```dotenv
ONCALL_SERVICE_SECRET="<service-account-service-secret>"
```

将占位值替换为服务账号的 **Service Secret**。它不是个人 JWT，也不是 AK/SK 中的 SK；当前客户端没有 AK/SK 签名或兑换实现，不能直接填 SK。

本地配置文件为 `~/.botmux/.env`，权限应为 `0600`。部署平台则将密钥注入 daemon 的环境，不要仅注入到会话 CLI。启动时已有环境变量可能优先于 `.env`，轮换后应确认实际运行进程使用了新值，不能只修改文件而不更新启动环境。

服务账号须获准调用 Oncall 建群接口并访问目标租户。不要将密钥写进 `bots.json`、目标 JSON、命令行参数、日志、截图、文档或 PR；不要要求点击者提供个人 JWT。当前没有后台刷新服务 Secret 的模块，凭据失效由管理员轮换处理。

### 建群目标

文件为 `<dataDir>/oncall-group-targets.json`，默认通常是 `~/.botmux/data/oncall-group-targets.json`。实际目录以 `config.session.dataDir` 为准，可受 `SESSION_DATA_DIR` 和已有数据目录记录影响，不要另建一份无人读取的配置。

```json
{
  "cli_example": {
    "endpoint": "https://oncall.example.test/api/v1/oncall_platform/api/inf/v1/chat/",
    "tenantId": 123,
    "typeId": 456,
    "region": "nation",
    "emailDomain": "example.test"
  }
}
```

外层键替换为目标 Bot 的真实飞书 App ID。`example.test` 只是占位域名，不是可用服务或测试接口。

| 字段 | 填写要求 |
| --- | --- |
| `endpoint` | 支持服务账号 Bearer 鉴权的官方 HTTPS 建群网关完整地址；不得包含用户名、密码、查询串或片段 |
| `tenantId` | 已授权租户的正整数 ID |
| `typeId` | 该租户下问题分类的正整数 ID；不是群 ID |
| `region` | 平台接受且与目标匹配的区域标识；`nation` 仅为示例，不由客户端自动探测 |
| `emailDomain` | 点击者邮箱域名，不带 `@`；需确认邮箱本地部分就是平台用户名 |

当前每个 App ID 只有一套目标，没有按来源群覆盖或卡片上的区域切换。修改目标不会改变已成功问题复用旧群的行为。

### 来源群

在 Dashboard 对目标 Bot 打开「消息卡片 / 最终回答反馈」旁的「支持拉起 Oncall 群」，通过「生效群」下拉框选择群。对应 Bot 配置片段为：

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
| 按钮、来源校验及点击处理 | [oncall-group.ts](../src/im/lark/oncall-group.ts)；[card-handler.ts](../src/im/lark/card-handler.ts) 路由 `oncall_group_create` |
| 原反馈重渲染 | [skill-feedback-card.ts](../src/im/lark/skill-feedback-card.ts) 中 `renderFeedbackCard`，保留按钮并恢复 `behaviors` |
| 目标加载、邮箱映射、HTTP 调用 | [oncall-group-client.ts](../src/services/oncall-group-client.ts) |
| 来源索引、文件锁和去重状态 | [oncall-group-store.ts](../src/services/oncall-group-store.ts) |
| CLI 子进程密钥清理 | [child-env.ts](../src/utils/child-env.ts) 中 `REDACTED_CHILD_ENV_KEYS` |
| 页面服务凭据读写 | [oncall-service-secret.ts](../src/dashboard/oncall-service-secret.ts)，复用宿主安全文件、文件锁、同源及 CSRF 校验；`GET/PUT /api/oncall-service-secret` |

后续改动继续复用上述入口。不要单独复制一份反馈状态机、按钮工厂或认证 adapter；修改卡片时同时覆盖普通最终回答和 CLI 最终发送。鉴权只在 Oncall 客户端处理，不改全局 CLI 身份注入。

## 自动化测试

仓库使用 Bun `1.4.2`，具体约束见 [贡献指南](../CONTRIBUTING.md)。已有共享 `node_modules` 的 worktree 不运行 `bun install`，避免影响正在运行的其它 checkout。

针对 Oncall、凭据隔离、原身份逻辑及 Bun runner 的回归：

```bash
bun run test test/oncall-service-secret.test.ts test/oncall-service-secret-ui.test.ts
bun run test test/oncall-group.test.ts test/oncall-group-callback.test.ts \
  test/bytedcli-auth.test.ts test/child-env.test.ts \
  test/turn-cli-identity.test.ts test/bun-runner-selectors.test.ts
```

原反馈和环境隔离回归：

```bash
bun run test test/skill-feedback-card.test.ts test/skill-feedback-callback.test.ts \
  test/feedback-policy.test.ts test/command-handler.test.ts \
  test/cli-identity.test.ts test/dashboard-feedback-settings.test.ts \
  test/daemon-lifecycle-env.test.ts test/tmux-backend-env.test.ts
```

配置保存或投递入口有变化时，还应跑相关集成回归：

```bash
bun run test test/bot-config-store.test.ts test/dashboard-ipc.test.ts \
  test/bridge-final-output-retry.test.ts
bun run build
bun run test:bun:self-check
```

主要断言包括：默认关闭、空群列表、跨群和私聊不展示、重复装配不新增按钮、二级反馈后回调仍在、点击者映射、Secret 缺失、401/403 提示、并发去重、超时不重建，以及成功落盘但回复失败后的链接复用。自动化中替换 `fetch` 只用于测试，不是部署中的 mock 接口。

页面凭据入口增加前的开发记录：Oncall、身份与反馈回归共 **671 项通过、5 项跳过**，完整构建和 Bun runner 自检通过；该统计不含新增的两个页面凭据测试文件。入口集成回归列作后续改动的验证要求，不包含在这个统计中；自检也不代表全量 Bun 测试通过。远端 PR CI 状态应另行确认。

## 部署验收

1. 配齐凭据和目标，确认服务账号授权、通讯录邮箱权限和持久化数据目录。先仅对专用测试群启用按钮。
2. 在准备部署的 checkout 完成测试和构建，再安排重启。仅构建不会切换当前 live 版本；需要切换 checkout 时依次执行 `bun run switch:here`、`bun run daemon:restart`。这会影响该部署管理的全部 Bot，应确认运行实例和测试窗口后再操作。
3. 在来源群发起一个新问题，等待新最终回答。检查按钮出现，原反馈及二级选择正常；在未启用群中确认无按钮。
4. 点击按钮，确认原回答下出现真实群链接，平台只有一条对应流程。核对租户、分类、区域、问题内容和发起人，并实际检查点击者是否已加入群。
5. 同一问题重复或并发点击，确认不重复建群；换另一位用户发起新问题并点击，验证服务账号代建及其实际入群行为，而不是只复用已有链接。
6. 关闭开关，再点击旧卡片应被拒绝。真实请求出现超时或结果不明时先核对平台，不反复点击或删除记录试错。

此前已用临时个人凭据完成过真实建群，但它不能证明当前服务账号方式和跨用户入群已验收。**当前服务账号代建仍待配置凭据后真实联调**。本次整理文档不部署、不重启，也不创建真实群。

## 故障处理

| 现象 | 检查和处理 |
| --- | --- |
| 看不到按钮 | 确认运行的是当前构建、目标 Bot 和来源群匹配、开关开启，并查看启用后新发出的最终回答 |
| 旧卡片提示未开启或失效 | 检查群范围与 `<dataDir>/oncall-groups/messages/` 来源索引；不要为旧卡片伪造来源记录 |
| 建群服务未配置或配置无效 | 检查实际数据目录、目标 JSON 外层 App ID、五项参数及 HTTPS 地址 |
| 缺少 `ONCALL_SERVICE_SECRET` | 将 Service Secret 配到实际 daemon 环境，而不是 CLI 会话；更新启动环境并重启 |
| HTTP 401 | 检查凭据类型、有效性及实际进程是否仍使用旧值；必要时轮换后手动重试 |
| HTTP 403 | 检查服务账号的接口、租户及平台代建授权，不反复刷新个人 JWT |
| 无法确认 Oncall 账号 | 检查回调点击者、通讯录邮箱权限、可见范围、邮箱域名和平台用户名映射 |
| 结果待确认 | 查看持久化请求状态，并用原消息 ID 和问题内容核对平台；当前没有自动重试或状态修复入口 |
| 平台已成功但飞书没收到链接 | 若本地已为 `succeeded`，再次点击会复用链接；若本地仍为 `pending/unknown`，先人工核对 |
| 群已创建但点击者不在群 | 核对平台发起人和入群规则；当前代码不补发邀请，不能以 HTTP 成功代替入群验收 |

停用时优先关闭对应 Bot 的按钮开关，保留去重记录；如需回退代码，重新部署已验证版本。排障输出只保留必要状态和错误类别，避免暴露凭据、问题正文或个人信息。
