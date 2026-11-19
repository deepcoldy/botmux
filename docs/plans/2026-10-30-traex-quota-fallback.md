# 实施计划

1. `src/services/traex-quota.ts` 与测试：结构化额度错误分类、原生模型目录读取、日/周额度解析。验证未知值、普通 429、过期 reset、字段格式。
2. `src/services/traex-auto-model.ts` 与测试：quota-only 策略、严格顺序、耗尽/重置状态恢复；保持容量策略兼容。
3. `src/services/traex-transcript.ts`、`src/worker.ts` 与测试：在终态交付前固定程序切换、精确恢复、原输入不重放、并发/取消保护和最终耗尽失败交付。
4. `docs/design/2026-10-30-traex-quota-fallback.md`：配置、已知边界与验收记录。
5. 验证命令：使用 packageManager 指定的 Bun 运行 `bun run build`；运行 traex-quota、traex-auto-model、traex-transcript 及真实 Worker 相关测试。集成故障注入不得发送真实群消息、创建 Bug 或消耗真实模型额度。

构建会生成 dist 与内嵌资源；不执行 `use:here`，避免替换本机正在运行的其他 Botmux。回滚通过关闭新配置恢复原行为；远程部署需先备份原二进制和配置。

验收：完整构建通过；9 个相关单测文件共 504 项通过、1 项既有跳过；真实 Worker/PTY 的 quota 场景 5 项通过。覆盖首个输入与恢复、严格顺序、全部耗尽停止、普通限流不切换。独立异常探针补齐初始化旁路、真实停止键、查询期间 journal 恢复、部分窗口数据缺失；移除 journal 守卫后同一恢复断言失败。

## PR #2605 评审跟进

- 已 rebase 到 `master` 的 `42432fe84`。先复现 `dispatch-user-route` 4 个缺少 `traexQuotaPending` 的失败；注入 scope 并补 pending ready gate 行为测试后，该文件 41 项通过。
- 首选模型且无耗尽记录时跳过远程读；保留已有 block、备用模型恢复和结构化额度失败时的查询。Worker/PTY 同时验证原输入不查询、两次额度失败恰好查询两次。
- 新增日窗口过期、周窗口仍有效的组合测试；目录读取改为 8 秒返回 unknown、SIGTERM 后 1 秒仍未退出则 SIGKILL，覆盖迟到响应和提前退出。
- 验证环境 Node 22.22.0 / Bun 1.4.3。`bun run build` 通过；`node node_modules/vitest/vitest.mjs run` 的 12 个相关单测文件共 452 passed、1 skipped；`test/traex-auto-model.integration.test.ts -t quota` 5 passed；原容量策略、继承 RPC、关闭功能场景 3 passed；tmux 的 quota 续跑场景 1 passed。按名称筛选的其他集成用例未运行，不计入通过数。
- 8 个异常探针覆盖取消与 8 秒 deadline 交叠、目录查询期间 controller/generation/队首变更、耗尽记录已持久化但切换未提交后的恢复、全池耗尽超时与下一次输入交叠，以及重复失败/迟到响应，均通过。移除 deadline 结算、首选 fast-path、过期日窗口完整性守卫或 pending ready gate 后，对应断言均失败。
- 真实不响应 SIGTERM 的独立假 CLI：Node 22 和 Bun 1.4.3 均在约 8 秒返回 unknown，宽限期后确认子进程已退出。两台 Linux 的真实目录只读核验见设计文档；未发送群消息、耗尽真实额度或更改 live daemon。
