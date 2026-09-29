# Frozen Commands

Frozen Commands save approved execution steps as slash commands. An executor returns data or complete Markdown, a renderer turns data into Markdown, and the host owns identity, gates, rules, and display safety. `/command args` and the exact form `run /command args` execute directly by default; only an explicit matching `output.rules[].handoff` invokes the model.

## Lifecycle and permissions

- Create and update operations require the same verified human to confirm within ten minutes. Writing YAML alone never grants execution permission.
- The final confirmer becomes owner. Owners and administrators manage lifecycle; permanent revocation is irreversible and requires a second confirmation.
- Any command, executor, or renderer change changes the revision and requires re-approval.
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
    minimumVersion: 0.4.0
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

Data MCP 0.4.0 `execute_frozen_query` returns only `rows`, `columns`, `row_count`, `query_id`, and `error_code`. Parameter encoding, byte-identical validate/run, and `_meta` identity remain plugin responsibilities; the host does not interpret SQL. The service also enforces `MAX_SQL_BYTES` on rendered SQL (20000 UTF-8 bytes by default). An oversized query records `sql_too_large` in service audit logs while users receive only a fixed host error.

## Command definition

Batch one accepts exactly one step, but already uses the final `steps[]` syntax and step-qualified namespaces:

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

Every step requires `id`, `executor`, `input`, and `renderer`. Data executors use `builtin.table` or a registered script renderer. Executors with `content` must use `builtin.content`. `required` defaults to false and becomes relevant when multi-step execution is enabled.

`output` permits only `format: markdown|text` (markdown by default) and ordered `rules`. Each rule has exactly one action: `handoff` or `show`. Variables are `q.<step-id>.*`, `run.status`, `run.<step-id>.*`, and `cmd.*`. With no matching rule, the renderer result is shown. Handoffs require executor `allowHandoff`; the host prepends immutable command context and exposes only fixed error codes and messages.

Legacy fields are rejected with no compatibility parser: top-level `executor` / `input`, `output.text`, `prefix` / `suffix`, `else`, `onError`, `format: table|auto`, and registry `risk`, `format: json`, `contractVersion`, or `aliases`.

## Renderer protocol

`builtin.table` renders multiple rows as a table and one row as “field: value”. `builtin.content` uses executor Markdown. A custom renderer reads this JSON shape from stdin:

```json
{"rows":[{"merchant":"A","failures":12}],"columns":[{"key":"merchant","label":"Merchant"}],"totalRows":1,"fields":{},"cmd":{"name":"risk_report","args":{"date":"2026-09-28"}}}
```

stdout is UTF-8 Markdown. Timeout, non-zero exit, output limit, or artifact drift records `renderer_failed` and falls back to `builtin.table`. Renderers receive no credential or caller identity.

## Display safety

The host removes mentions, rejects raw HTML, and converts links to plain text for every source. Escaping recognizes fenced code so angle brackets inside code are preserved. `vega-lite` blocks are handled by the Feishu adapter when #1633 is present; without it they remain ordinary code. `format: text` derives plain text from Markdown. Shared 20KB text and 80KB card budgets remain in force.

## Scheduling and release

A verified human creates a task with `/schedule <rule> /<command> [args]`. Creation and execution re-check approval, revision, creator identity, and `schedulable`. Production rollout still requires QA, development, and operations online, plus technical monitoring, core-function verification, and product/business acceptance. Production configuration changes require mandatory approval.
