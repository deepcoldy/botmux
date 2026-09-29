# Frozen Commands

Frozen Commands save approved execution steps as slash commands. An executor returns data or complete Markdown, a renderer turns data into Markdown, and the host owns identity, gates, rules, and display safety. `/command args` and the exact form `run /command args` execute directly by default; only an explicit matching `output.rules[].handoff` invokes the model.

## Lifecycle and permissions

- Create and update operations require the same verified human to confirm within ten minutes. Writing YAML alone never grants execution permission.
- The final confirmer becomes owner. Owners and administrators manage lifecycle; permanent revocation is irreversible and requires a second confirmation.
- Any command, executor, or renderer change changes the revision and requires re-approval.
- This multi-step upgrade changes the executor artifact digest to a list-based calculation. An existing third-party executor command may therefore report one expected binary-drift warning after upgrade; approve the new revision once.
- Group invocations must mention the target bot. `restrictGrantCommands` continues to use BotMux's verified-user permission boundary.
- Definitions live under `<working-directory>/.botmux/commands/*.yaml`; drafts live under `.botmux/frozen-command-drafts/*.yaml`. They may contain business SQL and must not be committed to a public source repository.

## Administrator registry

Every executor and custom renderer is registered in `~/.botmux/command-executors.yaml`. Missing registrations, disabled or missing plugins, missing tools, insufficient versions, and artifact drift all fail closed.

```yaml
schemaVersion: 2
executors:
  - id: data.query.readonly
    kind: plugin-tool
    plugin: data-mcp
    tool: execute_frozen_query
    minimumVersion: 0.4.1
    arguments:
      sql:
        type: string
        required: true
        maxLength: 100000
        accepts: [literal]
    output:
      container: rows
      exposeRowFields: [dt, channel, registrations]
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

Executor kinds are `process`, `script`, and `plugin-tool`. `arguments.*.accepts` admits `literal`, `param`, or trusted `context:*` sources. A plugin-tool must not declare identity arguments such as `open_id`, `union_id`, `user_id`, or `email`, nor any `context:caller.*` source. The one-shot gateway injects the verified caller only through `_meta`.

`output` supports three modes:

- `content: markdown`: the whole stdout/tool result is Markdown;
- `content: <field path>` with optional `exposeFields`: a JSON field supplies content while projected data remains available to rules;
- `exposeFields`, or `container` plus `exposeRowFields`: data only, rendered separately.

Optional fields are `labels` / `labelsFrom`, `totalRowsField`, `auditFields`, `errorField`, and `maxContentBytes`. Undeclared fields cannot be displayed or referenced. A plugin-tool string accepted only from `literal` may be up to 200000 characters; dynamic and process/script arguments remain capped at 10000.

Data MCP 0.4.1 `execute_frozen_query` returns only `rows`, `columns`, `row_count`, `query_id`, and `error_code`. Parameter encoding, byte-identical validate/run, and `_meta` identity remain plugin responsibilities; the host does not interpret SQL. The service also enforces `MAX_SQL_BYTES` on rendered SQL (20000 UTF-8 bytes by default). An oversized query records `sql_too_large` in service audit logs while users receive only a fixed host error.

## Command definition

Each command contains 1–8 independent steps and uses step-qualified namespaces:

```yaml
schemaVersion: 2
name: recent_registrations
description: Daily registrations for the last N days
timezone: Asia/Shanghai
params:
  - name: days
    label: Days
    type: integer
    min: 1
    max: 90
    default: 7
steps:
  - id: main
    executor: data.query.readonly
    input:
      sql: |-
        SELECT toDate(reg_time) AS dt, channel, count() AS registrations
        FROM example WHERE reg_time >= today() - {{days}}
        GROUP BY dt, channel ORDER BY dt
    renderer: builtin.table
    required: false
output:
  format: markdown
  rules:
    - when: "{{q.main.row_count}} == 0"
      show: { text: "No registrations in the last {{cmd.args.days}} days" }
    - show: result
```

Every step requires `id`, `executor`, `input`, and `renderer`; `status` is a reserved step id. Data executors use `builtin.table` or a registered script renderer. Executors with `content` must use `builtin.content`. Steps run concurrently without feeding data to one another, with at most three steps running at once, under both their own executor/renderer timeout and a command-wide deadline. All predictable gates are checked before launch. A runtime gate failure or required-step failure cancels queued and still-running siblings. `required` defaults to false: an optional failure renders only the fixed message `该部分暂时无法获取` in place while other steps remain visible. Multi-step output is concatenated in definition order with a blank line and no automatic internal-id heading.

`output` permits only `format: markdown|text` (markdown by default) and ordered `rules`. Each rule has exactly one action: `handoff` or `show`. Variables are `q.<step-id>.*`, `run.status`, `run.<step-id>.*`, plus `cmd.name`, `cmd.description`, `cmd.args.*`, `cmd.source`, and `cmd.taskId`; any failed step makes aggregate `run.status` equal `error`. Each step reports only its own error, while a successful step has an empty error. A rule that references `q.<id>.*` for a failed step is treated as non-matching and evaluation continues. With no matching rule, the renderer result is shown. A handoff carries data only from steps whose executors set `allowHandoff: true`; the host prepends immutable command context and exposes only fixed error codes and messages. Scheduling requires every step to be `schedulable`.

Legacy fields are rejected with no compatibility parser: top-level `executor` / `input`, `output.text`, `prefix` / `suffix`, `else`, `onError`, `format: table|auto`, and registry `risk`, `format: json`, `contractVersion`, or `aliases`.

## Renderer protocol

`builtin.table` renders multiple rows as a table and one row as “field: value”. `builtin.content` uses executor Markdown. A custom renderer reads this JSON shape from stdin:

```json
{"rows":[{"merchant":"A","failures":12}],"columns":[{"key":"merchant","label":"Merchant"}],"totalRows":1,"fields":{},"cmd":{"name":"risk_report","args":{"date":"2026-09-28"}}}
```

stdout is UTF-8 Markdown. Timeout, non-zero exit, an early stdin close, output limit, or artifact drift records `renderer_failed` and falls back to `builtin.table`. Renderers receive no credential or caller identity. When a data result exceeds 1,000 rows, the host projects the first 1,000 rows and reports the full row count.

## Display safety

For every source, the host removes mentions, replaces the opening angle bracket of Feishu-specific tags with its full-width form, rejects remaining raw HTML, wraps body URLs in non-clickable copyable inline code, and removes reference-link definition lines. Only a top-level `vega-lite` fence is exempt from body cleaning; quoted, listed, or indented fences are treated as body text. The Feishu adapter handles `vega-lite` when #1633 is present; without it the fence remains ordinary code. `format: text` derives plain text from Markdown. Content itself is not truncated at 20KB: a card over 80KB falls back as a whole to derived plain text, and only the final text message may be truncated to 20KB.

## Scheduling and release

A verified human creates a task with `/schedule <rule> /<command> [args]`. Creation and execution re-check approval, revision, creator identity, and every step's `schedulable` policy. Revision, specHash, and the confirmation card cover every step's executor and renderer; the card lists each dependency and its handoff permission. Every step writes its own execution audit under one shared execution ID. Production rollout still requires QA, development, and operations online, plus technical monitoring, core-function verification, and product/business acceptance. Production configuration changes require mandatory approval.

## Complete example: three-step morning report

```yaml
schemaVersion: 2
name: morning_report
description: Registration trend + amount Top 10 + today's calendar
params:
  - { name: days, label: Days, type: integer, min: 1, max: 90, default: 7 }
steps:
  - id: reg
    executor: data.query.readonly
    input: { sql: "SELECT dt, count() AS registrations … {{days}} …" }
    renderer: risk.trend-chart
  - id: top
    executor: data.query.readonly
    input: { sql: "SELECT merchant, amount … ORDER BY amount DESC LIMIT 10" }
    renderer: builtin.table
  - id: cal
    executor: lark.calendar-agenda
    input: { date: "{{today}}" }
    renderer: builtin.table
output:
  format: markdown
  rules:
    - when: "{{q.reg.row_count}} == 0"
      show: { text: "No data in the last {{cmd.args.days}} days" }
    - show: result
```

The steps are parallel rather than chained, and their output is assembled in definition order. Run it with `/morning_report 7`; schedule it with `/schedule every day at 9am /morning_report 7`.
