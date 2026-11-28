# bytedcli 精确业务目录与隔离执行

CLI 审核版本为 `0.199.0`，目录为 `2026-11-27.2`。原 JSON grammar 保留 18 行，纯模块 `src/core/bytedcli-business-command-catalog.ts` 登记精确业务签名。合并后的目录供 parser、Dashboard、help 和策略状态使用；每行包含真实 effect、允许参数、匹配条件、输入快照及执行方式。运行配置不能添加目录条目或改变 effect。

| 签名 | 效果与限制 |
| --- | --- |
| `api-test.rpc-call.picko-troubleshoot` | write；`ecom.market.udc_dump/PickoTroubleShoot`，JSON 仅 `scene:manual_check`、字符串 picko_id/entity_id。服务端可能自动 flush。 |
| `api-test.rpc-call.picko-size`、`picko-is-online`、`picko-export-pids` | read；同 PSM 的 Debug，分别限制 scene 和 picko_id 或数字 flush_id。 |
| `api-test.rpc-call.picko-user-email` | read；`ecom.market.udc_picko_service/Debug`，branch/master，仅邮箱查询 scene 与 record_id。 |
| `api-test.rpc-call.assign-info` | read；`ecom.search.assign_manager/GetAssignInfo`，仅数字 assign_id。 |
| 上述 RPC 的 `-ticket` 后缀 | write；必须完整携带 create-permission-ticket、固定接口测试角色及 reason；不带后缀的行禁止票据参数。所有 RPC 固定 lf/prod/default/CN，BAM 来源除邮箱查询外固定 bam。 |
| `api-test.http-call.picko-tag-enum` | read；固定 PSM、POST `/ecom/market/udc/picko/api/list_tag_enum_values`，仅 tag_id。 |
| `api-test.http-call.picko-membership` | read；固定 `ecom.market.udc_picko`、POST `/ecom/market/udc/picko/admin/search_from_picko`，lf/prod/default/CN；body 仅字符串 picko_id、page_size（1–100）、page_num（1–1000）及只含字符串 entity_id 的 filter，ID 为正 int64。查询指定商品的包内记录。 |
| `tcc.config.get.picko-rules` | read；`ecom.market.udc_dump` 的 `/dump_v2/rule_list_config_PRODUCT_new`，CN/prod。 |
| `rds.db.query`（别名 query-db） | read；仅 ecom_market_pick/ecom_search、region cn、单条受限 SELECT。函数白名单，禁止变量、写关键字、锁、注释、未知/引用/库名限定函数及多语句。仅将单引号字面量中的 `\"` 规范为双引号后转发。 |
| `cache.execute-command.picko-hget` | read；服务 15479，HGET `ecom_activity_product_<id> <assign_id>`。 |
| `bam.method.get`、`tce.service.get/search`、`scm.repo.search` | read；封闭 PSM/method/schema 或关键词/仓库选择器。BAM 仅 rpc/default/ref。 |
| `log.get-logid-log`、`log.search-psm-log` | read；CN vregion；PSM 搜索明确时间窗不超过一小时、最多 200 条、console 输出。 |
| `iam.permission.apply.check-only` / `.submit` | 前者 read，后者 write；Argos 日志 permission+PSM 或显式 PSM 角色。提交必须 role/reason/yes，check-only 与 yes 互斥。 |
| `slardar.web.data.list.mix-profile` | read；固定 slardar.bytedance.net/mix_h5/production/web/view，一项 UID/DID 精确条件、有限 metrics、一小时/20 行内。 |
| `slardar.web.analyze-url`、`slardar.web.chat.check-auth/get/send` | analyze-url/check-auth/get 为 read；send 创建或续问 CAT 任务，为 write。URL 仅审核 origin，chat 限定 thread/input/stream。 |
| `libra.layer.get`、`libra.experiment.list/get-batch` | read；明确 layer/app/flight，列表至多 100 行。 |
| `tos.upload-object.c4-report` | write；bucket 20001326，key 以 c4_config_checker_res/ 开头，timeout 30000，仅 Agent 二进制文件快照。 |
| `bits.release.search`、`bits.pipeline`、`bits.pipelines.vars` | read；明确 workspace/pipeline 与有限分页、run-seq。 |
| `bits.develop.get` | read；仅 dev-id 与 space-id；不接受 pipeline-id、URL、stage/task，保持 initTaskIds 分支不可达。 |
| `bits.pipelines.run` | write；明确 pipeline-id、对象 vars 和 `--yes`。 |
| `bits.anywhere.share.get` | read；固定 Bits share URL，仅 appId、_proxy_share_item_id、env。 |
| `codebase.repo.file` | read；相对服务端路径、显式 repo/revision。 |

全部新增行走 `isolated-native`，机器例外也相同。原封闭 JSON grammar 使用 `audited-native`；auth/help 使用 `host-api`。三个 execution 值与 effect、identity 独立。

未登记的合法业务调用规范化为 `unknown.<sha256(canonical argv)>`，effect 为 unknown，固定 actor，并使用 write 的 intent、并发额度、结果不确定和同轮重放防线。该 opaque ID 不属于可配置目录；machine/actor/deny 规则均不能登记它。需要逐命令策略时，必须先审核为稳定目录条目。

RPC、HTTP、Redis、TCC、TOS 等混合入口根据精确目标/scene 区分其他业务与已登记签名。无关目标保留 unknown/actor；命中签名后出现额外字段、非法选项或路由参数必须拒绝，不能转成 fallback。原封闭命令路径同样不能以非法参数逃逸。认证导出、身份/profile 切换、插件、升级和 DB `+update` 等控制入口拒绝。

隔离必须使用固定系统 bubblewrap，创建独立 FS/PID/user/IPC/UTS 视图。仅只读绑定冻结 CLI 安装依赖、Node、必要系统库/CA/DNS、本次请求；本次 home/cwd 可写，root/tmp/request 文件只读。宿主 HOME、broker、其他请求、凭据、策略及宿主 PID 不可见。缺少 bubblewrap/namespace 或运行时证明时拒绝，不降级裸 native。

RDS 还需要预装 DB 二进制。宿主启动时冻结 `DB_CLI_BINARY`，或固定 dependency/db 安装中的平台二进制，不读取/挂载整个 bytedcli data。包管理器硬链接文件会经过稳定源校验后复制到 `host-authority/bytedcli-broker/db-code/db-cli-<sha256>`，使用私有临时文件、fsync 和不覆盖的原子发布；副本必须 nlink=1/mode500，既有副本核对内容哈希、类型、所有权与权限。发布后清理前中断时，只有全部额外硬链接都能证明是同一私有目录内本协议 `.pending-UUID` 的完成发布才可清理恢复，目录外或未知链接拒绝且不删除。源、别名、祖先及副本均重新校验，隔离进程仅挂执行副本。普通可信文件接口仍拒绝硬链接。半写或篡改的最终副本拒绝执行，不自动修复。

缺失或改动在 lease/CLI 发现前拒绝；执行使用固定 `DB_CLI_BINARY` 与 `BYTEDCLI_DB_NO_AUTO_UPDATE=1`。其他操作将 DB override 指向已存在的不可执行 `/dev/null`，阻止 DB passthrough 的首次自动安装。此代码不安装、更新或调用真实 DB。

旧目录 `2026-11-26.1` 仅按冻结的历史 ID/effect 表迁移。v1 只接受该历史版本，仍拒绝 machine write；v2 接受当前目录或历史目录内原有规则，不接受任意版本。parser-issued policy 的 WeakSet 证明与冻结 authority 的机器写入守卫保留。

响应新增可选 `operationEffect`：新宿主输出已解析操作的实际效果，解析前错误和旧宿主可省略。客户端核对本地规范操作；未知效果值、unknown+machine、read+write_outcome_unknown 等组合拒绝。请求仍不能提交 effect/identity。客户端在丢失或不可信响应后，按本地 write/unknown 保守返回 write_outcome_unknown。

固定 Picko ES 分布查询与 GDPR realm、JWT 型 Skill 最终 API 已在 [受管 Skill 合同](bytedcli-managed-skill-api.md) 补充；其他 ES/DoAs 调用仍无机器条目，不能用其他 RPC 或 SQL 行代替。目录审核不等于真实服务权限已开通；没有执行真实业务/认证网络验证。

受管最终 API、场景完整预设与源码安装边界见 [受管 Skill 合同](bytedcli-managed-skill-api.md)。
