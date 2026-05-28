# botmux

<p align="center">
  <img src="cover.svg" alt="botmux cover" width="800">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js >= 20">
  <a href="https://www.npmjs.com/package/botmux"><img src="https://img.shields.io/npm/v/botmux.svg" alt="npm version"></a>
  <a href="https://github.com/deepcoldy/botmux"><img src="https://img.shields.io/github/stars/deepcoldy/botmux?style=social" alt="GitHub Stars"></a>
</p>

<p align="center">
  <a href="#design-philosophy">Design</a> &middot;
  <a href="#key-advantages">Advantages</a> &middot;
  <a href="#5-minute-setup">Quick Start</a> &middot;
  <a href="#usage">Usage</a> &middot;
  <a href="#configuration">Config</a>
</p>

[中文](README.md) | English

**Plug any AI coding CLI into Lark (Feishu) topic groups — one thread per session, streaming cards, web terminal, zero glue code.**

| Lark Streaming Cards | Web Terminal | tmux Session Management | Multi-Bot Collaboration |
|:-:|:-:|:-:|:-:|
| <img src="gif/fold&unfold.gif" width="220" /> | <img src="gif/web_terminal.gif" width="220" /> | <img src="gif/tmux.gif" width="220" /> | <img src="docs/setup/multi-bot-collab.png" width="220" /> |

<details>
<summary>Full demo video</summary>

[Demo Video](https://github.com/user-attachments/assets/3ba4c681-0a7e-4a03-89c8-b8d26b544a65)
</details>

---

## Why botmux?

### Design Philosophy

Core philosophy: **Bridge CLIs, don't rebuild them**. botmux doesn't reimplement Agent capabilities — it bridges existing AI coding CLIs (Claude Code, Codex, Cursor, Gemini, OpenCode, Antigravity) directly. Memory, context management, tool use, permission systems — these capabilities are evolving rapidly within the CLIs themselves. botmux rides on top of that evolution rather than rebuilding in parallel. Every CLI upgrade benefits botmux automatically with zero adaptation.

### Key Advantages

Compared to OpenClaw-style approaches built on Agent SDKs:

| Feature | botmux | OpenClaw-style |
|---------|--------|---------------|
| Architecture | Bridges full CLI processes directly | Rebuilds on Agent SDK |
| CLI Capabilities | Full runtime (hooks, memory, plan mode, skills, `/` commands) | SDK API subset, missing features must be reimplemented |
| CLI Upgrades | Zero-adaptation automatic benefit | Must track SDK version changes |
| Memory / Context | Reuses CLI's built-in memory system, improves as the CLI evolves | Must build custom memory system, duplicating CLI-native capabilities |
| Multi-CLI Support | 6 CLIs, switch with one config (Claude Code / Codex / Cursor / Gemini / OpenCode / Antigravity) | Tied to a single SDK, cannot switch CLIs |
| Web Terminal | Interactive full terminal, mobile shortcut toolbar, phone/desktop/Lark tri-screen sync | Usually web chat UI or read-only output |
| Multi-Bot Collaboration | Multiple bots in same group via @mention routing, isolated processes, different CLIs sparring | Usually single bot |
| Terminal Access | tmux attach directly into the CLI process, same as local dev experience | No direct terminal access |
| Installation | `npm install -g botmux`, 5-min Lark setup | Easy to install, but more configuration needed |

---

## Prerequisites

- **Node.js** >= 20
- **AI coding CLI / local agent app** installed and authenticated (`claude`, `codex`, `coco`, `cursor-agent`, `gemini`, `opencode`, `hermes`, or `agy` (Antigravity) in PATH)
  - **CoCo requires `0.120.32+`**: type-ahead (sending a new message while a turn is still running, parked in CoCo's own message queue) relies on 0.120.32+ behavior; earlier versions may drop or serialize input while busy — upgrade before use
- **tmux** >= 3.x (optional — auto-enabled when installed for persistent CLI sessions)
- **CJK fonts** (only needed for screenshot rendering of Chinese text / emoji):
  - macOS: ships with PingFang / Hiragino, no action needed
  - Debian/Ubuntu: daemon will background-install `fonts-noto-cjk fonts-noto-color-emoji` on first boot if missing (requires passwordless sudo or running as root; restart the daemon after install)
  - Other Linux distros: install Noto CJK + Noto Color Emoji manually (package names vary)

## 5-Minute Setup

> 💡 **TL;DR**: run `botmux setup` and pick "scan-to-create" to finish Steps 1+2 in one shot (the official `@larksuiteoapi/node-sdk` device flow gives you the AppID/AppSecret). PersonalAgent apps come with event subscriptions and bot capability pre-configured, so only Step 4 (permissions) + Step 5 (optional redirect URL) + Step 6 (publish) require browser clicks; the setup wizard writes a JSON file with a one-line clipboard copy command and prints deep-links to each remaining step.

### Step 1: Create a Lark App

**Recommended**: `botmux setup` → pick "1) Scan-to-create app". Scan with the Lark mobile app and the AppID/AppSecret are persisted automatically; no manual browser navigation. Falls back to manual paste on cancel/timeout/network error.

> ⚠️ **Currently only Feishu (feishu.cn) tenants are supported.** If scan detects a Lark international (larksuite.com) tenant, setup aborts — the daemon runtime (Lark Client/WSClient/event-dispatcher) hasn't been wired up for the `larksuite.com` domain yet, so accepting Lark credentials would land users in a half-working state. A follow-up PR will add full Lark support.

**Manual**: go to the [Lark Open Platform](https://open.larkoffice.com/app) and click "Create Custom App".

![Create App](docs/setup/create-app.png)

### Step 2: Get Credentials

> The scan-to-create path completes this step automatically; skip to Step 3.

Open the app details page → "Credentials & Basic Info", and copy the **App ID** and **App Secret**.

![Get Credentials](docs/setup/credentials.png)

### Step 3: Install & Start botmux

```bash
# Install
npm install -g botmux

# Interactive setup — pick "1) Scan-to-create app" or "2) Paste AppID/Secret manually".
# Credentials are validated with a tenant_access_token call before bots.json is written.
# At the end of setup the wizard writes the full scope JSON to ~/.botmux/lark-scopes.json
# and prints a one-line clipboard copy command for your platform.
botmux setup

# Start (if you ever need to verify the event subscription, Lark requires the daemon to be running so it can detect the WebSocket connection)
# Re-validates credentials before forking workers; missing scopes only WARN, do not block the daemon.
botmux start
```

### Step 4: Add Permissions

Run the copy-to-clipboard command setup printed, then go to "Permissions & Scopes" → "Batch Import/Export" and paste. Submit for review — visibility "only me" auto-approves.

![Permissions](docs/setup/permissions.png)

The full JSON lives at `~/.botmux/lark-scopes.json` (also tracked in-repo at [src/setup/lark-scopes.json](src/setup/lark-scopes.json), kept in sync with the internal wiki, covers ~290 tenant + user scopes).

```bash
# macOS (local)
cat ~/.botmux/lark-scopes.json | pbcopy
# Linux desktop (local X server)
cat ~/.botmux/lark-scopes.json | xclip -selection clipboard
# SSH / headless: just cat — selecting in your local terminal copies to your local clipboard
cat ~/.botmux/lark-scopes.json
# SSH via OSC 52 — write to local clipboard through terminal (iTerm2 / kitty / WezTerm / Alacritty / tmux 1.5+)
base64 -w0 < ~/.botmux/lark-scopes.json | awk 'BEGIN{printf "\033]52;c;"}{printf "%s",$0}END{printf "\a"}'
```

> Scan-created PersonalAgent apps have `im.message.receive_v1` + `card.action.trigger` subscribed and the bot capability enabled out of the box, per botmux maintainer testing. Lark hasn't documented this as stable behavior, so **if the bot receives no messages at all after setup**, see "Step 8: Troubleshoot — bot not receiving messages" below for a manual fallback.

### Step 5: Add Redirect URL (optional)

If you plan to use `/login` inside Lark to let botmux act on your behalf for docs / calendar / wiki / sheets, add a redirect URL under "Security Settings" → "Redirect URL":

```
http://127.0.0.1:9768/callback
```

Skip this step if you only need bot messaging.

### Step 6: Publish the App

Go to "Version Management & Release", click "Create Version" and publish. Set availability to "Visible to me only" for automatic approval.

![Publish](docs/setup/publish.png)

### Step 7: Create a Group and Start Chatting

1. Create a **topic-enabled group** in Lark
2. Go to Group Settings → Bots → Add the bot you just created
3. Send a message in the group — the bot responds automatically

![Add bot to group](docs/setup/add-bot-to-group.png)

### Step 8: Troubleshoot — bot not receiving messages (fallback)

PersonalAgent apps come with event subscriptions and bot capability pre-configured; in normal cases you don't touch this. If the bot **receives no messages at all** after setup (not even DMs), verify these two settings:

- **Event subscription**: Open Platform → your app → Events & Callbacks → should be subscribed to `im.message.receive_v1` + `card.action.trigger`. If missing, add them manually. Subscription mode must be "Receive via persistent connection" (WebSocket), and the botmux daemon must be running.
- **Bot capability**: Open Platform → your app → Features → Bot should be enabled (it is by default). Adjust name/avatar if needed.

After verifying, restart: `botmux restart`.

### Step 9: Enable Boot-time Autostart (recommended)

Once the bot is sending and receiving messages cleanly, run:

```bash
botmux autostart enable
```

This registers the daemon with your user's init system (launchd on macOS, user systemd on Linux). **No sudo required.** After a reboot — or after logging back in — the daemon comes up on its own. See [CLI Commands § Boot-time Autostart](#boot-time-autostart) below for the full reference.

---

## Features

### Streaming Cards

Each conversation turn gets a live-updating Feishu card that shows:

- Real-time terminal output rendered as Markdown, TUI chrome auto-filtered to show only actual work output
- Status indicator: Starting > Working > Idle
- Action buttons: Open Terminal, Get Write Link, Restart CLI, Close Session


### Web Terminal (Interactive)

Each session exposes a web terminal at `http://<WEB_EXTERNAL_HOST>:<port>`.

- **Read-only link** — shown on the streaming card in the group thread
- **Write-enabled link** — sent via DM on demand (click "Get Write Link" on the card)

On mobile/tablet, a floating shortcut toolbar provides Esc, Ctrl+C, Tab, arrow keys and other control keys missing from virtual keyboards — full CLI control from your phone.

### Multi-Bot Collaboration

Run multiple Lark bots on a single machine, each mapped to a different CLI. In the same group chat, messages are routed via @mention — each bot gets its own isolated CLI process. With a single bot in the group, it responds automatically without @. In a regular (non-topic) group, `@<bot1> @<bot2> /t xxx` spawns one independent thread per mentioned bot anchored at the same message. Send `@<bot1> @<bot2> /introduce` once so they register each other's open_id; afterwards each bot can explicitly @-mention the others from within its own session (see [§ Slash Commands](#slash-commands)).

### Tmux Persistence

When tmux is installed, botmux automatically uses it. CLI processes persist inside tmux sessions — all features work unchanged.

**Key benefit: daemon restarts don't interrupt the CLI.** During `botmux restart`, the worker process exits but the tmux session (and the CLI inside it) keeps running. The next incoming message triggers a re-attach — no `--resume` context reload needed.

```bash
# Interactive session picker — select and attach to tmux (see § CLI Commands)
botmux list

# Or manually attach (session name = bmx-<first 8 chars of session ID>)
tmux attach -t bmx-<first-8-chars-of-session-id>
# Ctrl+B, D to detach — CLI keeps running

# Force pure pty mode (disable tmux)
BACKEND_TYPE=pty botmux start
```

**Lifecycle:**

| Event | tmux session | CLI process |
|-------|-------------|-------------|
| `botmux restart` | Survives | Survives (re-attaches on next message) |
| `/close` or close button | Destroyed | Terminated (SIGHUP) |
| CLI exits / crashes | Closes with it | Already exited (auto-restart creates new session) |

### Session Adopt

Seamlessly connect Botmux to CLI processes already running in tmux — monitor and interact from your phone via Lark.

```
/adopt              # Scan tmux, show selection card
/adopt 0:2.0        # Directly adopt a specific tmux pane
```

- **Shared mode** — After adopting, iTerm2 and Lark stay in sync: streaming card shows real-time terminal output, Lark chat input is forwarded directly to the terminal
- **One-click takeover** — Click the "Takeover" button on the streaming card to rebuild the session with `--resume` and convert to a standard Botmux session
- **Safe disconnect** — Click "Disconnect" to detach Botmux without affecting the original CLI

### Scheduled Tasks

Three schedule types (once / interval / cron) with Chinese/English natural
language, executed inside the original thread (no new topic per run).

**Two ways to create**:
- **Slash command** (quick): `/schedule 每日17:50 check AI news`
- **Conversation** (flexible): just tell the agent "add a reminder for every day at 9:00 to check deploys" — the `botmux-schedule` Skill fires automatically.

Supported formats: Chinese NL (`每日17:50` / `30分钟后` / `明天9:00`),
English duration (`30m`), interval (`every 2h`), cron (`0 9 * * *`),
ISO timestamp (`2026-05-01T10:00`).

### Lark integration (Skill + CLI)

When a CLI spawns inside a botmux session it automatically gets
`~/.botmux/bin` on PATH plus a set of ready-to-use Skills:

- `botmux send` — send a message to the current thread (text, images, files, @mention)
- `botmux history` — fetch session history (topic groups → in-thread, regular groups → whole chat)
- `botmux quoted <message_id>` — when the user @ed the bot via Lark's quote-reply UI, fetch the quoted message on demand
- `botmux bots list` — discover bots + their `open_id`s
- `botmux schedule` — manage scheduled tasks

These capabilities are wired via `--append-system-prompt` and Skill
descriptions, so the agent picks them up automatically. Compared to
Anthropic's official Telegram channel — which exposes each action as an
MCP tool — the Skill + CLI combo skips the MCP handshake on every CLI
launch, doesn't burn tool-list tokens, and works across every CLI that
can read a system prompt and shell out (Claude Code / Codex / Cursor /
Gemini / OpenCode / Antigravity), with no MCP protocol support required.

### Dashboard

> `botmux dashboard` issues a one-time-token URL — manage every daemon/bot from the browser.

- One-click locate back to the Feishu thread / open Web Terminal / multi-select batch close
- Create a new group with auto owner-transfer + @-mention notification
- Disband or leave a chat (associated sessions auto-closed)
- **Workflows console**:
  - Run List (5 s poll) + Run Detail with summary, dangling-work red panel, node/activity table, event timeline, and a **parallel-execution timeline** (attempt-level), auto-stopping polling once the run reaches a terminal state
  - **Cancel a run directly from the dashboard**; approve / reject `humanGate` with reviewer comments
  - **Workflow Catalog**: lists every workflow under `~/.botmux/workflows/`, drills into schema / dependency graph, and triggers a new run from the UI (with params input)
  - IM approval / cancel cards remain available; `botmux workflow` CLI subcommands also keep working

<img src="docs/dashboard.png" alt="botmux dashboard" width="800" />

---

## Usage

### Workflow

1. Send a message in a Lark topic group to create a new thread; or in a regular group send `/t <prompt>` to force-open a new topic
2. The bot shows a repo selection card — pick a project or click "Start directly" (chats bound via `/oncall bind` skip this step)
3. The CLI spawns in the selected directory
4. A live streaming card appears in the thread, showing real-time terminal output with markdown rendering
5. Each reply creates a new streaming card for that turn; previous cards freeze at their last state
6. Click "Get Write Link" on the card to receive a write-enabled terminal URL via DM
7. The CLI replies in the thread via the `botmux send` command (wired through the `botmux-send` Skill)

### Slash Commands

Send these straight into a topic — the daemon intercepts them (no clash with the underlying CLI's own slash commands: any `/xxx` botmux doesn't recognize is forwarded verbatim to the CLI). Send `/help` anytime to see the same list inside the topic.

**📌 Session management**

| Command | Description |
|---------|-------------|
| `/repo` | While a repo is pending selection, launch in the default workingDir; mid-session, show the project selector card (interactive dropdown + text list) |
| `/repo <N>` | Switch to Nth project from last scan |
| `/repo <path\|name>` | Skip the selector card; pass a path (relative/absolute) or a first-level project name under workingDir |
| `/cd <path>` | Change working directory and restart the CLI process |
| `/status` | Show session info (uptime, terminal URL, etc.) |
| `/restart` | Restart CLI process (keeps the session context) |
| `/close` | Close session and send a resumable card (with the CLI's native resume command) |
| `/t <prompt>` / `/topic <prompt>` | Force-open a new topic from a non-topic group (shows the repo selector); empty prompt is allowed — fill it in after picking the repo |

**🔀 Forwarded to the underlying CLI**

| Command | Description |
|---------|-------------|
| `/compact` `/model` `/clear` `/plugin` `/usage` `/context` `/cost` `/mcp` `/diff` `/code-review` `/security-review` `/review` `/btw` | Sent verbatim to the underlying CLI for its own built-in slash commands (e.g. Claude Code's `/compact` / `/context`, Codex's `/diff` / `/btw`) |

**⏰ Scheduled tasks** (syntax & examples in [§ Scheduled Task Management](#scheduled-task-management))

| Command | Description |
|---------|-------------|
| `/schedule <natural language / cron>` | Create a task, e.g. `/schedule 每日17:50 check AI news` |
| `/schedule list` | List all scheduled tasks |
| `/schedule remove\|enable\|disable\|run <id>` | Remove / enable / disable / run once |

**📡 Session adoption**

| Command | Description |
|---------|-------------|
| `/adopt` | Scan local tmux and pop a card to adopt a running CLI session |
| `/adopt <tmux_pane>` | Adopt a specific tmux pane directly (e.g. `/adopt 0:2.0`) |

**🔐 User authorization**

| Command | Description |
|---------|-------------|
| `/login` | Lark user OAuth — afterwards you can download third-party card images and call cloud-doc/calendar APIs as yourself |
| `/login status` | Show current OAuth status |

**🛎️ Oncall mode (group chats)**

| Command | Description |
|---------|-------------|
| `/oncall bind <path>` | Bind current chat to a project dir, skip the repo card (any group member can @ the bot; buttons / daemon commands still gated by `allowedUsers`) |
| `/oncall unbind` | Unbind the current chat |
| `/oncall status` | Inspect the current chat's oncall binding |

**🔑 Access grants (owner only)**

| Command | Description |
|---------|-------------|
| `@bot /grant @someone` | Pop an authorization card to add the user to the "this chat" or "global" allowlist; also auto-pops (and @s the owner) when an unauthorized user @-mentions the bot |
| `@bot /revoke @someone` | Revoke the user's this-chat + global access |

**🆕 One-shot session group**

| Command | Description |
|---------|-------------|
| `/group <name>` (alias `/g`) | Auto-create a new Lark group, invite you, transfer ownership; the whole group acts as one chat-scope CLI session. Empty name falls back to a timestamp. The group does **not** auto-start a session — just go in and start chatting with the bot. Any bots you @-mention in the command are pulled into the new group (the first mentioned bot does the creating). |

**👥 Multi-bot collaboration**

| Command | Description |
|---------|-------------|
| `@botA @botB /t <prompt>` | With multiple bots, each @-mentioned bot opens its own independent topic from the same message |
| `@botA @botB /introduce` | Bots register each other's open_id so they can later explicitly @-mention one another across sessions (any @ order, extra text allowed) |

**❓ Help**

| Command | Description |
|---------|-------------|
| `/help` | Show the full command list above, inside the topic |

### Scheduled Task Management

Two creation paths are covered above in [Scheduled Tasks](#scheduled-tasks); below is just the slash-command syntax and management commands.

```bash
# Chinese NL
/schedule 每日17:50 check AI news
/schedule 工作日每天9:00 run health check
/schedule 每周一10:00 generate weekly report

# One-shot
/schedule 30分钟后 verify deployment
/schedule 明天9:00 standup reminder

# English / cron
/schedule every 2h probe services
/schedule 30m remind me to drink water
/schedule 0 9 * * * good morning

# Manage
/schedule list
/schedule remove|enable|disable|run <id>
```

**Execution behavior**: the task fires inside the **original thread where it was created** — no new topic per run. Working directory is preserved. If the original session is still alive, the prompt is injected into it; otherwise a fresh worker spawns bound to the same thread root.

---

## Configuration

Configure bots via `~/.botmux/bots.json`. Run `botmux setup` to create it interactively, or edit manually.

```bash
# Interactive setup
botmux setup
```

When `~/.botmux/bots.json` already exists, `botmux setup` can add a bot, reconfigure from scratch, edit an existing bot, or delete a bot config. The edit/delete flow accepts the process name shown by `botmux status` (e.g. `botmux-1` or a custom `botmux-claude-main`) or the `larkAppId`; empty input keeps the current value, and `-` clears optional fields such as `name`, `model`, `backendType`, `workingDir`, and `allowedUsers`. Changing `larkAppId` asks for confirmation because historical session/chat state under the old app ID is not migrated automatically. Deleting a bot only removes one local `bots.json` entry; it does not delete the Lark app, historical messages, or local session data. Run `botmux restart` for changes to take effect.

**bots.json format:**

```json
[
  {
    "larkAppId": "cli_xxx_bot1",
    "larkAppSecret": "secret_1",
    "name": "claude-main",
    "cliId": "claude-code",
    "model": "sonnet",
    "workingDir": "~/projects",
    "allowedUsers": ["alice@company.com"],
    "allowedChatGroups": ["oc_xxx_team"]
  },
  {
    "larkAppId": "cli_xxx_bot2",
    "larkAppSecret": "secret_2",
    "cliId": "codex",
    "model": "gpt-5-codex",
    "workingDir": "~/work"
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `larkAppId` | Yes | Lark app ID |
| `larkAppSecret` | Yes | Lark app secret |
| `name` | No | Process name suffix shown by `botmux status`; e.g. `claude-main` appears as `botmux-claude-main`, defaults to `botmux-<index>` |
| `cliId` | No | CLI adapter, defaults to `claude-code` (options: `aiden`, `coco`, `codex`, `codex-app`, `cursor`, `gemini`, `opencode`, `antigravity`, `hermes`) |
| `model` | No | Model name used when spawning the CLI. Currently honored by: `claude-code`, `codex`, `coco`, `cursor`, `gemini`, `opencode`; other adapters ignore the field. Leave empty to use the CLI default. `botmux setup` proposes per-CLI candidates plus a free-form Other option. |
| `cliPathOverride` | No | Absolute path to the CLI entry, for wrappers / routers; typical use: `ccr`, `claude-w`, `aiden-x-claude`, etc. |
| `backendType` | No | Session backend: `pty` or `tmux` (auto-detected by default) |
| `workingDir` | No | Default working directory, supports comma-separated. The new-topic repo-select card scans for git repos **from this directory downward** (recursive, up to 3 levels), no longer climbing to the parent: point it at a repos root (e.g. `~/projects`) to list every repo beneath it, or at a single repo to list just that repo (and its linked worktrees) |
| `defaultWorkingDir` | No | Single-repo default: new topics with no oncall binding and no peer-session inheritance spawn directly here, skipping the repo-select card. `/cd <path>` still switches mid-session; the next new topic falls back to this default. **Difference from `defaultOncall`:** does NOT write `oncallChats` and does NOT change the `canTalk` / `canOperate` permission model |
| `allowedUsers` | No | Allowed users (**full emails** like `alice@example.com`, or open_ids `ou_xxx`). Email prefixes can't be resolved and are dropped. Required (at least one entry, as owner) when `allowedChatGroups` is set |
| `allowedChatGroups` | No | Talk-open chats (`chat_id`, for example `oc_xxx`). Any member talking **inside these chats** can use the bot (decided by the message's chat — new members work immediately, removed members lose access, no restart needed); grants `canTalk` only, sensitive ops still require `allowedUsers`. Equivalent to the owner running `/grant` (no target) in that chat. |
| `globalGrants` | No | Global talk allowlist (`open_id` list, e.g. `ou_xxx`; humans or bots). Listed entries can talk to the bot in **any** chat; grants `canTalk` only, sensitive ops still require `allowedUsers`. Usually written via the owner's `/grant` card (the "grant talk globally" button); can also be set manually here. |
| `oncallChats` | No | Oncall bindings (written by `/oncall bind`), e.g. `[{ "chatId": "oc_xxx", "workingDir": "~/projects/foo" }]`; any group member can @ the bot |

**Config priority:** `BOTS_CONFIG` env var > `~/.botmux/bots.json`

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BOTS_CONFIG` | _(unset)_ | Path to bots.json (overrides default location) |
| `WEB_HOST` | `0.0.0.0` | HTTP server bind address |
| `WEB_EXTERNAL_HOST` | _(auto-detect LAN IP)_ | External hostname/IP for terminal URLs |
| `SESSION_DATA_DIR` | `~/.botmux/data` | Where sessions and queues are stored |
| `DEBUG` | _(unset)_ | Set to `1` for debug logging |

### File Locations

| Path | Description |
|------|-------------|
| `~/.botmux/bots.json` | Bot configuration |
| `~/.botmux/data/` | Session data, message queues |
| `~/.botmux/logs/` | Daemon logs |

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `botmux setup` | Interactive setup (first-time / add / edit / delete bots) |
| `botmux start` | Start daemon (PM2 managed) |
| `botmux stop` | Stop daemon |
| `botmux restart` | Restart daemon (auto-restores active sessions) |
| `botmux logs` | View daemon logs (`--lines N` for more) |
| `botmux status` | Show daemon status |
| `botmux upgrade` | Upgrade to latest version |
| `botmux list` | List all active sessions (alias: `ls`) |
| `botmux delete <id>` | Close a session by ID prefix (alias: `del`/`rm`) |
| `botmux delete all` | Close all active sessions |
| `botmux delete stopped` | Clean up zombie sessions with dead processes |
| `botmux autostart enable` | Register boot-time autostart (macOS launchd / Linux user systemd, no sudo) |
| `botmux autostart disable` | Unregister boot-time autostart |
| `botmux autostart status` | Show autostart status |
| `botmux dashboard` | Print a fresh Web Dashboard URL (rotates the token; previous URL becomes invalid) |

### Boot-time Autostart

`botmux autostart enable` registers the daemon with your user's init system so it comes back automatically after a reboot:

- **macOS**: writes `~/Library/LaunchAgents/com.botmux.daemon.plist` and loads it via `launchctl bootstrap`. **No sudo required.**
- **Linux**: writes `~/.config/systemd/user/botmux.service` and runs `systemctl --user enable --now`. **No sudo required.**
  - On servers / headless boxes the user systemd manager stops when you log out. To survive logouts and reboots, also run `sudo loginctl enable-linger <your-user>` — `autostart enable` warns when linger is off.
  - Containers / SSH-only sessions without a user DBus fall back to printing manual instructions.
- The `node` and `cli.js` paths baked into the unit come from `process.execPath` at install time. After switching nvm/fnm versions, run `botmux autostart enable` once to rewrite. `botmux start`/`restart` also detect path drift and refresh the unit in place — no manual step needed.
- `enable` / `disable` **only manage the autostart hook — they do not touch a running daemon**. To start the daemon right away run `botmux start`; to stop it run `botmux stop`. This avoids the "I just wanted to turn off autostart, why did my service also die" footgun.
- If you prefer letting systemd own the lifecycle (`systemctl --user start/stop botmux`), that works too — the unit declares `ExecStop=botmux stop` for a clean shutdown path.

### Agent-facing subcommands

Run from inside a botmux-spawned CLI session — session context is auto-detected via ancestor process markers:

| Subcommand | Description |
|------------|-------------|
| `botmux send [content]` | Send a message to the current thread (stdin / heredoc / `--content-file`; `--images` / `--files` / `--mention` flags) |
| `botmux bots list` | List bots in the current chat (includes `open_id` for `--mention`) |
| `botmux history [--limit N]` | Fetch session message history (JSON); topic groups → in-thread, regular groups → whole chat |
| `botmux quoted <message_id>` | Fetch a single quoted message (JSON); the ID comes from the daemon-injected `[用户引用了消息 用 botmux quoted om_xxx 查看]` prefix |
| `botmux schedule add <schedule> <prompt>` | Create a scheduled task bound to the current thread |
| `botmux schedule list/remove/pause/resume/run` | Manage scheduled tasks |

These require the `~/.botmux/bin/botmux` wrapper, which the daemon writes at startup and prepends to the worker's `PATH` — always matches the running daemon's version (no `npm i -g` needed).

---

## Web Dashboard

botmux ships a LAN-accessible Web Dashboard for managing all sessions and scheduled tasks across every configured bot.

```bash
botmux dashboard
# prints: http://<lan-ip>:7891/?t=<token>
```

Each invocation rotates the token — previous URLs are invalidated immediately. This is by design, so a leaked link stops working as soon as you fetch a new one.

v1 features:
- **Sessions board** — every active and closed session across every bot, filterable by CLI / status / adopt / free-text. The detail drawer exposes a "📍 定位到飞书话题" button that posts a marker into the original thread (workaround for Feishu having no public topic deep-link), then opens AppLink to the chat. Also: copy IDs, close session, open xterm.
- **Schedules board** — every scheduled task across every bot, with Run-now / Pause / Resume actions.

Environment variables (set in `~/.botmux/.env`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `BOTMUX_DASHBOARD_HOST` | `0.0.0.0` | Dashboard HTTP bind address |
| `BOTMUX_DASHBOARD_PORT` | `7891` | Dashboard HTTP port |
| `BOTMUX_DASHBOARD_EXTERNAL_HOST` | `WEB_EXTERNAL_HOST` or LAN-IP autodetect | Host used in the printed URL |
| `BOTMUX_DAEMON_IPC_BASE_PORT` | `7892` | Per-daemon IPC port = base + botIndex |

The dashboard runs as its own pm2 process (`botmux-dashboard`) — `pnpm daemon:restart` brings it up alongside every bot daemon. Each daemon exposes a localhost-only IPC at `127.0.0.1:7892+botIndex`; the dashboard process is a thin reverse proxy + token gate. The HMAC secret at `~/.botmux/.dashboard-secret` (mode `0600`) is generated on first start and is used only to sign `botmux dashboard` rotation requests — it never reaches the browser.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
