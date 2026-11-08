# 权限与授权

botmux 的权限只回答两个问题：

| 权限 | 意思 | 例子 |
|------|------|------|
| **对话权**（canTalk） | 能不能跟 bot 说话、让它干活 | @bot 提问、在话题里继续聊 |
| **操作权**（canOperate） | 能不能改动会话本身 | `/cd`、`/restart`、`/close`、点卡片上的管理按钮 |

大多数授权方式**只给对话权**。操作权默认只属于管理员（`allowedUsers`）。

## 最常用的操作

先看这张表，大部分需求在这里就能解决：

| 我想做什么 | 怎么做 |
|------------|--------|
| 让**整个群**都能问，不限条数 | 群里发 `@bot /grant`（或 `/grant all`）。收回发裸 `/revoke`。话题群对群内所有话题生效 |
| 只给**某几个人**开通，先试用几条 | `@bot /grant @张三 @李四`，bot 回一张授权卡，默认每人 3 条、1 小时 |
| 直接指定条数 | `@bot /grant @张三 20`，每人 20 条；有效期还在卡片上选 |
| 在卡片上细调 | 有效期五选一：**1 小时 / 8 小时 / 1 天 / 7 天 / 永久**；消息额度填 1–1000 的整数，**留空表示不限**。哪个先到就先收回 |
| 收回某人的授权 | `@bot /revoke @张三`（可一次 @ 多人）。会清掉 ta 的本群授权和全局授权；**如果 ta 还在管理员名单 `allowedUsers` 里，也会一起移除**，回执会写明撤了哪些范围。撤 owner 本人、或撤完 bot 就没有管理员了，会被拒绝 |
| 值班群即问即答、不用选仓库 | `/oncall bind ~/projects/foo`，见 [Oncall 模式](/oncall) |
| 在网页上批量授权 | Dashboard「群组管理」→ 该群「管理」→「成员权限」标签页，见下图 |

`/grant`、`/revoke` 只有 owner / 管理员能用。被授权的人（访客）只能对话。

![Dashboard 群组管理里的「成员权限」标签页](/img/permissions-group-member-access.png)

「成员权限」页可以：

- **授权所选**：多选成员（一次最多 50 人），可选消息额度和有效期。写入前会实时确认对方还在群里。
- **整群授权 / 取消整群授权**：等同于群里发裸 `/grant` / `/revoke`。
- **封禁 / 解封**：把某人加入或移出黑名单，见 [黑名单](#黑名单-blockedusers)。
- 授权是按「机器人视角」写的。群里有多个 bot 时，先在顶部「机器人视角」里选好是给哪个 bot 授权。

## 授权方式一览

从「只给几个人」到「谁都能用」，一共这几层：

| 方式 | 谁能用 | 范围 | 额度 / 有效期 | 操作权 | 怎么开 |
|------|--------|------|---------------|--------|--------|
| **管理员** `allowedUsers` | 名单里的人 | 这个 bot 的所有群和私聊 | 长期有效 | 对话 + 操作 | `botmux setup`、编辑 `bots.json`、`/botconfig set allowedUsers` |
| **本群访客** `chatGrants` | 被点名的人（真人或 bot） | 只在授权的那个群（话题群对全部话题生效） | 默认 3 条 / 1 小时，批准时可改 | 仅对话 | `@bot /grant @某人` 授权卡、Dashboard 成员权限；给群里的 bot 授权可用 [`botmux grant chat`](#grant-chat-cli) |
| **全局访客** `globalGrants` | 被点名的人 | 任意群 | 同上 | 仅对话 | owner 发起的授权卡上点「全局授权对话」 |
| **整群放开** `allowedChatGroups` | 群里**所有人**（退群自动失效，新人进群立即可用） | 一个群 | 不限额、不过期，直到收回 | 仅对话 | 群里裸 `/grant`、Dashboard「整群授权」 |
| **Oncall 群** | 群里所有人 | 一个群 | 永远放行、永远不限额 | 仅对话；新话题直接进绑定目录，不用选仓库 | `/oncall bind <目录>`、Dashboard oncall 开关 |
| **私聊全开** `p2pOpen` | 飞书应用「可用范围」内的所有人 | 只限私聊 | — | 仅对话 | Dashboard「Bot 配置」、`bots.json`、`/botconfig set p2pOpen on` |
| **开放模式** | **任何人** | 全部 | — | 对话 + 操作 | 以上名单**一个都没配**时的兜底状态，不建议长期这样用 |

补充说明：

- 正常 onboarding 创建的 bot 都会把 owner 写进 `allowedUsers`，所以默认是**限制态**：只有名单里的人能用。
- 只配了 `p2pOpen` 而没配管理员，也算限制态：群聊不会被放开，也没人能执行管理操作。
- 同团队的 bot 和平台团队成员另有信任规则，见 [角色与团队](/roles)。同一台机器上的 bot 见下文 [同机 Bot](#同机-bot管理命令与点名授权-trustsameownerbots)。
- 访客授权（本群 / 全局）和它们的额度、有效期存在本地授权库 `grants.sqlite` 里，不在 `bots.json`。过期的授权每小时自动清理一次。字段细节见 [bots.json 配置](/bots-json#权限与授权)。
- 会议助手另有一个默认关闭的「邀请人管理本场会议」开关（Dashboard「全局设置 → 会议监听 → 会议角色预设 → 按 Bot 的会议开关」）。它只让邀请人管理自己邀请的那场会议，不给 bot 的任何其它权限。

## 入群不等于授权

**把 bot 拉进一个群，不会自动给这个群开权限。**

- **限制态 bot**（配了 owner / 管理员名单，onboarding 创建的都是）：不在名单里的人 @ bot 会被**挡住**，bot 自动给 owner 发一张[授权申请卡](#授权申请卡)。owner 点一下批准，对方就能用了。
- **只有什么名单都没配的开放模式 bot** 才是谁都能用。这是兜底状态，跟「拉进群」无关。
- 「进群自动开工」（`autoStartOnGroupJoin`）也不是授权。它还有一道闸：群里至少要有一名管理员，bot 才会自动建会话。

想控制「谁能把 bot 拉进群」，要在飞书开放平台侧设置（应用可用范围、群添加权限）。

## 授权申请卡

限制态 bot 下，没有权限的人在群里明确 @ bot 时，bot 会自动给 owner 发一张申请卡：

- 卡上可以点「**授权本群对话**」或「**拒绝**」，额度和有效期在卡上直接改。
- owner 自己发 `@bot /grant @某人` 弹出的卡，还多一个「**全局授权对话**」按钮（任意群都能用）。
- 批准后，**触发申请的那条消息**会自动重新送进会话，对方不用再发一遍。
- daemon 重启后，还没处理的申请卡照样能点。
- 有效期或额度用完，授权自动收回。

申请人在等待期间又来找 bot 会怎样：

| 情况 | 申请人看到什么 |
|------|----------------|
| 卡片就回复在 ta 自己的消息下 | 不再额外回话，卡片本身就说明在等管理员。这期间发的新消息不会处理 |
| 卡片转去了 owner 私聊（见下） | 一句「还在等管理员确认」，同一张卡只提示一次。这条消息不处理，批准后请重新发 |
| 被拒绝后 10 分钟内 | 一句「没有通过」，同一次拒绝只提示一次。过了 10 分钟再找 bot，会重新发卡 |

几个特殊情况：

- **关掉自动发卡**：Dashboard「Bot 配置 → 授权与额度 → 未授权 @ 自动弹授权卡」（`autoGrantRequestCards`，默认开）。关掉后照样拦截，只是不发卡、不提示。
- **私聊被挡默认是静默的**：私聊里没有 owner，把卡回给陌生人既没法点、还会暴露 owner，所以不发。
- **被拉黑的人**不会触发申请卡。

### 申请卡转投 owner 私聊

开关是 `grantRequestToOwnerDm`，默认关闭。适合 owner 不想进群、或者经常有人私聊 bot 的场景。

打开后，当会话里**没有任何管理员能点卡**时，申请卡改发到主 owner 的私聊：

- 群里查不到管理员（比如关了「进群自动拉 owner」`autoInviteOwnerOnGroupAdd`，owner 不在群里），或者
- 私聊被挡。

具体行为：

- 申请人只收到一句中性回执，不会看到 owner 是谁。owner 批准或拒绝后，结果会回告到原会话。
- 额度用完后，对方再发消息会自动重新申请。
- 群里有管理员，或者查群成员失败，仍按原来的方式在群里发卡。
- 防刷屏：每个 owner 每小时最多收 20 张转投卡（发送失败不算）。超出或发送失败时这次不发卡，下一条消息再试。
- 群聊每次都要查一下群成员（缓存 60 秒）。应用缺群成员读取权限（`im:chat.members:read`），或群超过 2000 人拿不到完整名单时，按原来的方式在群里发卡。

开启方式：Dashboard「Bot 配置 → 授权与额度 → 申请卡转投 owner 私聊」、`bots.json`，或 `/botconfig set grantRequestToOwnerDm on`。

## 黑名单 `blockedUsers`

黑名单按**发送者**一票否决，在 Dashboard「Bot 配置」里维护，也可以在群组「成员权限」页直接点「封禁」。

- 群聊、私聊**都生效**。被拉黑的人在 oncall 群、整群放开的群、团队群里一样被挡，换个群也没用。
- 被拉黑的人被挡时**不会**给 owner 发申请卡，免得一直打扰。
- **owner / 管理员不能被拉黑**，写入时直接拒绝，防止把自己锁在外面。
- 黑名单只管对话权。[消息监听](/bots-json#message-listener)（让 bot 按规则自动盯消息）有自己的匹配范围，不受黑名单影响。

## 进阶：调整默认值和命令权限

| 想做什么 | 配置 | 在哪改 |
|----------|------|--------|
| 改授权卡的默认有效期 | `grantDefaultDurationMs`，可选 1 小时 / 8 小时 / 1 天 / 7 天，默认 1 小时 | Dashboard「Bot 配置 → 授权与额度 → 默认授权时长」 |
| 改授权卡的默认条数 | `messageQuota.defaultLimit`，1–1000，默认 3。只影响访客，oncall 群永远不限额；`/grant @某人 N` 照样用 N | 同上「消息额度覆盖」 |
| 访客只能聊天，不能用任何斜杠命令 | `restrictGrantCommands: true`。只约束靠本群 / 全局访客授权进来的人；owner、管理员、oncall 群、整群放开的成员不受影响 | 同上「限制被授权人只能纯对话」，或 `/botconfig set restrictGrantCommands on` |
| 让能对话的人也能用某些 botmux 命令 | `canTalkDaemonCommands`，例如 `/status /help`。只认 botmux 自己处理的命令，写错或透传命令会被忽略。`/cd`、`/restart` 这类会改状态的命令请谨慎放开 | Dashboard「Bot 配置 → Slash 命令 → canTalk 可用的 daemon 命令」，或 `/botconfig set canTalkDaemonCommands /status,/help` |

`/grant`、`/revoke` 不受 `canTalkDaemonCommands` 影响，始终只有管理员能用。

## 同机 Bot：管理命令与点名授权 `trustSameOwnerBots`

「同机 Bot」指同一台机器、同一份 `bots.json` 里的其它 bot。它们本来就能互相对话。如果对方 bot 的 **owner 和本 bot 是同一个人**，还多三项能力（默认开启）：

- **没认出也能对话**：本 bot 还没学到它的身份时，它的消息也直接放行、不弹授权卡。比如它在话题群里不 @ 直接发顶层消息，而本 bot 开了 `autoStartOnNewTopic`。因此 `botmux create-group` 建群时，同 owner 的同机 bot 之间不再写两两本群授权（owner 不同的照写）。
- **执行管理命令**：可以对本 bot 执行 `/cd`、`/repo`、`/restart`、`/close` 等管理命令，和跨部署的团队 bot 同权。`/botconfig`、`/dashboard`、`/term` 这类只认管理员名单的命令不受影响。
- **点名授权**：它在群里 @ 本 bot 时，同一条消息里被它 @ 的其他人自动获得**本群对话授权**，和 owner 在授权卡上点「授权本群对话」效果一样（只能对话，额度 / 有效期取授权卡默认值，`restrictGrantCommands` 照常生效）。结果卡回在那条消息下，@ 被授权的真人（被 @ 的其它 bot 只显示名字，不发通知）。已经能对话的人、@所有人、发送方自己和黑名单用户会跳过；只在群聊生效。

怎么判断：

- **是不是同机 Bot**：看飞书在消息上标注的 union_id，必须精确对上本机 `bots.json` 里唯一一个其它应用（`apiOnly` 除外），不看显示名。
- **是不是同一个 owner**：对方 bot 的**每个**管理员都必须也是本 bot 的管理员。对方多一个本 bot 不认的管理员就不算，否则那个人能借对方 bot 操作本 bot。两边管理员可以写成不同形式（邮箱、手机号、`on_`、`ou_`），会各自换成 union_id 再比；有管理员换不出 union_id（比如应用缺通讯录读取权限）也不算。改了管理员后约 30 秒内重新生效。
- 能驱动对方 bot 的人（它的访客、它 oncall 群里的人），也可能借它驱动本 bot。这是 bot 之间互信本身的性质；不接受就关掉开关。
- 一台机器托管多个人的 bot 时，owner 不同的同机 bot 仍然只能对话。

关闭方式：Dashboard「Bot 配置 → 授权与额度 → 信任同一 owner 的同机 Bot」、`bots.json` 写 `trustSameOwnerBots: false`，或 `/botconfig set trustSameOwnerBots off`。关闭后所有同机 bot 都只能对话（用 `/repo` 选仓库不受影响）。如果在已有群里关掉它，之前没被认出的那对 bot 没有历史本群授权可用，需要重新 `/grant`。

### @ 交接时带上发起人身份（`delegateOnMention`） {#delegate-on-mention}

上面的互信解决「同机 Bot 能不能互相操作」；这一项解决「交接过去以后用谁的身份干活」。

本 Bot 在**真人直接发起的一轮**里用 `botmux send --mention` 把活交给同一台机器上的另一个 Bot 时，对方调用 `lark-cli` / `bytedcli` 会以**这位发起人**的身份进行，而不是对方 Bot 自己或本机登录态。

- **默认开**，但只有发起方 Bot 自己开了[按触发人身份调用 CLI](/bots-json#trigger-user-auth)（`enabled` 为 `true` 且 `tools` 不为空）才生效：自己都不按发起人身份调用，就没有经过验证的发起人可以交出去。
- 接收方也要开按触发人身份调用 CLI，并且仍会校验这个人能不能和它对话、是不是在群里。
- 只在同机 Bot 之间生效，跨机器的 Bot 拿不到。`botmux dispatch` 派活不受这个开关影响，见[派活时用谁的身份](/multi-topic#进阶派活时用谁的身份)。
- 关闭：Dashboard「Bot 配置 → 权限与安全 → 按触发人鉴权」里取消「@ 同机 Bot 交接时带上发起人身份」，或在 `triggerUserAuth` 里加 `"delegateOnMention": false`。关掉后，@ 交接的那一轮对方没有可用的发起人。

## 委托授权 bot `grantDelegateBots`

这是同机 Bot 之外的**第二种委托来源**：owner 手动列出信任的外部 bot。两者互不影响。点名授权的效果和上一节完全一样，区别只在「谁算委托方」。

典型场景：外部平台用自己的 bot 建群，再发一张 @ 本 bot 的开场卡，卡里同时 @ 提需求的人。限制态下这个人接着 @ 本 bot 会被挡住，要等 owner 手动批准。把平台 bot 加进名单，这一步就省掉了。

- 名单里填受信 bot 的 open_id（本 bot 视角下的 `ou_…`）或 app_id（`cli_…`）。
- 名单里的 bot 在群里 **@ 本 bot** 时，同一条消息里被它 @ 的其他人自动获得**本群对话授权**：只能对话，额度 / 有效期取授权卡默认值，`restrictGrantCommands` 照常生效。
- 结果卡回在那条消息下，@ 被授权的真人（其它 bot 只显示名字，避免误唤醒）。
- 会跳过：已经能对话的人、发送方自己、@所有人、黑名单用户；私聊不触发。委托 bot 自己被拉黑时整条跳过。
- **信任边界**：这等于把「本群谁能和本 bot 对话」的点名权交给名单里的 bot。它不能给管理权，不能改 `allowedUsers` / `allowedChatGroups` / `globalGrants`，授权也只限它发消息的那个群。只放你完全信任的平台 bot。
- 默认是空名单，行为和不配一样。

配置方式：Dashboard「Bot 配置 → 授权与额度 → 委托授权的外部 Bot 名单」、`bots.json` 的 `grantDelegateBots`，或 `/botconfig set grantDelegateBots ou_xxx,cli_yyy`（`/botconfig unset grantDelegateBots` 清空）。

## 用命令给群里的 Bot 授权 `botmux grant chat` {#grant-chat-cli}

想在脚本里让某个 bot 在**某一个群**里能和本机 bot 对话，用 `botmux grant chat`。它只写本群访客授权（`chatGrants`），只给对话权。

```bash
# 推荐：用对方的 App ID，由接收方 bot 自己换成它视角下的 open_id
botmux grant chat --bot <接收方> --chat-id oc_xxx --subject-bot cli_xxx

# 已经知道接收方视角下的 open_id
botmux grant chat --bot <接收方> --chat-id oc_xxx --subject-open-id ou_xxx

# 收回
botmux grant chat revoke --bot <接收方> --chat-id oc_xxx --subject-open-id ou_xxx

# 查询是否已授权
botmux grant chat readback --bot <接收方> --chat-id oc_xxx --subject-open-id ou_xxx
```

| 参数 | 说明 |
|------|------|
| `--bot` | 接收方 bot，也就是授权后会接收对方消息的那个本机 bot。填完整 App ID、显示名或唯一的 cliId，有歧义会拒绝。它的 daemon 必须在线 |
| `--chat-id` | 群的 `oc_…` ID，只能传一个 |
| `--subject-bot` | 被授权 bot 的 App ID（`cli_…`），可重复。**只能用于授权** |
| `--subject-open-id` | 被授权 bot 在接收方视角下的 `ou_…`，可重复 |

使用要点：

- `--subject-bot` 和 `--subject-open-id` 只能二选一。一次最多 50 个。
- **授权**时会实时查一次群里的 bot 成员，每个对象都必须是当前在群里的 bot，有一个不在就整批拒绝，什么都不写。查询失败也直接拒绝，不用历史记录兜底。
- **收回**不查群成员，对方 bot 已经退群也能清掉旧授权。收回和查询只接受 `--subject-open-id`。
- **查询**只回答你问的那几个对象，不会列出全部授权。
- 用这条命令授权**不限条数、不过期**，直到收回。如果对方之前有额度或有效期，再授权一次会改成不限。
- 不会改 `allowedUsers`、`allowedChatGroups` 或团队信任，也不给 `/repo`、`/cd`、`/restart` 这类管理命令权。
- 要在跑 daemon 的那台机器上执行，命令会读取本机的 `.dashboard-secret` 去调用接收方 daemon。
- 成功时 stdout 输出一行 JSON；失败时 stderr 输出错误，退出码非零。

## 常见疑问

- **oncall 和裸 `/grant` 有什么区别？** 都只给对话权。oncall 还会把群绑定到一个工作目录，新话题跳过选仓库；`/grant` 只放开对话，不绑目录。
- **怎么只给某人 3 条？** `@bot /grant @某人` 弹出的卡默认就是 3 条 / 1 小时；也可以在命令后带数字，或在卡上改。
- **每个新成员都要 owner 批吗？** 不用。整群放开（裸 `/grant`）或 oncall 后，群里任何人都能直接用。想保留门槛才用逐人授权和申请卡。
- **被授权的人发了消息没反应？** 先看 ta 的额度或有效期是不是用完了；再看是不是开了 `restrictGrantCommands`，而 ta 发的是斜杠命令。

更多问答见 [FAQ / 排错](/faq)；什么时候必须 @ 机器人见 [@ 策略](/mention-mode)。
