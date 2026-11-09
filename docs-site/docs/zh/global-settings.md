# 全局设置（config.json）

有些开关管的是**整台机器**，不是某一个机器人：比如几点自动更新、要不要定时清理空闲会话、机器负载太高时提醒谁。这些都放在 Dashboard 的「全局设置」页，保存后写进 `~/.botmux/config.json`，这台机器上所有机器人共用。

> 只想改某一个机器人（工作目录、管理员、CLI 等），去 [bots.json](/bots-json)。会话里要用的环境变量见 [环境变量](/env)。

## 在哪改

1. 打开 Dashboard，点左侧导航「全局设置」。
2. 页面左边有目录，分三大块：**通用设置**、**会议 Agent**、**系统与维护**，点哪一项就跳到哪。
3. 开关一拨就保存；输入框（群名前缀、代理、回调基址等）要点旁边的「保存」。大多数设置不用重启。

也可以直接编辑 `~/.botmux/config.json`。下文每一项都写了 JSON 字段名，方便手工改或备份。如果开了「允许无 token 只读访问 dashboard」，没有 token 的访客只能看、不能改。

## 常用设置速查

| 我想… | Dashboard 位置 | 字段 | 默认 |
|---|---|---|---|
| 每天自动装新版 | 系统与维护 → 自动维护 → 自动更新 | `maintenance.autoUpdate` | 关 |
| 装完新版自动重启 | 系统与维护 → 自动维护 → 自动重启 | `maintenance.autoRestart` | 关 |
| 定时关掉长期不用的会话 | 通用设置 → 定时任务 → 定时自动清理空闲会话 | `sessionCleanup` | 关 |
| 机器过载时收到私信 | 通用设置 → 机器过载告警 | `hostOverloadAlert` | 关 |
| 定时任务按某个时区算 | 通用设置 → 定时任务 → 时区 | `scheduleTimeZone` | 跟随主机 |
| `/g` 建的群自动加前缀 | 通用设置 → 群聊创建 | `groupNamePrefix` | 不加 |
| 选仓卡里不显示 worktree | 通用设置 → 仓库选择 | `repoPickerMode` | 仓库 + worktree |
| 新建的 worktree 放到大数据盘 | 通用设置 → Worktree | `worktreeRoot` | 建在主仓库旁边 |
| 下载新版走代理 | 系统与维护 → 自动维护 → GitHub 下载代理 | `httpProxy` | 不设 |
| `/login` 授权后不用手动粘贴链接 | 通用设置 → 访问权限 → OAuth 回调基址 | `oauthRedirectBase` | 不设 |

## 自动更新与自动重启

想让 botmux 每天自己升级 → 打开「系统与维护 → 自动维护 → 自动更新」，再选一个时间。

- **自动更新**（默认关）：每天在设定时间（默认 04:00，按北京时间）检查一次，有新版就按你当初的安装方式（npm / pnpm / Bun 全局安装）更新。**只装不重启**，新版本在下次重启时生效。
- **自动重启**（默认关，要先开自动更新）：只有在这次**真的装上了新版本**时才重启。没有新版就什么都不做，它没有自己的时间表。
- 到点时如果有会话正在跑任务，这次更新会整次跳过，顺延到第二天，不会打断正在干活的会话。
- 从源码运行（本地开发安装）时自动更新不可用，页面上会写明。

主动重启（手动重启、自动更新后重启、回滚）之后，第一个机器人默认会私信它的首位管理员一份「重启报告」。不想收，在 `config.json` 里写 `"maintenance": { "notifyOnRestart": false }`（这一项页面上没有开关）。

```json
{
  "maintenance": {
    "autoUpdate": { "enabled": true, "time": "04:00" },
    "autoRestart": { "enabled": true }
  }
}
```

### 自动升级会话里的 Codex

位置：通用设置 → 实验性配置 → 自动升级会话 Codex 版本。实验功能，默认关。

打开后，本机装了新版 Codex，正在用的 Codex 会话会在**安全空闲时**换成新版进程，并接回原来的会话，不会额外发起一次对话。有后台任务、或者判断不了是否安全的会话会先等等再升。开关立即生效。

## 定时清理空闲会话

会话开多了占内存。想让长期没人用的会话自动关掉 → 打开「通用设置 → 定时任务 → 定时自动清理空闲会话」。

![定时任务区块：时区、Codex 归档与空闲清理](/img/settings-schedule-idle-cleanup.png)

| 选项 | 说明 | 默认 |
|---|---|---|
| 定时自动清理空闲会话（`enabled`） | 总开关 | 关 |
| 空闲阈值（`olderThanHours`） | 最后一条消息早于多久才清：24 小时 / 72 小时 / 7 天 三选一 | 7 天（168） |
| 检查频率（`intervalMinutes`） | 每隔几分钟检查一次，最少 5 分钟 | 60 |
| 关闭/清理时同步归档 Codex（`archiveCodex`） | 关会话时（手动关闭或空闲清理）顺手归档对应的 Codex 会话，重新打开时恢复 | 关 |

它和「会话控制」页上手动点「清理空闲」用的是**同一套判断**，只是自动跑。只清真正空闲的会话：正在运行、被锁定、还有待处理的选仓或需要你处理的提醒的会话，都不会被关。

```json
{
  "sessionCleanup": { "enabled": true, "olderThanHours": 72, "intervalMinutes": 60 }
}
```

## 机器过载告警

机器负载太高时，新会话冷启动容易超时。想在过载时第一时间知道 → 打开「通用设置 → 机器过载告警」。

1. 打开「启用过载告警」。
2. 选一个**通知 Bot**（整台机器选一个就够）。页面会显示接收人：这个 Bot 的**第一位管理员**。
3. 需要的话调两个阈值。

之后这个 Bot 每 30 秒看一次整机负载和内存。**进入过载**时私信管理员一条，**恢复**后再发一条；短时间内反复进出不会刷屏（两次「进入」提醒至少隔 15 分钟）。

| 阈值 | 什么时候算过载 | 默认 |
|---|---|---|
| 负载进入阈值（`enterLoadRatio`） | 15 分钟平均负载 > CPU 核数 × 这个值 | 1.5 |
| 内存进入阈值（`enterMemUsedFrac`，页面填百分比） | 已用内存占比达到这个值 | 92% |

恢复线是内置的（负载 = 核数 × 1.0，内存 85%）。如果你把进入线调到不高于恢复线，恢复线会自动压到进入线的 95%，避免来回抖。

注意：

- 通知 Bot 必须能发飞书消息（不能是只走 API 的 bot），而且配了管理员。
- 也能用环境变量调：`BOTMUX_OVERLOAD_ENTER_LOAD_RATIO`、`BOTMUX_OVERLOAD_EXIT_LOAD_RATIO`、`BOTMUX_OVERLOAD_ENTER_MEM_FRAC`、`BOTMUX_OVERLOAD_EXIT_MEM_FRAC`、`BOTMUX_OVERLOAD_MIN_REALERT_MS`。环境变量优先于页面设置。
- `BOTMUX_OVERLOAD_ALERT=0` 会彻底关掉这个功能，不管页面怎么设。

## 内存保护（新会话启动前检查）

这一项默认就是开的，平时不用管。每次要新起或恢复一个会话进程前，botmux 会看一眼内存：

- 可用内存低于**保留量**（默认取总内存的 25%，最多 4 GiB），或
- 内存压力（Linux PSI 的 `full avg10`）达到**上限**（默认 20%），

就不启动，并在会话里回一条说明，请你释放内存后重发消息。差得不多时会先挂起几个空闲会话腾内存，再试一次。

页面上没有这组开关，用命令行看和改：

```bash
botmux worker-budget status                          # 看当前内存、阈值和来源
botmux worker-budget set --min-available-mib 2048    # 保留量改成 2 GiB
botmux worker-budget set --max-memory-full-avg10 30  # 压力上限改成 30%
botmux worker-budget set --memory-admission-enabled false   # 关掉检查
botmux worker-budget set --session-memory-max-mib 4096      # 每个会话最多用 4 GiB（需要 cgroup v2 支持）
botmux worker-budget unset                           # 清掉自定义，回到默认
```

对应 `config.json` 里的 `worker` 字段（`memoryAdmissionEnabled`、`minAvailableMemoryBytes`、`maxMemoryFullAvg10`、`sessionMemoryMaxBytes`）。它不改变每个机器人最多常驻几个会话（那是 bots.json 的 `maxLiveWorkers`）。

## 定时任务时区

位置：通用设置 → 定时任务 → 时区。默认「跟随主机」。

[定时任务](/schedule)的触发时间、「明天 9:00」这类说法、卡片和 Dashboard 上显示的时间，都按这个时区算。服务器在海外、人在北京时，选 `Asia/Shanghai` 就行。

生效顺序（前面的优先）：

1. 环境变量 `BOTMUX_SCHEDULE_TIMEZONE`
2. 页面里选的时区（`scheduleTimeZone`）
3. 主机系统时区

填了不合法的时区名会被跳过，落到下一层。自动更新的时间不受这里影响，固定按北京时间。

## 建群和选仓

- **`/g` 群名前缀**（通用设置 → 群聊创建，`groupNamePrefix`）：用 `/group` 或 `/g` 建群时，群名前面自动加上这段文字，例如 `AI讨论·`。别的建群方式不加。清空保存就关掉，最多约 2 秒生效。详见[一键新建会话群](/group)。
- **仓库选择卡模式**（通用设置 → 仓库选择，`repoPickerMode`）：`all`（默认，仓库和它的 worktree 都列出来）或 `repos`（只列主仓库）。选了 `repos` 后，直接写 `/repo <worktree 路径>` 仍然能进 worktree。
- **worktree 存放目录**（通用设置 → Worktree，`worktreeRoot`）：botmux 新建的 worktree 放到这个目录下，例如 `/data00/worktrees`，适合系统盘小、另有大数据盘的机器。目录下按主仓库所在路径分层：`/root/iserver/botmux` 的 worktree 会建成 `/data00/worktrees/root/iserver/botmux-wt-…`，所以不同位置的同名仓库不会冲突。填一个已存在、可写的目录的绝对路径（可以 `~/` 开头）。只影响之后新建的 worktree，已有的留在原处照常使用，之后再换目录也不影响。这个目录之后若不存在或不可写（比如数据盘没挂上、被重新挂成只读），新 worktree 会临时建回主仓库旁边，并在日志里告警。清空保存就恢复为建在主仓库旁边，最多约 2 秒生效。

## 网络与访问

| 设置 | 位置 | 用途 |
|---|---|---|
| GitHub 下载代理（`httpProxy`） | 系统与维护 → 自动维护 | 独立二进制版自更新时，从 GitHub 下载用的 HTTP 代理，如 `http://127.0.0.1:7890`。不填就用 `HTTPS_PROXY` / `HTTP_PROXY`，都没有就直连。npm / pnpm / Bun 安装走它们自己的代理配置 |
| OAuth 回调基址（`oauthRedirectBase`） | 通用设置 → 访问权限 | 飞书授权（如 `/login`）完成后跳回这个地址，Dashboard 自动收下，不用再手动粘贴回调链接。适合 botmux 不在你自己电脑上跑的情况。只填协议 + 主机 + 端口，如 `http://10.1.2.3:7891`。改完到任一机器人的「会话群标签」里点一次「修复开放平台回调」，否则飞书会报 20029 |
| 远程访问终端（`remoteAccess`） | 通用设置 → 访问权限 | 默认关。这台机器绑定了中心平台时才显示。打开后，会话终端、卡片上的终端按钮和 webhook 地址都换成平台链接，关掉就用本机链接 |

网页终端本身的说明见 [Web 终端](/web-terminal)。

## 内置 Skill 怎么交给 CLI

botmux 自带的 skill（发消息、建定时任务等）要交给 CLI 用。对 Codex、OpenCode 这类只有全局 skill 目录的 CLI，有三种方式（`skills.builtinInjection`）：

| 值 | 做法 |
|---|---|
| `prompt`（默认） | 不碰 CLI 的全局目录，只在会话提示里放一份目录，需要时再查完整说明。不会影响你自己手动开的 CLI |
| `global` | 装进 CLI 的全局 skill 目录，体验最原生；但你自己手动跑 `codex` 时也能看到它们 |
| `off` | 都不放，只留一句「用法见 `botmux --help`」 |

这是整台机器的默认值，用命令改：`botmux skills injection [global|prompt|off|unset]`，不带参数是查看。单个机器人在 bots.json 里设了 `skillInjection` 时，以机器人自己的为准。详见 [Skill](/skill-cli)。

## 同群多人独立会话（XPI，实验性） {#xpi}

**默认关闭。** 关着时，群里所有人共用同一个会话：别人在 Bot 干活时发的消息按普通方式排队，等当前任务做完再处理。

打开后，同一个群里**每个真人各用一套独立的 CLI 上下文和 git worktree**，可以并行干活、互不打断：

- 消息仍然在群里公开可见，只是各自进各自的「lane」。
- 引用别人正在执行的任务时，会走建议 / 确认流程，不会直接插进别人的任务；其它消息直接在发送者自己的 lane 里继续。
- 在话题里发 `/lane status` 查看自己 lane 的分支、worktree、未提交改动和未推送提交数；`/lane close` 安全关闭自己的 lane（有任务在跑或有未提交文件时会拒绝，回收前先推送未发布的提交，不会自动合并或删分支）。
- Agent 给别的 Bot 发消息时，要用 `botmux send --as independent|suggestion` 说明是「另开任务」还是「留给当前任务」。

怎么开：Dashboard「全局设置 → 通用设置 → 实验性配置 → 跨身份打断隔离（XPI）」，对应 `config.json` 的 `dashboard.crossPrincipalInterruption: true`。开关对这台机器上所有 Bot 生效，**下一轮消息就生效，不用重启**。只想让某个 daemon 进程开或关，可以给它设环境变量 `BOTMUX_XPI_ENABLED=true` / `false`，它优先于 Dashboard 开关。

大家需要共用同一份上下文和文件时保持关闭；任务彼此完全独立时再开。

## 常见问题

**改了 config.json 要重启吗？**
页面上的大部分开关保存后立即生效。手工改文件时，建议改完到页面上确认一下数值；拿不准就 `botmux restart`。

**自动更新开了，为什么没更新？**
可能是：到点时有会话在跑（顺延到第二天）；到点时 botmux 没在运行、超过 1 小时才起来（这天跳过）；已经是最新版；当前是本地开发安装或不支持的安装方式（页面「自动维护」标题旁会提示）。

**过载告警一直没收到？**
确认选了通知 Bot、这个 Bot 在线、配了管理员；再看是否设置了 `BOTMUX_OVERLOAD_ALERT=0`。

**备份要带上 config.json 吗？**
要。迁移机器时把 `bots.json`、`.env`、`config.json` 和 `data/` 一起带走，见 [环境变量](/env)。
