# 决策看板与管家

把一个机器人设成**管家**：它帮你推进交代给它的开发任务，遇到需要你拍板的事就写进**决策看板**。你在看板上逐项写决定、贴图，写完点一次「提交」，这一批决定作为**一条消息**送进管家的会话，管家马上逐项执行，再把结果写回看板。

> 默认关闭。没开管家的部署不会多任何文件、页面或提示词。

## 开启

Dashboard → **Bot 配置** → 选中要当管家的 bot → **管家** 分组：

- **设为管家**：打开后，这个 bot 的会话可以用 `botmux board` 维护看板，侧边栏出现「决策看板」。
- **管家所在群**：你在这个群里给管家交代任务，提交的批次也送进这个群的会话。建议选只有你和管家的群（普通群）。
- **提示词**：预置的管家规则只读展示；你可以在后面**追加**自己的规则（例如推进标准、合码标准文件路径、改用别的工具发消息），也可以**整段替换**。

也可以在飞书里用 `/config set steward {"enabled":true,"chatId":"oc_…"}` 设置。

## 管家怎么工作

- 管家群里每轮只多一行系统提示，告诉它有看板、规则用 `botmux board guide` 读；规则正文不常驻。
- 管家默认用**自己的 bot 身份**到相关群发消息推进（`botmux send`）。目标 bot 需要接受管家 bot 的消息（飞书开放平台开启「获取群组中其他机器人 @ 当前机器人的消息」，botmux 侧给管家 bot 对话授权）。
- 不能自己定的、不可逆的事，管家写成「待拍板」，给出选项、后果和推荐。
- 定时巡检不在这个功能里。需要的话，用[定时任务](./schedule.md)给管家配一条，prompt 里写巡检要求即可。

## 拉新群时带上管家

管家要用自己的身份在群里发消息，得先在群里。所以开了管家之后，botmux 每次建新群（`/group`、私聊自动建的会话群、`/fork --create`、`/relay --create`、Dashboard 建群、`botmux create-group` 等所有入口）都会看一眼：新群的成员或发起人里有这个管家的 owner，就由建群的 bot 顺手把管家拉进去。

- **默认开启**。开关在 **Bot 配置 → 管家 → 拉新群时带上管家**，也可以用 `/config set steward {"enabled":true,"chatId":"oc_…","autoJoinNewGroups":false}` 关掉。管家不用自己的 bot 身份发消息时（比如改用 owner 本人的身份发）不需要带，关掉即可。
- 管家进群**不发言、不开会话**：不跑它的入群命令、入群钩子和「被拉进新群自动开工」，不拉 owner，也不参与 oncall 绑定、角色套装和 kickoff。之后有人 @ 它，才按平常的规则回应。
- **只带对应的管家**：同一台机器上几个人各有管家时，只带 owner 在新群里的那个。owner 按 union_id 认；管家没配 owner（allowedUsers 为空），或它的 daemon 还没换出 owner 的 union_id 时（刚启动、缺通讯录权限），不带。
- **只有一个人和一个 bot 的新群默认不带**：比如私聊转出的会话群、在私聊里用 `/group`、`/fork --create` 建的群、会议监听群。这类群不用 @ 就能接着聊，带上管家就成了两个 bot，原来那个 bot 要 @ 才回。按实际进群的人和 bot 数判断。确实要带，打开下面的 **只有你和一个 Bot 的群也带上管家**（默认关，需要上一项开着），或 `"autoJoinSoloGroups":true`。
- 管家本来就在要拉的 bot 里时不重复加。拉管家失败（应用可见范围、权限等）不影响建群，只记日志，`botmux create-group` 会在输出里说明。

## 看板

- **汇总页**：待你拍板 / 进行中 / 全部 三个视图。● 表示你上次看过之后管家有新进展，✎ 表示你有没提交的草稿。
- **详情页**：一句话说明、当前进展、要你定的问题与选项（标出推荐项）、你的决定（可贴图）、历史时间线、关联的 PR / 群 / 会话 / 提交。
- **草稿**自动保存在服务端，不会发给管家。电脑上和飞书侧栏里看到的是同一份草稿。
- 点「**提交 N 项决定**」：所有勾选的草稿成为一个批次，送进管家会话的一个回合。管家正在忙时排在当前回合后面。投递失败时页面显示原因，可以重新投递；daemon 重启后会自动补投没送到的批次。

状态只有 6 个：待拍板、待验收、进行中、等待中、已完成、已关闭。更细的流程词（在审、在修、可合、等作者……）写在「阶段」里。

## 在飞书里打开

管家给出的每个事项链接，在飞书 PC 端点开会在**会话右侧栏**里打开（`applink …/client/web_url/open?mode=sidebar-semi`），手机端在客户端内打开。链接本身不带任何凭证：

| 部署 | 打开后怎么登录 |
|---|---|
| 绑定中心平台并开启远程访问 | 平台飞书 SSO 自动登录；只有机器 owner 和协管者能进 |
| 配置了 Dashboard 飞书 H5 免登（`BOTMUX_DASHBOARD_FEISHU_H5_*`） | 飞书内免登，只放行名单里的人；H5 身份只额外放开看板接口 |
| 都没配 | 进入 Dashboard 登录页，登录一次后飞书 webview 会记住 |

## 管家用的命令

```bash
botmux board guide                                    # 管家规则（预置 + 自定义）
botmux board list [--view decide|active|all]          # 列事项，每行带飞书里打开的链接
botmux board show <编号|key>
botmux board add <标题> --key pr:owner/repo#12 --link pr=owner/repo#12 --link chat=oc_…
botmux board set <编号> --state decide --ask "要你定的问题" \
  --option "A=做法 → 结果和风险" --option "B=…" --recommend A --reason "理由"
botmux board set <编号> --unlink doc=https://旧链接 --link "doc=https://新链接|看板文档"   # 删掉 / 替换关联
botmux board history <编号> "做了什么、结果" --handled   # --handled：这项最近一批决定已执行
botmux board attach <编号> shot.png --note "复现截图"
botmux board pending                                  # 已提交、还没执行的决定
```

`--link kind=ref|标签` 里最后一个 `|` 之后是标签（网址里本身有 `|` 时写成 `%7C`）；`--link` 只追加，填错的用 `--unlink kind=ref` 删掉。完整参数见 `botmux board --help`。

## 数据

看板存在 `<数据目录>/decision-board.sqlite`（按管家 bot 分区），截图存在 `<数据目录>/decision-board/<app_id>/files/`。第一次使用看板时才创建。关闭管家不会删除看板数据。
