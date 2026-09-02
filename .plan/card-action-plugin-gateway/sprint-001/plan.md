# feat(plugin): 实现通用卡片动作插件网关

## Sprint 目标

把当前进程内 Handler Registry 重构为持久化、通用的插件服务能力：插件用固定 convention 声明精确 action 或 action namespace prefix allowlist 与 loopback endpoint，Botmux 按 Bot 启用范围通过私有 token 转发版本化 JSON，并继续独占 Lark ACK、去重、超时和 late patch。最终源码中不存在任何 Happy Cloud 专用逻辑。

## plan_root

`.plan/card-action-plugin-gateway`

## files_to_touch

Generator 负责源码和设计文档；不得写 `test/**`：

- `src/core/plugins/types.ts`
- `src/core/plugins/convention-scanner.ts`
- `src/core/plugins/paths.ts`
- `src/core/plugins/materializer.ts`
- `src/core/plugins/service-manager.ts`
- `src/core/plugins/card-actions/auth.ts`（新增）
- `src/core/plugins/card-actions/protocol.ts`（新增）
- `src/core/plugins/card-actions/gateway.ts`（新增）
- `src/im/lark/card-handler.ts`
- `src/im/lark/card-action-handler-registry.ts`（删除；以持久化插件 gateway 替代）
- `src/im/lark/event-dispatcher.ts`
- `src/daemon.ts`
- `src/features/happy-cloud/card-action.ts`（删除）
- `docs/design/2026-09-02-card-action-handler-registry.md`（删除）
- `docs/design/2026-09-02-card-action-plugin-gateway.md`（新增）

Evaluator 负责下列测试/fixture；不得修改上述业务源码：

## test_files

- `test/plugin-manifest-store.test.ts`
- `test/plugin-service-link-watch.test.ts`
- `test/plugin-card-action-gateway.test.ts`（替代 `test/card-action-handler-registry.test.ts`）
- `test/card-action-handler-registry.test.ts`（删除）
- `test/plugin-card-action-gateway.integration.test.ts`（新增）
- `test/fixtures/plugin-card-action-service.ts`（新增；由 `test/helpers/ts-runner.ts` 启动）
- `test/event-dispatcher.test.ts`

## 实施步骤

1. 在插件类型和 scanner 中增加公开 `cardActions` contribution，固定读取 `card-actions/index.json`，支持可选 `actions` 与 `actionPrefixes`（至少一个非空），严格校验 schema、静态 selector、endpoint，以及与 service contribution 的组合约束；materialized marker 同步暴露非私密索引。
2. 新增私有 token helper：安全创建/读取 `private/card-actions.token`，拒绝 symlink/非普通文件，确保 per-plugin 独立且不进入 public files。
3. 在 `service-manager` 生成服务环境时，在插件 env 合并后冻结注入 token 和 endpoint；有 cardActions 时要求有效固定 port。保持现有 auto/manual、update/uninstall、linked watch 和配置 hash 行为。
4. 新增版本化 protocol 与 HTTP gateway：按 `larkAppId` 的有效插件筛选 allowlist，精确 action 优先、prefix 按最长匹配；相同 exact 或相同 prefix 在同一 Bot 有效插件集合内冲突时 fail closed。从服务状态取 port，以 `loopbackFetch` + Bearer token POST；限制 body/response/总耗时并校验 ACK。
5. daemon 将现有内建 `handleCardAction` 作为未命中插件时的兼容 fallback，注入每个 Bot 的 effective plugin resolver；不再注册任何编译进程内业务 handler。
6. 保留并补全 event dispatcher 的 `action.name` selector、2.5 秒 ACK、`event_id`/in-flight 去重和 late patch；网关不得重复实现 Lark deadline。
7. 删除 Happy Cloud helper、专用测试数据和旧设计文档，新增面向所有插件作者的声明、请求/响应、鉴权、生命周期、慢响应和业务幂等说明。
8. Evaluator 用可执行本机 mock HTTP plugin service 覆盖主流链路，并补 scanner、token、绑定隔离、冲突、失败、重连和内建回归测试。

## 核心不变量

- `card.action.trigger` 仍只有 Botmux Lark dispatcher 接收，插件绝不持有 Lark secret/WS。
- 外部 action 只能命中安装时扫描出的精确 action 或静态 namespace prefix allowlist；payload 不能指定 endpoint、pluginId、prefix 或模块路径。
- gateway 只拨字面量 loopback，token 不走代理、不进 URL、不进日志、不进公共状态文件。
- 每次回调按 `larkAppId` 使用 global + bot plugin binding；不能跨 Bot 泄漏 action 或 app-scoped `open_id`。
- 插件异常、离线、慢响应和非法响应不能拖死长连接，也不能破坏内建卡片 fallback。
- Botmux 核心对接入方业务字段保持完全不知情。

## 场景（BDD）

```gherkin
Feature: feat(plugin): 实现通用卡片动作插件网关
  As a Botmux 插件开发者和飞书卡片操作者
  I want 通过受鉴权的通用插件服务消费静态声明的卡片动作
  So that 新业务只发布插件即可接入 Botmux 的既有长连接与 ACK 能力

  Background:
    Given Botmux 使用测试 HOME 中隔离的插件 registry、materialized 文件和 service state
    And 测试中的 Lark SDK 与消息更新 API 已被隔离，不访问真实飞书
    And 可执行 mock 插件服务通过 test/helpers/ts-runner.ts 启动并只监听字面量 loopback

  Scenario: 安装并启用一个合法的通用卡片动作插件  @id=S-1
    Given 插件 dist 同时包含合法 service/index.js 与声明 actions、actionPrefixes、endpoint 的 card-actions/index.json
    When 插件开发者安装并启用该插件
    Then 公共 registry 与 materialized marker 应只记录精确 actions、静态 actionPrefixes 和相对 endpoint
    And 公共文件中不应出现 per-plugin token 或回调正文

  Scenario: 拒绝不安全或不完整的卡片动作声明  @id=S-2
    Given 插件声明包含空或非法 selector、actions 与 actionPrefixes 均为空、远程或越界 endpoint、缺失 service 中的一种
    When 插件开发者尝试安装该插件
    Then 安装应以确定性诊断失败
    And registry 与目标 runtime 不应留下半安装记录

  Scenario: 将已启用插件的卡片动作完整转发并返回同步 ACK  @id=S-3
    Given 插件只对当前 Lark App 有效且 mock 服务返回合法 success toast
    When 操作者点击该插件静态声明的卡片 action
    Then mock 服务应只收到一次带 Bearer token 的版本化 POST
    And 请求应包含 eventId、larkAppId、平台 operator、context、actionName、value、name、option 和 formValue
    And 操作者应收到插件返回的 success toast

  Scenario: 隔离不同 Bot 的插件绑定  @id=S-4
    Given 同一 daemon 的 Bot A 启用插件而 Bot B 未启用插件
    When 两个 Bot 各收到一次同名插件卡片 action
    Then mock 服务应只收到 Bot A 的请求并带 Bot A 的 larkAppId
    And Bot B 应获得合法 ACK 且不泄漏 Bot A 的 operator 或表单

  Scenario: 保持既有 Botmux 卡片动作行为不变  @id=S-5
    Given 当前 action 没有被当前 Bot 的任何有效插件声明
    When 操作者点击一张既有 Botmux 卡片
    Then daemon 应只调用一次既有 handleCardAction fallback
    And 返回给操作者的 toast 或 card 应与改造前一致

  Scenario Outline: 按确定性规则选择或熔断动作声明  @id=S-6
    Given 当前 Bot 启用的插件声明形成 <declaration_case>
    When 操作者点击匹配这些声明的卡片 action
    Then Botmux 应产生 <routing_result>
    And 未被选中的插件不应收到请求且日志不应包含 payload

    Examples:
      | declaration_case | routing_result |
      | 一个精确 action 与一个可匹配 prefix | 只向精确 action 所属插件发送一次请求 |
      | 两个不同长度且都可匹配的 prefix | 只向最长 prefix 所属插件发送一次请求 |
      | 两个插件声明相同精确 action | 不向任何插件发送并返回合法空 ACK 与冲突审计 |
      | 两个插件声明相同 prefix | 不向任何插件发送并返回合法空 ACK 与冲突审计 |

  Scenario Outline: 隔离不可用服务和非法插件响应  @id=S-7
    Given 已启用插件服务处于 <failure_mode>
    When 操作者点击该插件声明的卡片 action
    Then Botmux 应在边界内结束该次转发并返回合法 ACK
    And daemon 与同一 Lark 长连接应继续处理后续卡片动作

    Examples:
      | failure_mode |
      | stopped service state |
      | connection refused |
      | HTTP non-2xx or redirect |
      | invalid JSON or schema |
      | oversized response |
      | gateway 30-second timeout |

  Scenario: 为慢插件先 ACK 再更新原卡片  @id=S-8
    Given mock 插件服务在 2.5 秒后且 30 秒内返回合法 card
    When 操作者点击该插件声明的卡片 action
    Then Botmux 应在飞书 3 秒 deadline 前返回后台处理中 toast
    And 插件完成后 Botmux 应只 patch 一次原 open_message_id

  Scenario: 按稳定 eventId 抑制重复业务投递  @id=S-9
    Given 两次回调具有相同 larkAppId 和稳定 eventId
    When Lark dispatcher 连续投递这两次回调
    Then mock 插件服务应只收到一次 POST
    And 重复回调应收到不重复执行的合法 toast

  Scenario: 为每个插件服务注入独立且不可覆盖的私有 token  @id=S-10
    Given 两个 cardActions 插件尝试在自定义 service env 中伪造网关 token
    When Botmux 生成并启动这两个插件服务
    Then 两个服务应分别获得不同的 Botmux 生成 token 和各自 endpoint
    And token 文件应为非 symlink 的 0600 普通文件且插件 env 不能覆盖它
    And registry、materialized、service report 与日志中均不应出现 token

  Scenario: 服务与长连接恢复后无需重新注册业务 Handler  @id=S-11
    Given 插件已启用且其服务 restart 后保持同一 token，同时 Lark WSClient 已完成 reconnect
    When 操作者再次点击该插件声明的卡片 action
    Then 新服务进程应收到且只收到一次请求
    And Botmux 不应要求 daemon restart 或产生重复 Handler 注册
```

## 验证命令

```bash
node_modules/.bin/vitest run --project unit \
  test/plugin-manifest-store.test.ts \
  test/plugin-service-link-watch.test.ts \
  test/plugin-card-action-gateway.test.ts \
  test/plugin-card-action-gateway.integration.test.ts \
  test/event-dispatcher.test.ts
node_modules/.bin/tsc --noEmit
bun run build
git diff --check
```

额外静态门禁：

```bash
! rg -n -i 'happy[_ -]?cloud|happycloud|finding|fix/ignore/defer' \
  src/core/plugins/card-actions src/features src/im/lark/card-action-handler-registry.ts \
  test/plugin-card-action-gateway.test.ts test/plugin-card-action-gateway.integration.test.ts \
  docs/design/2026-09-02-card-action-plugin-gateway.md
```

允许路径不存在（被删除）时由 evaluator 将命令拆成存在路径列表执行，结论必须是 Botmux 通用实现和对应测试/文档没有接入方专用业务词。

## 准出条件

- BDD `S-1` 至 `S-11` 的 `must_pass=true` verification 全部通过。
- 本机可执行 mock plugin service 主链路真实完成 loopback TCP、Bearer 鉴权、JSON 请求与 ACK 返回，不以 mock `fetch` 代替。
- 现有内建卡片、ACK timeout、dedupe、late patch 测试无回归。
- `tsc --noEmit`、`bun run build`、`git diff --check` 通过。
- 通用源码、测试和新设计文档没有 Happy Cloud 专用 action、表单或业务流程。
- evaluator 评分不少于 90，且反虚假完成检查无命中。

## 反虚假完成自检

- 不接受只新增 interface/文档而 daemon 没有真实 HTTP 路由。
- 不接受把 mock handler 直接注册进进程内 registry 代替可执行 loopback service。
- 不接受只断言函数被调用而未验证真实 POST headers/body/response。
- 不接受插件自报 endpoint host/URL，或使用全局 `fetch` 发送 token。
- 不接受通过 action 值推导 operator，也不接受日志快照包含 token/表单正文。
- 不接受删除内建 fallback 或通过“未知 action”测试掩盖既有卡片回归。
- 不接受在 Botmux 核心保留任何接入方专用 helper/常量。
