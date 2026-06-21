# 角色与团队

给每个机器人按群设独立人设，并在多机器人协作时形成一份「团队花名册」。命令是 `/role`。

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
