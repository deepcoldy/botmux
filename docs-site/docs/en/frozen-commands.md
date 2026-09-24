# Frozen Commands

Frozen commands turn a verified query or read-only script into a slash command. After installation, `/command args` or the single sentence `run /command args` executes directly in the host without an LLM or a second run-confirmation card.

## Lifecycle and permissions

- Creating or updating a command requires the same human to click the host confirmation card within 10 minutes. Writing YAML alone never authorizes execution.
- The human who confirms creation becomes the owner and may update, retire, or restore the command.
- Permanent revocation requires the command to be retired first and always requires a `frozenCommandAdmins` administrator.
- Create, update, retire, restore, and revoke operations all require a reason between 1 and 500 characters.
- In a group chat, mention the target bot. This also applies to administrative commands such as `/freeze list`.
- When a bot enables `restrictGrantCommands`, visitors who can chat only through `chatGrants` or `globalGrants` cannot use `/freeze` or installed frozen commands. The restriction also covers natural-language direct execution and non-ASCII command names. Owners, `allowedUsers`, on-call users, and full-chat members keep their existing permission behavior.

Live definitions are stored in `<working-directory>/.botmux/commands/*.yaml`; drafts use `<working-directory>/.botmux/frozen-command-drafts/*.yaml`. These files may contain business SQL. The botmux source repository ignores both paths at any directory depth; add the same rules to other working repositories. Copy sanitized definitions to a dedicated, access-controlled configuration repository if versioning is required.

## Administrator executor allowlist

Data MCP queries use the built-in `builtin.data-mcp.readonly` executor. To freeze `lark-cli` or a custom script, an administrator must create `~/.botmux/command-executors.yaml`. If the file is absent, the registry is empty and every process/script command is disabled by default.

During a trusted human turn, an agent may call `botmux freeze executors` for the read-only authoring contract. The response contains only executor ids and argument names, types, accepted sources, and constraints; it excludes executable paths, fixed arguments, and artifact paths/digests. Candidate definitions are checked against this complete contract before a confirmation card can be shown.

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

Ask the human to send the canonical form `/schedule <rule> /<command> [args]` so the task stores a trusted creator identity. Creation verifies that the command exists, is approved, accepts the arguments, and is schedulable, then persists the exact `/command args` form. The older `, run /<command>` wording remains compatible for existing tasks. Silent schedules suppress normal successful output only; identity, approval-state, retirement, and execution errors are still delivered.
