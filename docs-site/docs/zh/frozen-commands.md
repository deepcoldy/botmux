# 固化命令

固化命令把经过批准的执行步骤保存为斜杠命令。executor 只负责返回数据或完整 Markdown；renderer 把数据变成 Markdown；宿主统一负责身份、闸门、规则判断和展示安全。用户发送 `/命令 参数` 或单句 `运行 /命令 参数` 时默认直接执行，只有显式命中 `output.rules[].handoff` 才交给模型。

## 生命周期与权限

- 新建和更新必须由同一位真人在 10 分钟内确认；只写 YAML 不会获得执行权限。
- 最终确认者是 owner。owner 与管理员可管理生命周期；彻底撤销不可逆，并需二次确认。
- 修改命令、executor 或 renderer 会改变 revision，原批准立即失效，必须重新批准。
- 群聊里必须 @ 目标机器人；启用 `restrictGrantCommands` 时仍沿用 BotMux 的真实用户权限边界。
- 命令定义位于 `<工作目录>/.botmux/commands/*.yaml`，候选位于 `.botmux/frozen-command-drafts/*.yaml`。其中可能包含业务 SQL，不应提交到公共源码仓库。

## 管理员白名单

所有 executor 和自定义 renderer 都登记在 `~/.botmux/command-executors.yaml`。未登记、插件未安装/未启用、工具缺失、版本不足或制品摘要变化都会 fail closed。

```yaml
schemaVersion: 2
executors:
  - id: data.query.readonly
    kind: plugin-tool
    plugin: data-mcp
    tool: execute_frozen_query
    minimumVersion: 0.4.0
    arguments:
      sql:
        type: string
        required: true
        maxLength: 100000
        accepts: [literal]
    output:
      container: rows
      exposeRowFields: [dt, 渠道, 注册数]
      labelsFrom: columns
      totalRowsField: row_count
      auditFields: [query_id]
      errorField: error_code
    policy:
      schedulable: true
      allowHandoff: false
      timeoutMs: 120000

renderers:
  - id: risk.daily-md
    executable: { realpath: /usr/bin/python3 }
    fixedArgs: [-I, /opt/botmux/renderers/risk_daily_md.py]
    scriptArtifacts: [/opt/botmux/renderers/risk_daily_md.py]
    policy:
      timeoutMs: 10000
      maxInputBytes: 1048576
      maxOutputBytes: 60000
```

支持 `process`、`script`、`plugin-tool` 三类 executor。`arguments.*.accepts` 明确值可来自 `literal`、`param` 或可信 `context:*`。plugin-tool 禁止声明 `open_id`、`union_id`、`user_id`、`email` 等身份参数，也禁止 `context:caller.*`；真实调用人只由一次性网关通过 `_meta` 注入。

`output` 有三种模式：

- `content: markdown`：整个 stdout/工具结果就是 Markdown；
- `content: <字段路径>` 加可选 `exposeFields`：从 JSON 取内容，同时保留规则可用的数据；
- `exposeFields`，或 `container` + `exposeRowFields`：只返回投影数据，由 renderer 展示。

可选字段还有 `labels` / `labelsFrom`、`totalRowsField`、`auditFields`、`errorField`、`maxContentBytes`。未登记字段不会展示，也不能被规则引用。plugin-tool 的纯 literal 字符串最长 200000；动态参数和 process/script 仍最多 10000。

Data MCP 插件 0.4.0 的 `execute_frozen_query` 只返回 `rows`、`columns`、`row_count`、`query_id`、`error_code`；参数编码、同字节 validate/run 和 `_meta` 身份仍由插件保证。宿主不理解 SQL。服务端还会按 `MAX_SQL_BYTES` 校验参数替换后的最终 SQL（默认 20000 个 UTF-8 字节），超限在审计日志中记录 `sql_too_large`，固化命令对用户只显示固定错误。

## 命令定义

第一阶段只允许一个 step，但语法已经使用最终的 `steps[]` 和带步骤 id 的命名空间：

```yaml
schemaVersion: 2
name: 近n天注册商户数
description: 近 N 天每日注册商户数
timezone: Asia/Shanghai
params:
  - name: days
    label: 天数
    type: integer
    min: 1
    max: 90
    default: 7
steps:
  - id: main
    executor: data.query.readonly
    input:
      sql: |-
        SELECT toDate(reg_time) AS dt, channel AS 渠道, count() AS 注册数
        FROM example WHERE reg_time >= today() - {{days}}
        GROUP BY dt, 渠道 ORDER BY dt
    renderer: builtin.table
    required: false
output:
  format: markdown
  rules:
    - when: "{{q.main.row_count}} == 0"
      show: { text: "近 {{cmd.args.days}} 天没有注册商户" }
    - show: result
```

`steps[].id`、`executor`、`input`、`renderer` 都必填。数据 executor 使用 `builtin.table` 或登记的脚本 renderer；带 `content` 的 executor 只能使用 `builtin.content`。`required` 默认 false，在多步版本中生效。

`output` 只允许：

- `format: markdown | text`；省略时默认为 markdown；
- `rules`：按顺序匹配，第一条命中即停止。每条规则必须且只能有 `handoff` 或 `show`。

规则变量为 `q.<步骤 id>.*`、`run.status`、`run.<步骤 id>.*` 和 `cmd.*`。没有规则或全部未命中时展示 renderer 的结果。`show: result` 展示结果；`show: {text: ...}` 展示安全插值后的文字。handoff 受相关 executor 的 `allowHandoff` 约束，宿主固定注入命令上下文，错误只提供固定错误码与文案。

旧字段不兼容并会直接拒绝，包括顶层 `executor` / `input`、`output.text`、`prefix` / `suffix`、`else`、`onError`、`format: table|auto`，以及白名单的 `risk`、`format: json`、`contractVersion`、`aliases`。

## Renderer 协议

`builtin.table` 把多行变为表格、单行变为“字段：值”；`builtin.content` 原样使用 executor 内容。自定义 renderer 从 stdin 读取：

```json
{"rows":[{"商户":"A店","异常笔数":12}],"columns":[{"key":"商户","label":"商户"}],"totalRows":1,"fields":{},"cmd":{"name":"风险日报","args":{"date":"2026-09-28"}}}
```

stdout 必须是 UTF-8 Markdown。renderer 超时、非零退出、提前关闭 stdin、输出超限或制品变化时，宿主记录 `renderer_failed` 并退回 `builtin.table`。renderer 不会获得凭证或调用人身份。数据结果超过 1000 行时，宿主只投影前 1000 行，并用总行数提示还有未展示的数据。

## 展示安全

所有来源统一经过宿主策略：消除 @；把飞书专有标签的左尖括号替换为全角字符；拒绝剩余原始 HTML；把正文 URL 包成不可点击、可复制的行内代码，并删除引用式链接定义。只有顶格的 `vega-lite` fenced code 免于正文清洗；引用、列表或缩进中的代码块都按正文处理。`vega-lite` 图表由飞书适配层在 #1633 可用时处理，未安装该能力时按普通代码显示。`format: text` 从 Markdown 推导纯文本。内容本身不按 20KB 截断；卡片超过 80KB 时整体降级为推导后的纯文本，只有最终文本消息会按 20KB 截断。

## 定时与发布

真人使用 `/schedule <规则> /<命令> [参数]` 创建任务。创建和运行时都会复核批准状态、revision、可信创建者身份与 `schedulable`。常规生产部署仍需 QA、研发、运维在线，并完成技术监控、核心功能和产品业务验收；生产配置变更须走强制审批。
