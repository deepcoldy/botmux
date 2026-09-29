# 固化命令

固化命令把已经验证过的插件工具或白名单进程保存为斜杠命令。安装后，用户发送 `/命令 参数` 或单句 `运行 /命令 参数`，宿主默认直接执行；只有命令作者显式配置并命中 `output.rules` 时，结果或执行失败才会交给模型。生命周期确认卡不会变成每次运行都要点的确认卡。

## 生命周期与权限

- 新建和更新必须由同一位真人在 10 分钟内点击宿主确认卡；仅写入 YAML 不会获得执行权限。
- 命令以最终确认创建的人为 owner。owner 可更新、废弃、恢复和彻底撤销自己的命令；管理员可以代为处理。无可验证 owner 的旧命令仍只能由管理员接管。
- 彻底撤销必须先废弃，操作不可逆且需要同一真人在专用卡片中确认。
- 每次新建、更新、废弃、恢复和彻底撤销都必须提供 1～500 字原因。
- 群聊中必须 @ 目标机器人；`/freeze list` 等管理命令也不例外。
- Bot 启用 `restrictGrantCommands` 时，仅靠 `chatGrants` / `globalGrants` 获得普通对话权的访客不能使用 `/freeze` 管理入口或已安装命令；自然语言直达和非 ASCII 命令名同样受限。owner、`allowedUsers`、oncall 与整群成员按原权限模型执行。

命令定义位于 `<工作目录>/.botmux/commands/*.yaml`，候选草稿位于 `<工作目录>/.botmux/frozen-command-drafts/*.yaml`。这两个目录可能包含业务 SQL；botmux 源码仓库会忽略任意子目录下的这两类路径，其它业务仓库也应添加同样规则。如需版本化，应复制到经过脱敏和权限控制的专用配置仓。

## 结果展示

`output.format` 支持 `text`（默认，保持原纯文本消息行为）、`markdown`、`table` 和 `auto`。宿主中间契约只保存版本化的 Markdown/表格块，不接受 text 块或原始 HTML；`format: text` 时飞书使用经过转义和 20KB 截断的 `fallbackText` 发送 text 消息，其余格式渲染为卡片。后续 Web 页面可复用相同结构并由自己的安全渲染器生成 HTML。`table` 最多展示前 50 行、20 列，完整纯文本仍作为降级内容保留；旧插件返回 text 块会按契约不兼容拒绝，不做隐式转换。

需要按结果选择展示或模型解释时，使用有顺序的 `output.rules`；第一条命中的规则生效。每条规则必须且只能配置 `handoff` 或 `show`。没有规则或全部未命中时，统一按 `output.format` 正常展示。直接运行、确认运行和定时运行共用同一套决策：

```yaml
output:
  format: table
  maxChars: 20000
  rules:
    - when: "{{run.status}} == 'error' && {{run.error.transient}} == true"
      handoff:
        prompt: "执行暂时失败，请根据命令上下文给出安全的后续建议。"
    - when: "{{q.max_drop}} > 0.2"
      handoff:
        prompt: "指标波动超过阈值，请解释可能原因。"
        data: "{{q.rows}}"
        maxRows: 20
    - when: "{{q.row_count}} == 0"
      show:
        text: "本次没有符合条件的数据"
        format: markdown
    - show: result
```

- `q.*` 是成功结果字段与 `q.rows` / `q.row_count`；`run.*` 包含 `status`、`error.code`、`error.message`、`error.transient`、`executionId`；`cmd.*` 包含命令名、说明、参数、执行器、触发方式和任务 ID。
- 只有执行器真正开始后的失败能进入规则。未批准、已废弃/撤销、身份不可信、参数非法、执行器 revision 变化等闸门错误始终直接报错。
- handoff 前，宿主固定注入命令、参数、执行器、触发方式、结果/安全错误码和执行 ID；作者 prompt 不能覆盖这段上下文。错误 handoff 不携带执行器原始输出。
- 是否允许 handoff 由 executor 的 `policy.allowHandoff` 控制，默认 `false`。`policy.handoffIncludesInput` 默认 `false`；开启后定义中的 `input` 仅作为工具调用上下文提供，并明确禁止向用户展示。
- `show: result` 按默认 `format` 展示原结果；`show: { text, format }` 展示模板文字并可覆盖默认格式。省略 `when` 的规则始终命中，适合作为规则列表最后的显式兜底。
- 旧的单个 `output.when` / `handoff` / `else` 仍兼容，并在读取时转换成“条件命中 handoff、否则 show else.text”两条规则。旧 `onError: fallback_llm` 会被读取为“仅瞬时执行错误 handoff”的等价规则；新定义不要再使用 `onError` 或 `else`。

## 管理员执行器白名单

所有固化命令都必须登记在 `~/.botmux/command-executors.yaml`。注册表支持 `process`、`script` 和通用的 `plugin-tool`；宿主不内建任何业务插件名称。文件不存在时注册表为空，固化命令默认不可用。

`plugin-tool` 登记插件 id、工具名、最低稳定版本和安全策略。实现固化命令展示契约的工具声明 `contractVersion`，由插件返回通道中立的 Markdown/表格块及纯文本降级内容；普通 MCP 工具声明 `output`，宿主按白名单中的 `exposeFields` 或 `container` + `exposeRowFields` 投影其 JSON。执行时宿主只打开该插件的一次性网关，通过 `_meta` 注入可信调用者。插件必须在宿主注册表中已安装、已启用且版本满足要求；缺工具或契约不兼容都会 fail closed。

Agent 可在当前真人消息轮次调用 `botmux freeze executors` 查看只读参数契约。返回内容只包含 executor id 与参数名、类型、来源和约束，不暴露可执行文件路径、固定参数或脚本制品路径/摘要。候选定义在弹出确认卡前会完整校验该契约；字段、必填项、类型、来源或约束不兼容时直接拒绝。

下面先给出 Data MCP 作为普通插件工具的登记示例。SQL 对宿主是不透明载荷；参数编码、同字节校验和执行都由插件负责。身份不能出现在 `arguments` 中，只能由网关 `_meta` 注入。

```yaml
schemaVersion: 2
aliases:
  builtin.data-mcp.readonly: data.query.readonly
executors:
  - id: data.query.readonly
    kind: plugin-tool
    plugin: data-mcp
    tool: execute_frozen_query
    minimumVersion: 0.3.1
    contractVersion: 2
    arguments:
      sql:
        type: string
        required: true
        maxLength: 100000
        accepts: [literal]
      datasource:
        type: enum
        required: false
        values: [tchouse-c]
        default: tchouse-c
        accepts: [literal]
    policy:
      schedulable: true
      allowHandoff: true
      handoffIncludesInput: false
      timeoutMs: 120000
```

普通 JSON MCP 工具只需把 `contractVersion` 换成投影定义，例如：

```yaml
    output:
      format: json
      container: rows
      exposeRowFields: [name, total]
```

下面是只读脚本执行器示例。路径必须是绝对 canonical realpath，不能是符号链接；`scriptArtifacts` 中的入口脚本会在每次执行前校验摘要。

```yaml
schemaVersion: 2
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
      schedulable: true
      allowHandoff: false
      timeoutMs: 10000
      maxOutputBytes: 65536
    output:
      format: json
      exposeFields: [total, currency]
```

安全边界：

- `risk` 字段已经删除；旧注册表中的该字段会被忽略并记录告警。能力是否只读由 executor 登记人保证，宿主不根据 `risk` 字符串推断安全性。进程参数仍按独立 argv token 传递，不做 shell 字符串拼接。
- `arguments.*.accepts` 明确每个参数允许来自常量、用户参数或可信上下文的哪些来源。
- `plugin-tool` 的参数不能接受 `context:caller.*`；调用者身份只能使用宿主冻结后注入的 `_meta`。
- 输出必须是 JSON，并通过 `exposeFields` 或 `container` + `exposeRowFields` 二选一投影；未列出的字段不会返回给用户。
- 凭证由宿主按当前 Bot 注入，业务命令与白名单都不经手凭证路径或环境变量。
- 插件注册表是全局安装面；全局启用的插件会对所有 Bot 可见，但每个固化命令仍只能调用白名单登记的单个插件和单个工具。
- 当前隔离方案不提供额外 OS 级沙箱：进程以 daemon 的同一 UID 运行。同 UID 进程可能读取子进程环境，因此不得把进程环境或 `ps eww` 输出粘贴到群聊。
- 修改白名单或脚本会改变 executor revision；已批准命令必须重新批准后才能运行。

### 从旧版内建 Data MCP 执行器迁移

升级前先增加上面的 `plugin-tool` 登记，并用 `aliases` 把旧 id `builtin.data-mcp.readonly` 指向新 executor；新定义应直接使用新 id（例如 `data.query.readonly`）。保留可选 `datasource` 参数，才能继续读取显式写了该字段的旧定义。

本次迁移有三个需要显式处理的影响：

1. executor revision 的计算方式发生变化，所有已批准命令都必须由 owner 或管理员重新批准。
2. 旧定义中的 `onError: fallback_llm` 会转换为瞬时错误 handoff 规则；若对应 executor 没有显式开启 `policy.allowHandoff`，该定义会 fail closed，必须先删除旧回退或开启经过审查的 handoff。
3. 旧 Data MCP 定义若包含 `datasource`，白名单也必须声明上例中的同名参数，否则定义校验会拒绝迁移。

推荐顺序：先备份命令定义与审批账本；部署并启用满足 `minimumVersion` 的插件；更新 executor 注册表和 alias；逐条校验旧定义并重新批准；最后升级 BotMux 并做 direct、confirmed、scheduled 三条链路冒烟。反向升级会按设计 fail closed。

## 定时执行

让真人发送 canonical 形式 `/schedule <规则> /<命令> [参数]`，以便任务保存可信创建者身份。宿主会在创建时确认命令真实存在、已批准、参数有效且允许定时执行，并把任务保存为精确的 `/命令 参数`；旧版文档中的 `，执行 /<命令>` 写法仍兼容已有任务。静默任务只隐藏正常成功结果；身份缺失、命令未批准或已废弃、执行失败仍会通知。
