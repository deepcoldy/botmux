# 定时任务

支持三种调度类型 + 中文自然语言，到点在**创建任务的原话题**内续一条消息并执行（不另开 thread，工作目录与创建时一致）。

## 两种创建方式

- **斜杠命令**（快捷）：`/schedule 每日17:50 帮我看看AI圈有什么新闻`
- **对话触发**（灵活）：直接跟 agent 说「帮我加个每天 18:00 检查部署的定时任务」，自动触发 `botmux-schedule` Skill。

## 支持的格式

```bash
# 中文自然语言
/schedule 每日17:50 帮我看看AI圈有什么新闻
/schedule 工作日每天9:00 检查服务状态
/schedule 每周一10:00 生成周报

# 一次性任务
/schedule 30分钟后 检查部署状态
/schedule 明天9:00 发早会提醒

# 英文 duration / interval / cron
/schedule every 2h 巡检服务
/schedule 30m 提醒我喝水
/schedule 0 9 * * * 早安问候

# ISO 时间戳
/schedule 2026-05-01T10:00 ...
```

## 管理

```bash
/schedule list
/schedule remove|enable|disable|run <id>
```

> 执行行为：到点若原话题的会话还活着，prompt 直接注入现有会话（不另起 worker）；否则新拉一个 worker 在原工作目录执行。
