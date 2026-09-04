# Sprint 001：实现基于飞书增量上下文的 Subject 监听运行时

## 迭代目标（Goal）

未 @ 的 Subject listener 消息会以飞书群记录为上下文启动隐藏执行；Subject 可以静默或使用现有能力回应。明确 @ 不进入 Subject，legacy listener 保持旧行为，Subject 游标只在有正向成功证据时单调推进。

## 实现方案

主要实现落点：

- `src/bot-registry.ts`：增加向前兼容的 listener behavior/subjectPolicy 类型与归一化；缺省仍为 legacy prompt。
- `src/services/message-listener.ts`：让 match 携带 Subject 元数据，分别渲染 legacy prompt 与确定性 Subject 协议。
- `src/services/subject-listener-context.ts`（新增）：从飞书记录构造截止触发消息的增量快照；游标找不到时回退 N 条，事件原文补尾去重，全部标为 untrusted。
- `src/services/subject-listener-cursor-store.ts`（新增）：按 larkAppId + chatId 持久化并单调提交 `{messageId, createTime}`。
- `src/im/lark/event-dispatcher.ts`：Subject 匹配进入按 Bot + 群有序的监听执行，并携带触发上界；明确 @ 仍先被 matcher 排除。
- `src/daemon.ts`、`src/core/types.ts`、`src/core/worker-pool.ts`：把 Subject 快照送入首轮；逐 turn 隐藏流式卡、reaction 和辅助 UI，但保留最终回复；在可见发送成功或明确静默终态后提交游标，失败不提交。
- `src/skills/definitions.ts`：提供内置 `botmux-subject` Skill，并让 Subject 模式直接使用同一协议正文，不依赖 skill discovery/injection mode。
- `test/subject-listener-context.test.ts`、`test/subject-listener-runtime.test.ts`、`test/subject-listener-runtime.e2e.ts`：由 evaluator 编写游标、上下文、@ 隔离、静默与回复链路测试。

实现必须保留现有 `messageListeners`、20+ CLI、Pty/Tmux 等后端共用路径；Subject 特例按 turn 标记，不能做 session 级永久开关。

## 场景（BDD）

```gherkin
Feature: 基于飞书增量上下文的 Subject 监听运行时
  As a 在飞书群中工作的 Bot
  I want 在未被明确 @ 时根据连续的飞书对话决定是否介入
  So that 我像群成员一样理解现场，同时不污染明确指派和旧监听行为

  Background:
    Given 某 Bot 已在目标群启用 behavior=subject 的消息监听
    And 飞书历史读取与 worker 输出由可控测试替身提供

  Scenario: 未被 @ 的消息按已提交游标获得连续飞书上下文  @id=S-1
    Given Subject 上一次成功处理的飞书消息游标为 om_previous
    When 群里出现未 @ 当前 Bot 的新顶层消息 om_trigger
    Then 交给 Subject 的不可信上下文只包含 om_previous 之后且不晚于 om_trigger 的消息
    And 当前事件原文应作为去重后的最后一条消息

  Scenario: 冷启动或游标丢失时使用最近 N 条消息兜底  @id=S-2
    Given Subject 没有可恢复的上次读取游标且 fallbackMessages 为 20
    When 群里出现未 @ 当前 Bot 的新顶层消息
    Then Subject 应获得截止触发消息的最近 20 条飞书记录
    And 上下文应标记 cold_start 或 cursor_lost 而不是伪装成连续历史

  Scenario: Subject 静默成功时不留下任何群内辅助痕迹  @id=S-3
    Given Subject 已收到未 @ 消息并决定无需介入
    When worker 以 BOTMUX_NOTHING_TO_SEND 成功结束本轮
    Then 群里不应出现回复卡片、处理卡片或状态 reaction
    And Subject 游标应提交到本轮触发消息

  Scenario: 明确 @ 当前 Bot 时绕过 Subject 并保证可见反馈  @id=S-4
    Given 同一个群同时启用了 behavior=subject
    When 有权限用户明确 @ 当前 Bot 发送任务
    Then 消息应走现有普通会话路径而不含 Subject 上下文
    And 即使模型判定无需回复也应产生现有的可见静默回执

  Scenario: Subject 执行失败时不越过未成功处理的消息  @id=S-5
    Given Subject 正在处理一条游标之后的未 @ 消息
    When worker 以 failed、cancelled 或 ambiguous 终态结束
    Then 持久化 Subject 游标不应推进
    And 下一次读取仍应覆盖这段未成功处理的飞书消息
```

## 评分标准

见 [eval-rubrics.yaml](./eval-rubrics.yaml)。
