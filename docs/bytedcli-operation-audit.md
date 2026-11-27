# ByteCloud broker 命令目录审核

审核基于安装候选 `@bytedance-dev/bytedcli` **0.199.0** 的发布源码，目录版本 `2026-11-27.1`。本目录只支持 `cn` 认证分区；未知 release、已登记命令非法参数和区域均拒绝。未登记业务仅通过隔离的 actor/unknown 路径执行。源码审核只读取文件，并用独立 Commander 实例验证参数 grammar；没有调用业务接口、个人授权或更新 CLI。

## 目录维护与运行规则

随 Botmux 发布的 `src/core/bytedcli-operation-catalog.json` 是审核数据，包含 release/catalog 版本、规范 ID、命令路径与别名、真实效果和封闭参数 grammar；纯 TypeScript loader 验证并冻结整份目录。新增命令、选项或改变效果必须重新审核实际 handler/service/API 链，更新该文件与行为测试，再发布新版本。宿主规则文件和 Bot 配置不能加载外部目录、登记未审核 ID、改变 read/write 效果或绕过参数重建。

运行规则采用 `botmux.bytedcli-operation-policy.v2`、CLI `0.199.0`、catalog `2026-11-27.1`。宿主固定文件为 `~/.botmux/host-authority/bytedcli-broker/policy/operation-policy.json`；Bot 为 `triggerUserAuth.bytedcliOperationPolicy`。二者使用规范 ID 的 `machine` / `actor` / `deny` 映射，缺项继承。read 默认 machine，write 默认 actor；v2 的显式 `machine` 可选择机器写入例外。任一 deny 禁用，任一明确 actor 优先于 machine；Bot 不能覆盖宿主明确 actor/deny，默认写身份不作为明确宿主限制。合法旧 v1 按旧合同校验后迁移为 v2，v1 machine write 仍拒绝。状态 schema 同样为 v2。所有已登记别名继承同一规范 ID 的规则。auth/help 保留专用适配器与个人控制边界。

[配置示例、私有权限、Dashboard 与失效恢复](bytedcli-read-write-identity.md#逐命令规则与宿主限制)说明全局和 Bot JSON、旧客户端保留与显式清除语义。运行时验证文件及修订，身份查询之前拒绝禁用/无效配置；排队、取票、派发和返回持续绑定修订。actor-read 的真实效果仍为 read，使用读额度/结果审计；业务 write 无论机器或个人身份仍须 durable intent、写入限额与结果落盘；机器写入要求实际 parser 生成且冻结的显式有效策略证明。已派发写入在同一执行中保留 request ID 派发记录，策略变动不会解除重复写入防线；结果未知无自动重试。

## 参数与输出边界

所有业务调用由 parser 从审核字段重新生成 argv，明确添加 `--site cn`。调用方可提供的通用参数只有 `--json` / `-j`、`--site cn` 和 help；root `--version` / `-V` 只返回安全版本信息。命令里的 `--version <n>` 是 MR 版本号，其类型不同于 root version。其它全局选项全部拒绝。

支持长短选项、`--key=value`、选项置于命令路径前后、`--`、已登记命令别名。单值选项及它们的别名重复使用即拒绝；可重复列表按逗号拆分并逐项校验，再逐项重建。零参数布尔 flag 不接收值；可选布尔参数只开放 `true` / `false`，规范化为 `--remove-source-branch=true|false`。只开放已登记的 negated flag。带 `-` 的文本值须以 `--key=value` 输入，重建也使用该形式，避免被上游再解释成身份或执行选项。

全局 `--as`、`--profile`、JWT 文件、auth-site、network-profile、AI Auth subject/app-key、代理、任意 header、调试/HTTP trace、timeout override、关闭脱敏、`--jq`、`--vdc` 均拒绝。只有日志 matcher 开放 `--vregion China-North|China-North6` 中的一个值；不支持跨区、多区域管道串或其它站点。

数字为无前导零的十进制整数。资源 ID 范围 `1..Number.MAX_SAFE_INTEGER`，页码 `1..10000`，每页 `1..100`。repo 只接收分段的组织/仓库资源路径或数字 ID，二选一；不接受 URL、宿主目录或隐式当前仓库。MR 只接收明确数字 number 或 `--mr-id`，二选一。branch 只接受有限字符和长度，不接受 `..`、空分段或 `.lock` 后缀。

argv 限制 256 项 / 64 KiB，解码输入总量 2 MiB，HTTP 请求 body 3 MiB，合计输出 16 MiB。目录默认 timeout 60 秒；这些上限是执行器的合同，不代表只调用 parser 就已建立执行隔离。响应只允许预定义安全 error code 和 opaque 账号 fingerprint。parser 不承担通用日志或所有第三方秘密的识别。

新增加的 40 个精确业务签名、unknown 合同及 DB 依赖前提见 [业务目录合同](bytedcli-business-command-catalog.md)。以下为原 JSON grammar 的 18 行。

## 已开放目录及实际效果

以下参数是完整开放子集；上游还有其它参数，未列出的一律拒绝。所有 Codebase MR 项同时支持旧 `pr` group；`get/view`、`update/edit` 是等价已登记路径。

| operationId | 开放字段 | 审核的 handler/service/API 效果 |
| --- | --- | --- |
| `codebase.repo.get` | 明确 repo（positional、`--repo` / `-R` / `--repo-name`）或 `--repo-id`；`--languages` | repository handler 调用 `getRepositoryWithDefaultBranch`，再取 repository/default-branch/languages；repository API 的 `GetRepository` / `GetDefaultBranch` 只查询，repo cache 是进程缓存。显式资源避免 git origin 推断。 |
| `codebase.repo.list` | `--query`（1 KiB）；`--page` / `--page-number`；`--page-size`；`--namespace-id`；`--statuses`（created,archived）；`--sort-by`（LastActivityAt,Path）；`--sort-order`（Asc,Desc）；`--has-wiki` | repository handler 构造有限查询；API `ListRepositories`，只查询及更新进程 repo cache。 |
| `codebase.mr.get` | 明确 repo 与 number（positional / `--mr`）或 `--mr-id`；`--version`（1..10000） | `resolveMergeRequestDetails` → repo/MR/version 查询。禁止 `--work-items`，不引入额外 work-item 授权域；禁止 URL/branch/隐式当前分支 selector。 |
| `codebase.mr.list` | repo；分页（`--page` / `--page-num`，`--page-size` / `-L` / `--limit`）；`--state` / `-s` / `--status`（open,merged,closed,all）；head/base（含 `-H/-B` 和旧 source/target-branch alias）；author/reviewer/attention（128 bytes）；title（1 KiB）；可重复 label（128 bytes）/milestone-id；commit（7..40 hex）；draft/wip（true/false）；review-status（unreviewed,approved,rejected）；sort-by（CreatedAt,UpdatedAt）/sort-order（Asc,Desc） | list service 在缺少 `updated-since` 时直接调用 `ListRepoMergeRequests`；attention 可执行当前账号 username 查询。禁止 `updated-since`，避免上游扫描至 1000 页统计 total 的额外工作。所有过滤值仅进入查询，不选择执行身份。 |
| `codebase.mr.count` | repo；同上 head/base、author/reviewer/title、重复 milestone-id、commit、draft/wip、review-status；无分页/label/attention | `GetRepoMergeRequestsCount` 查询；所有字段是筛选条件。 |
| `codebase.mr.diff` | repo；明确 number / `--mr` 或 `--mr-id`；version；可重复 `--file`（repo 内相对资源名，1 KiB）；context（0..100）；max-patch-bytes（1..1 MiB）；ignore-whitespace | `resolveMergeRequestRange` 与仓库 compare/diff 查询；file 是服务端资源筛选，不能在宿主读取此路径。不接受绝对路径及 `..` 分段。 |
| `codebase.mr.files` | repo、明确 MR selector、version | `handleCodebaseMrChanges` 与 `resolveMergeRequestRange` 查询 MR/version/改动文件，不下载文件。 |
| `codebase.mr.status` | repo、明确 MR selector、page-size | 查询 MR、mergeability/detail、review status、最多一页 check runs；不执行流水线。 |
| `codebase.mr.create` | repo、head（`--head` / `--source`）、base（`--base` / `--target`）、title 必填；description 文本（`--body` / `--description`，32 KiB）或 snapshot `--body-file` / `-F` 二选一；merge-method（merge_commit,rebase_merge）；draft、squash-commits；可选 remove-source-branch true/false；merge/squash-commit-message（4 KiB）；重复 reviewer-ids（数字 ID 或有限 username）；no-auto-invite-reviewers | handler 解析 description，查询目标 repo、解析 reviewer username，再向 `CreateMergeRequest` 提交已知字段。service 仅在 `opts.push` 时调用 git push，仅在 `opts.meego` 非空时关联 Meego；这两项均被目录拒绝。禁止 attachments、work-item/label/milestone/link/auto-link-work-items 等未开放字段。 |
| `codebase.mr.update` | repo、明确 MR selector（含 `--number` alias）；至少一个 title/body/snapshot/base/draft/ready；draft 与 ready 互斥；alias edit | `UpdateMergeRequest` 修改这些明确字段。service 中其它 Meego、links、attachments、labels 等分支在目录下不可达；禁止 merge-method 与全局 yes 的额外预览/应用分支。 |
| `codebase.mr.close` / `codebase.mr.reopen` | repo、明确 number / `--mr` 或 `--mr-id` | selector 查询后调用 `CloseMergeRequest` / `ReopenMergeRequest` 修改 MR 状态。 |
| `bits.develop.list` | space-id 必填；page/page-size；title（1 KiB）；about-user（有限 username）；sort（created-at-asc/desc）；重复 state（initial,opened,closed,finished） | developList service 构造 conditionGroup 后调用 `listDevTasks` 查询，再生成可读 sidecar。禁止 raw、work-items、任意 body 与其它跨域输入。 |
| `log.search-log-matchers` | psm 必填；id；可选 vregion（China-North 或 China-North6）；output 只允许 console，并由 parser 明确注入 | query handler 调用 `searchLogMatchers`；API 构造固定站点路由 `/v1/analysis/log_matchers` 的 psm/vregion/id 查询，不 watch。显式 console 避免 text 输出默认 file。禁止 output-file 等路径。 |
| `auth.status/userinfo/login/logout` | 只有 json/site/help 等安全通用选项，无 auth-specific 参数 | **专用个人 auth adapter descriptor**，不允许执行 SDK 原始 handler。上游 status/userinfo 可能带原始材料，login/logout 涉及持久个人授权；后续 adapter 必须只操作可信本人的授权并投影安全结果。没有安全 adapter 时应拒绝。 |

## 上游源码证据

审核文件都相对于该 release 的 `dist/`：

- `cli/index.js` 的全局 grammar（约 914..963 行）：JSON、site、身份、profile、代理、HTTP trace 与 request-JWT 参数。
- `cli/commands/codebase/repo.js` 的 get/list（约 736..789 行）；`cli/commands/codebase/shared.js` 的 repo/MR selector 与 legacy alias。
- `cli/commands/codebase/pr.js` 的 get/list/count/status/create/update/diff/files/close/reopen；`cli/handlers/codebase/repository.js` 与 `pull_request.js` 对应 handler。
- `services/codebase/merge_request.js` create/update（约 169..315 行）：push 和 Meego 条件分支、attachments/labels 等分支；`merge-request-list.js` 直接 list 与扫描分支。
- `api/codebase/repository/api.js`、`api/codebase/merge-request/api.js`、`api/codebase/client.js`：查询 action 与写 action，认证选择和 exchange。目录分类基于完整调用链，不能由 action 名称或 HTTP method 单独推导。
- `cli/commands/bits/develop.js`、`cli/handlers/bits/develop.js`、`services/bits/develop/task.js`：list 的查询链；`task-detail.js` 与 `api/bits/develop.js`：get 的初始化旁路。
- `cli/commands/log/search.js`、`cli/handlers/log/query.js`、`api/log/api.js` 与 `client.js`：matcher 的固定 URL 查询、站点供票和 text output。
- `cli/commands/auth/index.js`：个人 auth 命令与 export/import/token/AK/SK 等禁止分支。

## 执行器必须维持的前提

MR create handler **即使显式 head，也仍无条件调用 `inferCurrentGitBranchFromCwd()`**。显式 head 在值选择时优先，push 分支被禁止；但必须保持空的私有 cwd/HOME、固定可信 PATH/git、禁用继承的 git 配置和环境，不能让宿主探测调用落入 Agent 仓库、hooks、fsmonitor 或 credential helper。本目录不接收 cwd，也不支持 clone、branch/create、push 或附件。

Codebase client 会交换 request-scoped ByteCloud JWT，错误时也可重取短期 JWT；BITS/log client 可能请求路由需要的认证材料。后续 executor/provider 必须证明使用同一冻结身份的短期 CN lease，移除所有其它身份源，禁止隐式长期存储和共享账号 fallback。若空 HOME / request JWT 不能安全供票，相关操作应保持运行时拒绝；操作目录开放不是运行环境证明。

Auth/help 在宿主独立 adapter 上执行。输出需要先由宿主去除活跃凭据的精确值、认证字段和已知秘密形状；业务输出保留 stdout/stderr/exit status，但原始 auth handler 输出始终禁止。

## 原始审核未覆盖的候选（历史）

本节记录首期审核限制；2026-11-27.1 已在新目录中补充的精确签名以[业务目录合同](bytedcli-business-command-catalog.md)为准，其余业务使用 unknown/actor 隔离路径，认证与安装控制仍拒绝。

- **BITS develop get**：task-detail service 在明确 pipeline-id 且选中 task 时调用 `initTaskIds`，请求 `/dev/task/workflow/init_ids`。现有 CLI 发布源码只见 GET，不能证明服务器没有持久初始化效果；而不传 pipeline-id 的 handler 又有 undefined/null 诊断 ID 校验问题。因此整项拒绝，不能借 get/help 描述归为读。
- BITS develop check-mr/inspect-changes/create/update、release get/search/inspect/stages/project-configs：没有完成所有参数与效果链审核，首期不开放。create 涉及模板、跨域 Meego、环境构造和可能多步变更；不是任意已知字段天然安全。
- 其它 log 候选（get-logid-log、get-log-cluster、get-lane-instance-log）：涉及 SDK、滚动抓取、dump/默认输出等额外边界，首期不开放。
- MR 的 work-items、Meego、附件、labels/link、merge-method update、安全 bypass、merge、queue、local branch workflow；standalone Codebase/Bits/git 远端操作。
- raw API、RPC test、任意 SQL、远端 shell、插件、升级、auth export/import/token 和 app AK/SK。

扩展目录必须重新审核 release 的实际 handler/service/API 链和参数组合，并验证独立宿主执行边界。
