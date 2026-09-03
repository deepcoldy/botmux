# Slash Commands

Just send these commands directly in a topic, and the daemon intercepts and handles them. Only the allowlisted commands in the [passthrough section](#-passthrough-to-the-underlying-cli) are forwarded verbatim to the underlying CLI; any other `/xxx` the daemon doesn't recognize is treated as ordinary conversation text and relayed as a normal message. Send `/help` anytime to view the full list.

## 📌 Session Management

| Command | Description |
|------|------|
| `/repo` | When a repository is pending selection, start with the default workingDir; if a session is in progress, pop up the project selection card |
| `/repo <N>` | Switch to the Nth project from the last scan |
| `/repo <path\|project name>` | Directly specify a path or a top-level project name under workingDir |
| `/cd <path>` | Switch the working directory and restart the CLI process |
| `/status` | View session info (uptime, terminal address, etc.) |
| `/retry` | Retry the most recent failed or interrupted turn (10s cooldown) |
| `/restart` | Restart the CLI process (preserving the session context) |
| `/close` | Close the session and send a recoverable card (including the CLI's own resume command) |
| `/fork <task>` | Fork the current session with full context into a new sub-topic of the same topic group; the source session keeps running untouched (Claude family / Codex terminal only) |
| `/forklist` | Re-post the current session's forked-task panel with live/closed status and links to the child topics |
| `/fork --create <group name>` | Clone the current session into a freshly-created group instead of a sub-topic |
| `/rename <title>` | Rename this Botmux session and sync the running Codex/Claude native session name |
| `/fork --create <new group name>` | Clone the current idle session into a newly-created group while leaving the source session untouched (Claude family / Codex terminal mode; invoke inside the source session's topic) |
| `/card` | Manually summon the current session's streaming card (can summon and restore live refresh even when streaming is off; in private-card mode, sends a static snapshot visible only to authorized users instead). `/card off` and `/card on` toggle streaming cards for this chat; `/card pin off`, `/card pin on`, and `/card pin status` control the per-chat streaming-card Pin override |
| `/cot` | Thinking-process message switch: `/cot off` mutes this chat's thinking bubble, `/cot on` restores it, `/cot show` summons a one-off peek at the current turn's bubble while the switches are off, `/cot status` reports the state (bot-level master switch `thinkingCard`, on by default; claude-code / codex only) |
| `/term` | Get the operable (write-enabled) terminal link for this session, delivered privately to the owner (visible-to-you in-chat, falling back to DM in topic/p2p — never exposed in the group) |
| `/dashboard [module]` | Open Dashboard control cards in Feishu (sessions/schedules/groups/settings/help, etc.) |
| `/insight` | owner-only: instantly posts a "session insight summary" card for the current session (aggregate metrics + rule suggestions; action-span detail / per-turn reconciliation / conversation replay live on the Dashboard "Insights" page) |
| `/vc prepare <meeting link or number>` | Use the current regular group as a meeting-prep chat and reuse the same Agent session during the meeting |
| `/introduce` | Register the bots in this chat with each other by `open_id`, so they can @-mention one another precisely when collaborating |
| `@bot /summary` | Read the current topic (or the configured regular-group history range) and generate a summary (default: latest 50 messages / 24 hours). If the bot has `summaryMemory` enabled, the summary is appended to the configured memory file (`summaryMemoryPath`, defaults to `summary.md`), and text following `/summary` acts as a hard "summarize only from this message" boundary; when memory is off, trailing text is only a focus hint for this summary |
| `/t [<text>]` `/topic [<text>]` | Force a new topic inside a regular group; text becomes the first task (starting after repository selection when needed), while the bare command opens topic setup |
| `/issue` | Open the Issue Board card and claim a botmux platform task in place: pick a repo and botmux creates a group, adds you, binds the platform task and starts the agent. Requires this machine to be bound to the platform, and the invoker to be in the bot's `allowedUsers`; only the invoker can operate the card |
| `/issue status` | Run inside the task group to see which platform task it is bound to and where things stand: platform status / claimant / local binding / whether any status write-back is still stuck in the outbox. Read-only, also limited to the bot's `allowedUsers` |
| `/issue done` | Run inside the task group to **accept the work** and move the task to its terminal state on the platform. An agent can only deliver up to "in review"; marking it done is a human decision. Once done, the platform clears the claim and the task can no longer be released. Also limited to the bot's `allowedUsers` |
| `/issue release` | Run inside the group created when the task was claimed: hands the task back to the platform's todo pool so someone else can take it. The group and session are **not** disbanded — the conversation is kept. Also limited to the bot's `allowedUsers` |

See [Session & Topic Model](/en/session-model) for the repository-picker and pinned-directory branches of bare `/t`. You can also make `/repo` the new topic's first command:

- `/t /repo <path|project name>`
- `/t /repo wt <path|project name> [branch]`

These forms create the topic and select a repository or create a worktree directly, without starting an empty session and switching it afterward. Send the task as the next message in the topic.

## 💬 Reply Mode (`/reply-mode`)

Controls how the bot opens a session when @mentioned. No argument (or `status`) shows the current mode; changing it needs `canOperate`, viewing needs `canTalk`. In group chats you must @ the target bot (in multi-bot groups, @ the specific bot). Only regular groups and 1:1 DMs are supported; topic groups need no setting (they're already topics) and the command is rejected there.

**DM (1:1)** — the mode applies to **all of this bot's DMs** (bot-level global config, not per-chat), but different users' DMs with the bot still keep isolated sessions. The modes are `chat` / `topic` / `group` (`new-topic` is a compat alias of `topic`):

| Command | Description |
|------|------|
| `/reply-mode` `/reply-mode status` | Show the current DM session mode |
| `/reply-mode chat` | Each 1:1 DM is one flat continuous session — all messages in that DM share one session (**default**) |
| `/reply-mode topic` `/reply-mode new-topic` | Each **top-level** DM opens its own session/thread; replies inside an existing thread continue that thread's session |
| `/reply-mode group` | Each **top-level** DM births a dedicated user+bot session group hosting the conversation (AI-generated name; returning to the group resumes the session — see `p2pMode=group`) |

`shared` / `chat-topic` rely on native group topics and are rejected in DMs.

**Regular groups** — how top-level @mentions open sessions (per-chat override, higher priority than the dashboard default):

| Command | Description |
|------|------|
| `/reply-mode` `/reply-mode status` | Show the current group reply mode |
| `/reply-mode chat` | One continuous group session (all top-level @mentions share it) |
| `/reply-mode chat-topic` | Flat at top level, native topics each get their own session |
| `/reply-mode new-topic` | Each @mention opens a new topic and its own session |
| `/reply-mode topic` `/reply-mode shared` | Topic UI but a shared session (`topic` is a compat alias of `shared`) |

The group-level setting overrides the dashboard "Bot Config → Regular Group Mode" default.

`/substitute [status|on|off]` — show or toggle **substitute mode** for the current group (owner-only to change).

## 🔀 Passthrough to the Underlying CLI

`/compact` `/model` `/clear` `/plugin` `/usage` `/new` `/context` `/cost` `/mcp` `/diff` `/code-review` `/security-review` `/review` `/btw` `/effort` `/fast` — delivered literally to the underlying CLI and handled by its built-in commands.

`/fast` is Codex-specific: it toggles Codex's native service tier, and the streaming card shows a read-only `⚡ <tier>` badge reflecting whatever tier Codex actually runs. On RPC-input or Riff backends the keystroke can't reach Codex's executor, so `/fast` fails closed there with a clear notice instead of a silent no-op.

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
| `/detach` | Disconnect this topic from the adopted session (the original CLI is untouched; `/disconnect` is an alias) |

## 🔐 User Authorization

| Command | Description |
|------|------|
| `/login` | Lark user authorization; once authorized, you can download third-party card images and call cloud docs/calendar and other APIs as yourself |
| `/login status` | View authorization status |
| `/login tags` | Session-group tag authorization (feed-group scopes); once granted, new session groups auto-join your sidebar feed group (for p2pMode=group with the feed-group tag mode — the default) |
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
| `/vc-auth @someone` | While meeting-listening is on, temporarily trust an in-meeting instruction source; `/vc-auth revoke @someone` revokes; `/vc-auth list` shows current grants |

## ⚙️ Remote Config & Skills (owner-only)

Written and hot-applied — no restart needed.

| Command | Description |
|------|------|
| `/botconfig get` | Show this bot's current operational config |
| `/botconfig set <field> <value>` | Change model/cli/lang/toggles; `/botconfig help` lists all fields |
| `/skills ...` | View/manage this bot's skill policy (`attach`/`detach` require owner) |

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
| `/workflow run <name> [key=value ...]` | Run a Saved Workflow |
| `/workflow save last [name]` · `/workflow list\|show\|cancel` | Save / list / inspect / cancel workflows (legacy v2 assets only support offline `migrate-v3` / `archive-runs`) |

> The old `/template run|cancel` commands are retired; sending `/template` now returns a retirement notice.

See [Workflow](/en/workflow) for details.

## 👥 Multi-Bot Collaboration

`@botA @botB /t <prompt>` (each opens a new topic) · `@botA @botB /introduce` (register the bots in this chat with each other by open_id for precise collaboration mentions) · `botmux bots list` (show bots available in the current group)

## ⏰ Scheduling & ❓ Help

`/schedule ...` (see [Scheduled Tasks](/en/schedule)) · `/help` (shows the full list inside the topic)
