# 决策看板 + 管家 Agent

> 2026-10-24 定稿（第 10 节各项按推荐执行）。用户文档见文档站「决策看板与管家」。

## 结论

- 看板挂在「管家 bot」名下，一个管家一张，存在整机一个 SQLite 里（按管家 bot 的 app_id 分区），只由管家 bot 的 daemon 写。
- 页面放进 Dashboard：`#/board` 是汇总页（待你拍板 / 进行中 / 全部），`#/board/<bot>/<编号>` 是详情页。权限沿用 Dashboard 登录，不另做一套。
- 每个事项一条链接：PC 用飞书 applink `web_url/open?mode=sidebar-semi` 在右侧栏打开，手机打开原链接。绑了平台的走 m-<machineId> + 飞书 SSO；开源部署走已有的 H5 免登，没配 H5 就是普通 Dashboard 登录。
- 草稿存在服务端、自动保存、不发出去。点一次「提交」生成一个批次，**马上**送进管家会话：一条消息、一个回合。管家空闲就立刻开始读；正在跑就排在当前回合后面。投递复用定时任务的回合投递路径。
- 这是通用功能：任何 botmux 用户都能把自己的一个 bot 设成管家，推进自己的开发任务。管家的活来自两处：owner 在管家群里交代的事，和 owner 提交的批次。**定时巡检不在本功能里**，是独立功能，后面单独做；想先用的话，现有定时任务就能配。
- 管家在 Bot 配置里开，每个 bot 默认关。可配：管家所在群、提示词（预置 + 追加或替换）。预置规则由 `botmux board guide` 按需输出；只在管家群里常驻一行提示（约 50 token），告诉它有看板、规则去哪读。
- 管家写看板用 `botmux board add/set/history/attach/list/show/pending/guide`。

## 1. 为什么不复用现有几个「板」

| 现有 | 是什么 | 为什么承载不了 |
|---|---|---|
| 会话看板（`#/sessions` 的看板视图） | 按会话分列 | 一件事横跨多个群和会话；会话关了，事可能还没完 |
| 白板（`botmux whiteboard`） | 按群/项目一份 markdown，给 agent 共享 | 没有逐项状态、决定和提交 |
| 平台 Issue Board | 团队任务队列，由 Desktop 领取 | 依赖平台 ByteDoc，开源部署没有；语义是「领活」，不是「owner 拍板」 |
| 项目群模式（`botmux project` + 置顶进度卡） | 一个普通群 = 一个项目，主控 bot 维护目标/阶段/阻塞，`dispatch` 派子话题、`report` 回报 | 范围是一个群里的一个项目；管家横跨很多已有的群和 PR，核心是「owner 拍板的队列」和「一次提交一批」，项目状态里没有选项、决定、附图 |

能复用的都复用：定时任务的回合投递（提交）、`botmux send`（推进）、`--attention=decision`（举手）、Dashboard 现有的图片校验、飞书侧栏 applink、平台 SSO 深链、H5 免登。

## 2. 数据模型

**位置**：`<dataDir>/decision-board.sqlite`，整机一个文件，每行带 `app_id`（管家 bot 的 larkAppId）。写法照 `grants.sqlite`：`openDatabaseSyncOrThrow`、WAL、`user_version`。附图放在 `<dataDir>/decision-board/<app_id>/files/<sha256>.<ext>`（权限 0600），不放进会被 14 天清理的 `attachments/`。**第一次开启管家时才创建**，没开的机器磁盘上不多任何东西。

**写入方**：只有管家 bot 的 daemon 写。Dashboard 走现有 `proxyToDaemon`，CLI 走带会话鉴权的 daemon IPC，沙箱会话也能用。

```
board_items      事项（主键 app_id + seq；seq 就是 #12）
  item_key         可选去重键，如 pr:deepcoldy/botmux#2195；add 遇到同 key 当作更新
  title            事项
  state            decide 待拍板 | accept 待验收 | active 进行中 | waiting 等待中 | done 已完成 | closed 已关闭
  stage            阶段，自由文本：在审 / 在修 / 在验证 / 可合 / 已合 / 等作者 / 等外部 …
  kind, repo       类型、仓库（自由文本）
  summary          一句话说明
  progress         当前进展（markdown）
  question         待拍板的问题（markdown）
  options_json     [{key:"A", label:"做法", effect:"结果和风险"}, …]
  recommend, recommend_reason   推荐项和理由
  rev              管家每改一次内容 +1（提交时用来提示「你写完草稿后管家又改过这项」）
  created_at / updated_at / state_at / steward_event_at / owner_seen_at
board_links      关联对象 (app_id, seq, kind, ref, label)
                   kind = pr | issue | chat | thread | session | commit | doc | url
board_events     历史，只追加：时间、actor（steward / owner / system，加会话 id 或提交人）、
                   kind（note / state / edit / decision / reply / attach / link / import）、text、data_json
board_files      附件元数据：sha256、mime、大小、上传方（owner / steward）、所属事项
board_drafts     草稿 (app_id, seq, author)：选项、文本、附件、base_rev、updated_at。Dashboard 固定写 author='owner'：
                   一张看板一份草稿，电脑上和飞书侧栏里看到的是同一份
board_batches    提交批次：编号、提交人、nonce（防重复点击）、投递状态 pending / delivered / failed、
                   落到哪个会话和回合、失败原因
board_decisions  批次里每项的决定：选项、文本、附件、提交时事项的 rev、handled_at（管家标记已执行的时间）
```

**状态对应**：旧表格的 11 个状态按下面映射——待你拍板 → decide；待你验收 → accept；在审 / 在修 / 在验证 / 可合 → active，原状态名写进阶段；等作者 / 等外部 → waiting，原状态名写进阶段；已合 / 已完成 → done（「已合」写进阶段）；已关闭 → closed。状态只决定页面分组，具体的流程词放在「阶段」里，botmux 不把 PR 流程写死。

**关联对象怎么显示**：pr / commit 按 GitHub 地址拼链接（不调 GitHub API）；chat 用 `chatAppLink` 打开群；thread 用 `threadAppLink` 打开话题；session 链到 Dashboard 会话页和 Web 终端；其它仓库或系统用 `url=`。

**隔离**：
- 一个管家 bot 一张看板，按 app_id 隔开。同一台机器上几个 owner 各开自己的管家 bot，就是几张看板，页面上可以切换。
- 能看、能提交的人 = 能登录这台 Dashboard 的人（第 10 节第 2 条定为 A；按管家 bot owner 的飞书身份隔离留作后续）。本机 token 登录的是 owner；平台 m- 入口进来的是机器 owner 和协管者，和「协管者与 owner 能力相同」的既有决定一致。这和今天能看会话的范围一样，不另做一套按人划分的权限。
- 只有管家 bot 自己的会话能写它的看板；别的 bot 调 `botmux board` 会报「本 Bot 未开启管家」。
- 提交人：本机登录记为该管家 bot 的 owner；平台登录记 actor 的 union_id 和名字。回合身份用管家 app 自己的 owner open_id，不跨应用复制 ou_。

## 3. 页面

汇总页：

```
决策看板 · 管家 Claude管家 ▾                          [提交 3 项决定]
[待你拍板 4]  [进行中 12]  [全部 57]        搜索…   仓库▾  类型▾
─────────────────────────────────────────────────────────────────
● #31 同机 bot 授信方式              待拍板·在审    botmux  2小时前  ✎草稿
     要你定：恢复同机 operate 还是只给 talk ｜ 推荐 A
  #30 kill 后探测统一入口            待验收         botmux  昨天
● #27 PR #2225 环境变量界面收紧      进行中·在验证  botmux  20分钟前
─────────────────────────────────────────────────────────────────
● = 你上次看过之后管家有新进展或新回复    ✎ = 你有没提交的草稿
```

- 待你拍板 = decide + accept，按进入该状态的时间排序。进行中 = active + waiting。全部视图可以筛出已完成和已关闭。
- 「提交 N 项决定」常驻在页头，没有草稿时置灰。

详情页（飞书侧栏宽 350–800px，按单列排版）：

```
← 决策看板                       #31 同机 bot 授信方式   待拍板·在审
PR #2195 ↗   评审群 ↗   管家会话 ↗   提交 236b328 ↗
一句话：同机兄弟 bot 的 operate 权限要不要恢复
当前进展（管家 10-24 11:20）
  ……（markdown）
要你定
  恢复同机 bot 的 operate 权限吗？
  ○ A（推荐）恢复，和点名授权合用一个「信任同机 Bot」开关，默认开 → ……
  ○ B 只信同 owner 的同机 bot → 要新增跨应用 owner 解析
  ○ C 维持现状，只做点名授权 → ……
  管家推荐 A：……
你的决定（自动存为草稿，点提交才发给管家）
  ┌───────────────────────────────────────────┐
  │ A，开关放 Bot 配置页                      │
  │ [截图1 ×] [截图2 ×]    粘贴或拖入图片     │
  └───────────────────────────────────────────┘
  ⚠ 你写草稿后管家改过这一项，提交前再看一眼
  [清空草稿]                     [提交（本项 + 另外 2 项草稿）]
历史
  10-24 11:20 管家  状态 在审 → 待拍板：……
  10-24 10:31 管家  已执行批次 #7：……
  10-24 10:05 你    决定（批次 #7）：先查删除原因  [附图]
  10-23 20:28 管家  创建
```

- 决定框 = 选项单选（可以不选，只写说明或提问）+ 文本 + 贴图。贴图复用 Dashboard 现有校验：png / jpg / gif / webp，验文件头，单张 10MB。
- 在框里提问，管家用 `history` 回答，一问一答按条进时间线，不再挤在一个格子里。有新回复时，汇总页那一行亮 ●。
- 有未保存的输入时离开页面，用现有的 leave-guard 提示。

## 4. 飞书内打开

**链接**：
- 目标 URL 是 `<Dashboard 对外基址>/board/<app_id>/<编号>`，**不带任何凭证**。基址复用 `buildDashboardUrls`：开了远程访问且绑了平台时是 `https://m-<machineId>.<平台域>`；否则依次是 `BOTMUX_PUBLIC_URL`、Devbox 短链、局域网 host:port。
- `/board/...` 是路径入口，Dashboard 收到后 302 到 `/#/board/...`（和 `/workbench` 的做法一样）。这个入口要在鉴权之前放行，它只做跳转，不返回数据。用路径而不用 `#`，是因为平台冷访问走 SSO 时只把 pathname + search 带进 `next`，`#` 后面的部分会丢。
- 在飞书里点开：PC 用 `https://<applink 域>/client/web_url/open?mode=sidebar-semi&width=800&min_width=350&max_width=1200&reload=false&url=<编码后的目标>`，在会话右侧栏打开，就是 Bits Flux「查看协作进度」那种效果。卡片按钮用 multi_url，手机端给原链接，因为手机不认 mode。applink 域按 bot 的 brand（feishu / larksuite）取，复用 `lark-hosts.ts`（看板用新的 `sidebarAppLink`；流式卡片终端按钮现有的 `sidebarUrl` 不动）。
- 平台前门用 **m-**，不用 t-：t- 只服务 `/s/*` 终端页，其它路径一律 403；m- 是 Dashboard 那一面，冷访问会自动走 `/open/<machineId>?next=…` → 飞书 OAuth（在飞书里基本无感）→ 回到原页。平台的 `safeProxyNextPath` 接受任意同源路径，平台仓库不用改。

**三种部署怎么登录**：

| 部署 | 在飞书侧栏点开后 |
|---|---|
| 绑定平台 + 开远程访问 | 走平台飞书 SSO，自动登录。只有机器 owner 和协管者进得去，其他人 403 |
| 开源，配了 H5 免登（`BOTMUX_DASHBOARD_FEISHU_H5_*`） | 跳到 `/auth/feishu?returnTo=/board/...` 做飞书免登，只放行名单里的 open_id。改动：`safeDashboardH5ReturnTo` 加上 `/board/`；H5 身份新增两项只作用于看板的能力（查看；写草稿和提交），其它能力不放开 |
| 开源，两样都没配 | 落到 Dashboard 登录页，粘一次 token，之后飞书 webview 会记住 cookie。Dashboard 只在内网时，只能在内网打开。也可以把同一链接放到浏览器里打开 |

链接里不放长期 token：管家会把链接发在群里，群里其他人点开要被挡在外面。

## 5. 提交流程

```
owner 改了 #31、#27、#12 → 每项草稿自动存进 board_drafts（不往外发任何东西）
点「提交 3 项决定」→ 确认框列出这 3 项（可以取消勾选某项，它继续留作草稿）
  POST /api/bots/<app>/board/submit {nonce, items:[{seq, draftUpdatedAt}]}
  daemon 在一个事务里：
    核对草稿没在别的标签页被改过 → 建批次 #8 → 每项写一条 board_decisions
    → 历史追加「你的决定（批次 #8）」→ 删掉草稿 → 提交事务
  事务完成后投递：
    拼一条消息 → 作为一个回合送进管家群的 chat 级会话
    管家正在跑：走现有排队，本轮结束后送达；会话已经没了：按定时任务同样的方式新建或恢复
    批次标为 delivered（记下会话和回合 id）或 failed（显示原因 + 「重新投递」按钮）
管家群里出一条「📥 决策看板：收到 3 项决定（批次 #8）」横幅，管家的回复接在后面
```

**投递怎么实现**：`deliverOwnerBatchTurn`（session-manager.ts）组合定时任务用的同一批底层原语——落点规则与定时任务的 chat 级顶层执行相同，会话在跑就 `sendWorkerInput`，挂起就冷启续接，没有就新建。没有直接复用 `executeScheduledTask`：它的尾段交织着定时任务专属状态（silent、task 位置的虚拟锚点与提升、deferredScheduleRun），看板批次一个都不需要，硬抽共用函数会把这些分支带进来，也会动到定时任务的稳定路径。
- 身份：批次按「owner 刚发的一条消息」处理（`trustedCaller.senderType='user'`，open_id 取管家 app 自己的 owner）。批次就是 owner 刚点的提交，不是定时触发，所以不新增 `TrustedCaller.source` 取值（那会牵动失败回合恢复、远端 runner 协议等几处按 source 分支的消费者）；回合 id 的 `board:<app>:<批次>:<uuid>` 前缀足以在审计里区分来源。不用 `/api/trigger`：它会把内容包成「不可信外部事件」，而且带不了图片。owner 的附图作为真正的图片附件随回合送进去（先拷一份到 `attachments/<app>/board-<批次号>/`，沙箱会话也能读到）。

**发给管家的消息**（示例，3 项大约 300 字）：

```
【决策看板 · 批次 #8】<提交人> 10-24 15:02 提交了 3 项决定。按 `botmux board guide` 里「执行决定」一节逐项执行，
每项做完运行 `botmux board history <编号> --handled "做了什么、结果"`。

#31 同机 bot 授信方式（待拍板·在审）
  选：A（管家推荐）
  说明：A，开关放 Bot 配置页
  附图：2 张（已随消息附上）
#27 PR #2225 环境变量界面收紧（进行中·在验证）
  选：未选
  说明：截图里第二行没对齐，修完再合
#12 ……
```

**兜底（不依赖巡检）**：
- 决定先落库再投递，消息丢了，决定也不会丢。批次表本身就是发件箱：投递失败的批次留在 failed，页面上能「重新投递」；daemon 重启后自动补投还没送达的批次。
- 重复点提交靠 nonce 去重。批次状态机为 `pending → dispatched → delivered`（+ `failed`）：
  调用 deliver() **之前**先落 dispatched 和稳定回合 id `board:<appId>:<batchId>`；deliver()
  成功返回后才落 delivered（worker 失败回执抢先到达时不覆盖，终态留 failed）。
- dispatched 是**结果未知态**不是成功态：它覆盖「横幅已发、worker 是否已收到无法确认」的整个
  deliver() 窗口。daemon 重启补投只对【本进程没有在途投递】的残留 dispatched 收敛——一律转
  `failed`（`delivery_interrupted`），页面显示「上次投递被中断，请重新投递」，由 owner 重投；
  绝不假设成功补登 delivered（那会变成「横幅说了收到、管家没拿到、看板显示成功」的静默丢消息）。
  本进程仍 in-flight 的 dispatched 由它自己的 deliver() 收敛，redeliver/补投/同 nonce 提交
  都直接返回当前批次、不二次投递。
- 重投沿用同一 turnId：worker 存活时 ordinary-turn 内存去重挡住二次执行（`board:` 与
  `om_`/`bmx-recovery-` 同属 `isOrdinaryImTurnId` 前缀族，worker 收到/提交去重、daemon
  投递追踪、冷启动 preload 补收据三处共用）。残留的 at-least-once 窗口只剩「进程死在
  deliver() 内部、worker 也已换过」，由批次号与管家的 `pending` / `history --handled` 台账兜底。
- 批次回合的投递终态失败（收据超时 / worker 拒绝入队）不往管家群发失败卡片：owner 在
  看板前而不是群里，daemon 经投递失败回调把批次退回 failed，页面显示原因并用同一 turnId 重投。
- `botmux board pending` 列出「已提交、管家还没标已执行」的决定，预置规则要求管家每次开工先看一眼。

**举手和提醒**：管家写进新的待拍板后，用现有的 `botmux send --attention=decision` 在管家群里说一声，Dashboard 的「需要你」会亮起。批次投递按 owner 本人的消息处理：投递成功后清掉该会话的决策举手，并按 `markSessionActivity(..., { human: !!ownerOpenId })` 刷新「人活动钟」（解析不到 owner 身份时不伪造 human 时间戳）。

## 6. 管家配置、预置提示词、CLI

**在哪开**：**Bot 配置 → 新分组「管家」**，放在「群负责人」旁边（同类开关放一起）。每个 bot 默认关；只要有一个 bot 开了，侧边栏才出现「决策看板」。分组里的字段：
- 设为管家：开关，默认关。
- 管家所在群：从这个 bot 所在的群里选，建议选「owner 1 人 + 管家」的群。owner 在这里交代任务，批次也送到这个群的 chat 级会话，始终是同一个会话。管家的记忆以看板为准，不靠对话，`/clear` 之后也不丢。
- 提示词：预置内容只读展示；下面是自定义文本框，方式二选一：「追加在预置后」或「替换预置」。
- 打开决策看板的入口。

这些存在 bots.json 的 `steward` 字段里：`{enabled, chatId, guideMode, guideText}`。等于默认值时不写盘。

**管家怎么知道规则**：
- 只在「管家 bot × 管家群」这一处常驻一行系统提示，照现有 `<project_group_mode>` 的做法（系统自带、只对指定群生效、和自定义角色并列）：
  `<botmux_steward>你是本群 owner 的管家，用 botmux board 维护决策看板；开工先跑 botmux board guide 读规则（预置 + owner 自定义）。</botmux_steward>`
  大约 50–80 token/轮。别的 bot、管家 bot 的其它群都不变。
- 规则正文由 `botmux board guide` 按需输出：预置 + 追加（或替换后的内容）。预置随 botmux 升级更新，用户的追加不丢。每次开工读一遍，约 1.5–2k token。
- 零注入的 bot 会跳过这行提示（零注入本来的语义）。批次消息自己带着「先跑 `botmux board guide`」，所以收批次照样能执行；owner 在群里交代任务时按零注入的惯例把话说全。
- 不用「角色」或内置 skill：角色只能整段替换、没有追加；内置 skill 的覆盖是整机的，不能按 bot；两者都会被零注入跳过。
- 预置文本编进代码常量。编译版单文件二进制里没有 dist 目录，不能按 `__dirname` 去读文件。

**预置提示词**（通用版，只列要点，正文实现时再写）：

```
你是 {owner} 的管家，帮 owner 推进他交代的开发任务。决策看板是你的台账，以看板为准，不靠对话记忆。

开工
- 先看 `botmux board pending`（已提交、还没执行完的决定），再看 `botmux board list`。

接任务（owner 在管家群里交代事情时）
- 每件要跟的事建一项：`botmux board add <标题> --key … --link …`（PR、群、会话、提交）。
  已经有的用 set 更新，不重复建。交代得不清楚的先在群里问清楚。

推进
- 默认用你自己的 bot 身份到相关群发消息推进（`botmux send --chat-id <群> --top-level --mention <bot>`）：
  一条只 @ 一个 bot，@ 放在句首；对方正在工作就先不发，记进历史；短时间内催过、没新进展的不重复催。
- 看现场：`botmux history --session-id <会话> --scope chat`，以及仓库自己的工具（gh 等）。
- 进展和卡点用 `botmux board set <编号> --state/--stage/--progress` 回写，一句话用 `--note` 进历史。
- 按「推进标准」判断哪些事能直接做。没写标准时只汇报和催办，不替 owner 合并、关闭、发版、部署、删除。

要 owner 拍板
- 不能自己定的、不可逆的、会推翻 owner 以前决定的，写成待拍板：
  `--state decide --ask … --option "A=做法 → 结果" --option "B=…" --recommend A --reason …`。
- 写完在管家群里用 `botmux send --attention=decision` 说一声，带上 `botmux board list` 给出的链接。

执行一批决定（收到「决策看板 · 批次」时）
- 逐项：先 `botmux board show <编号>` 看最新内容，再执行；做完 `botmux board history <编号> --handled "做了什么、结果"`，按需改状态。
- 看不懂或和现状冲突：不要猜，写 `--handled "要你再确认：…"`，状态改回 decide。
- 最后回一条汇总。

推进标准
（owner 在自定义里写，例如「合码按 <标准文件路径> 执行」）
```

**团队自己的自定义（追加）**示例：

```
推进标准：<团队合码标准文件路径>。
发消息改用 open-lark，以 owner 本人身份发，按团队操作手册的规则：读消息只用 GET、带署名、发之前先看目标 bot 的状态卡；
不用 botmux send / history。
```

这类团队专属内容只放在自定义里，不进 botmux 的预置。

**CLI**（风格和 `botmux send` / `botmux schedule` 一致：中文用法说明，位置参数 + `--flag 值`，默认输出给人看，`--json` 给程序用）：

```
botmux board list [--view decide|active|all] [--json]          # 每行：#31 待拍板·在审 标题 链接
botmux board show <编号|key> [--json]                           # 全部字段 + 关联对象 + 最近历史 + 未执行的决定
botmux board add <标题> [--key K] [--state S] [--stage 阶段] [--kind 类型] [--repo 仓库]
                 [--summary 一句话] [--progress 进展]
                 [--ask 问题 --option "A=做法 → 结果" ... --recommend A --reason 理由]
                 [--link pr=owner/repo#N | chat=oc_… | thread=om_… | session=<id> | commit=owner/repo@sha | url=…]...
                 [--note 一句话]                                 # 同 key 已存在时按 set 更新，并给出提示
botmux board set <编号|key> [字段同上] [--clear-ask] [--note 一句话]   # 改状态和字段会自动记进历史
botmux board history <编号|key> <一句话> [--handled]             # 追加历史；--handled 表示这项最近一批决定已执行
botmux board attach <编号|key> <图片>... [--note 说明]           # 附相关截图
botmux board pending [--json]                                    # 已提交、还没标记已执行的决定
botmux board guide                                               # 打印管家规则（预置 + 自定义）
```

这组命令只在管家 bot 的会话里能用，鉴权走现有的会话 IPC，沙箱会话里同样能用。

## 7. 迁移和默认开关

**迁移**：不在产品里做多维表格导入器——这张表只有我们一家在用，放进 core 违反合码标准 3.5。v1 部署后，让管家用现有工具一次性导入：用 board.py 读表，逐行执行 `botmux board add --key <原 record id>`。

| 表格字段 | 看板里对应 |
|---|---|
| 事项 / 类型 / 仓库 / 一句话说明 / 当前进展 | title / kind / repo / summary / progress |
| 状态 | state + stage（见第 2 节的状态对应） |
| PR 链接、评审群 | `--link pr=…`、`--link chat=…` |
| 待你拍板、我的推荐 | `--ask`，按 A/B 行拆成多个 `--option`；`--recommend` + `--reason` |
| 历史记录（一行一条） | 每行一条历史，保留原来的时间前缀，kind=import |
| 你的决定 | 记一条历史「（导入）你的决定：…」，不新建批次。导入前先让管家把表里已经填写的决定执行完 |
| 你的附图 / 相关截图 | `botmux board attach` |

导入完成后，表格留作只读归档，在表头注明一句「已迁走」。

**默认开关**：这个功能命中合码标准 3.2 (c)——管家会以自己的身份去别的群发消息、影响多 bot 协作、管家群多一行常驻提示——所以默认关，在 Dashboard 里配置。开启位置：Dashboard → Bot 配置 → 选中某个 bot → 「管家」→ 设为管家。没开启的部署：
- 磁盘上不多文件，SQLite 和附件目录在第一次开启时才建；
- 侧边栏没有「决策看板」；
- 所有 bot 的 prompt、skill、命令语义都不变；看板相关的文本只出现在管家群的那一行提示、批次消息和 `botmux board guide` 的输出里；
- 运行 `botmux board` 会报「本 Bot 未开启管家」。

## 8. 拆分

**v1**（一个 PR；评审量太大的话按 1+2、3+4 拆成两个）：
1. 存储 + daemon IPC + `botmux board` CLI + 预置 guide。
2. Dashboard 汇总页和详情页（草稿自动保存、贴图、时间线、关联链接），提交一批 + 投递（`deliverOwnerBatchTurn`）。
3. 飞书内打开：生成链接（PC 侧栏 applink + 手机原链接）、`/board/...` 路径入口、H5 免登白名单。
4. Bot 配置「管家」分组：开关、管家群、提示词追加或替换；管家群那一行常驻提示。

**v1 的验证**：
- 行为测试覆盖：存储、提交事务、投递幂等、CLI 参数解析、H5 能力、链接生成。
- Dashboard 截图，用合成数据。
- 投递函数用 mock 的 worker 池测「续接 / 新建 / 话题群落点 / 开场未完成时拒绝」四种情况；真实飞书链路（侧栏打开、管家群收到批次回合）需要在真机上体验。
- 飞书侧栏的真机体验要你来看。

**后续**：
- 定时巡检（独立功能）：按频率叫醒管家，扫 owner 名下未完成的会话和 PR，把要拍板的写进看板。在那之前，可以用现有定时任务手配一条，prompt 里写巡检要求即可，看板这边不用改。
- 和项目群模式打通：项目主控遇到要 owner 拍板的阻塞时写进管家看板，事项关联到项目群。
- 管家群里放一张就地更新的「看板摘要卡」（待拍板数 + 打开看板按钮），代替每轮的长汇报。
- 在卡片上直接点 A/B 写草稿（仍然要点提交）。
- 待拍板超过 N 小时就私聊或加急提醒（默认关）。
- 让别的 bot（PR 群里的开发 bot）也能往管家看板报「要拍板」。
- 关联对象自动刷新状态（PR 合没合、群里最后一条消息）。
- 清理已结束的事项，加附件配额。
- 和平台 Issue Board 关联。

## 9. 影响面

- **基本只新增**：新 SQLite 文件、新 IPC 路由、新 CLI 子命令、新 Dashboard 页、Bot 配置里的新分组。动到共用路径的只有两处：
  - session-manager 新增 `deliverOwnerBatchTurn`，只组合现有原语，定时任务路径不动。
- **跨 CLI**：管家只要求 shell 能跑 `botmux`，与 CLI 种类、是否零注入都无关。附图按普通图片附件送，和在飞书里发图一样。
- **跨后端、跨会话类型**：pty 和 tmux 没有差别。管家群用 chat 级会话，所有批次进同一个会话；选了话题群时，批次按普通群顶层消息的规则落点，配置页提示建议用普通群。
- **前提**：管家 bot 要在目标群里。目标 bot 要接受管家 bot 的消息：飞书侧要开「获取群组中其他机器人 @ 当前机器人的消息」权限，botmux 侧要给管家 bot 对话授权。
- **编译版**：预置文本编进代码，不拼 `__dirname` 路径。
- **平台**：不改平台仓库。

## 10. 拍板结果（2026-10-24，全部按 A）

1. **状态**：A（推荐）6 个固定状态 + 自由文本「阶段」，各人的流程词都放阶段里，botmux 不写死 PR 流程；B 把 11 个状态原样写进 botmux。
2. **看板谁能看、能提交**：A（推荐）v1 跟 Dashboard 一致，能登录这台 Dashboard 的人。各人在自己的部署上用不受影响；缺点是一台机器托管多人的 bot 时，bot 的 owner 不是这台机器的管理员就进不来，管理员能看到所有人的看板。B v1 就按「管家 bot 的 owner」的飞书身份放行（union_id 比对，做法同插件结果页的按人链接），托管场景下各看各的；要多做一套按人鉴权，信任面变大。
3. **迁移**：A（推荐）只迁未结束的 + 近 7 天内结束的；B 全量迁；C 不迁。
4. **开源部署的飞书免登**：A（推荐）v1 就让已有的 H5 免登支持看板页；B v1 只做平台 SSO，开源部署先手动登录。
5. **和项目群模式的关系**：A（推荐）分开做，后续让项目主控把要拍板的阻塞写进管家看板；B 把看板做成项目群模式的一部分（每个项目一张），管家就是项目主控。

参考：[飞书开放平台：在飞书内打开网页（web_url/open）](https://open.feishu.cn/document/common-capabilities/applink-protocol/supported-protocol/open-the-web-view-in-feishu-to-access-the-specified-url?lang=zh-CN)
