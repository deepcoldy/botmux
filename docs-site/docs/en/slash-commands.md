# Slash Commands

Just send these commands directly in a topic, and the daemon intercepts and handles them. A `/xxx` that botmux doesn't recognize is **passed through verbatim** to the underlying CLI (so they don't conflict with the CLI's own slash commands). Send `/help` anytime to view the full list.

## 📌 Session Management

| Command | Description |
|------|------|
| `/repo` | When a repository is pending selection, start with the default workingDir; if a session is in progress, pop up the project selection card |
| `/repo <N>` | Switch to the Nth project from the last scan |
| `/repo <path\|project name>` | Directly specify a path or a top-level project name under workingDir |
| `/cd <path>` | Switch the working directory and restart the CLI process |
| `/status` | View session info (uptime, terminal address, etc.) |
| `/restart` | Restart the CLI process (preserving the session context) |
| `/close` | Close the session and send a recoverable card (including the CLI's own resume command) |
| `/card` | Manually summon the current session's streaming card (can summon and restore live refresh even when streaming is off; in private-card mode, sends a static snapshot visible only to authorized users instead) |
| `/insight` | owner-only: instantly posts a "session insight summary" card for the current session (aggregate metrics + rule suggestions; action-span detail / per-turn reconciliation / conversation replay live on the Dashboard "Insights" page) |
| `/t <prompt>` `/topic <prompt>` | Force a new topic inside a regular group |

## 🔀 Passthrough to the Underlying CLI

`/compact` `/model` `/clear` `/plugin` `/usage` `/new` `/context` `/cost` `/mcp` `/diff` `/code-review` `/security-review` `/review` `/btw` — delivered literally to the underlying CLI and handled by its built-in commands.

Some CLIs also declare adapter-default passthrough commands: Claude Code and Codex default-allow `/goal`, so a new topic whose first message is `/goal ...` will start/select the repository first and then send `/goal ...` to the CLI literally.

To allow more commands through, configure [`customPassthroughCommands`](/en/bots-json) for that bot (e.g. `["/export"]`) to extend beyond the allowlist above as needed. Entries that would shadow a botmux daemon command (such as `/status`, `/help`, `/cd`) are automatically dropped — daemon commands always keep their own semantics and cannot be overridden via passthrough.

## 🧩 View Available Commands

`/list-slash-command` (alias `/slash`): lists the currently available slash commands in a card, in four sections —

1. botmux's fixed passthrough allowlist;
2. commands default-allowed by the current CLI adapter;
3. commands this bot custom-allows via `customPassthroughCommands` in bots.json;
4. custom commands / skills / plugins auto-discovered from the `.claude` directory (project-level + `~/.claude` + plugin cache), shown in a paginated "command ｜ description" table, with a note of any detected MCP server names.

Permissions are the same as `/help`, and it doesn't occupy a session slot.

## 📡 Session Onboarding

| Command | Description |
|------|------|
| `/adopt` | Scan the local tmux and pop up a card to select a running session to adopt |
| `/adopt <tmux_pane>` | Directly adopt the specified pane (e.g. `/adopt 0:2.0`) |

## 🔐 User Authorization

| Command | Description |
|------|------|
| `/login` | Lark user authorization; once authorized, you can download third-party card images and call cloud docs/calendar and other APIs as yourself |
| `/login status` | View authorization status |
| `/pair <pairing code>` | Pair a Web/Dashboard-side session with your Lark identity (get the pairing code on the web side, then send `/pair <code>` in the topic to claim it) |

## 🎭 Roles (Personas)

| Command | Description |
|------|------|
| `/role` | View the currently effective Role (this-group override > default role > none) |
| `/role set <Markdown>` | Set **this group's** Role (overrides the default role) |
| `/role delete` | Delete this group's Role |
| `/role team set <Markdown>` | Set the **default role** (the cross-group default persona; the command name keeps `team`, = dashboard "Bot Config → Default Role") |
| `/role cap set <one-liner>` / `/role cap clear` | Set/clear the capability tag in the roster |
| `/role profile list` | List local role profiles |
| `/role profile show <profile> [--all]` | Show this bot's profile entry, or all local entries known to this daemon |
| `/role profile set <profile> <Markdown>` | Set this bot's entry in a reusable role profile |
| `/role profile save <profile>` | Save this bot's current effective role into the profile |
| `/role profile apply <profile> [--preview] [--force] [--quiet]` | Write this bot's profile entry as this group's Role |

See [Roles & Teams](/en/roles) for details.

## 🔀 Session Relay (Regular Groups)

| Command | Description |
|------|------|
| `/relay` | Pop up a card in the target group to **pull** an active session of yours from another group and continue it |
| `@botA @botB /relay --create` | **Move** the current session (with its collaborators) into a newly created group |

See [Session Relay](/en/relay) for details.

## 🛎️ On-Call (Group Chats)

`/oncall bind <path>` · `/oncall unbind` · `/oncall status`

## 🔑 Usage Authorization (owner-only)

| Command | Description |
|------|------|
| `@bot /grant @someone` | Authorize that person to chat in this group; `/grant` (without a person) authorizes **all members of this group** to chat |
| `@bot /revoke @someone` | Revoke that person's chat permission in this group; `/revoke` (without a person) revokes the whole group's authorization |

## 🆕 One-Click New Session Group

`/group <group name>` (alias `/g`): automatically creates a new Lark group, invites you in, transfers ownership to you, and runs the entire group as a standalone CLI session. `@botA @botB /g <group name>` can add multiple bots into the new group at once.

Add `--role-profile <profile>` to bootstrap the new group with reusable per-bot roles:

```bash
@botA @botB /g --role-profile collab-main War Room
```

See [One-Click Session Group](/en/group) for details.

## 📄 Feishu Doc Comment Entry

`/watch-comment`: watch Feishu doc comments, bind them to an AI session, and post replies back into their threads; supports `<doc link> [--dir <path>] [--all|--mentions-only]` and `list/off`. `/subscribe-lark-doc` keeps the original per-file Feishu API subscription flow. See [Feishu Doc Comment Entry](/en/doc-comment) for details.

## 🔧 Workflow (orchestration, experimental)

| Command | Description |
|------|------|
| `/workflow <goal>` (= `/workflow new <goal>`) | Start an **ad-hoc workflow**: the bot interrogates the requirement → auto-orchestrates a DAG → runs it concurrently after you confirm, with approval cards on risk nodes at execution time |
| `/template run <id> [key=value ...]` | Run a saved workflow template (the old `/workflow run` was renamed to this) |
| `/template cancel <runId>` | Cancel a template run (the old `/workflow cancel` was renamed to this) |

See [Workflow](/en/workflow) for details.

## 👥 Multi-Bot Collaboration

`@botA @botB /t <prompt>` (each opens a new topic) · `botmux bots list` (show bots available in the current group) · `@botA @botB /introduce` (legacy / external-bot fallback; usually no longer needed)

## ⏰ Scheduling & ❓ Help

`/schedule ...` (see [Scheduled Tasks](/en/schedule)) · `/help` (shows the full list inside the topic)
