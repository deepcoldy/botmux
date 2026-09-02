# 通用卡片动作插件网关

- 状态：active
- 当前 Sprint：`sprint-001`
- 目标：Botmux 提供一次性的通用 Card Action Plugin Gateway；任意受信插件服务通过静态 `cardActions` contribution 以精确 action 或 namespace prefix 接入现有飞书卡片回调，Botmux 核心不包含任何接入方业务 action、表单 schema、落盘或后续任务逻辑。
- 用户共识：Botmux 保持每个 Lark App 唯一长连接并负责 ACK、超时、去重和 late patch；插件通过本机 loopback HTTP + per-plugin token 接收版本化 JSON，并独立负责业务校验、业务幂等、持久化与任务触发。
- Sprint 数量：1
- 当前工作树：`/Users/bytedance/.codex/worktrees/6c5b/botmux`
- 当前分支：`codex/lark-card-handler-registry`
- 约束：保留并重构当前未提交改动，不覆盖或回滚无关改动；generator 不改测试，evaluator 不改业务代码；Sprint 通过前不改 HEAD。

## Sprint 索引

| Sprint | 目标 | 状态 | 产物 |
|---|---|---|---|
| `sprint-001` | 通用 cardActions contribution、私有鉴权、loopback gateway、daemon 接线和可执行 mock service 验收 | pending | `sprint-001/plan.md`、`sprint-001/eval-rubrics.yaml` |
