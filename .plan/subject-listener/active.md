# Subject 主体监听

## 需求总目标

在现有消息监听器上增加 `behavior: "subject"` 特殊模式。明确 @ 当前 Bot 的消息继续走普通会话并保证可见回应；未 @ 的消息才由 Subject 根据飞书群资料、发送者和增量消息记录判断静默、回复、执行或路由其它能力。

Subject 的事实上下文来自飞书，不依赖 CLI session 历史。系统按 Bot + 群持久化读取游标，正常读取到上一次成功处理的位置；冷启动或游标失效时回退最近 N 条，并只在可见回复已送达或收到明确 `BOTMUX_NOTHING_TO_SEND` 终态后推进游标。

## 最终效果

```jsonc
{
  "messageListeners": {
    "oc_xxx": {
      "enabled": true,
      "behavior": "subject",
      "prompt": "可选的群级关注范围",
      "subjectPolicy": {
        "context": { "source": "lark", "fallbackMessages": 20 }
      }
    }
  }
}
```

## Sprint 索引

| Sprint | 一句话概括 | 目录 |
| --- | --- | --- |
| 001 | Subject 运行时、飞书增量上下文、静默与游标提交 | [sprint-001](./sprint-001/) |
| 002 | Dashboard/API 配置、兼容保存与可操作界面 | [sprint-002](./sprint-002/) |
| Review | 合并前修复、架构讨论与最终验收 | [review-followups](./review-followups.md) |

## 当前状态

- Sprint 001、002 已完成，PR #1252 的构建与测试 CI 已通过。
- Review 发现的 R-1、R-2、R-3 已确认是合并前必须修复项。
- R-4 先讨论架构方案，不在未确认前改代码；R-5 放到最后补截图与 live 验收。
- 本轮仅处理代码规范中的嵌套三元，不顺带修改其它 review 项。
