# 工作区会话回收

`botmux workspace-recycle` 在外部工作区回收成功后，关闭事先确认属于该工作区的 Botmux 会话。发现依据为会话自身的 `workingDir`；群绑定、路径不存在、Bot 名称和标题都不单独授权关闭。跨 Bot 的写入由各自在线 daemon 执行，CLI 没有离线改库或全局删除兜底。

## 操作入口

先安装包含本功能的 Botmux 到工作区之外，并让涉及的 daemon 使用同版本。不要从即将被删除的 checkout 运行收尾命令。数据目录也必须在目标工作区之外。

```sh
# 只读。也可对已经不存在的目录生成存量候选清单。
botmux workspace-recycle discover --workspace /work/tasks/example

# 回收前：目录必须仍然存在。operationId 由外部通用 Hook 持久化并复用。
botmux workspace-recycle prepare \
  --workspace /work/tasks/example --operation reclaim-example-001

# 外部系统执行它自己获准的工作区回收，保存真实结果。
# 只有回收成功且旧目录确实消失后，才通知成功。
botmux workspace-recycle finish \
  --operation reclaim-example-001 --event end-result-example-001 --outcome succeeded

# 回收失败：不关闭任何会话，终止该次操作。
botmux workspace-recycle finish \
  --operation reclaim-example-001 --event end-result-example-001 --outcome failed

# 纯回读，包含各会话的结果、资源快照和失败原因。
botmux workspace-recycle status --operation reclaim-example-001
```

同一次操作的终态事件不能从失败改成成功，也不能换 `eventId`。失败回收后的新一轮使用新的 `operationId`。准备失败时，外部 Hook 应停止工作区删除；修复原因后重新准备，身份或目标集合变更时创建新的操作。相同成功事件可以重放，已验证关闭的会话只回读。

主机 CLI 会从受管进程上下文识别当前会话；脱离会话的 Hook 可在 `prepare` 显式传 `--initiator <exact-sessionId>`。它必须属于发现的目标集合。准备时允许该发起会话仍在运行，其他忙碌会话会阻止准备成功。成功回收后：

1. 先关闭并验证其他目标；任何失败、残留或覆盖缺口都会保留发起会话。
2. 将发起会话的交接写入工作区之外的持久日志，先返回 `pending` 回执。
3. daemon 在后续检查点等待该会话空闲、无未结束 turn/队列、无新输入，并再次检查其他目标的关闭状态及目标集合。
4. 条件满足才最后关闭发起会话。等待超过 15 分钟、路径/输入/worker 代次变化等情况返回具体 blocker。不会以忙碌强杀解决这些 blocker。

成功回收后的关闭会把 `workspaceRetirement` 与 `closed` 状态一起持久化。该会话永久退役：CLI、卡片、API 和会话群自动续聊均拒绝恢复，会话群也不会因恢复被拒绝而隐式新建会话。重建同名目录或修改旧行的工作目录不能解除退役；继续工作需在有效工作区显式创建新会话。已关闭历史、资源残留的关闭记录也保留退役标记，失败回收不会添加标记。

daemon 重启会恢复已持久化的延迟交接；如果重启改变了 worker 或输入证据，会安全停止，不能把重新启动的执行当成原空闲会话。普通部分失败不自动重试，操作员可检查原因后重放同一成功事件。`pending` 不是资源释放成功，调用方须用 `status` 获取最终回读。

## 通用生命周期 Hook 适配

Botmux 不调用工作区删除程序，也不往 Agent Task 核心植入 Botmux 逻辑。外部生命周期系统显式配置两次命令调用，将它自己的事件映射成下面的中立 JSON。当前接口可独立验证；接入某个通用 Hook 实现之后，还需要验证真实事件时序与失败传播。

```json
{
  "protocol": "botmux.workspace-recycle.v1",
  "phase": "before-reclaim",
  "operationId": "reclaim-example-001",
  "workspacePath": "/work/tasks/example",
  "initiatorSessionId": "exact-botmux-session-id"
}
```

```json
{
  "protocol": "botmux.workspace-recycle.v1",
  "phase": "after-reclaim",
  "operationId": "reclaim-example-001",
  "eventId": "durable-end-result-example-001",
  "outcome": "succeeded"
}
```

两个事件均交给同一个显式入口：

```sh
/opt/botmux/bin/botmux workspace-recycle hook --event-file - < /durable/events/event.json
```

配置方应保证：

- before 事件在删除前执行，准备失败会阻止删除；after 事件读取实际回收结果。
- operationId、原事件和命令回执保存在工作区之外；同一次失败的网络回执先回读再重放。
- 两个阶段使用相同主机与 `SESSION_DATA_DIR`，覆盖所有相关 Bot。daemon 不在线、版本缺少此接口、鉴权失败或任意 store 无法读取均作为失败处理。
- 若另有群工作目录改绑 Hook，应将群绑定指向实际归档结果；绑定变化不替代运行中会话的关闭。新出现且不在本次计划中的会话只报告，不能偷偷扩充关闭集合。
- 所有 Hook 默认是显式配置的命令调用；安装本功能不会扫描并关闭历史工作区。历史候选只能只读展示，实际清理需要另外确认精确目标和适用流程。

## 结果与资源证据

返回 JSON 中保留 exact `sessionId`、`larkAppId`、`chatId`、`rootMessageId`、scope、工作目录原值与规范化路径、身份指纹，以及 `session.workingDir` 关联依据。目录包含关系使用路径段边界，`/work/a-other` 不属于 `/work/a`。存活祖先目录的符号链接会被规范化；悬空或被改变的别名不能被猜测为原工作区。

证据位于 `<dataDir>/workspace-recycle/<operationId>/`：`operation.json` 为协调记录，按 Bot/session 键散列命名的 JSON 为各 daemon 的持久关闭记录。写入使用锁、临时文件、原子 rename 与 fsync；日志不包含 prompt、原始 transcript、附件或凭据。标准关闭继续保留历史会话记录，并沿用原有临时资源清理行为。

每个目标分别记录 `before` / `after`：活跃注册、worker 端口、具有出生身份的 worker/CLI/可发现子进程、RSS、FD、Linux inotify 实例与 watch 数，以及持久后端探测结果。PID 消失和 PID 被复用都会与原进程仍存活区分；不会对复用 PID 或共享进程补发终止信号。

| 状态 | 含义 |
| --- | --- |
| `prepared` | 精确目标已持久化，尚未关闭 |
| `deferred` / 聚合 `pending` | 当前会话已持久交接，尚未验证关闭 |
| `closed` | durable closed、退出活跃注册，所观测的所属资源释放验证通过 |
| `closed_with_residual` | 本地会话关闭，但资源仍存在、远端残留或无法完成资源证明 |
| `blocked` / 聚合 `partial` | 有明确失败/覆盖缺口；成功的兄弟目标不会被回滚或重复关闭 |
| `aborted` | 工作区回收失败，未触发关闭 |

退出码：`0` 已准备/已验证/已终止；`1` 部分失败或 blocker；`2` 参数/事件/读取错误；`3` 延迟交接待回读。调用者必须同时检查 `status`，不能把 `0` 一概解释为资源释放。

Linux 上的 inotify 配额是每用户的资源限制，不能将实例数与 Botmux 会话数等同。单次资源前后对比不能证明历史故障根因。当前资源观测覆盖采样时可归属的进程和已冻结的持久后端；不宣称枚举任意已脱离进程树的外部进程。其他平台无法验证子进程集合时会保留残留说明，远端 Mojo/Riff 的拒绝与隔离残留直接沿用标准关闭结果。

## 验证

```sh
bun run build
bun run test -- test/workspace-recycle.test.ts \
  test/workspace-recycle.integration.test.ts test/workspace-recycle-ipc.test.ts
```

测试使用临时目录和自建子进程。覆盖多 Bot/多群、目录边界与别名、外部会话排除、忙碌输入与排空锁、失败回收、部分失败恢复、关闭回执丢失、残留、当前会话最后退出及重复创建/回收。真实进程夹具创建自己的 HTTP 监听和 watcher，走标准关闭后验证 PID/注册/历史；不会连接真实飞书会话或关闭开发机现有 worker。
