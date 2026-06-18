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

## 每次开新话题

默认每次触发都续在**创建任务的原话题**里。如果想让每次执行都落在同群的一个**全新话题**、起一个独立会话（适合日报这类"每天一篇、各自独立"的任务），有三种写法：

```bash
# 斜杠命令：prompt 前加"新话题"关键字
/schedule 每日17:30 新话题 生成今天的群讨论日报

# CLI：--new-topic 旗标
botmux schedule add "每日17:30" "生成日报" --new-topic

# CLI：等价的 --deliver 写法
botmux schedule add "每日17:30" "生成日报" --deliver new-topic
```

也可以在 dashboard 的「定时」页用「投递」列的切换按钮，把已有任务在「原话题 / 每次新话题」之间切换。

## 管理

```bash
/schedule list
/schedule remove|enable|disable|run <id>
```

> 执行行为：到点若原话题的会话还活着，prompt 直接注入现有会话（不另起 worker）；否则新拉一个 worker 在原工作目录执行。`--new-topic` 任务则每次都新开话题 + 全新会话，从不复用旧会话。
