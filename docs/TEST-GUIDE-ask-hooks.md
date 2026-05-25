# 测试指南：botmux askUserQuestion hook 接管

分支：`feat/botmux-ask-hooks`（已推送 origin）。本期支持 **Claude Code + OpenCode**；Codex 不适用（无结构化提问 hook）。

## 1. 拉代码 + 构建（在另一台环境的 botmux 仓库里）

```bash
cd <你的 botmux 仓库目录>
git fetch origin
git checkout feat/botmux-ask-hooks      # 已在该分支则 git pull
pnpm install
pnpm build                              # tsc 干净，产出 dist/
```

确认 botmux 可执行指向这个仓库的 dist：
```bash
cat "$(which botmux)"                    # 应 exec node <本仓库>/dist/cli.js
```

## 2. 重启 daemon 让它跑新代码

```bash
botmux restart
botmux status                            # 确认 online
```

## 3. 确认 hook 被装上（spawn 一个会话后）

先在飞书话题里给 Claude bot 发条消息，拉起一个 Claude 会话，然后：

```bash
# Claude：应有指向 "hook claude-code" 的 PermissionRequest 钩子
cat ~/.claude/settings.json | grep -A3 PermissionRequest

# OpenCode：插件文件应存在
ls -l ~/.config/opencode/plugin/botmux-ask.js
```

## 4. 触发 askUserQuestion（核心验证）

**Claude 单选**：在 Claude 会话里让它问你一个选择题，例如发：
> 用 AskUserQuestion 工具问我「今晚部署还是回滚」，给两个选项

预期：飞书话题里弹出一张互动卡片（问题 + 选项下拉 + 「提交」按钮）。选一项 → 点提交 → Claude 收到答案继续往下。

**Claude 多选**：让它问一个 `multiSelect` 的问题，例如：
> 用 AskUserQuestion 多选问我「要跑哪些检查」，选项：单测/类型检查/lint，允许多选

预期：卡片里是多选下拉，勾两项 → 提交 → 两个答案都正确回到 Claude。

**OpenCode**：在 OpenCode 会话里同样触发一次提问，重复上面验证。

## 5. 降级验证（重要）

停掉 daemon（`botmux stop`）后，让 CLI 触发提问 → CLI 应**回退到它自己的终端原生提问**、不挂死。验证 hook 异常不卡 agent。

## 6. 出问题时看哪里

- daemon 日志：`botmux logs --bot <bot 名或序号>`，找 `[hook]`（安装）和 `[ask:...]`（提问生命周期）行。
- 三个"线上没验过、各隔离在一处"的点，行为异常时按序查：
  1. **飞书多选回调形状** → `src/im/lark/ask-card.ts` 的 `parseFormSelections`（已防御式兼容 数组/字符串/逗号串；若飞书回的格式更怪，这里加一种）。
  2. **OpenCode 插件 question.asked API** → `src/adapters/hook-installer.ts`（有 `TODO(dogfood)` 标记；插件协议若对不上，改这一处）。
  3. **Claude/OpenCode directive 形状** → `src/core/ask-hook/{claude-code,opencode}.ts` 的 `formatAnswer`（回填字段若 CLI 不认，改这一处）。

## 7.（可选）不用 CLI 的快速冒烟：直接打 broker

不想起 CLI，也可直接验"卡片 + 回调 + broker"整条（绕过 hook 客户端）：

```bash
# 找 daemon 的 ipc 端口（从 daemon 描述或日志）
# 然后用多问多选 body 打 /api/asks，会在指定 chat 弹卡，点提交后本命令返回 answers
curl -sS -X POST "http://127.0.0.1:<ipcPort>/api/asks" \
  -H 'content-type: application/json' \
  -d '{
    "sessionId":"smoke","chatId":"<你所在话题的 chatId>","larkAppId":"<bot 的 appId>",
    "rootMessageId":null,"timeoutMs":300000,"approvers":["<你的 open_id>"],
    "questions":[
      {"prompt":"部署还是回滚？","multiSelect":false,"options":[{"key":"deploy","label":"部署"},{"key":"rollback","label":"回滚"}]},
      {"prompt":"跑哪些检查？","multiSelect":true,"options":[{"key":"unit","label":"单测"},{"key":"types","label":"类型检查"},{"key":"lint","label":"lint"}]}
    ]
  }'
# 飞书点选 + 提交后，curl 返回 {"kind":"answered","answers":[["deploy"],["unit","types"]],...} 即全链路 OK
```

## 注意

- Codex 别测 askUserQuestion——它没有结构化提问 hook，adapter 对它永远 passthrough（无害）。
- 现有 `botmux ask buttons` 子命令仍可用（向后兼容，单选）。
