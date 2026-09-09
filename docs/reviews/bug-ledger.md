# Bug Ledger

## 待修清单

| ID | 标题 | 状态 | 严重度 | 层级 | 是否阻塞下一步开发 |
|---|---|---|---|---|---|
| BUG-20260828-001 | Mojo 本地工具继承宿主 PM2 污染环境后不可用 | 已修复 | S1 | 基础 | 否 |

## 详细记录

### BUG-20260828-001 Mojo 本地工具继承宿主 PM2 污染环境后不可用

- 状态：已修复
- 严重度：S1
- 层级：基础
- 来源：用户手测 / 本机回归
- 首次发现时间：2026-08-28
- 发现版本 / commit：Botmux 3.17.0；上游基线 `524e2ce5d49868bd8d44b4295e7f877ebb5b1a35`
- 影响范围：由 Botmux/PM2 启动、默认使用宿主本地工具的 Mojo 会话；已在 macOS arm64 复现
- 是否阻塞下一步开发：否
- 关联文件：`src/worker.ts`、`src/adapters/backend/mojo-backend.ts`、`src/adapters/backend/mojo-types.ts`、相关测试
- 关联 spec / 文档：无

#### 复现步骤

1. 通过 PM2 管理的 Botmux worker 启动 Mojo host-local 会话。
2. 让 Mojo 调用无副作用的 Bash 工具。
3. 对比正常继承环境与最小白名单环境；再分别注入 PM2 通用元数据、通用小写 `env`、代理变量组。

#### 期望结果

- Mojo 在 macOS 原生执行 Bash，不受 Botmux/PM2 管理元数据影响。
- 必要认证、路径、语言区域和显式 Bot/Mojo 配置继续生效。

#### 实际结果

- 正常继承 Botmux/PM2 环境时，本地 Bash 回合会停滞或以 `turn_error` 结束。
- 最小白名单环境可完成 Bash 工具调用；重新加入污染变量后可复现失败。

#### 证据

- macOS arm64，`@byted/mojo` 1.0.11。2026-08-28 有效登录态复验时，云端链路恢复：无工具后台查询和真实云端 Bash 均成功；本地 host 模式仍会在工具调用前后不稳定失败。
- 当前运行环境存在 PM2 通用元数据、通用小写 `env=[object Object]` 和重复大小写代理变量。
- Botmux 3.16.0 与 3.17.0 的 Mojo 环境合并核心文件逐字节一致，说明升级/重启是暴露事件，不足以证明缺陷由 3.17.0 新引入。
- 对照实验只记录变量名和通过/失败结果，不记录凭据或代理值。
- 清理 5 个服务端已离线或已无记录的孤儿 daemon 后重新启动：初次查询仍为 0 个在线环境；稍后服务端将新 daemon 标为 online，并上报 `bash/read/write/...` 能力，但 host 回合仍未稳定完成。
- 对照结果：完整宿主环境经候选代码清除 PM2 元数据后，host 回合可在 Bash 前直接失败；改用最小白名单环境并继续保留全部 6 个大小写代理变量后，一次回合到达 Bash 且 daemon 日志显示命令成功，最终仍以 `turn_error` 失败，重复一次又在 Bash 前失败。代理不是该现象的必要条件，PM2 清理也不足以单独恢复真实主链路。

#### 初步判断

- 疑似根因：worker 以 `process.env` 为 Mojo 基础环境，Mojo backend 再将其与显式 Bot/Mojo 环境整体合并；当前边界只剔除少量控制变量，PM2 管理元数据会进入 Mojo 进程。
- 历史外部现象（已解除）：Mojo 1.0.11 下 daemon 已连接、注册、Ready 并被控制面标为 online，能力表也包含 Bash，但 host 回合仍随机在工具派发前或工具成功返回后进入 `turn_error`。升级到 Mojo 1.0.12 后，同一 host 链路的直接 CLI 与真实 Botmux backend smoke 均已完成 Bash 回合。
- 次要问题：Mojo 在 macOS 上的辅助组件 bootstrap 反复报告 internal channel 仅发布 Linux binary，需另向 Mojo 侧反馈。
- 临时 workaround：`mojo.cloud=true` 可完成 Bash，但会把工具移到云端，无法等价替代需要访问 Botmux 宿主机的本地模式；不能静默启用。最小环境对照也不稳定，不作为 workaround。

#### 修复记录

- commit：当前分支的 Mojo 环境隔离提交
- 修复说明：
  - 在 `buildEffectiveChildEnv()` 增加仅对 Mojo 生效的 ambient/base 环境隔离开关；未传开关的非 Mojo 调用保持原有合并行为。
  - 仅在发现 `pm_id`、`env=[object Object]` 或成对 PM2 路径字段时判定为 PM2 污染，避免误删普通手工启动环境中的同名变量。
  - PM2 元数据在 host / cloud / sandbox 三种 Mojo 模式下均从 ambient 层移除；清单覆盖 PM2 `Common.js keysToIgnore` 及容器额外写入的日志路径、版本和实例字段。动态 `instance_var` 仅在值符合 PM2 非负实例序号且键名不属于路径、会话、凭据、证书、代理等关键运行变量时移除，避免错误配置删除 `PATH` 等必需环境。
  - host / cloud / sandbox 均保留宿主代理变量：现有真机证据尚未把代理与 `env=[object Object]` 等 PM2 元数据单独隔离，默认删除可能让依赖代理出网的宿主断网。
  - Bot 顶层 `env` 与 `mojo.env` 在清洗后按原优先级合并，显式配置可覆盖或置空代理变量，`mojo.env` 继续具有最高优先级。
  - worker 的 wrapper 解析与 Mojo backend 的真实 spawn 共同使用同一环境构造函数，避免“解析 wrapper 的 PATH”和“子进程真正运行的 PATH/环境”再次分叉。

#### 验证记录

- 验证方式：实现者自动化验证 + 未参与改动的 Reviewer 独立代码复审；历史审查修订后的增量和最新主线对齐后的最终差异均已复核通过
- 验证设备 / 环境：macOS arm64 + Node/Bun 自动化
- 自动化结果：
  - 修复前 focused 基线：3 个测试文件，135 项通过。
  - 原候选 focused gate：4 个测试文件，183 项通过、1 项平台跳过；审查修订后直接相关的 2 个测试文件 103 项通过。覆盖 host/cloud 代理保留、显式代理覆盖与置空、真实 PM2 实例序号与 `pm_id` 不相等、自定义实例变量不得删除 `PATH`/Botmux 会话路由、PM2 `Common.js` 元数据清单漂移、输入不变及非 Mojo 零影响。
  - 2026-09-09 对齐 `origin/master=9387fa19` 后全部 Mojo 测试串行复跑：34 个文件中 33 通过、1 个平台跳过；667 项通过、32 项平台跳过、0 失败。
  - `npx --yes bun@1.4.2 run build` 通过；domain audit、主 TypeScript、scripts TypeScript、test mocks TypeScript、dashboard bundle、dist audit 与嵌入资产审计均通过。
- 2026-08-28 真机结果：环境边界验证通过，但当时端到端回合仍未通过。有效缓存登录态下，候选代码生成的真实 Mojo 子进程环境中 PM2 污染键为 0，继承的 6 个大小写代理键均保留，stderr 无认证错误；随后回合连续 25 秒没有事件，`status=timeout`、`error.code=stalled`、`num_tool_calls=0`，Bash marker 未出现。新启动的 CLI 与 daemon 已按精确 PID 回收，临时验证文件已删除，无残留测试进程。
- 认证证据：`mojo auth status --json` 于本轮复验时返回 `logged_in=true`、缓存凭据未过期、可刷新；本次失败不能归因于登录过期。
- 后续真机补充：云端真实 Bash 成功，host daemon online 且声明 Bash 能力；host 在完整环境和“保留代理的最小环境”下仍未稳定完成，结果覆盖无工具事件停滞、Bash 前 `turn_error`、Bash 命令成功后回合 `turn_error` 三种形态。
- 2026-09-09 复验：经用户允许将全局 Mojo CLI 从 1.0.11 升级到当时最新的 1.0.12；升级后 `logged_in=true`、`refreshable=true`，无需重新登录。实时读取 `stream-json` 后确认，直接 host 两轮只读 Bash `pwd` 分别在 21.853 秒和 23.725 秒完成，均为 `result.status=completed`、`num_tool_calls=1`、Bash `return_code=0`。结果事件后裸 CLI 仍陪跑其子进程 `~/.mojo/bin/mojo-daemon`，不会立即退出；这不是回合未完成，Botmux backend 已按 `result` 事件结算并隔离后续迟到输出。cloud 对照在放宽空闲护栏后于 26.491 秒完成并正常退出。
- 真实 Botmux backend smoke：使用候选分支的 `MojoBackend` 在独立 workspace 启动默认 host 回合，约 19 秒收到任务完成回调、Bash 结果和最终答案，功能链路通过。结束 smoke 时，macOS 缺少 Linux `/proc`，现有进程树证明无法自动证明 quiescence，因此保留 1 个该 smoke 专用的 containment handle；经 cwd 复核属于本轮的孤立 CLI/daemon 已按精确 PID 清理，未触碰其他 Botmux/Mojo 会话。该清理证明边界不影响本次 host 功能通过结论，但需在最终交付中单列证据限制。
- 合并门禁：host 真机功能验证现已通过；候选分支已无冲突对齐 `origin/master=9387fa19`，对齐后的完整 Mojo 回归和构建通过。主线已移除 PM2 运行时依赖，因此漂移测试改为仅在本地实际安装 PM2 时读取其 `Common.js`；静态 fixture 仍始终覆盖清洗行为。当前分支不落后主线，最新差异的独立终审已通过，可以进入 push / 提 PR 阶段。
- 独立复审状态：首名 Reviewer 确认 PM2 元数据隔离、误删边界、wrapper/backend 同策略和测试覆盖无 blocker；指定的 V37F Reviewer 因其自身 API key 401 未能进入审查，Sekiro 替补路径又遇模型服务错误。随后 Wallpaper 完成实质终审并给出 `PASS`（blocker 0、major 0、minor 4）；Lead 全部采纳并修正真实 PM2 实例序号判断、关键环境键保护、测试依赖报错、Mojo 开关命名和 `PM2_HOME` 说明。Wallpaper 对修订增量再次给出 `PASS`（blocker 0、major 0），其两条可读性 minor 已通过测试名和注释澄清；关于未列入 Botmux 会话白名单的自定义 `BOTMUX_*` 实例键提醒不改，因为这类键被明确配置为 PM2 `instance_var` 时属于应清理的 PM2 元数据。2026-09-09 对齐最新主线后的独立终审再次给出 `PASS`（blocker 0、major 0、minor 1）；Lead 接受唯一的台账状态 minor，并在本次收口中同步修正。
