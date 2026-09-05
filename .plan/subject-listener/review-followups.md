# Subject PR review follow-ups

## 处理顺序

| ID | 状态 | 处理要求 |
| --- | --- | --- |
| R-1 | 必须修复 | Subject 必须在 session ownership 分流前成为路由主轴，不能因已有或恢复的 session 落入普通 `handleThreadReply`。补已有 session 与失败重试回归。 |
| R-2 | 必须修复 | 游标读取只允许对文件不存在或可识别的损坏状态做有记录的降级；权限、I/O 等真实故障必须可观察并阻止游标推进。 |
| R-3 | 必须修复 | Subject policy 只在字段真正缺省时使用默认值；显式非法配置应 fail closed，并让 bots.json、Dashboard/API 和运行时复用同一解析契约。 |
| R-4 | 已完成 | Sprint 003 已消除 Subject 协议对 Skill 目录的反向依赖，并把 Subject turn 准备逻辑从 daemon 巨型 handler 提取到稳定 service 边界。 |
| R-5 | 最后补齐 | Dashboard 截图与真实飞书监听链路的 live daemon 验收；在 R-1 至 R-4 收敛后执行，避免重复验收。 |

## R-4 建议方案

> 该方案已获用户确认，实施计划见 [sprint-003](./sprint-003/)。

目标是让 Subject 成为可组合的主体层，同时继续复用现有 CLI、worker、Lark 和编排能力，不再增加另一套执行引擎。

### 1. 独立协议所有权

- 新增稳定的 Subject 协议模块，例如 `src/services/subject-listener-protocol.ts`。
- 该模块只保存可信协议文本和最小输入/输出类型，不依赖 Skill catalog、daemon 或 Lark client。
- `skills/definitions.ts` 与消息渲染器都单向依赖该模块，消除 service 反向加载整个 Skill definitions 的关系。

### 2. 提取 turn 准备边界

- 新增 `prepareSubjectListenerTurn(input, dependencies)`，集中完成可信 trigger 校验、sender 解析、群资料读取、游标读取、飞书历史快照和最终 prompt 生成。
- 网络与持久化能力通过最小依赖注入传入，便于覆盖 cold start、cursor lost、I/O 失败和 Lark 失败。
- 返回一个明确的 `PreparedSubjectListenerTurn`，包含 prompt、chat context、resolved sender 和 candidate cursor。

### 3. 保持现有层职责

- event dispatcher 继续负责未 @ 匹配、按 Bot + 群 FIFO，以及 Subject 专用路由选择。
- daemon 只负责 admission、工作目录/会话创建、调用 turn 准备边界和注册 completion。
- worker-pool 继续负责可见送达、`BOTMUX_NOTHING_TO_SEND`、失败/取消与游标提交，不改变 CLI/后端共用语义。

### 4. 实施约束

- 不新增通用 Subject framework、插件系统或第二套 session。
- 不改变 `messageListeners` 公共配置结构。
- 拆分前先用测试钉住 R-1、R-2、R-3；拆分只移动职责，不同时扩展产品能力。

## 本轮规范修复

- [x] `subject-listener-context.ts`：拆平 continuity 的嵌套三元。
- [x] `subject-listener-cursor-store.ts`：拆平 createTime 比较的嵌套三元。
