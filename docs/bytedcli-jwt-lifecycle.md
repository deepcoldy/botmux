# 按人 ByteCloud JWT 的区域与续期

开启 trigger-user-auth 后，daemon 从触发人的独立 HOME 获取默认及区域 JWT；这限定的是签票材料来源，不代表 bytedcli 命令内部所有请求都已消除宿主登录回落。包装器按规范 `--site value`、`--site=value` 或 `BYTEDCLI_CLOUD_SITE` 选择对应区域，原始参数保持不变；显式参数优先于环境变量。`i18n`/`i18n-bd` 选择 i18nbd，`i18n-tt`/EU 规范站点选择 i18n，US 规范站点选择 tx。区域材料不以内部变量名传给子进程；区域材料缺失时沿用默认 JWT，claim 不符的签票结果被丢弃。

普通轮次每次重新核验个人登录并取得默认 JWT。区域 JWT 可在剩余寿命超过 30 分钟时复用，退出登录后清空。mint、续期以及撤权重登后的请求共用按人串行队列，旧子进程结束前不释放其 HOME 的操作锁；撤权代次校验阻止旧请求结果重新发布或进入缓存。

本地 mint 且使用 proven 存储的轮次会被追踪。daemon 每 5 分钟检查一次，在最早到期的可选 ByteCloud JWT 剩余不足 40 分钟时续期。仍使用原凭据持有人、同一 session 和同一 turn；原生会话历史不会因此增加输入。平台签发材料和 single 存储不进入这个本地续期器。

续期前后均核对已发布材料与追踪项。取消、GC、拒绝发布或重新发布后的旧结果不能恢复、覆盖或删除新的身份；失败保留原材料并在后续 sweep 重试。重启不恢复旧追踪项，后续正常身份发布才重新建立追踪。这里延长的是访问 JWT，不延长用户的登录授权。

验证覆盖真实 shell 包装器的区域选择、按人隔离、撤权时晚到结果、撤权重登时同 HOME 串行、同轮追踪替换、旧 sweep 快照、周期重叠及 companion 写入失败后的恢复。故障注入用 provider 子进程替身与假时钟，不需要真实凭据。


签票和续期在接纳时同时固定进程内代次与持久 CLI auth epoch，排队前后及各 provider 等待点复核；另一个 daemon 撤权后即使已重新登录、HOME 新 stamp 有效，也不能使旧请求的结果恢复有效。区域缓存同样绑定持久 epoch，重新登录后的请求不能复用旧代次区域 JWT。

HOME 的撤权判定只以持久 epoch 与 `.botmux-auth-epoch` stamp 为权威，不保留进程内的撤权 HOME 标记。撤权必须先持久 bump，再执行 logout 与 HOME 删除；旧 SDK child 重建的无 stamp HOME 在 epoch ≥ 1 时仍拒绝。另一个 daemon 完成重登后，当前 stamp 允许所有 daemon 使用新登录，后续 begin 不会删除有效 HOME。升级前 epoch 0 的无 stamp HOME 继续保留。进程内 epoch、去重失效和队列仍用于拦截本进程已接纳的旧操作；它们不代替跨进程判定。

begin/complete 登录也与 mint/renew 共用本进程的按人 HOME 队列。撤权只失效去重记录，不提前释放仍在运行的 SDK 操作锁；新登录等旧 child 退出后清掉其晚到文件，再建立新 challenge。旧 complete 不得消费新 challenge，mint 内部的自动 complete 使用同一队列内的原语，避免重复入队自锁。该机制不声称实现了跨 daemon 的文件锁，跨进程 SDK 写入仍见下方后续边界。

## 已知边界与后续

bytedcli 0.178 的内部跨 site 子请求可能重新取 JWT（例如请求 `cn`）。`bytecloudJwtBelongsToOtherSite` 发现注入的环境 JWT 的 region claim 与该子请求 site 不符时，会跳过它，继续读取 pane HOME 中的登录/SDK 缓存。当前 HOME 未被本 PR 改写，因此这类子请求仍可能回落到操作者登录。跳过不匹配环境 token 的判定与 HOME 是否指向个人目录无关；改 HOME 只能改变回落目录，不能消除单个环境变量无法供给多个 site 的接口错配。

本 PR 收窄而未消除该既有通道：修复前，外层 site 与默认 JWT 分区不匹配时，外层调用便可能整体回落操作者；有匹配区域材料后，外层规范 site 选择的是触发人对应区域的 JWT，但命令内部跨 site 子请求的回落仍存在。没有区域材料时沿用默认 JWT 的兼容行为也不构成跨区域身份保证。

后续跟踪 [#2505](https://github.com/deepcoldy/botmux/issues/2505)：评估 0.178 `--bytecloud-user-jwt-file` / `resolveCliRequestJwtContext` 的 request-scoped 按站点供给方式。本期不钉 HOME；若后续采用个人 HOME，必须同时决定文件沙箱 bind（当前个人目录未 bind）和与 scratch-credentials 保密封禁的关系，并处理 pane 与多个 daemon 的 mint/renew 对同一 SDK 缓存写入的跨进程串行问题。当前按人队列仅限单 daemon，不是文件锁。

站点别名/大小写归一另跟踪 [#2506](https://github.com/deepcoldy/botmux/issues/2506)：当前 `row`、`usttp`、`I18N-TT` 等非规范写法仍选择默认 JWT，`us-ttpbd` 无效映射的清理也留在该项一并处理。回归明确分为规范站点分区对照和带 issue 的 known-gap 行为断言；Bun 1.4.3 不支持 `it.fails`，跨引擎用例不使用该语法。

真实跨区域服务请求尚未在本 PR 的验证中执行；shell 包装器选择和 region claim 故障注入通过不等同于真实跨站点主体已闭合。
