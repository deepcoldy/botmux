# bytedcli 机器写入例外与 Skill 命令覆盖 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 支持默认触发者写入、可配置指定机器写入，补齐选定业务 Skill 调用及未登记业务 actor 执行。

**Architecture:** 效果与身份独立；v2 规则允许显式 machine write，宿主显式 actor/deny 仍是上限。未登记 actor 执行必须独立隔离，机器例外只匹配具体登记签名；JWT 型 helper 改走最终 API 的受管代理。

**Tech Stack:** TypeScript、Bun/Vitest、Linux bubblewrap、现有 peer authority/短期 lease/durable audit、React Dashboard。

**Spec:** `docs/bytedcli-machine-write-exceptions-design.md`

## Global Constraints

- 源码基线 `2145d2e8068fba1aa0dccc8ca7bbb341b032e70e`；沿用 `feat/bytedcli-read-write-identity`，不重做旧任务。
- bytedcli release `0.199.0`，CN 认证分区。未知身份、来源、release、策略版本或失效授权必须拒绝，不能机器 fallback。
- read 默认 machine，write 默认 actor；machine write 必须显式配置。宿主明确 actor/deny 不能被 Bot 放宽。
- 新 policy/status schema v2；合法 v1 严格迁移，v1 machine write 仍拒绝。新增目录增加 catalogVersion，旧配置迁移保持 ID/规则含义。
- write/unknown 无论身份均保留 durable intent、限额、未知结果和同轮派发 requestId 防重放。
- 未登记业务默认 actor，必须独立隔离；已登记命令参数错误不能 fallback 绕过规则；不能导出共享 JWT。
- 只对选定业务精确签名提供 machine 预设；不得自动给官方领域指南全部能力机器权限。
- 不安装依赖、不修改 package/lock、不改共享 node_modules、现网 wrapper/daemon/fleet/实际配置，不执行真实认证/业务或发送消息。
- 临时探针/变异必须 fenced-run，TS 子进程必须 test/helpers/ts-runner.ts；每次一个生产写入者，完整测试/二进制由控制器在冻结验证 worktree 执行。
- 任务独立复核后进入下一任务；最终持久状态独立对抗复核；普通推送同一功能分支，不 force/PR/merge/tag/release/deploy。

### Task 1: 已登记命令的可配置机器写入完整合同

**Files:** 修改 `src/core/bytedcli-operation-policy-config.ts`、`src/core/bytedcli-executor.ts`、`src/core/bytedcli-broker.ts`、`src/cli/bytedcli-exec-protocol.ts`、`src/dashboard/web/bot-defaults-page.tsx`、`src/dashboard/web/i18n.ts`；更新 `docs/bytedcli-read-write-identity.md`、`docs/bytedcli-operation-audit.md`。测试 `test/bytedcli-operation-policy-config.test.ts`、`test/bytedcli-operation-policy-runtime.test.ts`、`test/bytedcli-operation-policy-dashboard.test.ts`、`test/bytedcli-executor.test.ts`、`test/bytedcli-broker.test.ts`、`test/bytedcli-exec-protocol.test.ts` 与相关目录实际测试文件。

**Interfaces:** 保留 `parseBytedcliOperationPolicy(raw)` 和 `resolveBytedcliOperationRule(operationId, globalPolicy?, botPolicy?)` 的函数名/返回结构。新解析器输出当前 v2 规范对象。`BytedcliFrozenAuthority.executionIdentity` 与 `operationPolicy` 仍是宿主构造，不接受 wire identity。Task 2/3 依赖真实 effect 不改的 resolver 与兼容迁移。

- [ ] 编写 RED：write 默认 actor；global 或 Bot v2 显式 machine → machine；global actor + Bot machine → actor；任一 deny 禁用；read 原默认不变；v1 合法读取/actor迁移、v1 machinewrite拒绝。

```ts
const close = 'codebase.mr.close';
expect(resolveBytedcliOperationRule(close).identity).toBe('actor');
expect(resolveBytedcliOperationRule(close, undefined, parseBytedcliOperationPolicy(v2({[close]: 'machine'}))).identity).toBe('machine');
expect(resolveBytedcliOperationRule(close, parseBytedcliOperationPolicy(v2({[close]:'actor'})), parseBytedcliOperationPolicy(v2({[close]:'machine'}))).identity).toBe('actor');
```

- [ ] 执行目标测试确认因旧合同失败，而非环境/导入失败。
- [ ] 实现 v2 严格 parser 与旧 v1 严格迁移，保留版本闭合、私有文件/省略/null与原子拒绝。不要增加任意 runtime目录或未知 ID machine 能力。resolver 的默认身份不是宿主显式 floor。

```ts
const identity = globalRule === 'actor' || botRule === 'actor' ? 'actor'
  : globalRule === 'machine' || botRule === 'machine' ? 'machine'
  : operation.effect === 'read' ? 'machine' : 'actor';
```

- [ ] executor 只允许带有当前宿主 operationPolicy 明确 machine 解析证明的 write 选择 machine；只传 executionIdentity=machine 的 write descriptor 不得绕过配置。仍保持 intent/lease/结果与重放合同。机器 write 不要求 actor 授权；配置切回 actor 时恢复个人门禁。
- [ ] 协议允许真实 machine 的 write_outcome_unknown；broker 超时/授权失效响应使用已冻结身份，不能硬编码 actor。client stderr 仍无自动重试。
- [ ] Dashboard 写行允许 machine，在 effect=write 上标明机器例外。兼容 status v2 gating，旧 daemon 不误报成功，紧急关闭仍可用。新文案明确“默认触发者，允许显式例外”。
- [ ] 行为验证：机器 lease 唯一使用、无 actor lookup、write intent/result、审计失败不派发、已派发结果丢失机器 unknown、同 requestId 策略变动不重写。真实 UI 保存/全局 floor/旧配置往返。
- [ ] 拿掉 explicit policy guard 与全局 actor floor 的私有变异应分别咬红；目标回归一次，diff hygiene；中文提交并写 task report。此任务不拓展目录、不增加 fallback/API/预设，避免未经隔离的半成品执行。

### Task 2: 扩展精确业务目录与隔离的未登记 actor 执行

**Files:** 创建 `src/core/bytedcli-business-command-catalog.ts`、`src/core/bytedcli-fallback-operation.ts`、`src/core/bytedcli-isolated-process.ts`；修改 `src/core/bytedcli-operation-catalog.ts`/JSON、`src/core/bytedcli-operation-policy.ts`、`src/core/bytedcli-operation-policy-config.ts`、`src/core/bytedcli-broker-process.ts`、`src/core/bytedcli-executor.ts`、`src/core/bytedcli-broker-audit.ts`、`src/cli/bytedcli-exec.ts`、`src/core/bytedcli-broker.ts`。增加 `test/bytedcli-business-command-catalog.test.ts`、`test/bytedcli-fallback-operation.test.ts`、`test/bytedcli-isolated-process.test.ts` 和组合验收。

**Interfaces:** `BytedcliOperation.effect` 增加 unknown，`isBytedcliWriteLike(effect)` 为 write/unknown；`execution` 区分原生审核、隔离原生、host-api。新增业务签名统一在纯 catalog 中，对 browser/help/status可见；parser/client/executor同一版本。fallback ID 为可复算的规范 opaque ID，仅 actor，不能通过 runtime rules 设置 machine。

- [ ] RED：新机器候选实际 argv 规范化、参数条件/read/write区分；未知业务返回unknown/actor；已知路径错误参数拒绝；auth/profile/self/plugin控制拒绝；staged Agent 文件不读取宿主路径；目录版本与v1迁移兼容。

```ts
expect(parseBytedcliOperation(['new-business','inspect','123']).effect).toBe('unknown');
expect(() => parseBytedcliOperation(['codebase','mr','close','1','--repo','org/repo','--profile','other'])).toThrow();
```

- [ ] 从本地审计清单和安装源码补齐选定命令具体参数：TCC get、RDS 单条只读SQL、Redis HGET、BAM method get、限定Picko RPC/HTTP、TCE/SCM查询、日志查询、IAM预检/申请、Slardar data/chat、Libra读取、TOS上传、BITS状态/触发等。每条声明匹配条件、effect、输入文件和隔离需求；不可将整个rawRPC/HTTP/Redis视为机器读取。
- [ ] unknownactor native运行建立私有FS/PID namespace，绑定可信安装依赖/运行时/必要CA和请求目录，固定系统bwrap，不能挂整个host HOME/根或暴露broker/cookie/机器凭据。缺少隔离拒绝。所有宽参数新增native路径也走隔离，machine例外同样不能访问宿主敏感文件。
- [ ] 使用真实临时宿主secret、独立请求、readonly安装和可控Node fixture验证隔离读写拒绝，允许业务输入快照/stdout；无裸native降级。
- [ ] unknowneffect按write-like维护intent/配额/unknown结果和重放，wire结果如实投影；host当前rule/身份重新解析不可绕过。
- [ ] 新业务签名和fallback必须通过源码/真实编译模块行为测试及移除隔离/匹配条件的变异；中文提交，报告接口供Task3消费。

### Task 3: JWT 型 Skill 的最终 API 适配与机器例外预设

**Files:** 创建 `src/core/bytedcli-skill-api.ts`、`src/cli/bytedcli-skill-api-client.ts`、`src/core/bytedcli-skill-machine-preset.ts`、`docs/examples/bytedcli-mix-machine-policy.json`；修改 broker/executor/process 的 host-api dispatcher、Dashboard 与使用说明。Skill 源仓在 `/data00/home/kepeilin/code/mix-agent-plugin` 的隔离分支调整 `skills/release-plan-owner-sync/scripts/sync-release-owner.mjs` 及被确认使用JWT且需严格模式的实际源文件；未在源仓找到的独立Skill以可安装patch/artifact交付，禁止直接覆盖各安装副本。

**Interfaces:** 受管 command使用 `bytedcli --json skill-api <规范 operationId> --request <JSON>`，closed request字段按最终API验证，返回原helper需要的安全data。host dispatcher复用同一executor lease/intent/recheck/输出限额；不返回token。普通非strict Skill保留既有独立行为，strict调用走此client。

- [ ] RED：release查询和PUT写各为独立配置行；选定machinepreset匹配全部已授权精确签名，未选择Skill写命令不含machine；同一JWT导出命令不能决定全部最终API身份。

```ts
expect(MIX_SKILL_MACHINE_PRESET.rules['skill-api.bits.release.owner.update']).toBe('machine');
expect(MIX_SKILL_MACHINE_PRESET.rules['codebase.mr.create']).toBe('actor');
```

- [ ] 实现固定源/路径/方法/body的受管API dispatcher，发送前intent并重新核验；拒绝任意URL、redirect、header/credential选择，HTTP代理使用冻结宿主网络合同。nativefake与HTTPfake通过同一真实executor组合验证。
- [ ] release-owner读列表/单详情/关联研发单/PUT approvers改走受管操作，dry-run无写调用，apply machine例外与actor默认可观察且结果未知无自动重试。其他JWT型Skill按照实际最终API effect适配，不能导出机器JWT；必要MCP调用限定工具和server。源码改造/安装交付每项记录路径和验证，不与运行版本混淆。
- [ ] 提供全部选定Skill精确命令的machinepreset JSON；Dashboard应用按钮展示write例外并保存完整配置，global actor/deny不能放宽。未选定的所有已登记 read/write（含 MRcreate、SelfDo、MindAI 产物）显式 actor；选定签名 machine；宿主 actor/deny 保持上限。
- [ ] 更新使用说明、审核证据和真实假数据UI截图；targettests+private mutations覆盖preset遗漏、写效果丢失、任意目标、token泄露、dryrun误写。中文提交并报告。

### Task 4: 当前提交验证与独立对抗复核、交付

**Files:** 此计划的ignored workspace内 `controller-validation.md`、冻结验证日志、最终复核报告；按实际构建发现补精确asset登记与compiled smoke。

- [ ] 冻结最终HEAD到独立验证源码目录，仅复用已经准备且不变的依赖，不跑install；native typecheck/build、asset audit与完整Linuxstandalone通过。
- [ ] 编译client执行selectedmachinewrite、unknownactor、safeAPI、policyfloor、invalidconfiguration、结果未知与replay组合验收；说明手工requestId使用的真实路径。
- [ ] 按AGENTS.md独立真实组件+可控时钟攻击：人工改machine→actor/deny；intent成功/结果失败/半写策略恢复；长machine取票/未知actor执行×timeout/重试/下一轮交叠。检验不重复写、不泄漏身份、不遗留资源。
- [ ] 每个任务review清洁，最终review只覆盖本轮`2145d2e80..HEAD`；存在真实finding交原作者合并修复和scoped复核，影响验证重跑。
- [ ] 检查源码与验证目录clean/diff hygiene/无package-lock改动，普通推送既有功能分支并确认remoteHEAD相等。保留证据，报告配置入口、实际覆盖与部署尚需执行的步骤。

最终场景裁定（覆盖早先未选 write 省略示例）：预设对所有未选已登记业务 read/write 显式 actor，确保其他业务使用触发者，即使宿主此前明确 machine。应用后仍可手动调整已登记操作例外；global actor/deny 不可放宽。
