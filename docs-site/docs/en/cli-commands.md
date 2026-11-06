# CLI Commands

`botmux` commands come in two kinds:

- **Operator commands**: you run them in a server terminal to manage the daemon (the background process), bots, and sessions.
- **In-session commands**: the AI calls them inside a session to send messages, read history, create scheduled tasks, and so on. You usually don't type these yourself.

If you forget an option, run `botmux --help` for an overview, or `botmux <subcommand> --help` for the full options of one command.

## Most-used commands

| I want to… | Command |
|------|------|
| Configure for the first time / add a bot | `botmux setup` |
| Start / stop / restart | `botmux start` / `botmux stop` / `botmux restart` |
| Check whether it's running | `botmux status` |
| View logs | `botmux logs` |
| Upgrade | `botmux upgrade` |
| See active sessions, open a terminal | `botmux list` |
| Open the Dashboard | `botmux dashboard` |
| Start on boot | `botmux autostart enable` |

## Configure bots

### Interactive setup

```bash
botmux setup
```

Opens an interactive UI to configure for the first time, or add, edit, or delete bots. By default it signs in with a Lark QR scan and creates the app, grants permissions, sets the redirect, and publishes a version for you. Add `--no-open-platform-auto` to skip the automatic Open Platform setup.

### Scripted setup (no interactive UI)

Good for scripts or for letting an AI do it:

| Command | Purpose |
|------|------|
| `botmux setup list [--json]` | List configured bots (secrets masked) |
| `botmux setup add --create-app --allowed-users <owner>` | Scan a QR code to create a new Lark app and add it |
| `botmux setup add --app-id <cli_xxx> --app-secret <secret> --allowed-users <owner>` | Add a bot using an existing app's credentials |
| `botmux setup configure <process name\|AppID>` | Re-run Open Platform setup (permissions, events, publishing) for an added bot, e.g. when the last run didn't finish |
| `botmux setup edit <process name\|AppID> --cli codex` | Change individual fields, such as the CLI; pass `-` to clear a field |
| `botmux setup remove <process name\|AppID> --yes` | Delete a bot |

`--allowed-users` is the bot owner. When creating a new app, use a **full email, phone number, or a union_id starting with `on_`**, not an open_id starting with `ou_`: an open_id is valid only in the Lark app that issued it, and the new app doesn't exist yet, so it can't have a valid open_id. See `botmux setup help` for every field.

### Clone a bot

```bash
botmux clone <bot name> [--name <new name>]
```

Creates a new Lark app and copies the source bot's behavior settings. Without a name, it is named "source-name-copy-timestamp".

### Export a shareable preset

```bash
botmux preset export <bot> [--from-chat <chatId>] [--out <file>] [--yes]
```

Exports a bot's CLI, model, role, and capability tag as JSON, with setup guidance included. Send it to a teammate and their AI can set up a matching bot from it.

- `<bot>` is the process name (`botmux-xxx`) or AppID.
- The team-level role is exported by default; add `--from-chat <chatId>` to export the role content of one group instead (the group ID itself is not written to the file).
- By default it writes `<name>.botmux-preset.json` in the current directory; `--out -` prints to stdout.
- Before exporting, it shows you the role content to confirm. In non-interactive environments (for example when an AI runs it), add `--yes`.
- The file **contains no secrets**: AppID, Secret, `allowedUsers`, working directory, and similar fields are never exported.

### Switch the UI language

```bash
botmux lang          # Show the current language
botmux lang en       # Switch to English (zh / en)
botmux lang en --bot 0   # Change only bot #0 in bots.json
```

#### Switching languages in the setup wizard {#setup-lang}

While running `botmux setup`, press **L** on the first step's selection menu (with the search box empty) and the UI switches between Chinese and English right away; the choice is also saved as this machine's global language. In the simple numbered-input mode, typing `L` and Enter does the same.

You can also pick the language at launch: `botmux setup --lang en` (or `zh`), which is saved as the global language too. To change the UI language later, use `botmux lang` above.

## Start and stop the daemon

| Command | Description |
|------|------|
| `botmux start` | Start the daemon, plus plugin services with `mode=auto` |
| `botmux stop` | Stop the daemon. Plugin services keep running unless you add `--with-plugin` |
| `botmux restart` | Restart the daemon; active sessions are restored automatically |
| `botmux status` | Show the status of the daemon and each bot |
| `botmux logs` | View logs. Shows the last 50 lines and keeps following by default |
| `botmux start-bot <AppID>` | Start one bot only, without restarting the others. If the daemon as a whole isn't running, it tells you to use `botmux start` first |
| `botmux stop-bot <AppID>` | Stop one bot only; the other bots are unaffected |

`start-bot` / `stop-bot` accept `--json` for machine-readable output, handy in scripts. `botmux setup add` and Dashboard bot creation use `start-bot` to bring a new bot online.

Common `botmux logs` options:

- `--lines N`: show the last N lines.
- `--bot <index|name|AppID>`: show one bot only (index starts at 0).
- `--no-follow`: print and exit instead of following.

`start` / `restart` also accept `--companion-secret-file <absolute path> --companion-bot <appId>`. Passing both enables a closed local API for one isolated test bot; see [Local Companion API](/en/companion-api).

## Upgrade

```bash
botmux upgrade            # Upgrade to the latest stable release (alias: botmux update)
botmux upgrade canary     # Switch to a preview channel: canary / beta / rc / next
botmux upgrade 3.28.0     # Install a specific version
```

When it finishes, run `botmux restart` as prompted to load the new version. If you run botmux from a source checkout, `upgrade` does `git pull` + rebuild + restart instead. On releases older than v3.18.0, upgrade with the curl install script instead; see [FAQ · How do I upgrade?](/en/faq#how-do-i-upgrade).

## Manage sessions

### View sessions: `botmux list`

```bash
botmux list          # Interactive list (alias: ls)
botmux list --plain  # Plain-text table for scripts / pipes
botmux list --json   # JSON output
```

Keys in the interactive list:

| Key | Action |
|------|------|
| `↑` / `↓` (or `k` / `j`) | Select a session |
| `Enter` | Attach to the managed tmux / ZMX terminal; a suspended session is resumed first |
| `d` (or `x`) | Delete the selected session (press `y` to confirm) |
| `q` / `Esc` | Quit |

`list` also cleans up dead sessions: adopt sessions whose external process has exited, and throwaway sessions that never actually launched a CLI. A regular session is kept even if its CLI process exits; the next message picks it up again.

### Close, resume, suspend

| Command | Description |
|------|------|
| `botmux delete <id>` | Close a session (aliases `del` / `rm`). The first few characters of the ID are enough; if several match, you'll be asked for a longer prefix |
| `botmux delete all` | Close all active sessions |
| `botmux delete stopped` | Clean up zombie sessions whose process has exited (suspended sessions that can still resume are left alone) |
| `botmux resume <id>` | Resume a closed session and relaunch the CLI with its previous context (local sessions relaunch when the next message arrives) |
| `botmux suspend <id\|all>` | Suspend a session: the CLI process ends, but the session stays, and the next message picks up the context |
| `botmux suspend --bot <appId>` | Suspend all sessions of one bot |
| `botmux suspend --isolated` | Suspend sessions of every bot with read isolation. Use after updating CLI login credentials; the next launch syncs the new credentials |

Every `suspend` form accepts `--dry-run` to preview which sessions would be affected.

`delete` has the same effect as sending `/close` in Lark. When the daemon is online, it does the cleanup; if the daemon refuses or can't be reached, the command fails instead of killing processes locally. Local cleanup happens only once the daemon is confirmed offline.

### Suspend long-idle sessions in bulk

```bash
botmux maintenance suspend-idle --older-than 7d --dry-run   # Preview first
botmux maintenance suspend-idle --older-than 7d --yes       # Then execute
```

- `--older-than` is the last-activity threshold, in `ms/s/m/h/d/w`; default `7d`.
- `--dry-run` only lists candidates (session, bot, title, last activity, processes to be stopped) and changes nothing. Running for real requires an explicit `--yes`.
- `--bot <appId>` limits it to one bot; `--json` gives machine-readable output.
- Suspended sessions are kept; the next message cold-starts them from history.
- Only sessions that are clearly idle and resumable are picked. Sessions that are replying, have queued messages, are waiting on you, are locked, or were attached via adopt are skipped.

To run this periodically, turn on "Idle auto-suspend" in the bot settings in the Dashboard. This command is for manual previews and one-off batches.

### Get an operable terminal link

```bash
botmux term-link [id]
```

Gets a writable Web terminal for a session. The link isn't printed in the terminal; the daemon sends it to the bot owner as a private card (only you can see it in a group; in topics or direct chats it falls back to a direct message). You can omit `id` when there's only one active session. See [Web Terminal](/en/web-terminal).

## Dashboard login link

```bash
botmux dashboard           # Get the current login URL (same as dashboard current; creates one if missing)
botmux dashboard rotate    # Issue a new token; the old link stops working
```

See [Dashboard](/en/dashboard) for what it can do.

## Start on boot

```bash
botmux autostart enable   # Register start-on-boot (no sudo needed)
botmux autostart disable  # Unregister
botmux autostart status   # Show status
```

| OS | How it's done |
|------|------|
| macOS | `~/Library/LaunchAgents/com.botmux.daemon.plist` (launchd) |
| Linux | `~/.config/systemd/user/botmux.service` (user systemd), plus the crash watchdog `botmux-watchdog.timer` |
| Windows | A per-user scheduled task; falls back to the Startup folder if registering the task is denied |

Keep in mind:

- **On Linux servers, logging out stops the service.** To keep it running, run `sudo loginctl enable-linger <username>` once.
- The entry records the current Node (or single-file binary) path. After switching Node versions with nvm / fnm, run `enable` again; `start` / `restart` also detect and refresh it automatically.
- `enable` / `disable` **only manage start-on-boot; they never start or stop the running daemon**.
- On Linux, `enable` also turns on `botmux-watchdog.timer`: it checks every 30 seconds and brings the daemon back if it dies unexpectedly; `disable` turns it off too. After you run `botmux stop` on purpose, the watchdog won't bring it back; normal watching resumes on the next `start` / `restart`. `botmux autostart status` shows whether the watchdog is enabled.

## In-session commands (for the AI)

When run inside a botmux session, these commands detect the current session and group automatically, so no extra options are needed. The AI calls them as needed; it's enough for you to know what's available.

### Messages and cards

| Command | Description |
|------|------|
| `botmux send [content]` | Send a message to the current topic. Content can come from stdin / heredoc / `--content-file`. Common options: `--images`, `--files`, `--videos` (with `--video-covers`), `--card-file` / `--card-json` (custom card), `--mention` / `--mention-back` / `--no-mention` (who to @), `--diff` (collapsible code-change preview), `--voice` (voice bubble), `--dry-run` (render without sending). See `botmux send --help` for all options |
| `botmux card patch --message-id <om_xxx> (--card-file <path> \| --card-json <json>)` | Update a custom card previously sent by `send`, in place, without a new message. The messageId comes from the `send` output |
| `botmux card stream open/write/finish ...` | Stream text into a custom card with a typewriter effect, and optionally bind the daemon's runtime status to the card. See `botmux card stream --help` for the full flow |
| `botmux ask buttons --options "a,b" "<question>"` | Send a multiple-choice question as a button card and return the user's choice. `--multi` allows several choices |
| `botmux ask buttons --questions-file <file>` | Put several questions (choice, text, number, with presets) in one card, submitted once; returns all answers |
| `botmux ask buttons --answerer <open_id> ...` | Only the given person can submit (this limits who answers; it is not a business approval) |
| `botmux history [--limit N]` | Read the current session's message history (JSON). In a topic it reads the topic; in a regular group, the whole group |
| `botmux history --scope ambient` | In a topic session, read the group context outside the topic. `--scope` takes `session` / `thread` / `chat` / `ambient` |
| `botmux history --with-card-json` | Attach the raw structured JSON of each card |
| `botmux quoted <message_id>` | Read the single quoted message; attachments are downloaded locally |
| `botmux bots list` | List the bots in the current group (with open_id, for `--mention`) |
| `botmux bots list --scope team` | Discover opted-in bots from the same team on other machines (by expertise), to create or fill a group |
| `botmux bots invite --chat <chatId> --team <id> --agent <appId>...` | Add same-team bots, together with their owners, to an existing group; see `botmux bots invite --help` |

### Sessions and groups

| Command | Description |
|------|------|
| `botmux session rename "<title>"` | Rename the **current session**. Dashboard and the `/sessions` list update immediately. The Lark group name and topic name don't change. Suggested shape: "type \| subject", up to 200 characters |
| `botmux chat rename <new name> [--proactive]` | Rename the **Lark group** hosting the current session (in a topic group this renames the whole group, visible to all members). `--proactive` marks an AI-initiated rename, limited to once per 10 minutes |
| `botmux top-notice set <message_id>` | Pin one message in the current group as the group top notice. Works only in group sessions, or pass `--chat-id` to pick the group |
| `botmux slash "/command"` | Once the CLI is idle, inject one native slash command (such as `/compact`) into this session's CLI; see the notes below |
| `botmux preview <port>` | Register a local web service started in the session, so you can preview it after signing in to the Dashboard without exposing the local address |
| `botmux role switch <role dir>` | Switch the current topic to a role (the directory must be under `~/botmux-roles`); see [Roles](/en/roles) |
| `botmux skill list` / `skill show <name>` | List / read available skill instructions |

`botmux slash` **rejects everything by default**. First set `tuiSlashAllow` for the bot in [bots.json](/en/bots-json), listing the command names allowed, for example `["/compact"]` (case-insensitive; the leading `/` is optional). Also:

- Only single-line commands starting with `/` are accepted; arguments may follow, and the command name is matched against the list.
- `/cd` is always rejected, even if listed: it changes the session directory the daemon tracks, so it must go through a dedicated command.
- The command is queued until the CLI is idle; if the CLI process restarts before then, the command is dropped.

### Lark authorization

| Command | Description |
|------|------|
| `botmux auth request [--scope "<scope1 scope2>"] [--json]` | Generate a Lark authorization link for the person who sent this turn, returned as JSON. The AI sends the link to the user to click |
| `botmux auth wait --request-id <id> [--json]` | Wait for that authorization to finish, up to 5 minutes. On success, retry the original action |

#### Agent-initiated authorization {#agent-auth-request}

**Nothing to set up on the user's side.** When the AI calls a Lark API with `lark-cli --as user` in a session and finds your authorization missing, it runs `botmux auth request` itself (asking for all the scopes it needs in one `--scope`) and sends the link to **the person who sent this turn**:

- in a direct chat, the AI replies with the link;
- in a group, botmux sends the link to you in a private message, never into the group.

After you authorize, the AI waits for it with `botmux auth wait` in the same turn (up to 5 minutes) and retries the original action. If the turn has already ended, that's fine: authorize while the link is valid, then send another message to continue. You can also skip the wait and send `/login` (or `/login --scope <scope>`) in the topic yourself.

Prerequisite: this bot's `lark-cli` goes through botmux's app binding (`larkToolBinding`, on by default), or the bot has [Run CLI calls as the message sender](/en/bots-json#trigger-user-auth) on with `lark-cli` covered. With both off, the daemon refuses with `lark_user_auth_disabled`. The link only goes to the verified human of the current turn; the AI cannot request it on someone else's behalf.

### Read-only queries

These commands only read state; they change nothing.

| Command | Description |
|------|------|
| `botmux observe [--session <id>] [--lark-app <appId>]` | Query session and worker state live through the daemon (JSON). If it can't get an answer it shows unknown and never reads a cache |
| `botmux execution current --json` | Check which bot, session, turn, and worker the current process belongs to |
| `botmux actor current --json` | Return the daemon-verified enterprise email of this turn's sender, plus the current group ID and turn ID (no open_id). Refused when not run inside a session process |

### Advanced features (each has its own page)

| Command | Purpose | See |
|------|------|------|
| `botmux schedule add/list/update/remove/pause/resume/run/done` | Scheduled tasks | [Scheduled Tasks](/en/schedule) |
| `botmux dispatch` / `botmux report` | Open sub-topics, hand tasks to other bots, and report results back | [Multi-topic](/en/multi-topic) |
| `botmux project ...` | Maintain a pinned project progress card in a regular group | [Project Progress Card](/en/project-card) |
| `botmux workflow ...` | Multi-step orchestrated workflows | [Workflow](/en/workflow) |
| `botmux goal run <goal>` | Run one goal headless from the command line; `--json` prints the result | [Workflow](/en/workflow) |
| `botmux create-group --bot <name> [--bot ...]` | Create a Lark group with one or more bots | [Multi-bot](/en/multi-bot) |
| `botmux board ...` | Decision board (steward bot sessions only) | [Decision Board](/en/decision-board) |
| `botmux whiteboard ...` | Local project whiteboard | [Whiteboard](/en/whiteboard) |

For how the AI discovers and uses these commands, see [Skill + CLI](/en/skill-cli).

### Create a group that starts working, or a topic group {#create-group}

`botmux create-group` runs from a host terminal or inside a session; there is no switch to turn on:

```bash
botmux create-group --bot reviewer-a --bot reviewer-b --name "PR #123 review" \
  --chat-mode topic \
  --kickoff-bot ou_xxx --kickoff-prompt "Please review PR #123"
```

- `--bot`: at least one, repeatable. Prefer the bot's display name or full AppID. **The first one is the creator.**
- `--chat-mode topic`: create a topic group (each top-level message is its own topic); `group` or leaving it out makes a regular group. The group type can only be chosen at creation and cannot be changed later.
- `--kickoff-bot` + `--kickoff-prompt`: once the group exists, the creator @mentions that bot with this prompt so it starts working right away (for example, a PR review). Give both together. `--kickoff-bot` is that bot's open_id (look it up with `botmux bots list` in a session); it must be in the `--bot` list and cannot be the first one.
- `--working-dir <path>`: binds the new group to this directory for every bot that joined, so new topics skip the repo picker.
- `--json-status`: prints a structured status line after the chatId. With or without it, the command exits non-zero when a requested kickoff wasn't sent.

See `botmux create-group --help` for every flag, including cross-machine team groups (`--team` / `--agent`).

## Other configuration commands

| Command | Purpose | See |
|------|------|------|
| `botmux voice` | Configure voice summaries and speech recognition | [Voice](/en/voice) |
| `botmux plugin ...` | Create, install, and enable plugins | [Plugins](/en/plugins) |
| `botmux sandbox-network-policy ...` | Configure network access policy for local Linux sessions | [Sandbox](/en/sandbox) |
| `botmux env-policy get\|set\|unset` | Configure which environment variables bot processes inherit | [bots.json](/en/bots-json) |
| `botmux worker-budget status\|set\|unset` | View or adjust the memory check run before a session starts | [Global Settings](/en/global-settings) |
| `botmux feedback storage ...` | View or switch where feedback data is stored (SQLite / PostgreSQL) | [Feedback Storage & Migration](/en/feedback-storage) |
| `botmux session start/send/publish ...` / `botmux headless ...` | Start sessions and fetch results from scripts or CI without a Lark group | [Headless Automation Sessions](/en/headless-session) |
| `botmux model-proxy serve` | Start a local OpenAI-compatible endpoint (experimental) | [Model Proxy](/en/model-proxy) |

## Advanced: multi-replica deployments (primary mode)

Single-machine deployments can skip this section.

With `BOTMUX_COORDINATION_MODE=primary`, session state lives in PostgreSQL and is shared across machines (replicas). In this mode:

- Local `delete`, `resume`, `suspend` (except `--dry-run`), `maintenance suspend-idle`, and delete / resume inside `list` are refused. Close or resume from the session card in the original topic, so the action goes through the shared session-control channel.
- `list` still works, but only displays sessions and never cleans up local ones.

A session runs only on the replica that owns it, while Lark callbacks and browser requests may land on any replica:

- **"Show / Hide output" button**: applied by the owning replica, which updates the original card. It takes effect only for people allowed to operate the session; clicking an old card or lacking permission shows a hint to use the latest card.
- **Web terminal across replicas**: a request that lands on another replica is forwarded one hop to the owner. Configure:
  - `BOTMUX_TERMINAL_ROUTE_HOST`: the IP other replicas can reach this one at (e.g. the Pod IP); must be an IP. If unset, this replica doesn't take part in forwarding.
  - `BOTMUX_TERMINAL_ROUTE_PORT`: the port other replicas use for this Dashboard (e.g. a NodePort); defaults to `BOTMUX_DASHBOARD_PORT`.
  - Cookies, Authorization, and other login credentials are never forwarded.
- **What works across replicas**: only terminal links in Lark cards, which carry their own credential. The terminal embedded in the Dashboard, the touch-screen dynamic link, and takeover with write access must reach the owning replica directly (e.g. session-sticky load balancing); otherwise they return 403.
- Deployments without primary mode are unaffected.
