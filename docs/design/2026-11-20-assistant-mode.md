# botmux 个人助理模式（`assistantMode: true`）设计 v3

- 作者：Beta　日期：2026-11-20　状态：**待王旭裁决**（§9）
- 已定：按人分（同一人多个话题共用记忆）；共享知识只由管理员维护；**不支持角色系统**；**v3（王旭 11-20 提）：bot 整体配置成个人助理，每个会话归属一个人——私聊归发消息的人，群归把 bot 拉进群的人**
- 代码基线：`~/beta/botmux` @ `b4d795e50`（dev-beta 运行版），行号以它为准
- v1（角色系统支持）、v2（私聊/群分叉 + 单人群成员计数）已作废

## 1. 目标与非目标

**目标**：bot 开了全员可私聊（`p2pOpen`）后，用户 A 在私聊里说的、上传的、让 bot 生成的、bot 记住的东西，用户 B 在自己的私聊里拿不到——不能靠"问 bot"拿到，也不能靠让 bot 读文件、调飞书接口拿到。

**非目标**：
- 不防运营方：宿主机管理员、dashboard、daemon 日志、web 终端、Claude 账号侧仍看得到一切。
- 不改群聊：群本来就是群成员共享的。
- 不做跨私聊协作（让 bot 把 A 的事转告 B）。
- 私聊里不提供角色系统：没有「切换 / 新建角色」「沉淀知识」，人设全员同一个模板。以后要加是加法，不用推翻本设计。

## 2. 现状：哪些地方会串（已查代码）

本机 4 个 `p2pOpen` 的 bot（TEST、Gantt、blei-jiang、cli_aab09f8e…）全部 `sandbox: true`，私聊都落在 `shared/default`。沙盒隔的是 **bot 与 bot 之间**，同一个 bot 的不同用户之间没有任何隔离：

| # | 通道 | 现状 | 代码位置 |
|---|------|------|---------|
| 1 | Claude 记忆 | 按 cwd 分桶，所有人 cwd 相同 → 同一份记忆 | 桶在 `<BOT_HOME>/claude/projects/<cwd slug>/memory/` |
| 2 | 工作目录文件 | 同一个目录，A 生成/下载的文件 B 直接读 | `resolvePinnedWorkingDir` `daemon.ts:20600` 只看 chat/bot，不看发送者 |
| 3 | 沙盒把整个 `<BOT_HOME>` 授 readWrite | 所有人的记忆桶、transcript 都可读 | `fs-policy.ts:82` |
| 4 | 沙盒把整个 bot 角色库授 readWrite | 私聊 cwd 在角色库里时所有会话互相可读 | `fs-policy.ts:898` |
| 5 | `attachments/<appId>/` 整 bot readWrite | 所有人上传给 bot 的文件 | `fs-policy.ts:934` |
| 6 | `session-stores/<appId>/sessions.db` 整 bot 只读 | 所有会话元数据（标题、chat、owner） | `fs-policy.ts:928` |
| 7 | `botmux quoted <om_id>` | 只有 `--remote-runner-session-tool` 路径校验消息属于本会话 chat，普通路径任意 om_id 都取 | `cli.ts:9390` 附近 |
| 8 | `botmux history --session-id` | 可指到本 bot 任何会话 | `resolveSessionAppId` `cli.ts:9028` |
| 9 | lark-cli bot 身份 | daemon 把 tenant token 发给会话，bot 能读它所在的任何会话 | `dashboard-ipc-server.ts:3270` `lark-tool-identity` 路由 |

不用动的：`/cd`、`/repo`、`/botconfig` 走 `canOperate`，`p2pOpen` 的陌生人本来就用不了（fail-closed）。

## 3. 方案一句话

**每个会话有且只有一个 owner；目录、CLI 数据目录、沙盒授权、宿主侧读接口全部按 owner 收窄。** 没有「群共享桶」这个概念了：个人助理 bot 在任何会话里都是某一个人的助理。要团队共享就用另一个普通模式的 bot。 四条缺一条都是假隔离：目录分了沙盒不收窄 = 别人照样读（#3）；沙盒收窄了读接口不收窄 = 绕路（#7/#8/#9）。

```
~/.botmux/bots/<appId>/                 ← BOT_HOME
├── claude/                             ← bot 级凭证来源（owner 目录从这里拷凭证）
├── send-cred.json                      ← 已是精确路径 deny（不动）
└── users/<open_id>/                    ← 用户 A 的全部可写面，一棵子树
    ├── work/                           ← A 名下所有会话（私聊 + A 拉 bot 进的群）的 cwd；每次 spawn 从模板覆盖同步
    └── claude/                         ← A 的 CLI 数据目录：记忆、transcript、.claude.json
```

角色库 `~/botmux-roles/<appId>/` 只当模板来源，任何会话都不授它的权限。

## 4. 配置与开启条件

```jsonc
// bots.json per-bot
{
  "p2pOpen": true,
  "sandbox": true,                      // 必需（oncall 白名单模式）
  "assistantMode": true,                // 新增；缺省 undefined = 现状
  "assistantTemplateDir": "~/botmux-roles/<appId>/shared/default"  // 可选；缺省 = defaultWorkingDir
}
```

- 开启前置（daemon 加载配置时校验，不满足就拒绝启动该 bot 并打日志）：`sandbox` 为 oncall/true（scratch 是"读全盘"模型，v1 不支持）；模板目录存在。
- `/botconfig assistantMode on|off`（bot 管理员）可改；dashboard 开关后续再加。

## 5. 详细设计

### 5.1 会话归属：owner 解析（堵 #2）

每个会话 spawn 前先解析 owner，再由 owner 决定一切（cwd、CLI 数据目录、沙盒、读接口）：

| 会话来源 | owner |
|---------|-------|
| 私聊 | 发消息的人（`data.sender.sender_id.open_id`） |
| `p2pMode: group` 自动建的会话群 | `session-group-birth.ts` 已有的 `ownerOpenId` |
| 普通群 | **把 bot 拉进群的人**：`im.chat.member.bot.added_v1` 事件的 operator（`event-dispatcher.ts:6452` 已在处理这个事件），daemon 记到新表 `assistant-owners/<appId>.json`：`chat_id → { openId, since, how }` |
| 群里查不到 owner（开模式前就在群里、事件漏了） | **不服务**：bot 回一张「认领为我的助理」卡（复用 ask 卡），谁点谁是 owner（写表、`how: "claimed"`）；bot 管理员也可 `/assistant owner @某人` 直接绑 |

- `open_id` 形状校验 `^ou_[a-f0-9]{32}$`，不合形状 fail-closed（它要拼进沙盒白名单路径）。
- cwd = `<BOT_HOME>/users/<owner>/work`。这一分支优先级最高，压过 oncall 绑定、兄弟会话继承、`defaultWorkingDir`。
- `resolvePinnedWorkingDir`（`daemon.ts:20600`）加 `owner` 入参；6 处调用点（`daemon.ts:24599/25684/26442/26846/28770/30233`）。
- `buildFsPolicy` 对「workingDir 在 botmux 数据根内」抛 `working-dir-in-botmux-home`，自己的 BOT_HOME 除外——`users/<owner>/work` 符合既有例外。

**群里的其他人**：他们在跟「某人的助理」说话。他们的消息进 owner 的记忆、能看到 owner 让助理记住的东西——这是 owner 把人拉进自己助理所在群的后果，由 owner 自己决定，不涉及第三方数据（每个人的桶里只有自己的东西）。设计上不阻止，但会话卡脚注要标出「xx 的助理」，让所有人知道这是谁的空间。

**owner 退群**（`im.chat.member.user.deleted_v1`，`event-dispatcher.ts:6520` 已订阅）：立刻 suspend 该群所有会话、owner 记录标 `left`，群进入「不服务」状态直到有人认领；owner 的目录不动。**owner 自己拉 bot 进别的群** → 那个群也是他的，同一套记忆（个人助理的本意）。

**换 owner**：当前 owner 或 bot 管理员 `/assistant owner @某人`；换完旧会话 suspend，新 owner 的目录是空的（不迁移记忆）。

### 5.2 模板覆盖同步（人设与共享知识）

- 每次 spawn 前 worker 把模板目录（`assistantTemplateDir`，缺省 `defaultWorkingDir`）rsync 到 `work/`：模板里有的文件覆盖写入（CLAUDE.md、它 `@import` 的文件、`knowledge/`），模板没有的文件**不删**（用户自己的产物保留）。
- 不需要只读规则：用户改坏的是自己那份，下次 spawn 又被覆盖；管理员改模板全员下次会话生效。
- 模板的 CLAUDE.md 不应 `@import _role-protocol.md`（私聊不支持角色系统）；建议给保密 bot 单独准备一个模板目录，而不是直接拿 `shared/default`。
- `@import` 只能指向 cwd 内文件（指向 cwd 外会被 Claude Code 判为外部 include 弹批准框卡死，协议里踩过），覆盖同步正好满足。

### 5.3 按人分 CLI 数据目录（堵 #1、#3）

不靠"cwd 不同所以记忆桶不同"凑巧隔离，而是给每个用户独立的 `CLAUDE_CONFIG_DIR = <BOT_HOME>/users/<open_id>/claude`：

- 复用 `provisionIsolatedBotHome`（`worker.ts:2361`）+ `credentialsSourceDir` 那套：凭证来源 = 本 bot 的 `<BOT_HOME>/claude`（或 bot 配的 `credentialsSourceDir`），每次 spawn 同步 `.credentials.json`、seed `.claude.json`（减 projects）。与现有 per-bot 账号逻辑一致，只多一层。
- 效果：记忆、transcript、`.claude.json` 的 projects/mcp 状态、settings 全部按人分开。
- **凭证刷新怎么工作**（机队实测约束：一个账号一个 RT，刷新即轮换并吊销全部在途 AT；AT 8h；Claude Code 自己刷失败会清空副本）。现状链路 = cred-keeper 唯一刷新者（到期前 120 min）→ `on-refreshed` 钩子 cp 到 `~/.botmux/bots/*/claude/.credentials.json` → `botmux suspend all` → 下次冷启动 worker 再从源重拷。每人 HOME 之后机制不变：钩子多扫一层 `bots/*/users/*/claude/.credentials.json`；冷启动重拷本来就是每次 spawn。
- **加固（建议）**：用户副本里 `refreshToken` 换成垃圾串、只给 AT。会话多了之后「某个忙会话没被挂起、跑过 AT 过期点、自己拿 RT 刷新 → 整个账号 RT 轮换、全部会话作废」的概率上升（10-29 智付在 nana 上出过）；副本没有真 RT 就只会死自己这一个会话（下次冷启动重拷即恢复）。要真机验证：Claude Code 持垃圾 RT + 有效 AT 启动正常；AT 过期后只清空自己文件。
- 备选：`claude setup-token` 一年期长效 token 经 `CLAUDE_CODE_OAUTH_TOKEN` 注入，无凭证文件无刷新；与槽位换号（换目录不重启）不兼容，未在机队试过，不作主线。

### 5.4 沙盒授权（堵 #3、#4、#5、#6）

`buildFsPolicy` 的 ctx 新增 `assistantOwner?: { openId, userHome }`。模式打开后**所有**会话都带它，没有「群 / 私聊」分叉。

| 路径 | 现状 | 个人助理模式（所有会话） |
|------|------|------------------------|
| `<BOT_HOME>` | readWrite | **不授**；只授 `<BOT_HOME>/users/<owner>/` readWrite |
| `<BOT_HOME>/claude`（bot 级凭证来源） | readWrite | 不授（凭证由 worker 在宿主侧拷进 owner 目录） |
| 角色库 `<roles>/<appId>/` | readWrite | **整条不产生**（`fs-policy.ts:898` 已有 larkTransport 门，再加 assistantMode 门） |
| `attachments/<appId>/` | readWrite | 改为 `attachments/<appId>/u/<owner>/` readWrite；`downloadResources`（`session-manager.ts`）与 `cmdQuoted` 写到这里 |
| `session-stores/<appId>/sessions.db` | readOnly | **不授**；沙盒内 CLI 对本会话的查询走已有 daemon IPC（`resolveSessionById` 已是「优先问 daemon、离线才读库」，`cli.ts:4201`） |
| `turn-sends/<sessionId>.jsonl`、outbox、`bin`、插件目录 | — | 不变（已按会话或只读） |

两条守卫照搬：`users` 与 `<open_id>` 两段 lstat 必须是真目录不是链接（`role-library.ts` 对角色库末两段的做法）；spawn 处对 `work/` 做 `roleLibraryWorkingDirEscapes` 同款 fail-closed（用户能在自己的 rw 子树里把 `work` 换成指向 `$HOME` 的链接，下次 spawn 不能跟过去）。

### 5.5 宿主侧读接口按 chat 收窄（堵 #7、#8）

原则：沙盒内 CLI 能触达的每个「读别处」的口，只认 **同一 owner 名下的 chat**（owner 的私聊 + 他拉 bot 进的群）。校验都在 daemon/宿主侧做，沙盒绕不过。

- `botmux quoted`：把现在只在 `--remote-runner-session-tool` 下做的 `msg.chat_id !== session.chatId → refuse` 提到所有助理模式会话（`cli.ts:9390`）。
- `botmux history --session-id`：目标会话 `chatId` 必须等于当前会话 `chatId`，否则 403（`resolveSessionAppId` 后加一道）。`--scope ambient` 在私聊里 = 本 DM 整个 chat，同一个人，放行。
- `botmux list` / `sessions`：助理模式会话只返回本 chat 的会话。
- `botmux role switch`：403 `role_system_unavailable_in_assistant_mode`（沙盒 bot 本来就有「开沙盒即禁用角色系统」的先例，PR #644）。
- `/cd`、`/repo`：群里 oncall 授权可能让人 `canOperate`；助理模式下改目录命令一律拒绝（cwd 由 owner 决定，不接受手改）。
- 定时任务 `workingDir`：`capabilityScheduleWorkingDir`（`daemon.ts:8530`）在助理模式会话下只保留"必须在本会话 cwd 内"的既有分支，不回落角色库分支。任务 fire 走同一 spawn 路径，天然拿到同一套按人授权。
- IPC 审计：以 `BOTMUX_SESSION_ID` / binding accessKey 为凭据的 IPC 路由（`dashboard-ipc-server.ts` 的 `ipcRoute(` 列表）逐个过，凡返回跨会话数据的按 owner 过滤。实施期清单工作，不是设计未知。

### 5.6 lark-cli bot 身份（堵 #9）

沙盒里的 `lark-cli` 是 botmux 包装层（`lark-tool-binding.ts:211`），身份由 daemon 的 `lark-tool-identity` 路由按 `mode: bot|user` 发放 token——这就是闸口：

- 助理模式会话请求 `mode=bot` → 403 `lark_tool_bot_identity_withheld`；`mode=user`（用户本人授权）照常。
- 效果：bot 在 A 的私聊里不能用 bot 身份读 B 的私聊、拉 bot 所在群消息、读"共享给 bot"的文档；用 A 本人身份读 A 自己的文档/日历/邮件照常。
- 代价：`lark-tool-binding.ts:233` 那段"bot 无权就 --as user、用户无权就 --as bot 重试"的提示要加一句"保密私聊里 bot 身份不可用"。
- 助理模式隐含 `sandboxWithholdBotSecret`，不提供按 bot 配置放开 app 身份凭证的逃生阀。

## 6. 边界与已知限制

1. 不防运营方（§1）：dashboard 会话列表、web 终端、daemon 日志、`~/.botmux/data/queues/*.jsonl` 入站原文全在宿主上。
2. 模型层：模板知识、群里公开的内容，bot 在任何私聊里都可能说——那本来就是共享的。
3. 路径型沙盒既有限制：TOCTOU、mount point（`role-library.ts` 注释写明）、macOS 经 cfprefsd/Foundation 落盘的缓存不受策略管（`file-sandbox.md`）。与现有 bot 间隔离同级，不新增。
4. 开启瞬间的历史：开启前群桶 `<BOT_HOME>/claude/projects/<shared-default slug>/memory/` 里已混着所有人的私聊内容，群会话以后还看得到——开启流程处理（§7）。
5. 用户目录随人数线性增长（每人一份 `.claude.json`、transcript）；需要 `botmux privacy gc --inactive 90d` 一类清理，v2。
6. bot 管理员的私聊也按人分，不豁免；改模板去宿主终端。
7. 群里非 owner 成员的发言进 owner 的记忆、也能借助理看到 owner 记住的东西——由 owner 拉人这个动作承担，卡片脚注标明「xx 的助理」。
8. 开模式前 bot 已在的群需要一次认领，认领前不服务。

## 7. 开启流程（运维视角）

1. 准备模板目录（不 @import 角色协议），确认 bot `sandbox` 为 oncall。
2. 处理历史：把群桶里的 `memory/` 归档到宿主 `~/.botmux/archive/<appId>/memory-pre-privacy-<date>/`，管理员过一遍再决定哪些回填模板 `knowledge/`（人工步骤）。
3. `/botconfig assistantMode on` 或改 bots.json + daemon IPC 重载。
4. daemon 对该 bot **所有**活跃会话 `suspend`（旧会话 cwd 还是 shared/default，不能续）；已在的群各发一张认领卡。
5. 两个人各发一条私聊，按 §8 验收。

## 8. 测试与验收

**单元 / 回归（vitest + bun 两条腿）**
- `daemon-pinned-working-dir.test.ts`：p2p + per-user → `<BOT_HOME>/users/<open_id>/work`，压过 oncall / 继承 / 默认；open_id 形状不合法 → 拒绝 spawn；群会话不受影响。
- `fs-policy.test.ts`：有 `assistantOwner` → `BOT_HOME` 只剩 `users/<owner>`、角色库无规则、attachments 子路径、sessions.db 无规则；两个不同 owner 的规则集互不包含。**每条断言做变异验证**（把收窄逻辑注掉要红）。
- worker：模板覆盖同步——模板有的覆盖、用户自己的保留；`work` 是链接 → 拒绝 spawn。
- owner 解析：私聊 → sender；bot.added 事件 → 记 operator；无记录的群 → 不 spawn、发认领卡；认领后 → 该人；owner 退群 → suspend + 标 left。
- `cli`：quoted 跨 chat → exit 2；history `--session-id` 跨 chat → 403；role switch → 403。
- IPC：`lark-tool-identity` 助理模式会话 `mode=bot` → 403，`mode=user` 不变。
- `fs-policy-seatbelt.e2e` / `fs-policy-bwrap.e2e`：加 per-user 用例（真沙盒里读别人目录 EPERM/ENOENT）。

**真机验收（TEST bot，两个真人账号 A/B）**
1. A 私聊："记住我的工牌号是 12345" → A 的下一条新话题里 bot 能复述。
2. B 私聊问 A 的工牌号 / "你记住过什么" → 不知道；B 的 `memory/` 里没有 A 的内容。
3. B 让 bot `ls ~/.botmux/bots/<appId>/users/` → 只见自己；`cat` A 的路径 → 失败。
4. B 把 A 私聊里某条消息的 om_id 给 bot 让它 `botmux quoted` → refused。
5. B 让 bot 用 bot 身份 `lark-cli im +messages --chat-id <A 的 DM>` → 403。
6. A 上传文件 → 落 `attachments/<appId>/u/<A>/`；B 的会话看不到。
7. B 拉 bot 进自己的群问 A 的工牌号 → 不知道；`ls <BOT_HOME>/users` → 只见 B。
8. A 建定时任务 → 到点在 A 的 DM 触发、cwd 是 A 的 `work/`。
9. 管理员改模板 CLAUDE.md → A 下一个新话题生效；A 自己在 `work/` 里生成的文件没被删。
10. 群：A 拉 bot 进群说一件事 → A 私聊里 bot 能复述（同一人同一套记忆）；B 私聊问不知道；B 被 A 拉进那个群后问 → 知道（A 的空间，预期行为）；A 退群 → bot 停服、出认领卡。
11. 开模式前已有的群 → 认领卡，认领前 @bot 不回应。
12. 凭证：用户副本为垃圾 RT + 有效 AT 能正常工作；keeper 刷新后钩子覆盖到 users/* 且会话被挂起；人为让一个会话跑过 AT 过期 → 只有它 Login expired，账号主凭证不受影响。

## 9. 实施与待裁决

**改动点（约 6 个文件，400–550 行含测试；比 v2 多了 owner 存储与认领卡，少了私聊/群分叉与成员计数）**
- `bot-registry.ts`：三个新字段 + 加载期前置校验 + `/botconfig`
- `daemon.ts`：owner 解析 + `assistant-owners` 存储 + bot.added / user.deleted 事件接线 + 认领卡；`resolvePinnedWorkingDir` 加 owner，6 处调用点；`capabilityScheduleWorkingDir`、role switch、/cd、/repo 的助理模式分支
- `worker.ts`：USER_HOME 供给（复用 `provisionIsolatedBotHome`）、模板覆盖同步、`buildFsPolicy` ctx 加 `assistantOwner`
- `adapters/cli/fs-policy.ts`：§5.4
- `cli.ts` + `dashboard-ipc-server.ts`：quoted / history / list 收窄、`lark-tool-identity` bot 闸、IPC 跨会话读审计
- `core/session-manager.ts`：attachments 子路径
- 文档：`docs/file-sandbox.md` 补"私聊保密模式"一节

**落地顺序（建议）**：本机 worktree 开发 → TEST bot 两个真人账号试点 → deploy/all 合并 → 上游 PR。不直接改 `~/beta/botmux` 运行版。

**待裁决**
1. 助理模式下 lark-cli bot 身份缺省关、只留用户本人身份（§5.6）——同意吗？
1b. 开模式前已在的群：认领卡（我建议），还是管理员逐个手动绑？
2. 开启时群桶旧记忆归档给管理员人工筛（§7.2），还是留着不动？我建议归档。
3. 落地顺序按上面走，还是直接上游 PR？
