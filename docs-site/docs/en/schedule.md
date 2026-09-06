# Scheduled Tasks

Supports three schedule types plus natural-language input, posting a follow-up message in **the original topic where the task was created** and executing it when due (no separate thread is opened; the working directory matches the one at creation time).

## Two Ways to Create

- **Slash command** (quick): `/schedule 每日17:50 帮我看看AI圈有什么新闻`
- **Conversational trigger** (flexible): just tell the agent "add me a scheduled task to check deployment every day at 18:00", which automatically triggers the `botmux-schedule` skill.

## Supported Formats

```bash
# Chinese natural language
/schedule 每日17:50 帮我看看AI圈有什么新闻
/schedule 工作日每天9:00 检查服务状态
/schedule 每周一10:00 生成周报

# One-time tasks
/schedule 30分钟后 检查部署状态
/schedule 明天9:00 发早会提醒

# English duration / interval / cron
/schedule every 2h 巡检服务
/schedule 30m 提醒我喝水
/schedule 0 9 * * * 早安问候

# ISO timestamp
/schedule 2026-05-01T10:00 ...
```

## Bash Preconditions (Dashboard)

Enable **Bash precondition** when a scheduled task should check external state before calling the model. This setting is available when creating or editing a task in the Dashboard. Turning the switch off disables the precondition, but the scheduled task continues to run and the saved content is retained. Clear the script or file path and save to remove it.

Two source modes are available:

- **Enter Bash directly**: the script content is stored with the task configuration.
- **Bash file path**: the file must be a readable, regular UTF-8 Bash file on the daemon host and must be inside the `<dataDir>/schedule-preconditions/trusted-files/` directory shown in the Dashboard for the current bot. The page also shows a complete absolute-path example that can be entered directly. Relative paths, paths using `~` expansion, directories, files outside this directory, and symbolic links in any path component are rejected.

### File-path configuration demo

Suppose the Dashboard shows the following values for the current bot:

```text
Trusted directory: /home/alice/.botmux/data/schedule-preconditions/trusted-files/
Complete example: /home/alice/.botmux/data/schedule-preconditions/trusted-files/check-ready.sh
```

This is a Linux example. Your actual `dataDir` may differ, so use the values shown in the Dashboard instead of copying the example username. Then:

1. On the **same host that runs the daemon**, create or copy a regular UTF-8 Bash file into the directory shown in the Dashboard. The daemon creates this directory.
2. Paste the complete absolute path into **Bash file path**. For this example, enter `/home/alice/.botmux/data/schedule-preconditions/trusted-files/check-ready.sh`, not `~/...`.
3. Click **Test precondition**. Save the task after the test passes.

You can start `check-ready.sh` with this minimal content:

```bash
#!/usr/bin/env bash
# Replace this with the state path to check on the daemon host.
if test -f /srv/my-service/ready.flag; then
  printf '1\n'
else
  printf '0\n'
fi
```

Botmux validates and reads the file again for every test and scheduled trigger. You do not need to save the task again after changing the file.

Both modes use the same protocol. The script must exit with code `0`, and trimmed stdout must be exactly `1`, before the task calls the model. Output `0`, any other output, empty output, or a script error stops that run.

To append context to the model prompt for this run, write it to file descriptor 3 (FD 3):

```bash
printf '1\n'
cat >&3 <<'PROMPT'
The deployment check passed. Use this status in the analysis.
PROMPT
```

Click **Test precondition** to execute the current **unsaved** form content for real on the daemon host. The result shows pass, skip, or the full error and exit codes. Testing does not save the configuration, call the model, write a task execution log, or advance repeat counts. File, network, and other side effects produced by the script still happen for real.

> **Migrating existing configurations:** File paths saved before this upgrade remain configured when they are outside the trusted directory, but tests and scheduled runs fail closed while the precondition is enabled, so the model is not called. Botmux does not copy the file or rewrite the task automatically. Move or copy the file into the current bot's trusted directory, update the field with the new complete absolute path, test it, and save. FD 3 content is sent to the model and may enter session history, so do not output secrets or tokens.

## A New Topic Per Run

By default every fire continues in **the original topic where the task was created**. To make each run land in a **brand-new topic** in the same chat with its own isolated session (ideal for daily-report style tasks where each run should stand alone), there are three ways:

```bash
# Slash command: prefix the prompt with the 新话题 ("new topic") keyword
/schedule 每日17:30 新话题 generate today's discussion digest

# CLI: --new-topic flag
botmux schedule add "每日17:30" "generate digest" --new-topic

# CLI: equivalent --deliver form
botmux schedule add "每日17:30" "generate digest" --deliver new-topic
```

You can also edit a task on the Dashboard's **Schedules** page and use **Execution position** to choose the original topic, chat top level, or a new topic for every run.

## Follow the Active Topic

A topic-pinned task keeps firing into the topic it was created in; once that topic is closed and the conversation has moved on, reminders land where nobody is looking — and re-lighting a closed topic is one more topic session to carry. `--follow-active` makes the task re-resolve its target **at every fire**.

```bash
# Created from inside a topic session: that topic is the starting point
botmux schedule add "every 30m" "check the service, alert only on failure" --follow-active

# Or give the starting point explicitly
botmux schedule add "每日9:00" "standup reminder" --follow-active --root-msg-id om_xxx
```

Tried in order at every fire:

1. **The last landing point is still open and a human has spoken in it** (some bot still holds an active session under that topic, and that session has seen a human message) ⇒ fire there, even if the person spoke elsewhere more recently. Until the first fire, the last landing point is the creation topic.
2. **Otherwise** (closed; or open but only bots ever wrote there) ⇒ fire into the topic in this chat where a **human most recently spoke**, and record it as the new landing point. Only human messages count — bot replies and scheduled-task output are ignored, otherwise a task firing every 30 minutes would keep its own topic "most active" and follow itself forever. The lookup spans every bot: where the person is, is a property of the person, not of one bot. Note that this fire is injected into the person's live session, so the task's own `--workdir` does not apply there; the session's working directory is used.
3. **No open topic with human activity in this chat, but the last landing point is still open** (e.g. the topic step 4 opened, with only the task writing in it) ⇒ stay there; no new topic is opened.
4. **Nothing open at all** ⇒ this fire opens a fresh top-level topic, exactly like `--new-topic`, and records it as the new landing point — the next fire stays in it under step 3, and once the person replies there it is held under step 1.

Step 1 requiring a human is deliberate: a topic the task opened itself must not pin the task, so a bot-only landing point yields to any topic where a person is. If the session records cannot be read (e.g. sqlite temporarily unavailable) the task does not move and keeps its last landing point. A silent task reaching step 4 gets a deferred topic (created by the first `botmux send`), which is not recorded; the next fire re-resolves.

Cross-topic notice: a plain topic-pinned task that fires somewhere other than its creation topic posts a "delivered to …" notice back into the creation topic. A follow-active task moves by design, so it posts that notice only when it fires into a **different chat**; a move within the same chat just posts the "task started" banner in the topic it landed in.

`--follow-active` only makes sense for topic execution and cannot be combined with `--top-level` / `--new-topic`. Tasks of this kind show a `↷跟随活跃话题` marker in `schedule list`.

## Management

```bash
/schedule list
/schedule remove|enable|disable|run <id>
```

> Execution behavior: when due, if the session in the original topic is still alive, the prompt is injected directly into the existing session (no new worker is started); otherwise a new worker is spun up to execute in the original working directory. A `--new-topic` task always opens a fresh topic + new session and never reuses a prior one.
