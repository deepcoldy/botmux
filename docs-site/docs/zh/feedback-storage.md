# 反馈数据存储与迁移

botmux 会把「反馈数据」存在一个数据库里：用户对最终回答的评价、每一轮的执行结果、反馈 Webhook 的投递队列等。Dashboard 的「反馈分析」页看到的就是这些数据。

- **默认用 SQLite**：一个本机文件 `botmux-feedback.sqlite`，放在 botmux 数据目录里（默认 `~/.botmux/data/`）。不用装任何东西，绝大多数人一直用它就够了。
- **可以换成 PostgreSQL**：想集中存放、做备份或接入自己的分析系统时再换。

换存储的工具是 `botmux feedback storage` 命令和 Dashboard「反馈分析」页里的「反馈存储设置」面板，两边能做的事一样。

## 我该怎么选

| 我的情况 | 做法 |
|---|---|
| 刚装好，没特别需求 | 第一次 `botmux start` 问存储时直接回车，用 SQLite |
| 刚装好，就想用 PostgreSQL | 第一次启动时输入 `postgresql`，再给出配置文件路径（见[第 1 步](#第-1-步准备配置文件)） |
| 已经在用 SQLite，**还没有任何反馈数据** | [仅空库：直接启用](#没有旧数据直接启用) |
| 已经在用 SQLite，**有历史数据要带走** | [迁移](#第-3-步迁移)（需要一段停机时间） |
| 已经在用 PostgreSQL，想换回 SQLite 或换另一个库 | 目前不支持，见[常见问题](#常见问题) |

> 第一次启动时如果不是在交互终端里（比如脚本里跑），会直接用 SQLite，不会提问。

## 迁移前先知道这三点

1. **迁移期间会暂停服务**：进入「维护窗口」后，新话题、新一轮对话和 `botmux send` 都会被拒绝，重启的 daemon 也会先等着，直到迁移完成或取消。挑一个没人用的时间做。
2. **不会自动回退**：切到 PostgreSQL 之后，如果数据库出故障，botmux 不会自己切回 SQLite。原来的 SQLite 文件会保留，但已被标记为「退役」，不再写入。
3. **密码不能写在命令行或配置文件里**：只能写「密钥引用」，见[密码怎么填](#密码怎么填)。

## 用命令行切换

### 第 1 步：准备配置文件

新建一个 JSON 文件，比如 `pg.json`：

```json
{
  "backend": "postgresql",
  "postgres": {
    "host": "db.example.com",
    "port": 5432,
    "database": "botmux",
    "user": "botmux",
    "schema": "botmux_feedback",
    "passwordRef": "env:BOTMUX_FEEDBACK_PG_PASSWORD",
    "tls": { "mode": "verify-full" },
    "connectTimeoutMs": 5000
  }
}
```

| 字段 | 说明 |
|---|---|
| `host` / `port` / `database` / `user` | 连接信息，都必填 |
| `schema` | botmux 专用的 schema，填一个库里**还不存在**的名字，botmux 会自己建。只能是小写字母、数字、下划线，且不以数字开头 |
| `passwordRef` | 密码的引用，不是密码本身，见下文 |
| `tls.mode` | `verify-full`：校验服务器证书（推荐）；`disable`：不加密 |
| `tls.caRef` | 可选，自定义 CA 证书的引用，写法同 `passwordRef` |
| `connectTimeoutMs` | 连接超时，100～60000 毫秒 |

文件里不能有多余字段（比如写一个 `password`），否则会被拒绝。

### 第 2 步：保存为候选配置并测试

```bash
botmux feedback storage configure --config-file ./pg.json
botmux feedback storage test
botmux feedback storage status
```

- `configure` 只把它存成「候选配置」，**不会切换，也不会动数据**。
- `test` 会连一下数据库，并检查账号在这个库上有没有 `CREATE` 权限（botmux 要用它建自己的 schema 和表）。
- `status` 显示当前生效的存储（`active`）、候选配置（`candidate`）和历次迁移任务。不带子命令直接跑 `botmux feedback storage` 也是 `status`。

命令输出都是 JSON；出错时输出 `{"error":"feedback_..."}`，退出码为 1。

### 第 3 步：迁移

```bash
botmux feedback storage migrate --to postgresql --yes
```

`--yes` 表示你确认进入维护窗口，不加会被拒绝。命令会一直跑到结束，输出类似：

```json
{"migrationId":"5dd49f52-...","phase":"complete","blockers":[]}
```

`phase` 是 `complete` 表示成功（退出码 0），此后反馈数据就写进 PostgreSQL 了。中间会依次经过这些阶段：

| 阶段 | 在做什么 |
|---|---|
| `preflight` | 连接目标库、准备表结构 |
| `draining` | 进入维护窗口，等进行中的对话结束（最多约 45 秒） |
| `snapshot` | 给 SQLite 拍一份只读快照 |
| `importing` | 把快照导入 PostgreSQL（目标库必须是空的） |
| `verifying` | 逐表核对行数和内容 |
| `retiring` / `activating` | 让 SQLite 退役、切换到 PostgreSQL |
| `complete` | 完成，维护窗口结束 |

如果 `phase` 是 `blocked`，说明卡住了，看下一节。

### 卡住了：继续还是取消

`blocked` 时 `blockers` 里会写原因。**卡住之后维护窗口不会自动结束**，新对话会一直被挡着，需要你二选一：

```bash
# 解决问题后，从原任务继续（可以反复执行）
botmux feedback storage resume <migrationId>

# 放弃迁移，恢复原来的 SQLite
botmux feedback storage cancel <migrationId> --yes \
  --reason "目标库权限不够，改天再迁" \
  --evidence "ticket:1234"
```

- `cancel` 必须带 `--yes`、`--reason`（为什么取消）和 `--evidence`（你核对过的凭据，比如工单号），会记进审计记录。
- 取消只会恢复 SQLite，**不会删除已经写进 PostgreSQL 的数据**。
- SQLite 一旦被标记退役（`retiring` 阶段做完之后），就不能取消了，只能 `resume` 把迁移做完。

常见的 `blockers`：

| 原因 | 怎么办 |
|---|---|
| `feedback_maintenance_not_ready` | 45 秒内没准备好：还有对话在跑、有 `botmux send` 正在发或结果不明，或者某个 daemon 没响应。等对话跑完；结果不明的 send 先按[投递恢复项](#投递恢复项)确认，再 `resume` |
| `feedback_outbox_unsettled` | 有结果不明的 Webhook 投递，见[投递恢复项](#投递恢复项)，确认后再 `resume` |
| `feedback_storage_target_not_empty` / `feedback_migration_target_not_empty` | 目标 schema 已经存在且不是 botmux 建的，或者里面已有反馈数据。换一个还不存在的 schema 名 |
| `feedback_storage_secret_missing` | 密码引用读不到（环境变量没设或文件不存在） |
| `feedback_migration_database_or_io_error` | 数据库或磁盘出错，最常见的是连不上库或权限不够。先跑 `test` 排查，修好后 `resume` |

### 没有旧数据：直接启用

如果 SQLite 里还没有任何反馈数据，可以跳过迁移：

```bash
botmux feedback storage configure --config-file ./pg.json
botmux feedback storage enable-empty --yes
```

只要 SQLite 里有一条数据，`enable-empty` 就会拒绝（`feedback_storage_migration_required`），这时请用 `migrate`。

## 密码怎么填

为了不让密码出现在命令历史和配置文件里，命令行**拒绝** `--password` 和 `--token` 参数，配置文件里也只能写引用：

| 写法 | 含义 |
|---|---|
| `env:变量名` | 从环境变量读，比如 `env:BOTMUX_FEEDBACK_PG_PASSWORD` |
| `file:<id>` | 读 botmux 数据目录里受保护的密钥文件。在 Dashboard 里填密码时自动生成，一般不用手写 |

用 `env:` 时，运行 `botmux feedback storage` 命令的终端和 botmux 服务本身的运行环境里**都要有**这个变量，否则切换后服务会读不到密码。嫌麻烦的话，在 Dashboard 面板里直接填密码更省事：密码会存成仅本机用户可读的文件，配置里只记引用，页面也不会回显。

## 用 Dashboard 切换

打开 Dashboard「反馈分析」页，展开「反馈存储设置」。这个面板只有主机管理员能看到。

> 截图来自较早版本，现在的面板在「后端」右边还多一个「认证方式」下拉框。

<img src="/img/feedback-storage-panel.png" alt="反馈存储设置面板：后端选 PostgreSQL，填主机、端口、数据库、用户名、Schema、密码和 TLS，下方是保存候选配置、测试已保存连接、维护窗口确认勾选框和迁移按钮" />

1. 「后端」选 PostgreSQL，「认证方式」选「用户名 / 密码」，填好连接信息。密码留空表示沿用上次保存的密码。
2. 点「保存候选配置」，再点「测试已保存连接」。面板上会显示「当前生效: sqlite; 候选配置: postgresql」。
3. 勾选「确认进入维护窗口」，然后：
   - 有历史数据：点「迁移并启用 PostgreSQL」；
   - 没有数据：点「仅空库：直接启用」。
4. 迁移在后台跑，面板每隔几秒刷新一次，底部显示 `<迁移 ID>: <阶段> <原因>`。迁移期间配置项会锁住。
5. 卡在 `blocked` 时会出现「恢复原迁移任务」按钮（需要勾着确认框），作用等同 `resume`。

要取消迁移，展开下方「人工恢复与裁决」，填「操作原因」和「外部核对凭据」，保持上面的确认框勾着，点「取消迁移并恢复原库」。这个按钮只在有未结束的迁移时出现。

<img src="/img/feedback-storage-recovery.png" alt="人工恢复与裁决区域：操作原因、外部核对凭据两个输入框，以及取消迁移并恢复原库、列出未知投递与发送租约两个按钮" />

## 投递恢复项

迁移前，botmux 要确认没有「发出去了但不知道结果」的操作，否则数据可能对不上。这类操作有两种：

| 类型 | 是什么 |
|---|---|
| `webhook` | 反馈 Webhook（Bot 配置里的 `feedbackWebhooks`）的一次投递，请求发出后没拿到明确结果 |
| `send` | 一次 `botmux send` 的发送记录，进程中途退出，不知道消息到底发没发出去 |

查看：

```bash
botmux feedback storage recovery list
```

先去对端核对这条到底有没有送达（比如查 Webhook 接收方的日志、看飞书群里有没有那条消息），再记录你的结论：

```bash
botmux feedback storage recovery acknowledge \
  --kind webhook --id <id> --fingerprint <fingerprint> --yes \
  --reason "接收方日志里已有该事件" --evidence "ticket:1234"
```

- `--id` 和 `--fingerprint` 从 `recovery list` 的输出里复制。如果这期间状态变了，会提示 `feedback_recovery_stale`，重新 list 一次即可。
- 还在进行中的项（`live: true`）不能确认，等它结束。
- 确认只是「记一笔」，**不会重发**，也不会结束维护窗口。确认完再 `resume`。

在 Dashboard 里，「人工恢复与裁决」区的「列出未知投递与发送租约」按钮做的是同一件事，每一项下面有「确认已核对该项结果」按钮（同样要先勾确认框、填原因和凭据）。

## 自动化安装

脚本化部署时，可以设置环境变量 `BOTMUX_FEEDBACK_CONFIG_FILE` 指向第 1 步的配置文件。`botmux start` 时会自动保存这份配置并按空库直接启用（等同 `enable-empty`），不会再交互提问；配置和当前生效的一样时什么都不做。

这只适合全新安装：SQLite 里已经有数据时会报 `feedback_storage_migration_required`，请改用[迁移](#第-3-步迁移)。

## 常见问题

**能从 PostgreSQL 换回 SQLite，或者换到另一个 PostgreSQL 吗？**
目前不能。迁移只支持 SQLite → PostgreSQL。

**迁移会停多久？**
取决于数据量：要等进行中的对话结束，再导入并逐表核对。数据不多时通常很快。建议在低峰期做。

**迁移后原来的 SQLite 文件还在吗？**
在，`botmux-feedback.sqlite` 会保留在数据目录里，但已退役，不再写入。

**报 `feedback_storage_generation_conflict`？**
配置在你操作期间被别处改过（比如另开了 Dashboard），重新 `status` 看一下再操作。`enable-empty` 前忘了先 `configure` 保存候选配置，也会报这个错。

**相关文档**：[Bot 配置（bots.json）](/bots-json) 里有最终回答反馈卡片的配置；[Dashboard](/dashboard) 介绍了「反馈分析」页；其他命令见 [CLI 命令](/cli-commands)。
