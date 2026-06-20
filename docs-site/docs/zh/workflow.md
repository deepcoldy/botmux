# Workflow（实验性运维）

`botmux workflow` 把工作流 run 的状态当一等公民暴露出来——查看哪些 run 在跑、读事件流、从崩溃 / awaiting 恢复或取消。所有命令读写 `BOTMUX_WORKFLOW_RUNS_DIR`（默认 `~/.botmux/workflow-runs`），**不需要 daemon 在线**。

| 命令 | 说明 |
|------|------|
| `botmux workflow run <id> [--param k=v ...]` | 离线驱动 workflow；humanGate 节点跑到 awaiting-wait 退出 |
| `botmux workflow resume <runId>` | 从磁盘 runDir 冷恢复一个已有 run |
| `botmux workflow cancel <runId> [--reason <text>]` | 写 run-level cancelRequested 并驱动 cancel recovery |
| `botmux workflow ls [--all] [--status ...] [--wide] [--json]` | 列所有 run；默认仅 non-terminal |
| `botmux workflow tail <runId> [--from N] [--follow]` | 打印事件简表 |
| `botmux workflow show <runId>` | replay 事件，打 Snapshot 摘要 |

典型运维流程：

```bash
botmux workflow ls                         # 看哪些 run 在跑
botmux workflow tail wf-abc-123            # 进一个 run 看事件
botmux workflow resume wf-abc-123          # run 卡住/重启过 → 冷恢复
botmux workflow cancel wf-abc-123 --reason '依赖外部超时'
```

> 这是实验性能力，主要给运维/调试 workflow 编排用。普通使用无需关心。
