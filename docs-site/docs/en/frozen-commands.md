# Frozen Commands

Frozen commands turn a verified query or read-only script into a slash command. After installation, `/command args` or the single sentence `run /command args` executes directly in the host without an LLM or a second run-confirmation card.

## Lifecycle and permissions

- Creating or updating a command requires the same human to click the host confirmation card within 10 minutes. Writing YAML alone never authorizes execution.
- The human who confirms creation becomes the owner and may update, retire, or restore the command.
- Permanent revocation requires the command to be retired first and always requires a `frozenCommandAdmins` administrator.
- Create, update, retire, restore, and revoke operations all require a reason between 1 and 500 characters.
- In a group chat, mention the target bot. This also applies to administrative commands such as `/freeze list`.

Live definitions are stored in `<working-directory>/.botmux/commands/*.yaml`; drafts use `<working-directory>/.botmux/frozen-command-drafts/*.yaml`. These files may contain business SQL. The botmux source repository ignores both paths at its root; add the same rules to other working repositories. Copy sanitized definitions to a dedicated, access-controlled configuration repository if versioning is required.

## Administrator executor allowlist

Data MCP queries use the built-in `builtin.data-mcp.readonly` executor. To freeze `lark-cli` or a custom script, an administrator must create `~/.botmux/command-executors.yaml`. If the file is absent, the registry is empty and every process/script command is disabled by default.

Paths must be absolute canonical realpaths, not symlinks. Entry scripts listed in `scriptArtifacts` are hashed again before each run.

```yaml
schemaVersion: 1
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
      risk: read
      schedulable: true
      allowHandoff: false
      timeoutMs: 10000
      maxOutputBytes: 65536
    output:
      format: json
      exposeFields: [total, currency]
```

Security boundaries:

- Version 1 accepts only `policy.risk: read`; it does not allow writes or shell-string composition. Arguments are passed as distinct argv tokens.
- `arguments.*.accepts` declares the allowed source for each value.
- JSON output is projected through either `exposeFields` or `container` plus `exposeRowFields`; unlisted fields are not returned.
- The host injects credentials for the current bot. Neither command definitions nor the allowlist handle credential paths or environment variables.
- The current isolation scheme does not add an OS sandbox. Executors run under the daemon UID, so never paste child environments or `ps eww` output into chat.
- Changing the allowlist or an artifact changes the executor revision; affected commands require approval again.

## Scheduling

Ask the human to send `/schedule <rule>, run /<command> [args]` so the task stores a trusted creator identity. Silent schedules suppress normal successful output only; identity, approval-state, retirement, and execution errors are still delivered.
