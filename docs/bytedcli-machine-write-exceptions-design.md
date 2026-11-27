# bytedcli 可配置机器写入与业务 Skill 覆盖

用户已明确：原则上写操作使用触发者，但允许配置指定写命令改为机器身份。Picko 排障相关、release-plan-owner-sync、mix-troubleshooting、mix-c4-tracker 使用到的具体命令需要可配置的机器例外；其他已识别写操作保留触发者身份。未登记业务命令默认触发者身份。

## 配置合同

真实效果和执行身份继续分离。read 默认 machine；write 默认 actor；未完成效果审核的业务调用标记 unknown，默认 actor，并按潜在 write 处理限额、intent 和重放。显式 machine 可以覆盖 write 的默认 actor；不能覆盖宿主明确 actor 或 deny。Bot 能为无宿主明确限制的已登记命令选择 machine；宿主 deny 总是优先，Bot deny 同样禁用，Bot actor 可收紧宿主 machine。

新语义使用 `botmux.bytedcli-operation-policy.v2` 与 `botmux.bytedcli-operation-policy-status.v2`，防止旧客户端将机器写入误解为旧合同。旧 v1 对象在原版本下严格校验后迁移：v1 的 machine write 仍拒绝；合法旧规则保持含义并规范化到当前版本。命令目录新增条目时增加 catalogVersion，并明确接受旧已审核版本的迁移，不接受任意未知版本。

配置入口仍为宿主固定的私有策略文件与 Bot 的 triggerUserAuth.bytedcliOperationPolicy。省略/null/关闭模式保留/清除合同不变。界面允许写行选择机器，始终显示 write 效果和最终身份。提供可审阅的 MIX/Picko 机器例外 JSON 与 Dashboard 预设；应用动作写完整 Bot 配置，不能绕过宿主明确限制。源码改造期间不修改现网文件或重启 daemon。

## 受管执行

机器写入仍先持久化 intent、继续核验当前执行/策略/账号、维护同轮 requestId 派发记录，响应丢失或结果落盘失败仍返回 write_outcome_unknown。有效身份如实记录为 machine，不能在协议或 broker 超时路径中硬编码 actor。默认或未授权 descriptor 不能借机器写配置跳过验证。

未登记业务命令不能裸透传现有宿主 runner。将其隔离为独立 Linux 文件系统/PID 视图，仅暴露可信运行时/安装依赖和私有请求目录，保留受限网络与最小环境。fallback 只使用 actor lease；缺少本人授权拒绝。身份切换、凭据导出、宿主插件/升级等保留专用边界。已登记命令非法参数不转换为未登记 fallback，不允许绕过 deny 或 staged-input 限制。

## 业务命令与机器例外

依据本地审计补齐具体路径和允许参数，普通业务 ID 使用规范命令路径；对于 API/RPC/Redis 混合入口使用精确操作签名。PickoTroubleShoot 的自动 flush 与权限票据分支属于潜在 write，用户已允许其精确调用作为 machine 例外；其 write/unknown 效果仍保留。Debug 机器例外须限制已知 PSM、method、debug_scene 与请求字段，不能放宽全部 RPC。IAM check-only 与申请提交、CAT get 与 send 分别声明效果。SQL 限定单条只读 SQL，Redis HGET 等读取与其他命令分别声明。TOS 上传需要 Agent 文件快照，不允许读宿主文件路径。

同一 JWT 导出命令被机器例外 Skill 和 actor Skill 同时使用，不能按 auth.get-bytecloud-jwt-token 整项开放共享 token。对于必要直连 HTTP/MCP 调用，以最终受管 API 操作替代令牌导出，冻结目标、方法、参数和身份。release owner 的查询与 PUT 更新须分别成为配置行。旧普通独立运行可以保留原 Skill 行为，严格 Botmux 会话改走受管 client。Skill 适配必须在源仓隔离分支实现并验证，不直接覆盖多个漂移的安装副本。

## 验证和交付

围绕 machine write 的正常结果、持久 intent 失败、结果丢失、策略改变、同轮重放、长取票与下一轮交叠做行为测试与变异验证。真实 Linux 隔离探针证明未登记 CLI 看不到宿主凭据、不能写安装树/策略、不能读取其他请求。client/broker/authority/executor/API adapter 与 Dashboard 的组合验收必须覆盖真实新规则。最终同一提交完成 native typecheck/build、Linux standalone 与编译客户端验收，按 AGENTS.md 执行独立对抗复核后普通推送既有功能分支。无发布、合并或部署。
