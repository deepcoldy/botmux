# 会话级 Codex 实例：验收记录

状态：2026-09-08 本地回归、真实双账号和飞书端到端验收通过。Linux 实机与突然断电场景未验证。配置说明见 [使用文档](../codex-instances.md)，设计依据见 [方案](session-cli-instances.md)。

本文只保留可公开的验证方法与结果；账号标识、群名、消息/会话 ID、本机绝对路径和原始部署备份不进入仓库。

## 自动化验收范围

自动化测试使用临时数据根、假凭据和受控子进程，不登录真实账号、不消费额度、不发送飞书消息。tmux 使用独立 socket，不连接现有 server；测试结束清理自身进程。

| 门槛 | 已验证行为 |
| --- | --- |
| 权重 | 缺省 1:1；3:1 区间边界；拒绝零、负数、小数、字符串、null 和溢出 |
| 目录 | 显式绝对路径、规范路径唯一、非嵌套、0700/0600；拒绝软链和硬链凭据 |
| 来源 | 普通飞书新建进入池；schedule/HTTP/workflow 默认路由；external 不参与 |
| 持久化 | 先提交再发布；实际 SQLite 重读；失败回滚；陈旧对象不能抹除或修改 binding |
| 恢复 | 调整权重、默认实例、ID→home 映射后，旧会话/排队/fork 保持原 binding/runtime |
| 并发 | 实际入站 FIFO 与 SQLite 验证同一话题首条消息只创建一个绑定 |
| 环境 | 子进程收到冻结 CODEX_HOME；清除继承的 API 身份覆盖项；不复制全局 auth |
| 失败 | 缺失 home 或候选无效时拒绝；启动失败不换账号；默认失效不回退全局 |
| tmux | 持久 identity 不匹配或丢失时拒绝 attach，保留原 pane |
| 管理 | init/login/check 使用相同映射；已有登录重登需 --reauth；身份明确为 unverified |
| 兼容 | 无池 CLI、旧会话、工作流快照、owner 权限和配置写保护回归 |
| worker | 真实 worker IPC→workflow PTY→假 Codex，验证环境、MCP 准备顺序与缺失目录拒绝 |

同一目录被管理员人工换号不在自动检测范围；目录绑定不是强账号身份保证。

## 可复跑命令与结果

环境：macOS arm64、Node 24.2.0、Bun 1.4.0。功能分支已合入主仓基准 c5366fb9b；未修改依赖或版本号。

```sh
bun run test -- test/session-cli-instances-acceptance.test.ts test/session-store.test.ts test/session-store-sqlite.test.ts test/transcript-resolver-bot-home.test.ts test/transcript-resolver-symlink.test.ts test/tmux-backend-env.test.ts test/bot-config-store.test.ts test/config-store.test.ts test/setup-bots-store.test.ts test/cli-runtime.test.ts test/session-card-model.test.ts test/codex-adapter-history-ownership.test.ts test/daemon-rename-route.test.ts test/workflow-v3-ephemeral-pool.test.ts test/restore-zombie-close.test.ts test/codex-auth-sync-worker-wiring.test.ts test/worker-codex-instance.integration.test.ts test/codex-rpc-lifecycle.test.ts test/command-handler.test.ts test/card-handler-repo-select.test.ts test/trigger-session-root-message.test.ts test/session-resume.test.ts test/scheduler-silent-execute.test.ts test/fork-session.test.ts test/cli-selection.test.ts test/schedule-model-override.test.ts --maxWorkers=2
nice -n 10 bun run build
git diff --check
```

- 26 个测试文件：1236 通过、5 跳过、0 失败，18.13 秒；没有跑全仓 e2e。
- 两个新增验收文件单独复跑：39 通过、0 失败。
- 完整构建通过（含源码、脚本、test mocks 类型检查、Dashboard 打包、dist/资源审计）；runtime build id f297e746d28a。
- git diff --check 通过；自动化测试无残留 CLI/tmux 进程。

## 双真实账号与冷恢复

在独立授权下，使用同一个 Codex CLI 0.153.4 可执行文件和两个不同账号的 CODEX_HOME：

1. GPT-5.5 短文本问答分别返回 A_OK、B_OK。以只读沙箱和不调用工具的提示运行，忽略用户配置；不把该结果当作全部插件/配置已验证。
2. 真实实例预检拒绝原有 0755 目录及未显式设置文件凭据存储的配置。经确认收紧权限并设置根 cli_auth_credentials_store=file 后，两个 home 均通过。
3. 生产 createSession 在临时 SQLite 持久化两个实例绑定，测试固定 RNG 分别覆盖 A/B。
4. 全新进程重读，在测试配置里交换 ID→home 映射、改变默认实例和权重；旧绑定、runtime 与原生 thread ID 不变。
5. 通过生产环境解析器、启动 shell 和独立 tmux 调用真实 codex exec resume，分别正确回忆各自标记；退出码为 0，transcript 在各自 home 中。
6. 测试期间插件目录请求出现过网络/403 警告，但四轮模型回复成功；不宣称插件网络全部正常。

这一阶段的首轮原生会话由直接 CLI 创建，不能单独证明 worker 自动发现会话 ID。真实飞书链路另见下一节。

## 真实飞书新话题与续聊

经授权部署到本机现有服务，仅为目标 Codex Bot 配置 A/B 等权池、默认 A；其他 Bot 的配置不变。重启前确认在线会话全部空闲，备份配置和一致性 SQLite。重启后 45 idle / 15 dormant / 358 closed 与重启前一致，意外关闭为 0；255 条原有 Codex 记录保留 legacy 路由。

用户在同一个飞书话题群发两个真正新话题，然后分别在原话题追问 CODEX_HOME：

| 检查项 | 第一话题 | 第二话题 |
| --- | --- | --- |
| 持久化来源/实例 | pool / a | pool / b |
| 实际 CLI 环境 | 账号 A 的 home | 账号 B 的 home |
| 执行程序 | 同一 Codex 安装二进制 | 同一 Codex 安装二进制 |
| 首轮飞书最终回复 | 已收到 | 已收到 |
| 原话题续聊 | 已收到 | 已收到 |
| 续聊后 instanceId / 原生 thread ID | 均未变化 | 均未变化 |

核对依据同时包括生产 SQLite、运行进程环境、各 home 内 transcript、daemon/worker 入站日志及飞书消息读取 API，未只依赖模型自述。最终两会话均为 idle。

该实测覆盖真实飞书→live daemon/worker→tmux/真实 Codex→飞书最终回复，以及同话题续聊保持绑定。两个样本实际命中 A/B，不证明统计比例；非均匀权重通过可注入 RNG 的确定性测试验证。

## 限制与回滚

- 未执行 Linux Devbox 部署、Windows 实例池、突然断电、真实额度耗尽或账号续期异常测试。
- v1 普通池仅支持本机 Codex+tmux；不支持任意 bot env、wrapper、sandbox/readIsolation、external app server 或混合 CLI。
- enabled=false 只关闭随机分配，不撤销已绑定会话；不要直接降级到忽略 binding 的旧版本。
- 真实部署所用 worktree 及依赖目录必须保留；备份不可在产生新会话后盲目覆盖数据库。

## PR 合入最新主仓后的验证

提交 PR 时上游已推进至 `7d83eabdc`。在另一个独立 worktree 合入这 4 个提交，未切换或重建正在运行的部署目录。

- 解决两个配置写入口的冲突：同时保留实例 binding 配置保护与上游 `quotaFallbackBot` 图防环校验，没有覆盖任一方规则。
- 在上述 26 文件命令基础上追加 `test/quota-fallback.test.ts`、`test/quota-fallback-worker.test.ts`、`test/bot-registry.test.ts`，保持 `--maxWorkers=2`：29 个文件，1410 通过、5 跳过、0 失败，19.53 秒。
- `nice -n 10 bun run build` 再次通过，独立构建 runtime build id `8e4ea29d5158`；`git diff --check` 通过，无残留测试 CLI。
- 真实飞书验收对应上一节已部署构建 `f297e746d28a`；合入上游后的 PR 版本完成回归与构建，但未再次部署或重跑飞书链路。两种验证状态不混为一谈。

## PR CI 回归修复

首次 CI 的三个失败在本地全部复现：

- `api-only-mode-wiring`：恢复直接传递 bot 的 `readIsolation` 设置，避免实例绑定静默关闭管理员要求的隔离；不支持的组合由 worker 明确拒绝。新增真实 worker IPC 测试证明报错前不启动 CLI。
- `backend-gate`：源码断言定位具体的 backend compatibility 错误，不再误匹配此前新增的实例隔离错误。
- `bridge-final-output-retry`：补齐 session-store 的 `getSession` mock；否则新加入的 transcript binding 查询会被不完整 mock 抛错，最终被用量读取降级为空。

复验命令是在上一节 29 文件命令后追加 `test/bridge-final-output-retry.test.ts`、`test/api-only-mode-wiring.test.ts`、`test/backend-gate.test.ts`，仍使用 `--maxWorkers=2`：32 文件、1581 通过、5 跳过、0 失败，21.64 秒。

另以临时 HOME/TMPDIR、独立进程逐个执行 `bun test <file>`，覆盖 `api-only-mode-wiring`、`backend-gate`、`worker-codex-instance.integration`：共 86 通过、0 失败。本地 Bun 为 1.4.0，CI 的 1.4.2/Linux 结果单独以 GitHub Checks 为准。

`nice -n 10 bun run build` 与 `git diff --check` 通过。没有更新或重启 live 部署。

随后 Linux CI 的构建、三类二进制、三个 Vitest 分片及汇总全部通过；Bun 全量完成 1120 文件，其中 1118 通过、2 失败。剩余两项是 Bun 链接阶段检查整个传递导入图，暴露 `mojo-isolation-inventory-failclosed` 缺少 `getSession` mock、`summary-command-window` 缺少 `loadBotConfigs` mock。本地 Bun 逐文件复现相同错误后补齐，两文件共 8 项测试分别在 Bun 和 Vitest 通过。本次补充仅修改测试 mock，不改生产代码，也不通过排除测试规避失败。

## 评审补充：实例身份稳定性

`5d00c65b0` 的 [完整 CI](https://github.com/deepcoldy/botmux/actions/runs/34303801288) 已全绿，包括覆盖整个 unit 项目的三个分片、汇总、独立 Bun 测试及所有构建检查。评审提到的三个阻断项对应前述已修复问题。

针对 `codexInstanceIdentity()` 的非阻断建议，补充以下回归验证：

- 相同 runtime 配置改变输入键序（含 npm update 子对象）后，经 `resolveCliRuntime` / `snapshotCliRuntime` 规范化得到相同摘要。
- SQLite 持久化后由新进程加载，没有继承父进程内存或 bot 配置，binding 与 runtime 生成的摘要仍一致。
- 同一路径的假 CLI 从 `0.1.0` 原地更新为 `0.1.1`，实际执行 `--version` 确认版本变化，runtime 摘要不变；更换可执行路径或账号 home 则摘要不同。

当前 runtime 快照包含 id、displayName、executable、source、update，不包含 CLI 探测版本；快照创建有固定字段顺序，持久化读取保留顺序。因此保持当前 hash 协议，避免让已有 pane 的身份失效。这不是承诺任意手工重排持久化 JSON 或未来快照 schema 变更都兼容；这类变更需要显式迁移策略。

验证命令：`bun run test -- test/session-cli-instances-acceptance.test.ts test/cli-runtime.test.ts test/tmux-backend-env.test.ts test/worker-codex-instance.integration.test.ts --maxWorkers=2 --reporter=dot`。4 文件、134 通过、5 跳过、0 失败；`nice -n 10 bun run build` 和 `git diff --check` 均通过。此轮仅增加测试与文档，没有更改生产代码，也未重启 live daemon；重启证明来自隔离的真实 SQLite + 新进程测试，版本升级证明使用假 CLI，不冒充线上升级验收。

## 评审补充：legacy 的默认 CLI 变更语义

确认 legacy 与 pool/default 一样有意豁免默认 CLI mismatch 清理：旧会话迁移后已有冻结 runtime/home，移除池不会撤销此绑定。仅 legacy 引用时可移除池，因为它不引用命名实例；pool/default 引用仍受删除保护。用户文档新增与从未启用池的未绑定会话的行为差异，以及显式 `/close` 后新建、停用账号前关闭旧会话的操作边界。

新增 6 项回归覆盖真实 store 的 legacy 迁移→配置删除检查→重载保留绑定、运行中 pool/default/legacy 的 mismatch 豁免、默认 CLI 已切换时 legacy 在 tmux exists/missing/unknown 三种状态下的恢复。既有未绑定会话 mismatch-close 测试继续保留并通过。没有更改生产逻辑，仅补充代码注释、测试和文档。

验证命令：`bun run test -- test/restore-zombie-close.test.ts test/session-cli-instances-acceptance.test.ts test/cli-selection.test.ts test/cli-runtime.test.ts test/session-store.test.ts test/session-store-sqlite.test.ts test/session-resume.test.ts test/fork-session.test.ts test/kill-worker-orphaned-backend.test.ts --maxWorkers=2 --reporter=dot`。9 文件、411 通过、0 失败，12.19 秒；`nice -n 10 bun run build` 与 `git diff --check` 均通过。上一提交 `4df72c38b` 的 [CI](https://github.com/deepcoldy/botmux/actions/runs/34305500875) 已全绿，包含完整 unit 分片及独立 Bun 测试。本轮恢复测试使用模拟 backend 和临时 SQLite，不是 live daemon 重启。
