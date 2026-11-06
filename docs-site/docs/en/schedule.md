# Scheduled Tasks

<video src="../img/video-v5-automation-en.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

Let a bot do work on a schedule: a daily morning report, a service check every 30 minutes, cleaning up a branch once a PR merges. When a task is due, the bot hands your prompt to its AI CLI and posts the result back to Feishu/Lark.

## Quick start

The fastest way is to send this in a group or topic:

```text
/schedule 每日17:50 帮我看看AI圈有什么新闻
```

(`每日17:50` means "every day at 17:50"; the rest is the prompt.) The bot replies with the task ID, next run time and execution position. Use `/schedule list` to view tasks and `/schedule remove <id>` to delete one.

You can also just tell the agent "add a scheduled task to check deployment every day at 18:00". It uses the built-in `botmux-schedule` skill to create it.

## Four ways to create a task

| Way | Good for | Example |
| --- | --- | --- |
| Ask the agent | Not remembering syntax | "Summarize alerts every workday at 9" |
| Slash command `/schedule` | Quick task from a chat | `/schedule 工作日每天9:00 检查服务状态` |
| CLI `botmux schedule add` | More options (topics, model, until-done…) | `botmux schedule add "every 2h" "check the build"` |
| Dashboard **Scheduled Tasks** page | Visual editing, run logs, preconditions, calendars | Click **New Task** |

When you run `botmux schedule add` inside a bot session, the chat is inferred. Outside a session, add `--chat-id <chat ID>`.

<img src="/img/schedule-dashboard-list.png" alt="Dashboard scheduled task list: each task shows its type, target chat, execution position and next run, with Run Now, Enable, Edit and Delete buttons" />

## Writing the schedule

**The `/schedule` slash command only understands Chinese phrases** (schedule first, then the prompt):

| Phrase | Meaning |
| --- | --- |
| `每日17:50` / `每天9点` / `每天9点30分` | Every day at a time |
| `工作日每天9:00` / `每个工作日9:00` | Monday to Friday (ignores public holidays; use a [work calendar](#work-calendars) for those) |
| `每周一10:00` | Every week on a day (一 = Monday … 日 = Sunday) |
| `每月1号9:00` | Every month on a day |
| `每小时` / `每2小时` | Every hour / every N hours, on the hour |
| `每30分钟` | Every N minutes, clock-aligned |
| `30分钟后` / `2小时后` / `明天9:00` | Once: in 30 minutes / in 2 hours / tomorrow at 9:00 |

**The CLI and Dashboard accept more formats:**

```bash
botmux schedule add "每日9:00" "good morning"          # all Chinese phrases above work
botmux schedule add "every 2h" "check the services"    # fixed interval
botmux schedule add "30m" "remind me to drink water"   # once, 30 minutes from now
botmux schedule add "0 9 * * *" "good morning"         # 5-field cron
botmux schedule add "2026-12-01T10:00" "release reminder"  # once at a time
```

### Time zone

Cron and phrases like "every day at 9" fire, "tomorrow 9:00" is parsed, and times on cards and in the Dashboard are shown, all in one time zone. By default it follows the host.

If the server and you are in different time zones (say the host is overseas and you're in Beijing), pick `Asia/Shanghai` under Dashboard "General → Scheduled tasks → Timezone" (stored as `scheduleTimeZone` in `config.json`), or set the environment variable `BOTMUX_SCHEDULE_TIMEZONE`. The environment variable wins. See [Global Settings: Scheduled task timezone](/en/global-settings#scheduled-task-timezone).

The exception is an explicit date-time: `2026-12-01T10:00` without an offset is read in the host time zone, not this setting. To pin a zone, include the offset, e.g. `2026-12-01T10:00+08:00`.

## Where results go: execution position

**By default a task runs at the chat's top level**, even if you created it inside a topic. It does not automatically return to that topic. To change that, pick one of these:

| Execution position | Effect | How to set |
| --- | --- | --- |
| Chat top level (default) | Follows the bot / chat session mode; top-level tasks in one chat share the chat-level session | Default; CLI `--top-level` |
| A specific topic | Every run goes to one existing topic and continues its context | CLI `--topic` (uses the current topic inside a topic session, or `--root-msg-id <om_...>`) |
| New topic each run | Each run opens a fresh topic with its own session; good for daily reports | Prefix the prompt with `新话题`; CLI `--new-topic` |
| Dedicated task topic | The task owns one topic and keeps continuing in it; tasks don't mix | Prefix the prompt with `独立话题` or `专属话题` |

The Dashboard **Execution position** dropdown changes it directly. An admin can also send `/dashboard schedules` to get a DM card; the task detail view there can pause, resume or switch the execution position.

### New topic each run

```bash
# Slash command: prefix the prompt with 新话题 ("new topic")
/schedule 每日17:30 新话题 生成今天的群讨论日报

# CLI
botmux schedule add "每日17:30" "write the daily report" --new-topic
```

The first message of the new topic is the "task started" notice by default. Set your own title with `--topic-title` (up to 200 characters). Non-silent tasks can use placeholders:

| Placeholder | Becomes |
| --- | --- |
| `{{date}}` | The run's date in the schedule time zone, e.g. `2026-11-05` |
| `{{date:-1d}}` / `{{date:+2d}}` | A date some days before / after |
| `{{owner}}` | An @mention of the task creator (only for tasks with a recorded creator) |

```bash
botmux schedule add "每日9:00" "summarize yesterday's alerts" --new-topic --topic-title "{{date:-1d}} alert report {{owner}}"
```

Silent tasks only support fixed titles; templates are rejected on save.

### Dedicated task topic

- Every run of the same task lands in **the same topic**, so context carries over.
- Different tasks in the same chat each get their own topic, so a health check and a daily report never share a session.
- The topic is **created on the first run**: a non-silent task posts a "task started" message to start the topic; a silent task waits until the bot first speaks with `botmux send`.
- Only single-chat tasks are supported.

```text
/schedule 每日18:00 独立话题 汇总今天的服务巡检结果
/schedule 每个工作日9:00 静默 专属话题 生成晨报，有异常才说话
```

Keywords such as `静默` (silent) and `独立话题` can be combined in any order.

### Follow the active topic

A fixed-topic task has a weakness: when the topic closes and people move elsewhere, reminders land where nobody looks. With `--follow-active`, the task picks a target again on every run:

```bash
# Created inside a topic session: the starting point is the current topic
botmux schedule add "every 30m" "check service status, alert only on failure" --follow-active

# Or give the starting point explicitly
botmux schedule add "每日9:00" "stand-up reminder" --follow-active --root-msg-id om_xxx
```

Each run checks, in order:

1. The last topic is still open and a human has spoken in it → post there again.
2. Otherwise → post to the topic in this chat where **a human spoke most recently**, and remember it (bot replies don't count). The task then runs in that existing session, so its own `--workdir` doesn't apply.
3. No open topic with human messages, but the last topic is still open → stay put.
4. Nothing is open → open a new top-level topic and remember it.

If session records can't be read (for example the database is temporarily unavailable), the target doesn't move. `--follow-active` can't be combined with `--top-level` / `--new-topic`. In `schedule list` these tasks are marked `↷跟随活跃话题`.

## Silent mode

For checks that should stay quiet unless something is wrong:

```text
/schedule 每30分钟 静默 检查服务，挂了才报警
```

On the CLI use `--silent`. A silent task posts no "task started" notice; the model decides whether to send anything with `botmux send`. With a new topic, the topic is only created when there's something to say.

## Managing tasks

In a chat:

```text
/schedule list               # list tasks (also 列表)
/schedule remove <id>        # delete (also 删除)
/schedule disable <id>       # pause (also 禁用)
/schedule enable <id>        # resume (also 启用)
/schedule run <id>           # run once now (also 执行)
```

CLI:

```bash
botmux schedule list
botmux schedule pause <id>
botmux schedule resume <id>
botmux schedule run <id>
botmux schedule remove <id>
```

In a chat, `/schedule list` shows each task's run-as identity (`runAs`). A task with no usable identity is flagged, because tools that need a user identity will fail closed. See [Run-as identity](#run-as-identity-and-permissions).

### Change only the prompt

No need to delete and recreate. Use `update`:

```bash
botmux schedule update <id> --prompt-file report-prompt.md
# Short prompts can be passed inline (use one or the other)
botmux schedule update <id> --prompt "new full prompt"
```

The task ID, schedule, enabled state, execution position and run history are kept, and nothing is re-run. A run already in progress keeps the old prompt; the next run uses the new one.

Tasks with a Bash precondition can't be changed with `update`; edit them in the Dashboard (the precondition is bound to a checksum of the task content, so changing the prompt directly would make every later run fail the check).

## Run logs and multiple groups (Dashboard) {#logs-and-multi-chat}

Like the [Bash precondition](#bash-precondition), these two are only available on the Dashboard's **Scheduled Tasks** page.

**Run logs**: every row in the task list has a **Run logs** button. It shows recent runs: whether each one was submitted to the model, skipped because the precondition failed, or failed to schedule, plus the trigger (scheduler / Dashboard run now), start and end times and the precondition result. The log only covers the precondition check and the submission to the model; it does not include model output, terminal output or message delivery. Only runs recorded after the upgrade are shown, and viewing the log never triggers or changes the task.

**One task, several groups**: when creating or editing a task, **Bound groups** accepts several groups, up to 5.

- Each group calls the model independently, and a failure in one group doesn't stop the others; model usage grows with the number of groups.
- The Bash precondition runs once per schedule, and its result applies to every group.
- With the execution position set to **Dedicated topic for this task** or to a specific existing topic, only one group can be bound.

## Per-task model

A high-frequency sentinel is fine on a cheap model; a daily deep review deserves the strongest one. `--model` / `--reasoning-effort` apply to this task only and leave the bot config alone:

```bash
# High-frequency sentinel: cheap model, low effort
botmux schedule add "every 30m" "check service status, alert only on failure" \
  --silent --model gpt-5.2 --reasoning-effort low

# Once-a-day deep task
botmux schedule add "每日9:00" "review every PR merged to master yesterday" \
  --new-topic --model gpt-5.6-sol --reasoning-effort ultra
```

The Dashboard form has **Model** and **Reasoning effort** fields too; leave them empty to follow the bot config.

**Note: only the run that starts a new session can switch models.** The model is a launch argument of the CLI process and can't change once it's running:

| Execution position | Effect |
| --- | --- |
| New topic each run | Every run starts a new session, so the model applies **every time** |
| Dedicated task topic / specific topic / chat top level | Only the run that creates the session applies it; later runs keep the session's original model |

Reasoning effort can be `low` / `medium` / `high` / `xhigh` / `max` / `ultra`; which levels work depends on the model. Per-task models are supported on Codex, Codex App, Claude Code, Grok, TRAE (TraeX), Kimi, ZCode and Remote Runner. If at run time the bot has switched to a CLI without support, or the model no longer supports the level, that setting is dropped with a warning and the task runs anyway; it is never skipped for this reason.

## Until done: stateful follow-up tasks

For jobs like "switch back to main once the PR merges" or "delete the backup after Oct 30", use `--until-done`. The task keeps running on schedule until the session running it confirms the work is done and marks it complete.

```bash
# Check daily at 10:07, until Nov 20 at the latest
botmux schedule add "7 10 * * *" "After PR #123 merges, switch the cluster back to upstream and clean up the temporary worktree" \
  --until-done --deadline 2026-11-20 --silent

# Do it after a date; if not done, retry every 6 hours (one-shot default is 1 day)
botmux schedule add "2026-10-30T10:00" "Delete the pre-upgrade backup directory" --until-done --retry-every 6h

# From the running session, once the work is done (mark first, then send the final reply)
botmux schedule done self --note "Back on upstream; worktree cleaned up"
```

`--deadline` accepts a date, `7d`, `明天18:00` (tomorrow 18:00) and similar.

| Situation | Normal task | `--until-done` task |
| --- | --- | --- |
| Run succeeds | One-shot task is disabled | Stays on; one-shot task runs again after `--retry-every` |
| Run fails / interrupted by a daemon restart | One-shot task is disabled | Stays on; one-shot task retries within 1 hour, recurring task waits for the next run |
| Missed run (daemon down, etc.) | Skips to the next one | Catches up once right away, then resumes its rhythm |
| `--deadline` reached | — | One final closing run, then closes as "expired"; a failed closing run retries every 60 minutes, up to 3 times |
| `botmux schedule done` | N/A | Closes as "completed" with the result note |

Each run gets a footer appended to the prompt with the run number, deadline and how to mark completion, so your prompt only needs to say what to wait for and what to do. Completed or expired tasks can't be resumed; create a new one. Tasks created through cross-bot delegation don't support `--until-done` yet.

**Run ledger**: every task records runs, skips, failures and misses. `botmux schedule list` shows two extra lines per task:

```text
   状态: 直到完成 · 进行中 · 已执行 3 次 · 截止 2026/11/20 00:00:00
   账本: 执行 3 · 跳过 0 · 失败 1 · 错过 1（最近 2026/10/26 10:07:00）
```

(Status: until-done · in progress · ran 3 times · deadline …; Ledger: ran 3 · skipped 0 · failed 1 · missed 1.)

**Failure notifications**:

- `--notify failing,expired`: @mentions the creator in the topic where the task was created (or the target chat if there is none). `failing` fires after 3 failures in a row (once per streak); `expired` fires when the task closes at its deadline. Off by default.
- Admin fallback: whether or not `--notify` is set, any task that fails 3 times in a row DMs one admin once; it resets after a successful run.

## Bash precondition

To check something first and call the model only when a condition holds (saving cost and noise), turn on **Enable Bash precondition** when creating or editing a task in the Dashboard.

<img src="/img/schedule-bash-precondition.jpg" alt="Bash precondition section of the Dashboard task form: enable switch, configuration source (enter Bash directly / Bash file path) and script box" width="520" />

**There is one rule**: the script must exit with `0` and its stdout, trimmed, must be **exactly `1`** for the model to be called. Output `0`, anything else, empty output or an error skips this run.

```bash
#!/usr/bin/env bash
# Replace with what you actually need to check on the daemon host
if test -f /srv/my-service/ready.flag; then
  printf '1\n'
else
  printf '0\n'
fi
```

To give this model call extra context, write to file descriptor 3 (FD 3); it is appended to the prompt:

```bash
printf '1\n'
cat >&3 <<'PROMPT'
The deployment check passed. Continue the analysis with this in mind.
PROMPT
```

FD 3 content is sent to the model and may end up in the session log. Never print secrets or tokens.

**Two ways to configure it:**

- **Enter Bash directly**: the script is stored with the task.
- **Bash file path**: the file must live in the trusted directory the Dashboard shows, `<dataDir>/schedule-preconditions/trusted-files/` on the daemon host. Enter the **full absolute path**. Relative paths, `~`, the directory itself, files outside it and paths containing symlinks are rejected. The file is re-read on every test and run, so editing it doesn't require re-saving the task.

Then click **Test precondition**. It really runs the current (unsaved) form content on the daemon host and shows passed, not passed, or an error code. Testing doesn't save, doesn't call the model and doesn't count as a run, but the script's own side effects (writing files, network calls) do happen.

Turning the switch off only pauses the precondition; the task still runs and the script is kept. Clear the script or path and save to remove it.

> File paths saved outside the trusted directory before an upgrade are kept, but while enabled both testing and scheduled runs refuse them (no model call). Move the file into the trusted directory yourself, update the full path, test, then save.

## Work calendars

"Workdays at 9" means Monday to Friday, which breaks around public holidays and make-up workdays. Bind a work calendar and the scheduler filters runs by it:

```bash
botmux schedule add "0 9 * * *" "write the daily report" --calendar cn   # statutory workdays only
botmux schedule calendars                                                # list available calendars
```

> To run on Chinese statutory workdays, use **a daily cron plus the calendar** (e.g. `0 9 * * *`). `0 9 * * 1-5` never fires on weekends, so a calendar can't create the weekend make-up workday for it.

### Built-in China statutory calendar

ID `cn`, shown as "China Statutory Work Calendar", time zone `Asia/Shanghai`, including holidays and weekend make-up workdays. **Currently verified for 2026-01-01 to 2026-12-31**, based on the [State Council General Office notice on 2026 holidays](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm) (Guobanfa Mingdian [2025] No. 7). `schedule calendars` prints the source details.

It represents the nationwide holiday arrangement, not every organization's actual shifts; local holidays, company rosters, Hong Kong/Macao/Taiwan and other countries are out of scope. Dates outside coverage (such as the not-yet-verified 2027) are never guessed: the task stops running automatically and records `calendar_out_of_coverage`. Upgrade to a release with next year's data before the year ends.

### Custom calendars

For company rosters and the like, add your own calendar to the bot. The default path is `~/.botmux/bots/<appId>/work-calendars.json` (next to that bot's `schedules.json`); each bot's calendars are separate. Changes are picked up on the next check without a restart.

The following is **made-up demo data**:

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

| Field | Meaning |
| --- | --- |
| `version` | File format version, currently `1` |
| `calendars` | Calendar name → definition; names are 1–64 letters, digits, `_` or `-`, starting with a letter or digit |
| `displayNames` | Optional Chinese/English display names; the calendar ID is shown if omitted |
| `timeZone` | IANA time zone used to decide "which day it is" |
| `coverage.start/end` | Inclusive date range the data is confirmed for, `YYYY-MM-DD` |
| `workWeek` | Default working weekdays; `0` is Sunday, `1` is Monday, … |
| `restDates` | Extra days off |
| `workDates` | Extra workdays (e.g. weekend make-up days) |

Everything except `displayNames` is required. Duplicate dates, a day listed as both rest and work, an invalid time zone or a reversed range invalidate that definition. The file is limited to 1 MiB. One bad definition doesn't affect the others, but a malformed file stops every task bound to it from running automatically. `cn` is reserved and can't be overridden locally.

### Bind, change and unbind

```bash
botmux schedule add "0 9 * * *" "write the daily report" --calendar cn
botmux schedule update <task-id> --calendar cn                # rebind
botmux schedule update <task-id> --calendar-day-type restday  # run on rest days only (default: workday)
botmux schedule update <task-id> --calendar none              # unbind
```

In the Dashboard form, pick a calendar under **Custom Work Calendar**, choose **Workdays only** or **Rest days only** under **Run on**, or choose **No calendar filter** to unbind. Task rows show the **Next calendar-eligible trigger** and the reason.

### How calendars affect runs

| Trigger | Behavior |
| --- | --- |
| Automatic cron / interval | Checks the calendar when due; if the day type doesn't match, skips and waits for the next run, with no catch-up |
| One-shot task | Can't be bound to a calendar |
| Dashboard **Run Now** / `schedule run` | Manual runs bypass the calendar (preconditions still apply) |

- The calendar check happens before the precondition, the model call and topic creation. A skip is recorded as a skip, not a failure, and doesn't use up repeat counts.
- If the calendar is missing, broken or out of coverage, the task doesn't run and the reason is recorded, but the task isn't disabled; once the data is fixed, later runs proceed. A calendar read failure counts as one failure, and 3 in a row trigger failure notifications.
- A paused task can't `schedule run`; resume it first. Pausing cancels pending manual run requests.

Common reason codes: `work_date` / `work_week` allow the run, `rest_date` / `rest_week` skip it; `calendar_missing` (no such calendar), `calendar_invalid` (bad format), `calendar_out_of_coverage` (outside the covered dates).

If your own job script also hard-codes "Monday to Friday only", remove that, or it will still skip weekend make-up workdays the calendar allows.

## Run-as identity and permissions

When a task runs, whose identity is used for per-user tools like `lark-cli --as user` and `bytedcli`? The rule:

1. Someone claimed it → the claimant;
2. Otherwise → the creator (recorded automatically when a human creates the task in Feishu/Lark).

Every run re-checks that this person can still operate the bot.

| Where the task was created | Recorded creator |
| --- | --- |
| A human in Feishu/Lark via `/schedule` or the agent | The message sender |
| Dashboard through platform Feishu login | The signed-in person (must be able to operate the bot; otherwise the bot owner is recorded) |
| Dashboard local token link | The bot owner |
| Host terminal `botmux schedule add` | No person; use `--run-as <ou_... or Feishu email>` to set the run-as identity, who must be able to operate the bot |

`--run-as` only works from the host terminal; tasks created inside a session always run as the current requester.

### Claim card

If the bot has user identity auth on (`triggerUserAuth` in `bots.json`) and a task has no usable identity (no recorded creator, or the creator/claimant lost access), the bot posts a claim card in the task's chat (or topic) when it fires, instead of letting the task fail silently:

<img src="/img/schedule-identity-claim-card.jpg" alt="Four states of the scheduled-task claim card: pending (no creator), pending (creator lost access), claimed, and no longer needs a claim" />

- Click **Claim — run it as me**: every later run uses your identity. The identity comes from the clicker Feishu reports, so it can't be forged.
- After a claim you can use **Claim it for me instead** or **Run again**.
- Only members who can operate the bot can click. Each task has one card, refreshed in place on later runs.

(The screenshot shows the Chinese UI.)

### Who can manage tasks

- Creating, running, pausing, resuming, deleting and updating tasks are all judged by whether **the human sender of the current turn** is an operator of this bot. Bot messages, old messages and automatic continuations can't stand in for a human.
- A task's own run can stop itself with `botmux schedule pause self` / `remove self` (re-checking each time that the creator is still an admin and still in the chat; host-terminal tasks with no creator can do this too). It can only manage this one task: no prompt changes, no resume, no forced runs.
- To "send the final result, then delete myself", use one command instead of two steps:

```bash
botmux send --response-kind final --schedule-remove-self --no-mention "Task complete"
```

BotMux first confirms the result was delivered, then deletes the current task. If `scheduleSelfCleanup.removed` in the result is `false`, retry the same command; the message won't be sent twice.

The authoritative task records live in a host-side SQLite database; `schedules.json` is only a rebuildable copy, and hand-adding records there won't make a task run. So every write goes to the owning bot's daemon. If the daemon is unavailable the command fails loudly, instead of editing only the JSON and leaving a task that never runs.

## Advanced: cross-bot delegated creation

When a human explicitly asks Bot A, in the current turn, to have Bot B create a scheduled task, A must request the capability on the managed dispatch:

```bash
botmux dispatch --bot-app cli_target --title "Polling task" --brief "Create and maintain the poll" \
  --delegate schedule:create
```

The host must also turn it on in `~/.botmux/config.json` (off by default):

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

| Setting | Effect |
| --- | --- |
| `createEnabled` | Allow new delegations; off by default. Turning it off stops new ones, and tasks created via `botGrants` also stop running |
| `runEnabled` | Whether already delegated tasks keep running; on if omitted. The emergency stop |
| `maxTasksPerTurn` | Max tasks per dispatch turn; default 64, max 1024 |
| `runScopes` | Personal credentials a delegated task may reuse on later runs; currently only `bytedcli`; empty by default |
| `selfManageEnabled` | Whether delegated tasks may pause/remove themselves from their own runs; off by default |
| `defaultOnDispatchFromBotAppIds` | Managed dispatches from these source bots request `schedule:create` by default; opt out per dispatch with `--no-delegate schedule:create` |
| `botGrants` | Bot scheduling grants: pre-authorize by "source bot + target bots + chats", so dispatches not triggered by an admin can still create tasks on behalf of a "controller admin"; requires `createEnabled` |

These are also editable in the Dashboard under **Global Settings → Experimental** (**Cross-bot delegated scheduled tasks**, **Delegated task self-management**, **Bot scheduling grants**).

With `runScopes`, both the source and target bots must enable `triggerUserAuth`, and the target bot must route both `lark-cli` and `bytedcli` through identity isolation:

```json
"triggerUserAuth": {
  "enabled": true,
  "tools": ["lark-cli", "bytedcli"]
}
```

Limits: delegation is single-hop and bound to the target bot's current dispatch turn; it expires when the turn ends. Tasks can only land at the top level of the original dispatch chat or in the current topic; `--new-topic`, `--follow-active`, multiple chats and re-delegation aren't supported. Retrying the same request returns the original task instead of creating a duplicate.
