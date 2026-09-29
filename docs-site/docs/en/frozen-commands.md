# Frozen Commands

Frozen commands turn a verified plugin tool or allowlisted process into a slash command. After installation, `/command args` or the single sentence `run /command args` executes directly by default. A result or execution failure reaches a model only when the author explicitly configures and matches an `output.rules` entry. Lifecycle confirmation does not become a per-run confirmation prompt.

## Lifecycle and permissions

- Creating or updating a command requires the same human to click the host confirmation card within 10 minutes. Writing YAML alone never authorizes execution.
- The human who confirms creation becomes the owner and may update, retire, restore, or permanently revoke the command. Administrators may override; legacy commands without a verifiable owner still require an administrator claim.
- Permanent revocation requires retirement first, is irreversible, and must be confirmed by the same human in the dedicated card.
- Create, update, retire, restore, and revoke operations all require a reason between 1 and 500 characters.
- In a group chat, mention the target bot. This also applies to administrative commands such as `/freeze list`.
- When a bot enables `restrictGrantCommands`, visitors who can chat only through `chatGrants` or `globalGrants` cannot use `/freeze` or installed frozen commands. The restriction also covers natural-language direct execution and non-ASCII command names. Owners, `allowedUsers`, on-call users, and full-chat members keep their existing permission behavior.

Live definitions are stored in `<working-directory>/.botmux/commands/*.yaml`; drafts use `<working-directory>/.botmux/frozen-command-drafts/*.yaml`. These files may contain business SQL. The botmux source repository ignores both paths at any directory depth; add the same rules to other working repositories. Copy sanitized definitions to a dedicated, access-controlled configuration repository if versioning is required.

## Result presentation

`output.format` accepts `text` (the backward-compatible plain-message default), `markdown`, `table`, or `auto`. The intermediate contract stores only versioned Markdown/table blocks, never text blocks or raw HTML. With `format: text`, Feishu sends the escaped, 20KB-bounded `fallbackText` as a text message; every other format renders a card. A future Web surface can consume the same blocks with its own HTML sanitizer. Tables display at most 50 rows and 20 columns; the complete plain-text form remains available as a fallback. Legacy plugin text blocks fail closed instead of being converted implicitly.

Use ordered `output.rules` to choose between display and model interpretation. The first matching rule wins. Every rule must contain exactly one action: `handoff` or `show`. With no rules or no match, the result follows `output.format`. Direct, confirmed, and scheduled runs share this decision path:

```yaml
output:
  format: table
  maxChars: 20000
  rules:
    - when: "{{run.status}} == 'error' && {{run.error.transient}} == true"
      handoff:
        prompt: "Execution failed temporarily. Give safe next steps from the command context."
    - when: "{{q.max_drop}} > 0.2"
      handoff:
        prompt: "Explain the likely causes of this threshold breach."
        data: "{{q.rows}}"
        maxRows: 20
    - when: "{{q.row_count}} == 0"
      show:
        text: "No matching data"
        format: markdown
    - show: result
```

- `q.*` contains successful result fields plus `q.rows` and `q.row_count`. `run.*` contains `status`, `error.code`, `error.message`, `error.transient`, and `executionId`. `cmd.*` contains the command name, description, arguments, executor, trigger source, and task id.
- Only execution-stage failures can enter rules. Unapproved, retired, or revoked commands, untrusted identity, invalid arguments, fail-closed state, and executor revision drift always fail directly.
- The host prepends immutable command context before the author prompt. Error handoff includes only a stable code and user-safe message, never raw executor output.
- `policy.allowHandoff` controls every handoff and defaults to `false`. `policy.handoffIncludesInput` also defaults to `false`; when enabled, definition input is attached strictly for tool use and marked as non-displayable.
- `show: result` displays the original result with the default `format`; `show: { text, format }` renders a template and may override that format. A rule without `when` always matches and can be the final explicit catch-all.
- Legacy `output.when` / `handoff` / `else` remains readable and is converted into two rules: handoff on the condition, otherwise show `else.text`. Legacy `onError: fallback_llm` is converted to an equivalent transient-execution-error rule; new definitions should use neither `onError` nor `else`.

## Administrator executor allowlist

Every frozen command must be registered in `~/.botmux/command-executors.yaml`. The registry supports `process`, `script`, and the generic `plugin-tool` kind; the host does not embed any business-plugin name. If the file is absent, the registry is empty and frozen commands are disabled by default.

A `plugin-tool` entry declares a plugin id, tool name, minimum stable version, and generic safety policy. Contract-aware tools declare `contractVersion` and return channel-neutral Markdown/table blocks plus a plain-text fallback. Ordinary MCP tools declare `output`, and the host projects their JSON through allowlisted `exposeFields` or `container` plus `exposeRowFields`. At execution time the host opens a one-plugin gateway and injects trusted caller identity through `_meta`. The plugin must be installed, enabled, and new enough according to the host registry; a missing tool or incompatible contract fails closed.

During a trusted human turn, an agent may call `botmux freeze executors` for the read-only authoring contract. The response contains only executor ids and argument names, types, accepted sources, and constraints; it excludes executable paths, fixed arguments, and artifact paths/digests. Candidate definitions are checked against this complete contract before a confirmation card can be shown.

A `plugin-tool` string argument that accepts only `literal` input may set `maxLength` up to 200000 for administrator-reviewed large templates. Arguments that accept `param` or `context` input, and all `process` / `script` arguments, remain capped at 10000.

Data MCP is configured as an ordinary plugin tool. SQL is opaque to the host; literal encoding, byte-identical validation, and execution remain inside the plugin. Caller identity must not be declared in `arguments`; it arrives only through trusted gateway `_meta`.

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

For an ordinary JSON MCP tool, replace `contractVersion` with a projection such as:

```yaml
    output:
      format: json
      container: rows
      exposeRowFields: [name, total]
```

The following example registers a read-only script. Paths must be absolute canonical realpaths, not symlinks. Entry scripts listed in `scriptArtifacts` are hashed again before each run.

```yaml
schemaVersion: 2
executors:
  - id: finance.report
    kind: script
    executable:
      realpath: /opt/homebrew/Cellar/node/24.8.0/bin/node
    fixedArgs: [/opt/botmux/executors/finance-report.mjs]
    scriptArtifacts: [/opt/botmux/executors/finance-report.mjs]
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

Security boundaries:

- The `risk` field has been removed. A legacy value is ignored with a warning; read-only behavior is the executor registrant's responsibility and is not inferred from a string. Process arguments are still passed as distinct argv tokens, never composed into a shell string.
- `arguments.*.accepts` declares the allowed source for each value.
- `plugin-tool` arguments cannot accept `context:caller.*`; caller identity is available only through host-frozen `_meta`.
- JSON output is projected through either `exposeFields` or `container` plus `exposeRowFields`; unlisted fields are not returned.
- The host injects credentials for the current bot. Neither command definitions nor the allowlist handle credential paths or environment variables.
- The plugin registry is installed globally. A globally enabled plugin is visible to every bot, while each frozen command can still invoke only the one plugin and one tool in its allowlist entry.
- The current isolation scheme does not add an OS sandbox. Executors run under the daemon UID, so never paste child environments or `ps eww` output into chat.
- Changing the allowlist or an artifact changes the executor revision; affected commands require approval again.

### Migrating the legacy built-in Data MCP executor

Add the `plugin-tool` registration above and map the legacy `builtin.data-mcp.readonly` id through `aliases`; new definitions should use the canonical id such as `data.query.readonly`. Keep the optional `datasource` argument so legacy definitions that set it explicitly remain valid.

Handle these three migration effects explicitly:

1. The executor revision calculation changes, so every approved command requires approval again from its owner or an administrator.
2. Legacy `onError: fallback_llm` becomes a transient-error handoff rule. If its executor does not explicitly enable `policy.allowHandoff`, the definition fails closed; remove the legacy fallback or approve handoff first.
3. A legacy Data MCP definition containing `datasource` is rejected unless the allowlist declares the same argument shown above.

Recommended order: back up definitions and the approval ledger; deploy and enable a plugin satisfying `minimumVersion`; update the executor registry and alias; validate and re-approve each legacy command; then upgrade BotMux and smoke-test direct, confirmed, and scheduled paths. Reversing the plugin/BotMux order intentionally fails closed.

## Scheduling

Ask the human to send the canonical form `/schedule <rule> /<command> [args]` so the task stores a trusted creator identity. Creation verifies that the command exists, is approved, accepts the arguments, and is schedulable, then persists the exact `/command args` form. The older `, run /<command>` wording remains compatible for existing tasks. Silent schedules suppress normal successful output only; identity, approval-state, retirement, and execution errors are still delivered.
