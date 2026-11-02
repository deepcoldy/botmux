# 按人 ByteCloud JWT 的区域与续期

开启 trigger-user-auth 后，daemon 从触发人的独立 HOME 获取默认及区域 JWT；签票材料来自宿主按人登录目录，而包装器执行命令时使用会话 scratch 内的按人空 HOME；两者不共享 SDK 登录。包装器按规范 `--site value`、`--site=value` 或 `BYTEDCLI_CLOUD_SITE` 选择对应区域，原始参数保持不变；显式参数优先于环境变量。`i18n`/`i18n-bd` 选择 i18nbd，`i18n-tt`/EU 规范站点选择 i18n，US 规范站点选择 tx。区域材料不以内部变量名传给子进程；区域材料缺失时沿用默认 JWT，claim 不符的签票结果被丢弃。

普通轮次每次重新核验个人登录并取得默认 JWT。区域 JWT 可在剩余寿命超过 30 分钟时复用，退出登录后清空。mint、续期以及撤权重登后的请求共用按人串行队列，旧子进程结束前不释放其 HOME 的操作锁；撤权代次校验阻止旧请求结果重新发布或进入缓存。

本地 mint 且使用 proven 存储的轮次会被追踪。daemon 每 5 分钟检查一次，在最早到期的可选 ByteCloud JWT 剩余不足 40 分钟时续期。仍使用原凭据持有人、同一 session 和同一 turn；原生会话历史不会因此增加输入。平台签发材料和 single 存储不进入这个本地续期器。

续期前后均核对已发布材料与追踪项。取消、GC、拒绝发布或重新发布后的旧结果不能恢复、覆盖或删除新的身份；失败保留原材料并在后续 sweep 重试。重启不恢复旧追踪项，后续正常身份发布才重新建立追踪。这里延长的是访问 JWT，不延长用户的登录授权。

验证覆盖真实 shell 包装器的区域选择、按人隔离、撤权时晚到结果、撤权重登时同 HOME 串行、同轮追踪替换、旧 sweep 快照、周期重叠及 companion 写入失败后的恢复。故障注入用 provider 子进程替身与假时钟，不需要真实凭据。


签票和续期在接纳时同时固定进程内代次与持久 CLI auth epoch，排队前后及各 provider 等待点复核；另一个 daemon 撤权后即使已重新登录、HOME 新 stamp 有效，也不能使旧请求的结果恢复有效。区域缓存同样绑定持久 epoch，重新登录后的请求不能复用旧代次区域 JWT。

HOME 的撤权判定只以持久 epoch 与 `.botmux-auth-epoch` stamp 为权威，不保留进程内的撤权 HOME 标记。撤权必须先持久 bump，再执行 logout 与 HOME 删除；旧 SDK child 重建的无 stamp HOME 在 epoch ≥ 1 时仍拒绝。另一个 daemon 完成重登后，当前 stamp 允许所有 daemon 使用新登录，后续 begin 不会删除有效 HOME。升级前 epoch 0 的无 stamp HOME 继续保留。进程内 epoch、去重失效和队列仍用于拦截本进程已接纳的旧操作；它们不代替跨进程判定。

begin/complete 登录也与 mint/renew 共用本进程的按人 HOME 队列。撤权只失效去重记录，不提前释放仍在运行的 SDK 操作锁；新登录等旧 child 退出后清掉其晚到文件，再建立新 challenge。旧 complete 不得消费新 challenge，mint 内部的自动 complete 使用同一队列内的原语，避免重复入队自锁。该机制不声称实现了跨 daemon 的文件锁，跨进程 SDK 写入仍见下方后续边界。

## 已知边界与后续

bytedcli 0.178 的内部跨 site 子请求可能重新取 JWT（例如请求 `cn`）。`bytecloudJwtBelongsToOtherSite` 发现注入环境 JWT 的 region claim 不匹配时，会跳过它，再查执行 HOME 的登录/SDK 缓存。主干 #2550 已把受治理调用的 HOME 固定到会话 scratch 内的按人空目录，宿主按人登录目录不暴露给 pane。因此该子请求在没有适配的 SDK 登录时 fail-closed 拒绝，不能回落到操作者登录。外层规范 site 在有匹配区域材料时仍使用触发人的对应区域 JWT；没有区域材料时沿用默认 JWT，不构成跨区域身份保证。

#2550 消除了回落操作者登录的安全通道；跨 site 子请求的多站点 token 供给功能仍由 [#2505](https://github.com/deepcoldy/botmux/issues/2505) 跟踪，评估 0.178 `--bytecloud-user-jwt-file` / `resolveCliRequestJwtContext`。执行 HOME 并非宿主持久 per-person 登录目录，不与 daemon mint/renew 共写登录缓存。宿主多个 daemon 之间的 SDK 写入仍只由各进程的按人队列协调，尚未实现跨进程文件锁。

发布层统一通过 `publishedIdentityShape` 派生 HOME。续期前后使用同一派生形状与已发布 body 严格整串比较；任何凭据、执行人、turn 或 HOME 替换均使旧续期结果失效，不通过忽略字段放宽一致性。

站点别名/大小写归一另跟踪 [#2506](https://github.com/deepcoldy/botmux/issues/2506)：当前 `row`、`usttp`、`I18N-TT` 等非规范写法仍选择默认 JWT，`us-ttpbd` 无效映射的清理也留在该项一并处理。回归明确分为规范站点分区对照和带 issue 的 known-gap 行为断言；Bun 1.4.3 不支持 `it.fails`，跨引擎用例不使用该语法。

真实跨区域服务请求尚未在本 PR 的验证中执行；shell 包装器选择和 region claim 故障注入通过不等同于真实跨站点主体已闭合。
