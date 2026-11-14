# 新会话的飞书工具身份

Botmux 支持将会话内的 `lark-cli` 绑定到当前 bot 配置中的 App ID 和品牌。该功能为**可配置项且默认开启**。可以通过 Dashboard（Bot Defaults → 隔离与权限 → lark-cli 应用绑定）或斜杠命令 `/config set larkToolBinding off` 关闭（需新建会话或 `/restart` 生效）。

- **开启/未配置（默认）**：会话内 `lark-cli` 默认以当前 Bot 的应用凭证以 bot 身份调用，支持 `--as user` 使用当前用户对同一应用的授权；若显式指定 `--profile <profile>`，自动透传按宿主机原生环境及对应 profile 执行，不拦截切换。
- **显式关闭（`larkToolBinding: false`）**：不安装托管绑定包装器，完全回落为宿主机原生环境；若同时开启了 `triggerUserAuth`，则遵循按触发人鉴权规则。

该绑定依赖支持 `LARKSUITE_CLI_TENANT_ACCESS_TOKEN` 的较新 lark-cli；请使用
`npm i -g @larksuite/cli@latest` 保持更新。旧版只识别 App Secret，无法使用
Botmux 提供的短期 bot token。

## 与按触发人鉴权（triggerUserAuth）的关系

`larkToolBinding` 与 `triggerUserAuth` 职责明确分立：

| `larkToolBinding` | `triggerUserAuth` | `lark-cli` 行为 |
|---|---|---|
| 开启（默认） | 关闭，或开启且含 `lark-user` | 默认使用当前 Bot 身份；`--as user` 使用当轮触发人授权；`--profile <other>` 透传宿主对应 profile |
| 开启（默认） | 显式写了 `capabilities` 且不含 `lark-user`（只写 `tools` 的旧配置不算，行为与上游一致） | 默认使用当前 Bot 身份；`--as user` 原生执行：使用这台机器自己的 lark-cli 配置和用户登录，botmux 不注入凭据、不发授权请求；每次调用会在 stderr 提示所用账号（取自 `lark-cli auth status --json`，取不到则不显示名字）（`botmux auth request` 对 lark-cli 返回 `lark_user_auth_disabled`） |
| 关闭 | 关闭（默认） | 沿用宿主机默认凭证及用户 profile 切换 |
| 关闭 | 开启（含 `lark-cli`） | 遵循按触发人鉴权（以当轮触发人身份运行，未授权直接拒绝并提示授权，不降级为机器账号） |

## 凭据来源：中心化平台（`triggerUserAuth.credentialSource`）

按触发人鉴权开启后，该人的凭据可以来自两处：本机的按人 HOME（扫码一次、只在本机有效），或**中心化平台**（在平台凭据页授权一次，平台保管刷新凭据并按轮次向绑定的机器签发短期票，所有机器通用、可集中查看与撤销）。`bots.json` 的 `triggerUserAuth.credentialSource` 决定取法：

| 机器状态 | `auto`（默认） | `platform` | `local` |
|---|---|---|---|
| 未绑定平台 | 等同今天的本机扫码 | 一律拒绝，提示执行 `botmux bind` | 等同今天 |
| 已绑定，平台签发成功 | 用平台短期票 | 用平台短期票 | 忽略平台，用本机 HOME |
| 已绑定，该人未在平台授权 | 本机已有 HOME 则用，否则拒绝；平台凭据页由 botmux 私发本人，拒绝文案不含链接 | 拒绝；平台凭据页由 botmux 私发本人 | 本机已有 HOME 则用，否则本机扫码 |
| 已绑定，平台不可达 | 本机已有 HOME 则用，否则按「暂时不可用」拒绝，不自动发起本机扫码 | 拒绝 | 不受影响 |

要点：
- **用谁的授权由 botmux 决定，模型只能在角色内选择。** daemon 从飞书事件的发送人解析 union_id 后向平台请求，CLI 侧没有任何参数能改变它；模型只能用 `--as user` / `--as bot` 这类角色开关切换，不能指名任何人。委派与定时任务用已验签的原请求人（定时任务若经认领卡片认领，则用认领人，见 execution-identity.md）。
- 平台只返回短期变量（lark 为 user_access_token + app id，bytedcli 为 cloud JWT + code JWT，以及请求里声明过的海外分区 cloud JWT，见 bytedcli-jwt-lifecycle.md「平台供票」），**永不返回刷新凭据**；返回的变量键按工具白名单校验，多余键一律拒绝。
- 已绑定的机器**不再自动发起本机扫码**：有人值守的回合里，受管命令因平台没有该人的授权被拒绝时（原因 `platform_not_authorized` / `platform_consent_missing`），包装脚本向 botmux 发 `botmux auth request --provider <bytedcli|lark-cli>`，botmux 把平台凭据页（飞书用户身份和 ByteCloud 共用一页）连同缺失的 Meego 登录链接合成**一条**消息发给本人：先私聊，私聊发不出去时在当前群里发一张仅本人可见的卡片；agent 只收到不含链接的状态（「已私发给本人，等 TA 授权后重试」），拒绝文案里也没有链接。同一链接 3 分钟内不重复发。绑定会话里 `--as user` 被拒绝、`botmux auth request --scope` 走平台时同样如此。`auto` 模式下显式的 `/login lark` / `/login bytedcli` 仍可走本机扫码作为兜底；`platform` 模式下它们也只给平台链接。
- **平台不会为这个人签发时**（`platform_not_teammate`：与机器所有者不同队；`platform_forbidden`：平台拒绝了本机的请求）：`auto` 模式下 botmux 改为私发本机的 ByteCloud 授权入口（和缺失的 Meego 链接同一条消息），并告诉 agent「平台不会为这位发起人签发，已改发本机授权入口」；`platform` 模式没有本机兜底，agent 得到的说明是需要机器所有者把这个人加入平台上的团队（或检查本机的平台绑定），不会发起任何授权。本机授权完成后，同一回合内可继续使用。
- 平台地址来自 `~/.botmux/platform.json`（`botmux bind` 写入），源码不含任何部署专属域名。
- **codebase-cli 随 bytedcli**：Codebase CLI 读的是 bytedcli 派生的 Codebase JWT（`CODEBASE_CLI_USER_JWT`），所以它不单独授权：bytedcli 的身份一发布，`codebase` 的身份文件与 wrapper 就一起生成；bytedcli 被拒或拿不到 Codebase JWT 时，`codebase` 同样被拒，不会退回机器自己的 Codebase 登录。平台凭据页上它显示为随 bytedcli 的状态。
- **能力开关（`triggerUserAuth.capabilities`）**：`lark-user`、`bytecloud`、`meego` 三项各自开关。`bytecloud` 覆盖 bytedcli、codebase、git push 与 bitscli / bits-cli（后两者读取同一份 ByteCloud 授权派生的 JWT，在按人 scratch HOME 下执行，不会读到机器上的登录文件）；`meego` 只覆盖 `bytedcli meego`，独立的 `meegle` 命令不受管。没开的能力保持原生：命令直接使用这台机器自己的登录态，botmux 不注入身份、不改 HOME。只开 `meego`（不开 `bytecloud`）时，`bytedcli meego` 使用本人的 Meego 登录，其余 bytedcli 子命令原生执行。未写 `capabilities` 时由 `tools` 推导（`lark-cli`→`lark-user`，`bytedcli`→`bytecloud`+`meego`）。绑定会话里 `--as user` 的归属见上表：`triggerUserAuth` 开启且不含 `lark-user` 时它原生执行。
- **无人值守的运行（定时任务、`execution background`、外部触发 `trg_`、工作流事件 `workflow-event:`）**：运行时不发起任何授权。创建定时任务时，任务执行人会私下收到一条授权入口，列出尚未授权的已开启能力（只读检查，不向平台申请授权。任务执行人就是创建任务那一轮的发起人时，读取该轮已发布的身份：已授权则不提示，明确未授权则附平台凭据页或设备码链接，平台故障或尚未发布则不提示；其他情况只检查本机登录，平台来源的凭据无法只读判断，不在此列）。运行时只取任务执行人已有的凭据；受管命令因凭据缺失被拒绝时以 77 退出，命令未执行，不发链接给 agent、不往群里发任何内容，同时由包装脚本向 botmux 发一次非交互请求（`botmux auth request --provider <bytedcli|lark-cli|meego> --unattended`），botmux 私聊本人一条通知，列出该人所有缺失能力的授权入口（平台已绑定时是平台凭据页，未绑定时是设备码链接）；同一任务同一人同一能力的同一链接只发一次，送达成功后才记录，设备码过期后下一次拒绝会发新链接，凭据恢复后重置；没有触及受管工具的运行不发任何通知。重新授权后任务会再次运行。私聊发不出去时（执行人不在 bot 的可用范围等），通知改为发一张仅本人可见的卡片，位置是任务所在的群；创建任务时的授权入口同样如此。两者都失败时记录日志，agent 看到的拒绝文案说明联系不上这位执行人、需要把 TA 加入本 bot 的可用范围，文案里没有链接。无人值守运行里的 `bytedcli auth login`、`bitscli ... auth login`、`meego login` 同样直接拒绝；只有 `auth login` 和 `meego login` 视为登录命令，`login` 作为其他参数（如 `codebase search login`）照常执行。带 `--session` 或 `--session-method` 的 `bytedcli auth login` 是浏览器会话登录（Meego GoAPI 需要的飞书网页会话），不是 ByteCloud 登录：有人值守时在本人的目录下运行真实命令，会话落在本人名下；无人值守时以 77 拒绝且不运行。这条命令仍要先取到本人的身份，没有 ByteCloud 授权的人会先收到 ByteCloud 授权入口，授权后再重试。
- 平台按「发送人与本机所有者至少同属一个团队」且「发送人已对该团队开启同意」签发；不满足时分别返回 `not_teammate` / `consent_missing`，botmux 原样告知发送人，不退回任何其他身份。
- **绑定会话（`larkToolBinding` 默认开启）里的 `--as user` 同样会用平台凭据。** 自建 bot 应用的可用范围通常只有所有者本人，别人打开该应用的授权链接只会看到「你没有使用权限」，所以对他们来说平台是唯一可用的来源。取法：
  - `auto`：该人已有对本 bot 应用的授权就用它（所有者保留 bot 应用更多的权限）；没有则向平台申请，lark-cli 的用户调用改用平台应用的 app id 执行；机器未绑定平台时与以前一致。
  - `platform`：只用平台凭据，不看对 bot 应用的授权。
  - `local`，或 `triggerUserAuth` 未覆盖 lark-cli：与以前一致，只用对 bot 应用的授权。
  - `--as bot` 始终是本 bot 应用，不受影响；只有 daemon 明确标注为平台签发的用户票，lark-cli 包装器才接受与绑定应用不同的 app id。
  - 这种情况下 `botmux auth request` 不再发 bot 应用的设备码链接，而是由 botmux 把平台凭据页（带上缺的权限）私发给本人，返回 `platform_authorization_required` 与不含链接的说明；平台应用缺某个权限时，需要先在平台应用后台开通，再让用户在平台重新授权。
  - 平台应用拿不到某些敏感权限（例如以用户身份读群聊/私聊消息，全员可见的应用通常批不下来）时，数据若在本 bot 能访问的群或文档里，提示会先引导模型对这次**读取**改用 `--as bot`，再考虑补权限；写操作不改用 bot 身份。执行者由模型在命令里显式选择，包装器不会自动换身份重试。

## 多人发言的回合：按调用选择身份（`BOTMUX_AS`）

多人话题里，后来者的消息可能并入正在运行的回合。daemon 为每个回合记录发言人集合（含第一位，每位发言人对应自己最近一条消息的身份材料）。**默认始终是发起本轮的人**（回合主体，回合开始时固定）：后来者并入不会改变默认，新的回合开始后以新回合的发送者为默认。发言人集合只用来校验显式的 `BOTMUX_AS`。

**默认关闭**：`triggerUserAuth.allowSpeakerSwitch`（Dashboard「多人话题里，允许替其他发言人执行单条命令」）为 `true` 时才启用；关闭时 `BOTMUX_AS` 在所有路由上以 `as_unavailable` 拒绝，提示词也不介绍发言人列表。开启跨身份打断隔离（XPI）时消息不会并入同一回合，Dashboard 里该开关不可用（已开启的可以关掉）；设置了「串行输入」的群里每条消息各自成回合，提示词同样不列发言人。开关关闭时的拒绝文案是「该 bot 不允许替其他发言人执行命令」，只让 agent 去掉 `BOTMUX_AS` 重试，不会让它去指定发言人。

**只对已开启能力的受管调用生效**：`--as user` 需要 `lark-user`；bytedcli、codebase、bitscli 需要 `bytecloud`。能力关闭（或没有 `triggerUserAuth`、`enabled: false`）时和上游一致：沿用回合的原主体，`BOTMUX_AS` 一律拒绝。仅开 `meego` 时 `bytedcli meego` 同样沿用回合主体。

- 要以本轮另一位发言人的身份做某一条命令，只在那一条命令前加 `BOTMUX_AS=<open_id> <命令>`（例如 `BOTMUX_AS=ou_x bytedcli codebase mr create ...`），只对这一次调用生效。daemon 只接受当前回合发言人集合里的 open_id，凭据按与发言人相同的方式（平台或本机）解析。
- 被选中的发言人缺凭据时，授权入口只私发给该发言人；后续的 `botmux auth request` / `botmux auth wait` 要带同一个 `BOTMUX_AS`，拒绝文案和提示词都会这样说明。
- 指定了发言人但该发言人那一轮的身份材料已不存在时，和不指定时一样返回 `identity_material_unavailable`（404）。
- 会话不会重启或拆分，其他调用不受影响。凭证提示块在多人发言时列出发言人姓名与 open_id。

`BOTMUX_AS` 指定了不在发言人集合里的人时原因为 `as_not_speaker`；能力关闭、无人值守或后台任务等没有可指定发言人的情形为 `as_unavailable`。以下情形无法按人选择，带 `BOTMUX_AS` 的调用以退出码 77 和一行原因拒绝：无人值守回合（没有发言人）、后台 `background:` 任务、委托（dispatch）回合、带 `--profile <其他应用>` 的 lark-cli 调用（用该 profile 自己的登录）、原生执行的调用（`lark-user` 关闭时的 `lark-cli --as user`，原生的 bytedcli / Meego），没有包装脚本的工具（能力关闭时它们不受管，看不到 `BOTMUX_AS`，也不会按它换身份），以及按单快照模式运行的会话（文件式包装脚本不逐次向 daemon 取身份，这类会话的提示词也不介绍 `BOTMUX_AS`）。

## 使用

```sh
# 默认使用当前机器人的应用身份
lark-cli docs +fetch --doc <文档链接>

# 需要个人资源或 bot 无权时，以当前用户身份调用
lark-cli docs +fetch --doc <文档链接> --as user
```

`--as bot` 固定使用本 bot 应用。`--as user` 改变执行者：通常仍是本 bot 应用，若该用户只有中心化平台授权（见上节），则以平台应用执行。尚未授权时，可以在当前会话发 `/login`，或由 agent 按操作申请权限：

```sh
botmux auth request --scope "docx:document:readonly" --json
botmux auth wait --request-id <返回的请求ID> --json
```

授权链接（设备码、OAuth 授权页）只发给发起人本人：谁打开谁确认，身份就授给谁。所以在群聊（含话题群）里，`/login` 的授权链接、`botmux auth request` 生成的链接都由 botmux 私聊发给本轮发起人，群里只回一句「已私聊你授权链接」，`auth request` 的结果里也不含 `authUrl`（返回 `delivery: "dm"`）；私聊发不出去时提示对方先私聊机器人发 `/login`，链接不会出现在群里。群聊里命令被拒时，拒绝文案也不再附设备码链接，而是提示发 `/login`。只有和发起人的单聊会直接回复链接。

bot 读取失败后，agent 可根据任务与错误尝试 user。包装器不会自动重放业务命令；写入超时或部分成功时，应先确认结果，避免重复创建或发送。

## 范围与生命周期

- 默认开启（未配置或显式开启）。已接入的会话恢复或重启时重新评估配置。
- 当关闭该配置并重启（`/restart`）或恢复时，自动清理会话目录下的 `lark-tool-binding.json`、`lark-config/` 及托管包装脚本 `binDir/lark-cli`，且不会误伤 `triggerUserAuth` 包装脚本（如 `bytedcli` 或 trigger-user `lark-cli`）或其它文件。
- 绑定入口与 `triggerUserAuth` 包装脚本共用同一个 `binDir`，绑定会话不论是否开启按触发人鉴权都会把它放到 PATH 最前面。因此 `triggerUserAuth` 关闭（或不再覆盖某个工具）时，该工具的 trigger-user 包装脚本必须移除，否则它会继续拦截调用，而 daemon 已不再发布身份，每次调用都被拒绝：worker 每次 spawn 时按当时的配置移除，只移除带 trigger-user 包装脚本标记的文件。与 `triggerUserAuth` 的「下个会话生效」一致，关闭或重新开启都只对之后 spawn 的 worker 生效（新会话、`/restart`、daemon 重启）；运行中的 worker 保持它启动时的包装，不在运行中删除，避免运行中再打开时包装已经不在、工具静默以本机登录态执行。
- 远端后端、adopt、外部 app-server、workflow 和无飞书通道的会话不使用应用绑定。
- Linux 本机受管会话的 user 调用须通过当前执行的进程证明，覆盖标准 PTY/Tmux 与托管 RPC（如 Codex）。macOS 保留应用绑定和当前用户解析，不提供旧后台进程跨轮隔离保证。

## 实现

新会话启动时生成自己的工具入口和配置，记录当前 App ID、品牌与真实 lark-cli 路径。botmux 用已有执行权威确定当前请求者，并查询该用户在同一应用下的授权。会话入口的访问密钥绑定应用；Linux user 调用同时复用 `execution current` 的 socket 进程血缘检查，并在异步取得 token 后复核 turn、attempt 和 worker generation 等执行状态。旧轮后台进程及其新建子进程无法取得新轮用户凭证。机器触发的执行可在没有真人 actor 时使用该轮明确许可的工具委托身份。

工具启动前清除继承的旧应用/用户凭证变量，再注入本次 App ID、品牌及 bot 或 user 凭证。用户 token 不得跨应用使用，未知用户不会借用 owner 或机器默认账户。CLI 原有 stdout、stderr、退出码和工作目录保持。

bot 调用从当前应用的 SDK 获取 tenant access token，复用其缓存和到期刷新，再通过 `LARKSUITE_CLI_TENANT_ACCESS_TOKEN` 交给工具；不向工具传递 App Secret，也不在会话启动时固定 token。凭证获取失败时拒绝执行。

工具路径按合并后的 bot `env.PATH` 解析。参数取值类型和 `--as` 支持情况取自该 lark-cli 二进制的本地 `--help`，包括快捷命令和原生 API 命令；无法识别的参数在执行前报错，不能靠猜测删除业务参数。若显式指定 `--profile <profile>` 且 profile 不等于当前 Bot 的 App ID，则直接透传宿主原生环境和对应 profile 执行（使用宿主环境，不受当前 bot 凭证及按触发人鉴权约束）；若等于当前 Bot 的 App ID，则归一化为托管 Bot 身份。`event list/schema`、`doctor --offline` 等本地命令不取凭证，也不追加 `--as`。

绑定入口、配置和 shell 启动路径使用真实目录路径。Linux 文件沙箱同时保留会话入口和 bot PATH，直接执行、sh、bash 以及通过符号链接配置的数据根使用同一绑定。

已有 signed dispatch 验证通过的跨机器人任务保留其原请求者：新入口按原 turn 使用已验证的目标应用用户和工具许可，再查询目标应用自己的用户授权。缺少用户授权时，目标 Agent 可用 `botmux auth request --scope "<本次所需权限>" --json` 为原请求者申请目标应用的授权，并在任务话题将链接提供给该真人；授权后用 `auth wait` 确认，再以 `--as user` 重试原操作。不会把来源应用的 token 用于目标应用，也不要求派发机器人授权。目标访问/工具许可被拒、授权失败或撤销时沿原任务回报阻塞；后续普通消息不继承该委派。授权等待期间切换到另一位真人时，原请求不能用于该人的回合。

该功能解决标准新会话默认身份不明确的问题。文件沙箱、既有访问控制和独立 MCP 的凭证规则仍按原有机制运行。

## 验证

覆盖新/旧会话分流、同应用 bot/user、Feishu/Lark 品牌、缺少授权、参数冲突、macOS 无进程校验依赖、真实 runner 与 worker、登录 shell 和编译态入口。真实资源访问仍取决于应用 scope、用户授权及资源共享权限。
