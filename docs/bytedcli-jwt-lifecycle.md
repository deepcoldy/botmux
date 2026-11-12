# 按人 ByteCloud JWT 的区域与续期

开启 trigger-user-auth 后，daemon 从触发人的独立 HOME 获取默认及区域 JWT；签票材料来自宿主按人登录目录，而包装器执行命令时使用会话 scratch 内的按人空 HOME；两者不共享 SDK 登录。包装器按 bytedcli 0.191 的读法认站点并选择对应区域，原始参数保持不变：`--site value` / `--site=value` 与等价写法 `--cloud-site`（最后一个生效），显式参数优先于 `BYTEDCLI_CLOUD_SITE`，但空的 `--site` 视为未给、由环境变量决定；取值两端的空白（含 JS `trim()` 会去掉的 Unicode 空白）被去掉后再大小写不敏感匹配。`i18n`/`i18n-bd` 选择 i18nbd，`i18n-tt`/EU 规范站点选择 i18n，US 规范站点选择 tx。区域材料不以内部变量名传给子进程；claim 不符的签票结果被丢弃。

**全局站点**所在区域没有材料时，包装器**拒绝执行**（退出码 77），stderr 写明站点、所属分区和 `[reason=regional_jwt_missing]`，不会拿默认（cn）JWT 去请求该分区：分区服务对它只会回 401（使用者看到的是「用户未登录」），或者 bytedcli 因 region claim 不符跳过它、再去会话 scratch 内没有登录的按人 HOME 找，同样失败，而且掩盖了真正缺的是哪个分区的票。拒绝文案按区域材料的来源给出原因：本机签票没签到（发起人登录可能没有该分区权限，或这次签票失败）、平台没签出、或绑定的平台尚不签发分区票（需升级平台）。不涉及区域的站点（默认、`cn`、`boe` 等）照旧用默认 JWT。不会把该分区 ByteCloud JWT 发出去的调用也照常执行、不因缺票被拒：帮助与版本输出（`--help` 任意位置、命令前的 `-h` / `--version` / `-V`、没有命令）、`codebase`（用 Codebase JWT）、`meego`（用本人的 Meego 登录）——否则会话级设了海外 `BYTEDCLI_CLOUD_SITE` 时，缺票的人连这些命令都用不了。命令按 bytedcli 的 `getFirstCommandArgIndex` 找（跳过带值的根选项）；认不出的一律按需要分区票处理。

全局站点是 bytedcli 实际鉴权用的站点：命令前（同样按 `getFirstCommandArgIndex` 划界）最后一个 `--site` / `--cloud-site`，没有或为空时取 `BYTEDCLI_CLOUD_SITE`。bytedcli 开了 positional options，命令后的 `--site` 属于该子命令自己，含义因命令而异（例如 `bytecloud list-legacy-vregions --site i18n` 是在 cn 上按站点过滤），所以它不触发缺票拒绝，这类调用照旧带默认 JWT 执行；命令自己加的 `--site` 也不能盖掉全局站点的拒绝（`--site i18n-tt <cmd> --site i18n` 按 i18n-tt 判定并点名 i18n 分区）。换哪张票仍按上面「最后一个 `--site`、不分位置」的规则，保持 #2472 的行为：像 nac 这样用自己的 `--site` 决定鉴权站点的命令，持票时照旧拿到对应分区的票。

### 平台供票

机器绑定平台后，bytedcli 的 grant 请求体带 `cloudJwtRegions: ["i18n","i18nbd","tx"]`，声明本 daemon 能消费的分区。支持分区票的平台在同一次 grant 里、用同一人（同一 union_id）的同一份授权归档签出各分区的票，放在 `variables` 的 `BYTEDCLI_USER_CLOUD_JWT_I18N` / `_I18NBD` / `_TX`（签到才有），并在响应顶层回 `cloudJwtRegions` 表示实际尝试过的分区。daemon 只接受 region claim 与所在分区一致的票，发布方式与本机签的区域票相同；团队、同意、审计检查与默认票完全共用，不新增信任面。

兼容：分区变量必须由请求声明后才能下发——旧版 daemon 的 grant 白名单遇到任何未知变量会把整张 grant 判为无效，等于让该人失去 bytedcli 授权。旧版平台只读自己认识的请求字段，照旧只回默认票；daemon 收不到 `cloudJwtRegions` 回执，就把缺票原因写成「绑定的平台尚不签发分区票」。平台签发的材料不进入本地续期器（见下）。

普通轮次每次重新核验个人登录并取得默认 JWT。区域 JWT 可在剩余寿命超过 30 分钟时复用，退出登录后清空。mint、续期以及撤权重登后的请求共用按人串行队列，旧子进程结束前不释放其 HOME 的操作锁；撤权代次校验阻止旧请求结果重新发布或进入缓存。

本地 mint 且使用 proven 存储的轮次会被追踪。daemon 每 5 分钟检查一次，在最早到期的可选 ByteCloud JWT 剩余不足 40 分钟时续期。仍使用原凭据持有人、同一 session 和同一 turn；原生会话历史不会因此增加输入。平台签发材料和 single 存储不进入这个本地续期器。

已登记后台 job 的 `background:<jobId>` 缓存不进入普通轮次续期器。它必须由后台取票入口在每次调用前后核验任务、租期、进程根和撤权代次，再按需签票；普通 timer 不能在任务退役后重建其 HOME 或刷新旧 cache。

续期前后均核对已发布材料与追踪项。取消、GC、拒绝发布或重新发布后的旧结果不能恢复、覆盖或删除新的身份；失败保留原材料并在后续 sweep 重试。重启不恢复旧追踪项，后续正常身份发布才重新建立追踪。这里延长的是访问 JWT，不延长用户的登录授权。

验证覆盖真实 shell 包装器的区域选择、按人隔离、撤权时晚到结果、撤权重登时同 HOME 串行、同轮追踪替换、旧 sweep 快照、周期重叠及 companion 写入失败后的恢复。故障注入用 provider 子进程替身与假时钟，不需要真实凭据。


签票和续期在接纳时同时固定进程内代次与持久 CLI auth epoch，排队前后及各 provider 等待点复核；另一个 daemon 撤权后即使已重新登录、HOME 新 stamp 有效，也不能使旧请求的结果恢复有效。区域缓存同样绑定持久 epoch，重新登录后的请求不能复用旧代次区域 JWT。

HOME 的撤权判定只以持久 epoch 与 `.botmux-auth-epoch` stamp 为权威，不保留进程内的撤权 HOME 标记。撤权必须先持久 bump，再执行 logout 与 HOME 删除；旧 SDK child 重建的无 stamp HOME 在 epoch ≥ 1 时仍拒绝。另一个 daemon 完成重登后，当前 stamp 允许所有 daemon 使用新登录，后续 begin 不会删除有效 HOME。升级前 epoch 0 的无 stamp HOME 继续保留。进程内 epoch、去重失效和队列仍用于拦截本进程已接纳的旧操作；它们不代替跨进程判定。

begin/complete 登录也与 mint/renew 共用本进程的按人 HOME 队列。撤权只失效去重记录，不提前释放仍在运行的 SDK 操作锁；新登录等旧 child 退出后清掉其晚到文件，再建立新 challenge。旧 complete 不得消费新 challenge，mint 内部的自动 complete 使用同一队列内的原语，避免重复入队自锁。该机制不声称实现了跨 daemon 的文件锁，跨进程 SDK 写入仍见下方后续边界。

## 已知边界与后续

bytedcli 0.178 的内部跨 site 子请求可能重新取 JWT（例如请求 `cn`）。`bytecloudJwtBelongsToOtherSite` 发现注入环境 JWT 的 region claim 不匹配时，会跳过它，再查执行 HOME 的登录/SDK 缓存。主干 #2550 已把受治理调用的 HOME 固定到会话 scratch 内的按人空目录，宿主按人登录目录不暴露给 pane。因此该子请求在没有适配的 SDK 登录时 fail-closed 拒绝，不能回落到操作者登录。外层规范 site 在有匹配区域材料时仍使用触发人的对应区域 JWT；全局站点没有区域材料时由包装器拒绝（见上），不再回落默认 JWT；只有命令后的子命令 `--site` 指向缺票分区时沿用默认 JWT（那不是 bytedcli 的鉴权站点）。

#2550 消除了回落操作者登录的安全通道；跨 site 子请求的多站点 token 供给功能仍由 [#2505](https://github.com/deepcoldy/botmux/issues/2505) 跟踪，评估 0.178 `--bytecloud-user-jwt-file` / `resolveCliRequestJwtContext`。执行 HOME 并非宿主持久 per-person 登录目录，不与 daemon mint/renew 共写登录缓存。宿主多个 daemon 之间的 SDK 写入仍只由各进程的按人队列协调，尚未实现跨进程文件锁。

发布层统一通过 `publishedIdentityShape` 派生 HOME。续期前后使用同一派生形状与已发布 body 严格整串比较；任何凭据、执行人、turn 或 HOME 替换均使旧续期结果失效，不通过忽略字段放宽一致性。

站点别名/大小写/首尾空白归一已随 [#2506](https://github.com/deepcoldy/botmux/issues/2506) 落地：包装器照抄 bytedcli 0.173–0.187 的 `CLOUD_SITE_ALIAS_MAP`，匹配前用 POSIX 参数展开 trim，case 模式按大小写不敏感生成，与上游 `normalizeCloudSiteSelection`（trim → 小写 → 别名表）对齐；别名指向无区域 token 的 cn/boe 时仍走默认 token。`us-ttpbd` 不是通用站点（`normalizeCloudSiteSelection` 对它返回 null，只有 bmq / apm argos log / cloud-ticket 接受），三处上游都按 i18n-bd 分区取 JWT（`bmqCredentialSite`、streamlog `authSite`、cloud-ticket `jwt_site` 均为 `"i18n-bd"`），包装器据此把它从 tx 组移到 i18nbd 组而非删除。回归分规范站点分区对照与别名/大小写/空白行为断言两层；Bun 1.4.3 不支持 `it.fails`，跨引擎用例不使用该语法。

真实跨区域服务请求尚未在本 PR 的验证中执行；shell 包装器选择和 region claim 故障注入通过不等同于真实跨站点主体已闭合。
