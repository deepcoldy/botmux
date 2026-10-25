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
| 开启（默认） | 任意 | 默认使用当前 Bot 身份；`--as user` 使用当轮触发人授权；`--profile <other>` 透传宿主对应 profile |
| 关闭 | 关闭（默认） | 沿用宿主机默认凭证及用户 profile 切换 |
| 关闭 | 开启（含 `lark-cli`） | 遵循按触发人鉴权（以当轮触发人身份运行，未授权直接拒绝并提示授权，不降级为机器账号） |

## 凭据来源：中心化平台（`triggerUserAuth.credentialSource`）

按触发人鉴权开启后，该人的凭据可以来自两处：本机的按人 HOME（扫码一次、只在本机有效），或**中心化平台**（在平台凭据页授权一次，平台保管刷新凭据并按轮次向绑定的机器签发短期票，所有机器通用、可集中查看与撤销）。`bots.json` 的 `triggerUserAuth.credentialSource` 决定取法：

| 机器状态 | `auto`（默认） | `platform` | `local` |
|---|---|---|---|
| 未绑定平台 | 等同今天的本机扫码 | 一律拒绝，提示执行 `botmux bind` | 等同今天 |
| 已绑定，平台签发成功 | 用平台短期票 | 用平台短期票 | 忽略平台，用本机 HOME |
| 已绑定，该人未在平台授权 | 本机已有 HOME 则用，否则拒绝并附平台凭据页链接 | 拒绝并附平台链接 | 本机已有 HOME 则用，否则本机扫码 |
| 已绑定，平台不可达 | 本机已有 HOME 则用，否则按「暂时不可用」拒绝，不自动发起本机扫码 | 拒绝 | 不受影响 |

要点：
- **用谁的授权由 botmux 决定，模型只能在角色内选择。** daemon 从飞书事件的发送人解析 union_id 后向平台请求，CLI 侧没有任何参数能改变它；模型只能用 `--as user` / `--as bot` 这类角色开关切换，不能指名任何人。委派与定时任务用已验签的原请求人。
- 平台只返回短期变量（lark 为 user_access_token + app id，bytedcli 为 cloud JWT + code JWT），**永不返回刷新凭据**；返回的变量键按工具白名单校验，多余键一律拒绝。
- 已绑定的机器**不再自动发起本机扫码**：拒绝消息直接给平台凭据页链接。`auto` 模式下显式的 `/login lark` / `/login bytedcli` 仍可走本机扫码作为兜底；`platform` 模式下它们也只给平台链接。
- 平台地址来自 `~/.botmux/platform.json`（`botmux bind` 写入），源码不含任何部署专属域名。
- **codebase-cli 随 bytedcli**：Codebase CLI 读的是 bytedcli 派生的 Codebase JWT（`CODEBASE_CLI_USER_JWT`），所以它不单独授权：bytedcli 的身份一发布，`codebase` 的身份文件与 wrapper 就一起生成；bytedcli 被拒或拿不到 Codebase JWT 时，`codebase` 同样被拒，不会退回机器自己的 Codebase 登录。平台凭据页上它显示为随 bytedcli 的状态。
- 平台按「发送人与本机所有者至少同属一个团队」且「发送人已对该团队开启同意」签发；不满足时分别返回 `not_teammate` / `consent_missing`，botmux 原样告知发送人，不退回任何其他身份。
- **绑定会话（`larkToolBinding` 默认开启）里的 `--as user` 同样会用平台凭据。** 自建 bot 应用的可用范围通常只有所有者本人，别人打开该应用的授权链接只会看到「你没有使用权限」，所以对他们来说平台是唯一可用的来源。取法：
  - `auto`：该人已有对本 bot 应用的授权就用它（所有者保留 bot 应用更多的权限）；没有则向平台申请，lark-cli 的用户调用改用平台应用的 app id 执行；机器未绑定平台时与以前一致。
  - `platform`：只用平台凭据，不看对 bot 应用的授权。
  - `local`，或 `triggerUserAuth` 未覆盖 lark-cli：与以前一致，只用对 bot 应用的授权。
  - `--as bot` 始终是本 bot 应用，不受影响；只有 daemon 明确标注为平台签发的用户票，lark-cli 包装器才接受与绑定应用不同的 app id。
  - 这种情况下 `botmux auth request` 不再发 bot 应用的设备码链接，而是返回 `platform_authorization_required` 与平台凭据页地址；平台应用缺某个权限时，需要先在平台应用后台开通，再让用户在平台重新授权。
  - 平台应用拿不到某些敏感权限（例如以用户身份读群聊/私聊消息，全员可见的应用通常批不下来）时，数据若在本 bot 能访问的群或文档里，提示会先引导模型对这次**读取**改用 `--as bot`，再考虑补权限；写操作不改用 bot 身份。执行者由模型在命令里显式选择，包装器不会自动换身份重试。

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

bot 读取失败后，agent 可根据任务与错误尝试 user。包装器不会自动重放业务命令；写入超时或部分成功时，应先确认结果，避免重复创建或发送。

## 范围与生命周期

- 默认开启（未配置或显式开启）。已接入的会话恢复或重启时重新评估配置。
- 当关闭该配置并重启（`/restart`）或恢复时，自动清理会话目录下的 `lark-tool-binding.json`、`lark-config/` 及托管包装脚本 `binDir/lark-cli`，且不会误伤 `triggerUserAuth` 包装脚本（如 `bytedcli` 或 trigger-user `lark-cli`）或其它文件。
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
