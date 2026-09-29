# 固化命令

固化命令把已经验证过的查询或只读脚本保存为斜杠命令。安装后，用户发送 `/命令 参数` 或单句 `运行 /命令 参数`，宿主会直接执行，不经过模型，也不再弹运行确认卡。

## 生命周期与权限

- 新建和更新必须由同一位真人在 10 分钟内点击宿主确认卡；仅写入 YAML 不会获得执行权限。
- 命令以最终确认创建的人为 owner。owner 可更新、废弃、恢复和彻底撤销自己的命令；管理员可以代为处理。无可验证 owner 的旧命令仍只能由管理员接管。
- 彻底撤销必须先废弃，操作不可逆且需要同一真人在专用卡片中确认。
- 每次新建、更新、废弃、恢复和彻底撤销都必须提供 1～500 字原因。
- 群聊中必须 @ 目标机器人；`/freeze list` 等管理命令也不例外。
- Bot 启用 `restrictGrantCommands` 时，仅靠 `chatGrants` / `globalGrants` 获得普通对话权的访客不能使用 `/freeze` 管理入口或已安装命令；自然语言直达和非 ASCII 命令名同样受限。owner、`allowedUsers`、oncall 与整群成员按原权限模型执行。

命令定义位于 `<工作目录>/.botmux/commands/*.yaml`，候选草稿位于 `<工作目录>/.botmux/frozen-command-drafts/*.yaml`。这两个目录可能包含业务 SQL；botmux 源码仓库会忽略任意子目录下的这两类路径，其它业务仓库也应添加同样规则。如需版本化，应复制到经过脱敏和权限控制的专用配置仓。

## 结果展示

`output.format` 支持 `text`（默认，保持原纯文本行为）、`markdown`、`table` 和 `auto`。宿主保存的是版本化的文本/Markdown/表格结构，不接受原始 HTML：飞书把富结果渲染为卡片，后续 Web 页面可复用相同结构并由自己的安全渲染器生成 HTML。`table` 最多展示前 50 行、20 列，完整纯文本仍作为降级内容保留。

## 管理员执行器白名单

Data MCP 查询使用宿主内建的 `builtin.data-mcp.readonly`，不需要登记外部执行器。BotMux 只校验通用参数并把已批准的 `input` 作为不透明载荷交给 Data MCP 插件；SQL 参数编码、同字节校验与执行都在插件内完成。插件必须提供 `execute_frozen_query` 能力，旧版插件会明确报错并停止，不会回退到宿主旧 SQL 路径。Data MCP 执行器发生错误时也会直接报错；即使定义写了 `onError: fallback_llm`，也不会交给大模型重新生成查询，以保持冻结 SQL 的确定性。要固化 `lark-cli` 或自有脚本，管理员必须先创建 `~/.botmux/command-executors.yaml`。文件不存在时注册表为空，所有 process/script 类固化命令默认不可用。

Agent 可在当前真人消息轮次调用 `botmux freeze executors` 查看只读参数契约。返回内容只包含 executor id 与参数名、类型、来源和约束，不暴露可执行文件路径、固定参数或脚本制品路径/摘要。候选定义在弹出确认卡前会完整校验该契约；字段、必填项、类型、来源或约束不兼容时直接拒绝。

下面是一个只读脚本执行器示例。路径必须是绝对 canonical realpath，不能是符号链接；`scriptArtifacts` 中的入口脚本会在每次执行前校验摘要。

```yaml
schemaVersion: 1
executors:
  - id: finance.report
    kind: script
    executable:
      realpath: /opt/homebrew/Cellar/node/24.8.0/bin/node
    fixedArgs:
      - /opt/botmux/executors/finance-report.mjs
    scriptArtifacts:
      - /opt/botmux/executors/finance-report.mjs
    arguments:
      days:
        flag: --days
        type: integer
        required: true
        min: 1
        max: 90
        accepts: [param]
    policy:
      risk: read
      schedulable: true
      allowHandoff: false
      timeoutMs: 10000
      maxOutputBytes: 65536
    output:
      format: json
      exposeFields: [total, currency]
```

安全边界：

- 首版只接受 `policy.risk: read`，不支持写操作或 shell 字符串拼接；参数按独立 argv token 传递。
- `arguments.*.accepts` 明确每个参数允许来自常量、用户参数或可信上下文的哪些来源。
- 输出必须是 JSON，并通过 `exposeFields` 或 `container` + `exposeRowFields` 二选一投影；未列出的字段不会返回给用户。
- 凭证由宿主按当前 Bot 注入，业务命令与白名单都不经手凭证路径或环境变量。
- 当前隔离方案不提供额外 OS 级沙箱：进程以 daemon 的同一 UID 运行。同 UID 进程可能读取子进程环境，因此不得把进程环境或 `ps eww` 输出粘贴到群聊。
- 修改白名单或脚本会改变 executor revision；已批准命令必须重新批准后才能运行。

## 定时执行

让真人发送 canonical 形式 `/schedule <规则> /<命令> [参数]`，以便任务保存可信创建者身份。宿主会在创建时确认命令真实存在、已批准、参数有效且允许定时执行，并把任务保存为精确的 `/命令 参数`；旧版文档中的 `，执行 /<命令>` 写法仍兼容已有任务。静默任务只隐藏正常成功结果；身份缺失、命令未批准或已废弃、执行失败仍会通知。
