# Sprint 002：补齐 Subject 监听的 Dashboard 与配置兼容入口

## 迭代目标（Goal）

管理员可以在现有消息监听编辑器中选择普通提示词监听或 Subject 主体监听，配置兜底消息数并保存、刷新、预览；旧配置不迁移也保持原行为。

## 实现方案

- `src/services/message-listener-store.ts`：sanitize/validate/persist `behavior` 与 `subjectPolicy.context`；Subject 允许空 prompt，legacy enabled listener 仍要求 prompt；未知枚举拒绝。
- `src/core/dashboard-ipc-server.ts`：GET/PUT/preview/run-preview 完整透传 Subject 配置，试运行使用与真实监听一致的 Subject 协议和飞书上下文。
- `src/dashboard/web/roles.ts`：扩展 Dashboard listener 数据类型。
- `src/dashboard/web/roles-page.tsx`：增加监听行为选择与 `fallbackMessages` 数字配置；Subject 下提示词显示为可选关注范围，legacy 校验不变。
- `src/dashboard/web/i18n.ts`：增加中英文说明，明确 @ 不受影响、Subject 基于飞书增量历史且无关时静默。
- `test/message-listener-store.test.ts`、`test/dashboard-ipc.test.ts`、`test/dashboard-message-listener-subject.e2e.ts`：由 evaluator 编写配置 round-trip、兼容和用户操作链路测试。

## 场景（BDD）

```gherkin
Feature: Subject 监听的 Dashboard 与配置兼容入口
  As a Bot 管理员
  I want 在现有消息监听页面选择 Subject 并配置历史兜底条数
  So that 我不需要手改 bots.json 也能安全启用主体监听

  Background:
    Given 管理员已打开某个群与 Bot 的消息监听编辑器
    And Dashboard API 使用临时 bots.json 测试配置

  Scenario: 管理员保存 Subject 监听并在刷新后看到相同配置  @id=S-1
    Given 编辑器当前选择 Subject 主体监听并填写 fallbackMessages 为 30
    When 管理员点击保存并重新加载该监听器
    Then behavior 应保持为 subject 且 fallbackMessages 应为 30
    And 空的可选关注范围不应触发 prompt_required

  Scenario: 旧监听配置在升级后保持原来的提示词行为  @id=S-2
    Given bots.json 中有一个没有 behavior 且带非空 prompt 的旧监听器
    When Dashboard 加载、保存并试运行该监听器
    Then 它应继续按 legacy prompt listener 处理
    And 不应被自动改写为 Subject

  Scenario: 管理员无法保存未知模式或非法兜底条数  @id=S-3
    Given Dashboard API 收到未知 behavior 或非正整数 fallbackMessages
    When 管理员提交监听配置
    Then API 应返回可诊断的 400 错误
    And bots.json 中的原配置不应被修改
```

## 评分标准

见 [eval-rubrics.yaml](./eval-rubrics.yaml)。
