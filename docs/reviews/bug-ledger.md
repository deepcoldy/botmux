# Bug Ledger

## 待修清单

| ID | 标题 | 状态 | 严重度 | 层级 | 是否阻塞下一步开发 |
|---|---|---|---|---|---|
| BUG-20260828-001 | Mojo 本地工具继承宿主 PM2 污染环境后不可用 | 待验证 | S1 | 基础 | 是 |

## 详细记录

### BUG-20260828-001 Mojo 本地工具继承宿主 PM2 污染环境后不可用

- 状态：待验证
- 严重度：S1
- 层级：基础
- 来源：用户手测 / 本机回归
- 首次发现时间：2026-08-28
- 发现版本 / commit：Botmux 3.17.0；上游基线 `524e2ce5d49868bd8d44b4295e7f877ebb5b1a35`
- 影响范围：由 Botmux/PM2 启动、默认使用宿主本地工具的 Mojo 会话；已在 macOS arm64 复现
- 是否阻塞下一步开发：是
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

- macOS arm64，`@byted/mojo` 1.0.11，本地无工具聊天可用，云端工具调用可用。
- 当前运行环境存在 PM2 通用元数据、通用小写 `env=[object Object]` 和重复大小写代理变量。
- Botmux 3.16.0 与 3.17.0 的 Mojo 环境合并核心文件逐字节一致，说明升级/重启是暴露事件，不足以证明缺陷由 3.17.0 新引入。
- 对照实验只记录变量名和通过/失败结果，不记录凭据或代理值。

#### 初步判断

- 疑似根因：worker 以 `process.env` 为 Mojo 基础环境，Mojo backend 再将其与显式 Bot/Mojo 环境整体合并；当前边界只剔除少量控制变量，PM2 管理元数据会进入 Mojo 进程。
- 次要问题：Mojo 在 macOS 上的辅助组件 bootstrap 失败会影响无关本地工具，需另向 Mojo 侧反馈。
- 临时 workaround：用最小环境启动单次 Mojo；仅用于诊断，不作为多人正式方案。

#### 修复记录

- commit：当前分支的 Mojo 环境隔离提交
- 修复说明：
  - 在 `buildEffectiveChildEnv()` 增加仅对 Mojo 生效的 ambient/base 环境隔离开关；未传开关的非 Mojo 调用保持原有合并行为。
  - 仅在发现 `pm_id`、`env=[object Object]` 或成对 PM2 路径字段时判定为 PM2 污染，避免误删普通手工启动环境中的同名变量。
  - PM2 元数据在 host / cloud / sandbox 三种 Mojo 模式下均从 ambient 层移除；清单覆盖 PM2 `Common.js keysToIgnore` 及容器额外写入的日志路径、版本和实例字段，动态 `instance_var` 指向的实例变量一并移除。
  - host / cloud / sandbox 均保留宿主代理变量：现有真机证据尚未把代理与 `env=[object Object]` 等 PM2 元数据单独隔离，默认删除可能让依赖代理出网的宿主断网。
  - Bot 顶层 `env` 与 `mojo.env` 在清洗后按原优先级合并，显式配置可覆盖或置空代理变量，`mojo.env` 继续具有最高优先级。
  - worker 的 wrapper 解析与 Mojo backend 的真实 spawn 共同使用同一环境构造函数，避免“解析 wrapper 的 PATH”和“子进程真正运行的 PATH/环境”再次分叉。

#### 验证记录

- 验证方式：实现者自动化验证 + 一轮独立代码复审；指定的第二安全复审待完成
- 验证设备 / 环境：macOS arm64 + Node/Bun 自动化
- 自动化结果：
  - 修复前 focused 基线：3 个测试文件，135 项通过。
  - 最终候选 focused gate：4 个测试文件，183 项通过、1 项平台跳过；新增覆盖 host/cloud 代理保留、显式代理覆盖与置空、动态 PM2 instance key、防止恶意 instance key 删除 PATH、PM2 `Common.js` 元数据清单漂移、输入不变及非 Mojo 零影响。
  - 全部 Mojo 测试串行复跑：34 个文件中 33 通过、1 个平台跳过；663 项通过、32 项平台跳过、0 失败。并行初跑曾有 4 个一秒等待超时，相关 3 文件单独复跑 16 项通过、8 项跳过、0 失败，判定为负载抖动而非回归。
  - `npx --yes bun@1.4.0 run build` 通过；domain audit、主 TypeScript、scripts TypeScript、dashboard bundle 与 dist audit 均通过。
- 真机结果：尚未通过。macOS 上三种隔离方式启动真实 Mojo 均在进入 Bash 前超时；测试进程已按精确 PID 回收，临时目录已清理。`mojo auth status --json` 显示缓存身份存在但 `expires_at` 已过，需重新登录后复验，不能据此宣称修复已生效。
- 独立复审状态：一轮独立代码复审确认 PM2 元数据隔离、误删边界、wrapper/backend 同策略和测试覆盖无 blocker；默认删除宿主代理的早期方案已撤回，最终实现为所有 Mojo 模式仅清理 PM2 元数据并保留代理。指定的第二安全复审因对方认证错误尚未完成；同时尚未完成有效登录态下的真机验证，因此未进入 push / PR。
