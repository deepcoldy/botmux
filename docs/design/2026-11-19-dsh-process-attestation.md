# DSH SDK 原生进程认证

DSH SDK 使用两层进程：Botmux runner 桥接终端和 JSON-RPC，Node DSH 子进程执行模型与工具。原来 worker 只登记 runner 的 PID。第二轮及恢复场景下，DSH 的 `MainThread` 已在当前轮开始前存在，工具调用经过它时会被判为旧进程，`current_execution_unverified` 随之阻断依赖可信群身份的插件。

## 身份证明

Linux runner 在启动实际 RPC 子进程前创建一个权限为 0600 的文件，打开后立即删除路径，将打开的描述符作为 fd 3 传给子进程，并保留自己的描述符直到子进程退出。模型发现用的 `--dump-config` 进程不获得该描述符。没有新增环境变量或持久密钥。

worker 从已登记 backend PID 的内核血缘中寻找唯一匹配的 runner，核对实际 executable、源码或编译版入口以及 session/bin/profile/patch 契约。runner 的直接 DSH 子进程还必须匹配实际启动参数、拥有 RPC stdin/stdout，以及与 runner 持有相同设备号和 inode 的已删除文件描述符。登记前再次核对 PID 出生时间和 engine 到 backend 的完整祖先链。

`process_ready` OSC 仅触发内核查询，其 payload 不参与身份决策。runner 在 initialize 完成后、可见 prompt 之前发送该提示；初次登记将 `enginePid/engineProcStart` 经既有 worker IPC 传入 daemon，并在当前轮快照前完成登记。重复 marker 不重新发布身份或当前轮快照。

证明在 CLI generation 内冻结。generation 变化、内核身份变化、证据缺失或多个候选都不授予新引擎身份。`killCli` 清除缓存；worker-pool 的既有 generation 检查和进程出生时间检查继续生效。无需修改 daemon 的 `MainThread` 判定，也不改变群路由配置或操作者权限。

## 恢复与适用范围

重附着存活进程时，当前配置可能已经改变 model、bot-name 或 watchdog。这些字段不参与进程身份比较；session/bin/profile/patch 与入口仍严格核对，重复身份参数被拒绝。已存在的 runner 不会因为展示或超时配置变化失去身份。

本次只覆盖 Linux 本地 DSH SDK 的直接 Node/native RPC 子进程，支持源码与单文件编译 runner，以及带有中间 backend launcher 的已核证血缘。DSH TUI、其他 CLI 和不支持 procfs 的平台保持原行为。改变 session、DSH 可执行路径或 profile/patch 后，应启动新 runner；不提供弱验证降级。

上线前启动的旧 runner 没有继承证明 fd，重启 daemon 后复用旧 pane 仍无法获得这项身份。安装修复版本后新建话题即可启动新 runner；需要沿用旧话题时，在空闲后实际重启其 DSH CLI。DSH 跨进程恢复原生会话仍受现有适配器能力限制。

## 验证

回归测试覆盖真实 runner/假 SDK 的 fd 继承、编译 runner 的 RPC 交互、当前轮群身份、旧工具拒绝、PID 复用、枚举期间 reparent、恢复配置变化、重复身份参数、generation 失效和 marker 重放。邻接验证覆盖 Codex 引擎身份与 DSH TUI 既有行为。构建使用仓库固定的 Bun 1.4.4。

对新护栏做变异复验：移除引擎命令、共享描述符、出生时间、最终祖先链、generation、身份冻结或 marker 重放守卫时，相关行为测试必须失败。测试和临时探针使用仓库隔离围栏，不发送飞书消息或接触线上进程。
