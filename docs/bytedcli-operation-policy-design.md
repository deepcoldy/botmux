# bytedcli 版本化命令目录与执行策略

用户已批准实现版本化命令目录与可配置执行策略。本轮基于 `feat/bytedcli-read-write-identity` 的 `a0748e6ca`，沿用现有严格身份与隔离边界。

## 目标与配置

真实业务效果由随版本发布的已审核 JSON 目录声明，包含 CLI/catalog 版本、命令路径与别名、参数 grammar、必填条件和 read/write/auth/help 分类。将现有声明从 TypeScript entries 迁至 `src/core/bytedcli-operation-catalog.json`，解析器仍严格验证并重建 argv。默认目录保持当前 0.199.0/CN 的命令与参数行为。新增命令需要修改该数据文件、审核实际调用链及参数、补充测试并发布；运行时策略不能登记未审核命令或改变真实效果。

宿主全局执行策略使用固定文件 `~/.botmux/host-authority/bytedcli-broker/policy/operation-policy.json`。它处于现有凭据拒绝根之内，不接受 Agent argv/env/request 中的文件路径。未创建该文件时使用默认策略。目录独立于 probe/requests/audit，使配置创建/删除的修订检测不受普通业务暂存影响。

```json
{
  "schema": "botmux.bytedcli-operation-policy.v1",
  "cliVersion": "0.199.0",
  "catalogVersion": "2026-11-26.1",
  "rules": {
    "codebase.mr.list": "actor",
    "codebase.mr.close": "deny"
  }
}
```

Bot 配置在 `triggerUserAuth.bytedcliOperationPolicy` 中保存同一种版本化对象。它只在 enabled、ByteCloud 和 read-machine-write-actor 同时启用时生效，关闭模式保留有效 dormant 配置。显式 null 清除该字段；旧客户端不发送新字段时保留原值。

规则只针对目录中的业务 read/write operationId，取值 machine/actor/deny。machine 只允许真实 read；actor 适用于 read/write；deny 禁止调用。auth/help 保持专用适配器与现有个人控制边界，不能通过业务策略获得机器授权或新增原始 auth 参数。

合成顺序：审核默认 → 宿主全局 → Bot。拒绝优先；actor 比 machine 更严格；Bot 不能解除全局 deny，也不能将全局 actor 降至 machine。省略规则表示继承。规则必须使用规范 operationId；命令别名先归一化，继承同一规则。未知 ID、未知字段、错误 schema/version、write→machine 等配置拒绝。

## 实际效果与执行身份

`BytedcliOperation.effect` 保持由审核目录确定。配置仅选择执行身份和是否允许：actor-read 仍使用 read 的额度、结果语义，不写 business intent，也不产生 write_outcome_unknown；write 始终使用 actor，持久 intent 与未知结果规则不变。

宿主 authority 在身份查询前冻结全局策略修订和 Bot 策略，选择 machine/actor。actor-read 与 write 一样要求已核验真人、正式账号匹配、个人授权来源与 epoch/binding/delegation/schedule 权限；不能借 owner 或机器账号。普通 machine-read 继续不查询个人授权。

authoritative host authority 可增加 optional executionIdentity 字段，旧受信嵌入调用省略时沿用 effect 默认。executor 验证 write 永远 actor、actor-read 必须有 verified actor，并只按此受信字段选择 lease。HTTP 请求 schema 不增加身份、effect、策略或宿主路径字段。有效身份进入缓存绑定；真实 effect 继续控制 quota/audit/unknown。

## 热更新、文件与去重

宿主 reader 有界读取 UTF-8 JSON（最大32 KiB），拒绝软链、硬链接、特殊文件、非私有文件/目录和不可信所有者，不跟随不安全路径；首次严格请求可安全建立私有 policy 目录，不改真实配置内容。前后检查文件及目录身份，遇到不稳定/半写/无效配置拒绝本次严格操作，不使用上次配置或机器账号兜底。旧模式不调用 reader。

修订由规范配置、文件身份/修改元数据、独立 policy 目录的修改元数据生成有界摘要。文件不存在也绑定该目录修订，因此创建→删除的 ABA 可检测。固定路径及其父目录不由 Agent 选择，已有 host-authority 拒绝根保护所有未来内容。reader 的初始目录建立须在计算第一份修订之前完成。

排队、取票、派发与返回检查冻结修订和 Bot 策略；变化返回 policy_changed，已派发写入保留 write_outcome_unknown。authority.policyFingerprint 使用有界 SHA-256 摘要，避免新增规则将审计字段扩大到256字节以上。safe refusal 的同步 current 检查保留；不得重启新的异步身份 verifier。

同一执行（boot/app/session/worker generation/dispatch attempt/turn/identity turn）中，已派发的 write requestId 不能因策略修订而再次执行。跨策略缓存查找保留该请求的派发记录，结果无效时返回未知/拒绝并抑制旧业务输出；不能重新取得凭据或派发。已派发写入记录在相同执行范围内不被策略切换的 stale-cache 清理删除。新的显式执行轮/worker generation 仍可按原合同退休旧缓存；保留4096条记录、80 admissions、64 waiters 和128 MiB输出预算。actor-read 重放不得泄露旧 machine/actor 结果。

## Dashboard 与说明

在严格模式选择下展示命令表：规范命令、真实读写性质、Bot 规则（继承/机器/执行人/禁用）、最终身份或禁用状态。写项没有机器选项；全局 deny/actor 显示为有效约束。保存仍使用既有 trigger-user-auth PUT，保持完整 policy 和其它能力字段；全局配置无效时显示明确宿主配置错误，并能关闭模式。

通过现有 trigger-user-auth-status 的可信宿主路由提供无凭据的目录/全局修订与规则摘要；展示和运行使用同一解析/合成函数。help catalog 可展示真实效果和当前有效业务策略，不查询个人授权，不运行 native help。状态查询不可创建登录或返回凭据/真实宿主路径。

文档提供全局文件与 Bot JSON 示例、继承与收紧规则、热更新/失效语义、默认不变、外置数据目录仍需审核发布的边界及未知写入核对方式。截图使用临时 HOME、假数据和真实 UI，不启动 live Dashboard。

## 绑定约束

- 沿用 bytedcli0.199.0、catalog2026-11-26.1、CN、严格 Linux managed local PTY/Tmux/cold/fs+PID 证明；不扩大 CLI/backend/MCP 矩阵。
- absent 配置保持既有行为；strict 策略只在 enabled+ByteCloud+read-machine-write-actor 生效；保留 Lark/Meego/git/owner/delegation/个人 auth/旧模式合同。
- 所有请求参数仍闭合校验并规范重建；配置不能增加未审核命令/参数、将 write 变 read 或选择机器 write。
- 宿主全局规则只能收紧审核默认，Bot 只能进一步收紧；身份与真实 effect 分离；没有个人授权的 actor-read/write 均不回退机器。
- 排队/取票/派发/返回重新校验策略修订；拒绝同步检查不启动新 verifier；初始异步所有权、重复绑定、关闭/退休 join、合法后继与资源预算不得回退。
- 持久 intent fsync 在实际 write 派发之前；已派发写入不自动重试，策略修订不能清除同执行 requestId 派发记录；actor-read 不使用 write 额度/审计/未知语义。
- 不安装依赖、不修改 package/lock 或共享依赖；完整验证用既有 `/tmp/botmux-rw-validation-src.WNU9iw` 与 staged dependencies，只有控制器推进冻结提交。
- 测试使用临时 HOME、假 provider/CLI；TS 子进程使用 test/helpers/ts-runner.ts；临时探针/变异一律 bun scripts/fenced-run.ts；不碰 live 凭据/业务/daemon/fleet/systemd/tmux/wrapper。
- 提交格式 type(scope): 中文描述；公开源码/提交不含真实人名或部署主机；完成审查与完整验证后更新已授权的同一远端分支；不创建PR/merge/tag/release/deploy。
