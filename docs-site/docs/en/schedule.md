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

## Management

```bash
/schedule list
/schedule remove|enable|disable|run <id>
```

> Execution behavior: when due, if the session in the original topic is still alive, the prompt is injected directly into the existing session (no new worker is started); otherwise a new worker is spun up to execute in the original working directory.
