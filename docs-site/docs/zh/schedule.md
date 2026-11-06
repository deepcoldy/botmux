# 定时任务

<video src="img/video-v5-automation.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

让 Bot 到点自动干活：每天早上出日报、每 30 分钟巡检一次服务、PR 合入后再去清理分支……到点时，Bot 会把你写好的提示词（prompt）交给 AI CLI 执行，结果发回飞书群。

## 一分钟上手

最快的方式是直接在群里或话题里发：

```text
/schedule 每日17:50 帮我看看AI圈有什么新闻
```

Bot 会回一条确认，里面有任务 ID、下次执行时间和执行位置。之后可以用 `/schedule list` 查看、`/schedule remove <id>` 删除。

也可以直接跟 Agent 说「帮我加个每天 18:00 检查部署的定时任务」，它会调用内置的 `botmux-schedule` 技能帮你建好。

## 四种创建方式

| 方式 | 适合 | 示例 |
| --- | --- | --- |
| 跟 Agent 对话 | 不想记语法 | 「每个工作日 9 点帮我汇总告警」 |
| 斜杠命令 `/schedule` | 群里快速建一个 | `/schedule 工作日每天9:00 检查服务状态` |
| CLI `botmux schedule add` | 需要更多选项（话题、模型、直到完成等） | `botmux schedule add "every 2h" "检查构建"` |
| Dashboard「定时任务」页 | 图形界面编辑、看执行日志、配前置条件和日历 | 点「新建定时任务」 |

在 Bot 的会话里运行 `botmux schedule add` 时，所在群会自动推断；在会话外运行要加 `--chat-id <群 ID>`。

<img src="/img/schedule-dashboard-list.png" alt="Dashboard 定时任务列表：每个任务显示类型、目标群、执行位置、下次执行时间，以及立即运行、启用、编辑、删除按钮" />

## 时间怎么写

**斜杠命令 `/schedule` 只认中文写法**（时间写在最前，后面跟提示词）：

| 写法 | 含义 |
| --- | --- |
| `每日17:50` / `每天9点` / `每天9点30分` | 每天定点 |
| `工作日每天9:00` / `每个工作日9:00` | 周一到周五（不看法定节假日，要看节假日请用[工作日历](#工作日历)） |
| `每周一10:00` | 每周某天 |
| `每月1号9:00` | 每月某天 |
| `每小时` / `每2小时` | 整点对齐 |
| `每30分钟` | 按分钟对齐 |
| `30分钟后` / `2小时后` / `明天9:00` | 一次性 |

**CLI 和 Dashboard 还支持更多格式**：

```bash
botmux schedule add "每日9:00" "早安"            # 上面的中文写法都能用
botmux schedule add "every 2h" "巡检服务"         # 固定间隔
botmux schedule add "30m" "提醒我喝水"            # 30 分钟后执行一次
botmux schedule add "0 9 * * *" "早安问候"        # 5 段 cron 表达式
botmux schedule add "2026-12-01T10:00" "发版提醒" # 指定时间执行一次
```

### 时区

cron 和「每天 9 点」这类写法的触发时间、「明天 9:00」怎么解析、卡片和 Dashboard 上显示的时间，都按同一个时区算。默认跟随主机时区。

服务器和你不在同一个时区时（比如主机在海外、人在北京），在 Dashboard「通用设置 → 定时任务 → 时区」里选 `Asia/Shanghai`（对应 `config.json` 的 `scheduleTimeZone`），或者设环境变量 `BOTMUX_SCHEDULE_TIMEZONE`。环境变量优先，详见[全局设置：定时任务时区](/global-settings#定时任务时区)。

例外是直接写日期时间：不带偏移的 `2026-12-01T10:00` 按主机时区理解，不跟这个设置。想固定时区就带上偏移，比如 `2026-12-01T10:00+08:00`。

## 结果发到哪：执行位置

**默认在群消息顶层执行**，即使你是在某个话题里建的任务，也不会自动回到这个话题。想换位置，选下面这几种：

| 执行位置 | 效果 | 怎么设置 |
| --- | --- | --- |
| 群消息顶层（默认） | 按 Bot / 群的会话模式执行；一个群里的顶层任务共用群级会话 | 默认；CLI `--top-level` |
| 指定话题 | 每次都投到同一个已有话题，接着那里的上下文 | CLI `--topic`（在话题会话里自动取当前话题，或用 `--root-msg-id <om_...>` 指定） |
| 每次新话题 | 每次触发都开一个全新话题、独立会话，适合日报 | prompt 前加「新话题」；CLI `--new-topic` |
| 任务独立话题 | 这个任务专属一个话题，每次都在里面续上；不同任务互不串 | prompt 前加「独立话题」或「专属话题」 |

Dashboard 的「执行位置」下拉框可以直接改。管理员发 `/dashboard schedules` 会收到一张私信卡片，在任务详情里也能暂停、恢复或切换执行位置。

### 每次新话题

```bash
# 斜杠命令：prompt 前加「新话题」
/schedule 每日17:30 新话题 生成今天的群讨论日报

# CLI
botmux schedule add "每日17:30" "生成日报" --new-topic
```

新话题的首条消息默认是「任务开始」提示。想自定义标题用 `--topic-title`（最多 200 字），非静默任务还能用模板：

| 占位符 | 替换为 |
| --- | --- |
| `{{date}}` | 触发当天的日期（按定时任务时区），如 `2026-11-05` |
| `{{date:-1d}}` / `{{date:+2d}}` | 往前 / 往后若干天的日期 |
| `{{owner}}` | @ 任务创建人（任务要记录了创建人才能用） |

```bash
botmux schedule add "每日9:00" "汇总昨天的告警" --new-topic --topic-title "{{date:-1d}} 告警日报 {{owner}}"
```

静默任务只支持固定标题，用模板会在保存时被拒绝。

### 任务独立话题

- 同一任务每次触发都在**同一个话题**里，上下文连续；
- 同一个群的不同任务各用各的话题，巡检和日报不会混进同一段会话；
- 话题在**第一次触发时才创建**：非静默任务先发一条「任务开始」消息当话题开头；静默任务等 Bot 第一次 `botmux send` 发言时才建。
- 只支持单个群的任务。

```text
/schedule 每日18:00 独立话题 汇总今天的服务巡检结果
/schedule 每个工作日9:00 静默 专属话题 生成晨报，有异常才说话
```

「静默」和「独立话题」等关键字可以组合，先后顺序随意。

### 跟随活跃话题

固定话题的任务有个问题：话题关了、大家搬到别的话题聊了，提醒就落在没人看的地方。加 `--follow-active`，任务每次触发都会重新挑地方：

```bash
# 在话题会话里建：起点就是当前话题
botmux schedule add "every 30m" "检查服务状态，异常才报警" --follow-active

# 或者指定起点
botmux schedule add "每日9:00" "晨会提醒" --follow-active --root-msg-id om_xxx
```

每次触发按顺序判断：

1. 上次投的话题还开着，而且有真人在里面说过话 → 继续投那里。
2. 否则 → 投到本群里**真人最近说话**的话题，并记成新落点（Bot 自己的回复不算）。这时任务在别人的会话里执行，任务自己的 `--workdir` 不生效。
3. 群里没有任何有真人发言的开着的话题，但上次落点还开着 → 留在原地。
4. 什么都没开着 → 新开一个顶层话题，记成新落点。

读不到会话记录时（比如数据库暂时不可用）不移动。`--follow-active` 不能和 `--top-level` / `--new-topic` 一起用，`schedule list` 里带 `↷跟随活跃话题` 标记。

## 静默执行

适合「没事别说话，有事才报警」的巡检：

```text
/schedule 每30分钟 静默 检查服务，挂了才报警
```

CLI 用 `--silent`。静默任务不发「任务开始」提示，由模型判断要不要用 `botmux send` 发消息；配合新话题时，只有真的要发言才会建话题。

## 管理任务

群里：

```text
/schedule list               # 查看任务（也可以写「列表」）
/schedule remove <id>        # 删除（删除）
/schedule disable <id>       # 暂停（禁用）
/schedule enable <id>        # 恢复（启用）
/schedule run <id>           # 立即执行一次（执行）
```

CLI：

```bash
botmux schedule list
botmux schedule pause <id>
botmux schedule resume <id>
botmux schedule run <id>
botmux schedule remove <id>
```

群里的 `/schedule list` 会显示每个任务的执行身份（`runAs`），没有可用身份的任务会提示「按身份鉴权的工具会 fail-closed」，见[执行身份](#执行身份与权限)。

### 原地修改频率、提示词或日历

不用删了重建，用 `update` 原地改：

```bash
botmux schedule update <id> --schedule "every 4h"         # 改执行频率，写法同 schedule add
botmux schedule update <id> --prompt-file report-prompt.md
# 短提示词也可以直接传（--prompt 与 --prompt-file 二选一）
botmux schedule update <id> --prompt "新的完整提示词"
# 可以一起改
botmux schedule update <id> --schedule "0 9 * * 1-5" --prompt-file report-prompt.md
```

`--schedule` 接受和 `schedule add` 一样的写法（`每日17:50`、`every 2h`、5 段 cron 等），写错了会直接报错并给出示例，任务不受影响。改频率后按新规则从现在起重新计算下次执行时间，不补跑、也不立即触发，命令输出会显示新规则和下次执行时间；暂停中的任务改完仍是暂停。任务正在执行的那几分钟里不能改频率（会提示等这次执行完），一次性时间也不能设成已经过去的时间。

任务 ID、静默设置、执行位置、Bash 前置条件、工作日历、创建人身份、启停状态和运行记录都保留。正在跑的那次继续用旧配置，下一次用新的。权限与 Dashboard 编辑一致：能改提示词的人就能改频率；委托创建的任务需要重新授权。完整字段见 `botmux schedule update --help`。

## 执行日志与多群绑定（Dashboard） {#logs-and-multi-chat}

这两项和 [Bash 前置条件](#bash-前置条件)一样，只在 Dashboard「定时任务」页里操作。

**看执行日志**：任务列表每一行都有「执行日志」按钮，点开能看到最近的执行记录：每次是「已提交模型」「前置条件未通过」还是「调度失败」，触发方式（调度器 / Dashboard 立即运行）、开始和结束时间、前置条件的结果。日志只记录前置检查和提交模型这一段，不包含模型生成的内容、终端输出和消息投递结果；只展示升级后产生的记录，查看日志不会触发或修改任务。

**一个任务绑多个群**：新建或编辑任务时，「绑定群聊」可以多选，最多 5 个群。

- 每个群各自独立调用一次模型，一个群失败不影响其他群；模型调用量会随群数增加。
- Bash 前置条件每次调度只跑一次，结果对所有群共用。
- 执行位置选「本任务专属话题」或指定某个已有话题时，只能绑一个群。

## 按任务指定模型

高频哨兵用便宜模型就够，每天一次的深度审查才需要最强的。`--model` / `--reasoning-effort` 只影响这一个任务，不改 Bot 配置：

```bash
# 高频哨兵：便宜模型 + 低思考强度
botmux schedule add "every 30m" "检查服务状态，异常才报警" \
  --silent --model gpt-5.2 --reasoning-effort low

# 每天一次的深度任务
botmux schedule add "每日9:00" "审查昨天合入 master 的所有 PR" \
  --new-topic --model gpt-5.6-sol --reasoning-effort ultra
```

Dashboard 表单里也有「模型」和「思考强度」，留空就跟随 Bot 配置。

**注意：只有新建会话的那次执行能换模型。** 模型是 CLI 进程的启动参数，进程起来后改不了：

| 执行位置 | 效果 |
| --- | --- |
| 每次新话题 | 每次都新起会话，模型**每次生效** |
| 任务独立话题 / 指定话题 / 群消息顶层 | 只有创建会话那次生效，之后沿用会话启动时的模型 |

思考强度可选 `low` / `medium` / `high` / `xhigh` / `max` / `ultra`，具体能用哪几档看模型。支持按任务换模型的 CLI 有 Codex、Codex App、Claude Code、Grok、TRAE（TraeX）、Kimi、ZCode 和 Remote Runner。到点时如果 Bot 已换成不支持的 CLI，或模型不再支持该档位，会丢掉这一项照常执行并记一条警告，不会因此跳过。

## 直到完成：有状态的跟进任务

「等 PR 合入后切回主干」「10 月 30 日之后删掉备份」这类事，用 `--until-done`：没做完就按计划继续，执行它的会话确认做完后标记完成，任务才结束。

```bash
# 每天 10:07 检查一次，最晚到 11 月 20 日
botmux schedule add "7 10 * * *" "PR #123 合入后，把集群切回 upstream 并清理临时 worktree" \
  --until-done --deadline 2026-11-20 --silent

# 某天之后去做；没做成每 6 小时再试（一次性任务默认隔 1 天）
botmux schedule add "2026-10-30T10:00" "删除升级前的备份目录" --until-done --retry-every 6h

# 执行会话确认做完后标记（先标记，再发最终答复）
botmux schedule done self --note "已切回 upstream，worktree 已清理"
```

`--deadline` 可以写日期、`7d`、`明天18:00` 等。

| 情况 | 普通任务 | `--until-done` 任务 |
| --- | --- | --- |
| 执行成功 | 一次性任务随即停用 | 不停用；一次性任务隔 `--retry-every` 再执行 |
| 执行出错 / daemon 重启打断 | 一次性任务随即停用 | 不停用；一次性任务最迟 1 小时后重试，循环任务等下一次 |
| 错过准点（daemon 停机等） | 跳到下一次 | 立即补跑一次，再接上正常节奏 |
| 到达 `--deadline` | — | 做最后一次收尾执行，之后关闭为「已到期」；收尾失败每 60 分钟重试，最多 3 次 |
| `botmux schedule done` | 不适用 | 关闭为「已完成」，记下结果说明 |

每次执行时，prompt 末尾会自动附上第几次执行、截止时间和标记完成的方法，你只需写清「等什么、做什么」。已完成或已到期的任务不能恢复，要继续就新建。跨 Bot 委托创建的任务暂不支持 `--until-done`。

**执行账本**：所有任务都会记执行、跳过、失败、错过的次数，`botmux schedule list` 里每个任务多两行：

```text
   状态: 直到完成 · 进行中 · 已执行 3 次 · 截止 2026/11/20 00:00:00
   账本: 执行 3 · 跳过 0 · 失败 1 · 错过 1（最近 2026/10/26 10:07:00）
```

**失败通知**：

- `--notify failing,expired`：在创建任务的话题（没有就在执行群）@ 创建人。`failing` 是连续失败 3 次时（每轮连败只通知一次），`expired` 是到期关闭时。默认不通知。
- 管理员兜底：不管有没有配 `--notify`，任一任务连续失败 3 次都会私信一位管理员一次，恢复成功后解除。

## Bash 前置条件

想先检查外部状态、满足条件才调用模型（省钱、少打扰），在 Dashboard 新建或编辑任务时打开「启用 Bash 前置条件」。

<img src="/img/schedule-bash-precondition.jpg" alt="Dashboard 任务表单中的 Bash 前置条件区域：启用开关、配置方式（直接填写 Bash / Bash 文件路径）和脚本输入框" width="520" />

**规则只有一条**：脚本退出码为 `0`，且标准输出去掉首尾空白后**正好是 `1`**，才继续调用模型。输出 `0`、别的内容、空输出或报错，都会跳过这一次。

```bash
#!/usr/bin/env bash
# 换成 daemon 主机上你要检查的东西
if test -f /srv/my-service/ready.flag; then
  printf '1\n'
else
  printf '0\n'
fi
```

想给这次模型调用补充信息，写到文件描述符 3（FD 3），内容会追加到 prompt：

```bash
printf '1\n'
cat >&3 <<'PROMPT'
部署检查已通过，请结合这一状态继续分析。
PROMPT
```

FD 3 的内容会发给模型、可能进入会话记录，不要输出密钥或令牌。

**两种配置方式**：

- **直接填写 Bash**：脚本存在任务配置里。
- **Bash 文件路径**：文件必须放在 Dashboard 显示的受信目录 `<dataDir>/schedule-preconditions/trusted-files/` 下（daemon 主机上），填**完整绝对路径**。相对路径、`~`、目录本身、目录外文件、路径中带符号链接都会被拒绝。每次测试和触发都会重新读文件，改了文件不用重新保存任务。

配好后点「测试前置条件」：它会在 daemon 主机上真实运行当前表单里（还没保存的）内容，显示通过、未通过或错误码。测试不会保存配置、不调用模型、不计入执行次数，但脚本本身的副作用（写文件、发请求）会真实发生。

开关关掉时只是暂停前置条件，任务照常执行，脚本保留；清空脚本或路径再保存才会删掉。

> 升级前保存在受信目录外的旧文件路径会保留，但启用时测试和执行都会拒绝（不调用模型）。请手动把文件移进受信目录，改成新的完整路径，测试通过后保存。

## 工作日历

「工作日 9 点」按周一到周五算，遇到法定节假日和调休补班就不准了。给任务绑定工作日历，调度器会按日历过滤：

```bash
botmux schedule add "0 9 * * *" "生成日报" --calendar cn    # 仅法定工作日执行
botmux schedule calendars                                  # 查看可用日历
```

> 想按中国法定工作日跑，用 **每天的 cron + 日历**（如 `0 9 * * *`）。`0 9 * * 1-5` 本身没有周末触发，绑定日历也变不出周末补班那天。

### 内置中国法定工作日历

ID 为 `cn`，显示为「中国法定工作日历」，时区 `Asia/Shanghai`，包含放假和周末补班。**目前已核实覆盖 2026-01-01 至 2026-12-31**，依据是[国务院办公厅关于2026年部分节假日安排的通知](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)（国办发明电〔2025〕7号）。`schedule calendars` 会显示来源信息。

它表示全国统一的放假调休，不代表每个单位的实际排班；地方节日、企业排班、港澳台及其他国家不在内置范围。超出覆盖范围的日期（比如还没核实的 2027 年）不会推算，任务会停止自动执行并记录 `calendar_out_of_coverage`，跨年前请升级到包含下一年数据的版本。

### 自定义日历

公司排班等情况，可以给 Bot 加自己的日历。默认路径是 `~/.botmux/bots/<appId>/work-calendars.json`（和该 Bot 的 `schedules.json` 同目录），各 Bot 互相独立。改完文件无需重启，下次检查就会读到新内容。

下面是**虚构的演示数据**：

```json
{
  "version": 1,
  "calendars": {
    "demo": {
      "timeZone": "Asia/Shanghai",
      "displayNames": { "zh": "演示工作日历", "en": "Demo Work Calendar" },
      "coverage": { "start": "2027-12-30", "end": "2028-12-31" },
      "workWeek": [1, 2, 3, 4, 5],
      "restDates": ["2028-01-04"],
      "workDates": ["2028-01-01", "2028-01-08"]
    }
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `version` | 文件格式版本，目前为 `1` |
| `calendars` | 日历名 → 定义；名称 1–64 位字母、数字、`_` 或 `-`，首字符须为字母或数字 |
| `displayNames` | 可选，中英文显示名；不填就显示日历 ID |
| `timeZone` | 判断「当天是哪天」用的 IANA 时区 |
| `coverage.start/end` | 数据已确认覆盖的日期区间（含首尾），`YYYY-MM-DD` |
| `workWeek` | 默认工作星期，`0` 是周日、`1` 是周一…… |
| `restDates` | 额外的休息日 |
| `workDates` | 额外的工作日（如周末补班） |

除 `displayNames` 外都必填。日期重复、同一天既休息又上班、时区非法、区间反了，都会让这份定义无效；文件最大 1 MiB。一份定义坏了不影响其它定义，但整个文件格式损坏时，绑定它的任务都不会自动执行。`cn` 是保留名，本地文件不能覆盖。

### 绑定、修改与解绑

```bash
botmux schedule add "0 9 * * *" "生成日报" --calendar cn
botmux schedule update <task-id> --calendar cn                # 改绑
botmux schedule update <task-id> --calendar-day-type restday  # 改为仅休息日执行（默认 workday）
botmux schedule update <task-id> --calendar none              # 解绑
```

Dashboard 表单的「自定义工作日历」下拉框选日历，「执行日期」选「仅工作日」或「仅休息日」，选「不使用工作日历」即解绑。任务行会显示「日历允许的下次触发」和判断原因。

### 日历怎么影响执行

| 触发方式 | 行为 |
| --- | --- |
| 自动 cron / interval | 到点先查日历，不符合所选日期类型就跳过，等下一次；不补跑 |
| 一次性任务 | 不支持绑定日历 |
| Dashboard「立即运行」/ `schedule run` | 手动执行绕过日历（前置条件照常检查） |

- 日历判断在前置条件、模型调用、建话题之前。被跳过记为「跳过」，不算失败，也不消耗重复次数。
- 日历缺失、损坏或超出覆盖范围时不执行，记录原因，但不会自动停用任务；修好数据后后续触发恢复正常。日历读取失败按一次失败记账，连续 3 次会触发失败通知。
- 暂停的任务不能 `schedule run`，先恢复。暂停会取消还没执行的手动执行请求。

常见原因码：`work_date` / `work_week` 允许执行，`rest_date` / `rest_week` 跳过；`calendar_missing`（日历不存在）、`calendar_invalid`（格式错误）、`calendar_out_of_coverage`（超出覆盖范围）。

如果你的业务脚本里自己也写了「周一到周五才干活」，记得去掉，否则日历放行的周末补班仍会被脚本跳过。

## 执行身份与权限

任务到点运行时，以谁的身份调用 `lark-cli --as user`、`bytedcli` 这类按用户鉴权的工具？规则是：

1. 有人认领过 → 认领人；
2. 否则 → 创建人（真人在飞书里建任务时自动记录）。

每次触发都会重新确认这个人还能操作本 Bot。

| 在哪建的任务 | 记录的创建人 |
| --- | --- |
| 飞书里真人发 `/schedule` 或让 Agent 建 | 发消息的人 |
| Dashboard 经平台飞书登录 | 登录的人（此人须能操作本 Bot，否则按 Bot 主人记录） |
| Dashboard 本地令牌链接 | Bot 主人（Owner） |
| 宿主终端 `botmux schedule add` | 不记个人；可用 `--run-as <ou_... 或飞书邮箱>` 指定执行身份，此人必须能操作本 Bot |

`--run-as` 只能在宿主终端用；在会话里建的任务一律以当前发起人身份运行。

### 认领卡片

如果 Bot 开启了用户身份鉴权（`bots.json` 的 `triggerUserAuth`），而任务没有可用身份（没记录创建人，或创建人/认领人已无权限），到点时 Bot 会在任务所在群（或话题）发一张认领卡片，不会让任务一直悄悄失败：

<img src="/img/schedule-identity-claim-card.jpg" alt="定时任务认领卡片的四种状态：待认领（没有创建人）、待认领（创建人已无权限）、已认领、已不需要认领" />

- 点「认领，以我的身份执行」：之后每次到点都以你的身份运行。身份取自飞书回传的点击人，不能伪造。
- 已认领后可以「改为我认领」或「重新执行」。
- 只有能操作本 Bot 的成员能点；每个任务只有一张卡，之后到点会原地刷新。

### 谁能管理任务

- 新建、运行、暂停、恢复、删除、更新任务，都按**本轮真人发送者**是否是本 Bot 的操作者来判断。机器人消息、历史消息、自动续跑都不能代替真人授权。
- 任务的执行回合可以用 `botmux schedule pause self` / `remove self` 停掉自己（每次会复核创建人仍是管理员、仍在群里；宿主终端建的无创建人任务同样可以）。它只能管当前这一个任务，不能改 prompt、恢复或强制运行。
- 想「发完最终结果再删掉自己」，用一条命令完成，不要拆成两步：

```bash
botmux send --response-kind final --schedule-remove-self --no-mention "任务已完成"
```

BotMux 会先确认结果发出去了，再删除当前任务。如果返回里 `scheduleSelfCleanup.removed` 为 `false`，原样重试即可，不会重复发消息。

任务的权威记录保存在宿主侧的 SQLite 数据库里，`schedules.json` 只是可重建的副本，手动往里加记录不会让任务生效。所以所有写操作都要送到所属 Bot 的 daemon；daemon 不可用时命令会直接报错，而不是只改 JSON 留下一个永远不跑的任务。

## 高级：跨 Bot 委托创建

当真人在 Bot A 的当前回合里明确要 Bot B 建定时任务，A 需要在受管派发里显式申请：

```bash
botmux dispatch --bot-app cli_target --title "轮询任务" --brief "创建并维护状态轮询" \
  --delegate schedule:create
```

宿主还要在 `~/.botmux/config.json` 打开（默认关闭）：

```json
{
  "scheduleDelegation": {
    "createEnabled": true,
    "runEnabled": true,
    "maxTasksPerTurn": 64,
    "runScopes": ["bytedcli"],
    "selfManageEnabled": true
  }
}
```

| 配置 | 作用 |
| --- | --- |
| `createEnabled` | 允许签发新委托，默认关；关掉后不再签发，靠 `botGrants` 建的任务也会停止后续执行 |
| `runEnabled` | 已委托的任务能否继续运行，不写即开；急停开关 |
| `maxTasksPerTurn` | 一个派发回合最多建几个任务，默认 64，上限 1024 |
| `runScopes` | 委托任务以后每次运行可沿用原真人的哪些个人凭据，目前只有 `bytedcli`，默认空 |
| `selfManageEnabled` | 委托任务能否在自己的回合里暂停/删除自己，默认关 |
| `defaultOnDispatchFromBotAppIds` | 这些来源 Bot 的受管派发默认带上 `schedule:create`；单次可用 `--no-delegate schedule:create` 取消 |
| `botGrants` | 机器人调度授权：按「来源 Bot + 目标 Bot + 群」预先授权，非管理员触发的派单也能以「控制管理员」名义建任务；需同时打开 `createEnabled` |

这几项也可以在 Dashboard 的「全局设置 → 实验性配置」里改（「跨 Bot 委托创建定时任务」「委托任务自管理」「机器人调度授权」）。

使用 `runScopes` 时，来源和目标 Bot 都要开启 `triggerUserAuth`，并让目标 Bot 的 `lark-cli`、`bytedcli` 都走身份隔离：

```json
"triggerUserAuth": {
  "enabled": true,
  "tools": ["lark-cli", "bytedcli"]
}
```

限制：委托只能一跳，绑定目标 Bot 当前这次派发回合，回合结束即失效；任务只能落在原派发群的顶层或当前话题，不支持 `--new-topic`、`--follow-active`、多群或再转委托。相同请求重试会返回原任务，不会重复创建。
