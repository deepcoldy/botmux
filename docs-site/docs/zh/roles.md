# 角色与团队

给每个机器人按群设独立人设，并在多机器人协作时形成一份「团队花名册」。命令是 `/role`。

> 本页含两套相关但不同的能力：**`/role` 人设**（同一个 bot 一套人设、可按群覆盖，见下）与 **[角色切换（role switch）](#角色切换role-switch)**（一个 bot 拥有多个完整角色、各自独立记忆、用自然语言按话题切换，进阶功能）。

## 两级 Role（人设）

| 命令 | 作用 |
|------|------|
| `/role` | 查看当前**生效**的 Role（来源：本群覆盖 > 默认角色 > 无） |
| `/role set <Markdown>` | 设置**本群** Role（覆盖默认角色） |
| `/role delete` | 删除本群 Role |
| `/role team set <Markdown>` | 设置**默认角色**（该机器人**跨所有群**的默认人设；命令名沿用 `team`） |
| `/role team delete` | 删除默认角色 |

- **本群 Role** 优先级最高：同一个 bot 在不同群可以有不同性格 / 职责（如在 A 群当「严格的 reviewer」、在 B 群当「亲和的答疑助手」）。
- **默认角色** 是该 bot 的跨群默认人设，没设本群 Role 时生效。
- Role 内容是 Markdown，注入到 CLI 的 system prompt，最大约 4096 字节。
- Role 解析顺序始终是：**本群 Role > 默认角色 > 无**。

角色管理还提供按「群 + bot」生效的**话题任务回报**开关，默认关闭。开启后，当前 bot 在该群通过 `botmux dispatch` 派发任务时，子 bot 完成后仍会执行 `botmux report` 把结果回注到主编排的现有会话；同时还会在收到任务的原话题运行 `botmux send --no-mention "子项目完成 + 产出位置/摘要"` 额外留一份人可见的最终交付，不会 @ 主 bot 或新开话题。`--standby` 不发送任务，因此不会注入任务指令。

> 💡 **默认角色**最直观的设置方式是在 `botmux dashboard` 的 **Bot 配置** 页——每个 bot 卡片都有「**默认角色**」编辑器（和 `/role team set` 写的是同一份配置；它是 bot 级的全局默认人设，放在 Bot 配置更合适）。**团队**面板里只做**只读查看**入口，编辑统一去 Bot 配置页。

![Dashboard Bot 配置 — 默认角色编辑器](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780051089378_default-role-shot.png)

## Role Profile

Role profile 是一套可复用的、按 bot 区分的**本群 Role**。它不是第三层运行时 role，也不支持 `{{teamRole}}` 这类模板继承。

常用命令：

```bash
/role profile list
/role profile show collab-main
/role profile set collab-main <Markdown>
/role profile save collab-main
/role profile apply collab-main --quiet
```

工作方式：

- 每个 bot 只拥有自己的 profile entry，按 `larkAppId` 存储。
- `save` 会把当前 bot 的生效 Role 保存到 profile：先取本群 Role，再取默认角色；都没有则失败。
- `apply` 会把当前 bot 的 profile entry 写成本群 Role。若本群已存在 Role，默认拒绝覆盖，除非传 `--force`。
- 缺 entry 是安全的：不写任何内容；如果该 bot 有默认角色，会继续 fallback 到默认角色。

在 Dashboard 里，**角色配置集** 是独立入口：

- 左侧列表打开或新建 profile。
- 中间查看每个 bot 是否已有 entry，并编辑该 bot 的 Markdown Role。
- 在 Apply 区选择目标群，先 **预览 Apply**，确认不会误覆盖后再 **Apply Profile**。
- 从 **群组** 页面点击某个群的「应用配置集」会直接跳到该群作为 Apply 目标。

创建协作群时可以一次 bootstrap：

```bash
@botA @botB @botC /g --role-profile collab-main War Room
```

创建者会先直接应用自己的 entry，再在新群里发送 `@botB @botC /role profile apply collab-main --quiet` 给其它 bot。每个 bot 只应用自己的本地 entry，不会跨 daemon 写其它机器人的 role 存储。

## 能力标签（花名册）

```bash
/role cap set <一句话>   # 设置该 bot 的能力标签
/role cap clear          # 清除
```

能力标签会显示在「花名册」里——`botmux bots list` 列出当前群的机器人时，每个 bot 带上它的 `cap` 一句话简介，方便你和其它 bot 知道「谁擅长干什么」，在多机器人协作 / 交接时挑对人。

## 与多机器人协作的关系

Role + 能力标签是[多机器人协作](/multi-bot)的基础设施：给每个 bot 清晰的身份和职责，群里 @ 时模型不易混淆、各司其职（如一个主控调度、一个做实现 / review）。

## 团队协作（跨部署）

在 `botmux dashboard` 的 **团队** 面板，可以把**别人的部署**（同事自己跑的 botmux）邀请进同一个团队，互相发现机器人、跨部署协作拉群。

![Dashboard 团队 — 跨部署协作](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033301213_dash-team.png)

- **绑定身份**：用机器人凭证自动识别你的飞书身份；绑定后拉群会把你拉进群、机器人也归到你名下。
- **团队花名册**：聚合本部署 + 已加入团队的所有机器人（可跨部署），可按名称 / 能力 / CLI 搜索筛选，并标注谁有能力标签 / 默认角色（角色在此**只读查看**，编辑去 Bot 配置页）。
- **跨部署拉群**：在任一团队里勾选机器人即可一键建群，自动带上各自的负责人——一个群里凑齐不同同事部署的不同 CLI 协作。
- **团队管理**：新建团队、生成邀请码、加入别人的团队，都在「团队管理」子页。

> 适合多人 / 多机协作：每个人各自跑自己的 botmux 部署，通过团队联邦互相发现彼此的机器人，在同一个飞书群里协同。

## 角色切换（role switch）

> ⚠️ 进阶功能，需先部署「角色库」，且目前只支持 Claude Code。部署步骤见仓库的 [角色系统部署 runbook](https://github.com/deepcoldy/botmux/blob/master/docs/roles/deploy-runbook.md)；下面讲**部署好之后终端用户怎么用**。

和上面的 `/role`（同一个人设、按群覆盖）不同，**角色切换**让一个 bot 拥有**多个完整角色**，每个角色有自己的人设**和独立记忆**——切到「售后客服」它就带着售后的人设 + 只属于售后的记忆积累，切到「产品经理」又是另一套。角色**按话题生效**，新话题从默认角色开始。

### 怎么用（纯自然语言，不用记命令）

| 你说 | bot 做什么 |
|------|-----------|
| 「切换角色」/「有哪些角色」 | 列出你可用的角色（全员共享的 + 你自己建的），编号给你选 |
| 「切到售后客服」/ 回复编号 | 确认后切换；此后本话题由该角色应答，卡片脚注也变成该角色名 |
| 「新建角色：小红书运营，熟悉我们品牌调性」 | 起草人设给你确认 → 创建 → 自动切过去 |
| 「沉淀知识」 | 把该角色近期的记忆提炼成结构化领域知识，回灌自身（可选沉淀成飞书文档供人审核） |

用户端**全程自然语言**——底层是模型在幕后调 `botmux role switch <角色目录>`（受 daemon 硬校验，只能切到角色库内），你不需要、也不应该手敲这个命令。

### 几个要点

- **私有 + 共享（协议层约定，非 daemon 硬隔离）**：角色列表与「切到 XX」的可见性是由角色协议（`_role-protocol.md`）按发送者 open_id 过滤的——共享角色 + 你自己 `users/<你的 open_id>/` 下的角色可见可切，他人私有角色协议约定不展示、不可切。⚠️ 这是**协议层行为、不是安全边界**：daemon 侧只硬校验「目标目录不逃出角色库根 `~/botmux-roles`」，不做按发送者的目录级 ACL。若要把私有角色当硬隔离用，需自行加系统级权限，不要依赖本协议约定当安全承诺。
- **独立记忆**：每个角色一份记忆，跨群 / 跨话题共享同一份——同一角色越用越懂它的领域。
- **上下文保留**：切换时进程带 `--resume` 重启，之前的对话续回来，新角色的人设与记忆在新会话开场自动加载。
- **和 `/cd` 区分**：斜杠命令 `/cd <路径>`（见[斜杠命令](/slash-commands)）是通用的「切工作目录并重启」，任意目录、owner 操作权；角色切换只在角色库内、由角色协议驱动，两者不是一回事。

> 曾用命令名 `botmux cd` 已改为 `botmux role switch`（旧名保留为报错提示、不再执行切换）。维护存量部署时记得把角色库里的 `_role-protocol.md` 刷新为新命令名。
