# bots.json 配置

通过 `~/.botmux/bots.json` 配置机器人。运行 `botmux setup` 交互式创建，或手动编辑。

```json
[
  {
    "larkAppId": "cli_xxx_bot1",
    "larkAppSecret": "secret_1",
    "name": "claude-main",
    "cliId": "claude-code",
    "model": "sonnet",
    "workingDir": "~/projects",
    "allowedUsers": ["alice@company.com"],
    "allowedChatGroups": ["oc_xxx_team"]
  },
  {
    "larkAppId": "cli_xxx_bot2",
    "larkAppSecret": "secret_2",
    "cliId": "codex",
    "model": "gpt-5-codex",
    "workingDir": "~/work"
  }
]
```

## 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `larkAppId` | 是 | 飞书应用 App ID |
| `larkAppSecret` | 是 | 飞书应用 App Secret |
| `name` | 否 | 进程名后缀，如 `claude-main` → `botmux-claude-main`；留空默认 `botmux-<序号>` |
| `cliId` | 否 | CLI 适配器，默认 `claude-code`。见 [多 CLI 适配器](/adapters) |
| `model` | 否 | 启动 CLI 用的模型名；留空走 CLI 默认 |
| `cliPathOverride` | 否 | CLI 入口绝对路径，用于套 wrapper / router（ccr、claude-w、aiden-x-claude 等） |
| `backendType` | 否 | 会话后端 `pty` / `tmux`（默认自动检测） |
| `workingDir` | 否 | 默认工作目录，支持逗号分隔多个。从该目录**向下**递归找 git 仓库（最多 3 层），不向上扫 |
| `defaultWorkingDir` | 否 | 单仓库默认目录：无 oncall / 无同群兄弟 session 时直接进入，跳过 repo 选择卡片 |
| `allowedUsers` | 否 | 操作权名单（**完整邮箱**或 `ou_xxx`）。配了 `allowedChatGroups` 时至少要有一个作为 owner |
| `allowedChatGroups` | 否 | 可对话群（`oc_xxx`）。群内任何成员可对话（仅 `canTalk`），敏感操作仍由 `allowedUsers` 控制 |
| `globalGrants` | 否 | 全局可对话名单（`ou_xxx`，人或 bot）。任意群可对话，仅 `canTalk` |
| `oncallChats` | 否 | oncall 绑定，`[{ "chatId": "oc_xxx", "workingDir": "~/projects/foo" }]` |

> **配置优先级**：`BOTS_CONFIG` 环境变量 → `~/.botmux/bots.json`。改完跑 `botmux restart` 生效。
