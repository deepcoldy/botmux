# botmux

<p align="center">
  <img src="cover.svg" alt="botmux cover" width="800">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js >= 22">
  <a href="https://www.npmjs.com/package/botmux"><img src="https://img.shields.io/npm/v/botmux.svg" alt="npm version"></a>
  <a href="https://github.com/deepcoldy/botmux"><img src="https://img.shields.io/github/stars/deepcoldy/botmux?style=social" alt="GitHub Stars"></a>
</p>

<p align="center">
  <a href="#design-philosophy">Design</a> &middot;
  <a href="#key-advantages">Advantages</a> &middot;
  <a href="#5-minute-setup">Quick Start</a> &middot;
  <a href="https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/"><b>📖 Docs</b></a>
</p>

[中文](README.md) | English

**Plug any AI coding CLI into Feishu/Lark — every DM, group or topic gets its own CLI session, with live-streaming cards, a web terminal, and zero glue code.**

> 📖 **Full docs** (commands / config / best practices / troubleshooting): **<https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/>** — this README only covers why and how to get started fast.

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

Core philosophy: **Bridge CLIs, don't rebuild them**. botmux doesn't reimplement Agent capabilities — it bridges existing AI coding CLIs (Claude Code, Codex, Cursor, Gemini, OpenCode, Antigravity, GitHub Copilot) directly. Memory, context management, tool use, permission systems — these capabilities are evolving rapidly within the CLIs themselves. botmux rides on top of that evolution rather than rebuilding in parallel. Every CLI upgrade benefits botmux automatically with zero adaptation.

### Key Advantages

Compared to OpenClaw-style approaches built on Agent SDKs:

| Feature | botmux | OpenClaw-style |
|---------|--------|---------------|
| Architecture | Bridges full CLI processes directly | Rebuilds on Agent SDK |
| CLI Capabilities | Full runtime (hooks, memory, plan mode, skills, `/` commands) | SDK API subset, missing features must be reimplemented |
| CLI Upgrades | Zero-adaptation automatic benefit | Must track SDK version changes |
| Memory / Context | Reuses CLI's built-in memory system, improves as the CLI evolves | Must build custom memory system, duplicating CLI-native capabilities |
| Multi-CLI Support | 7 CLIs, switch with one config (Claude Code / Codex / Cursor / Gemini / OpenCode / Antigravity / GitHub Copilot) | Tied to a single SDK, cannot switch CLIs |
| Web Terminal | Interactive full terminal, mobile shortcut toolbar, phone/desktop/Lark tri-screen sync | Usually web chat UI or read-only output |
| Multi-Bot Collaboration | Multiple bots in same group via @mention routing, isolated processes, different CLIs sparring | Usually single bot |
| Multi-Topic Collaboration | A lead bot auto-splits the task, opens multiple topics, and dispatches several bots to work in parallel (coder + reviewer), with a Lark task list as the shared progress board | Usually manual one-by-one assignment, no unified progress board |
| Terminal Access | tmux attach directly into the CLI process, same as local dev experience | No direct terminal access |
| Installation | `npm install -g botmux`, 5-min Lark setup | Easy to install, but more configuration needed |

---

## Prerequisites

- **Node.js** >= 22
- **AI coding CLI / local agent app** installed and authenticated (`claude`, `codex`, `coco`, `cursor-agent`, `gemini`, `opencode`, `hermes`, `seed` (Seed CLI, a Claude Code fork), `relay` (Relay CLI, the new release of Seed), `pi`, `omp` (oh-my-pi, a Pi fork), `copilot` (GitHub Copilot CLI), `traex` (TRAE CLI), `mircli` (Mir CLI), or `agy` (Antigravity) in PATH)
  - **CoCo requires `0.120.32+`**: type-ahead (sending a new message while a turn is still running, parked in CoCo's own message queue) relies on 0.120.32+ behavior; earlier versions may drop or serialize input while busy — upgrade before use
- **tmux** >= 3.x (optional — auto-enabled when installed for persistent CLI sessions)
- **CJK fonts** (only needed for screenshot rendering of Chinese text / emoji):
  - macOS: ships with PingFang / Hiragino, no action needed
  - Debian/Ubuntu: daemon will background-install `fonts-noto-cjk fonts-noto-color-emoji` on first boot if missing (requires passwordless sudo or running as root; restart the daemon after install)
  - Other Linux distros: install Noto CJK + Noto Color Emoji manually (package names vary)

## 5-Minute Setup

> 💡 **TL;DR**: `npm i -g botmux` → `botmux setup` and **scan two QR codes** to get a working bot → `botmux start`. The 1st scan creates the app and saves the AppID/AppSecret (event subscriptions + bot capability pre-configured); the 2nd scan lets botmux's built-in Feishu Web login **import permissions, configure the redirect URL, and create + submit a publish version automatically**. The entire Open Platform config (create app / permissions / redirect / publish) is handled by setup; pass `--no-open-platform-auto` to skip the second auto-config step and use the manual steps folded at the end.

### 1. Install botmux

```bash
npm install -g botmux
```

> Requires **Node.js ≥ 22**, with at least one AI coding CLI installed and authenticated (`claude` / `codex` / `cursor-agent` / `gemini` / `opencode` / `coco` / `agy` on your PATH). Installing **tmux** too is recommended (enables session persistence automatically).

### 2. Create the App & Configure (`botmux setup`)

Run `botmux setup` and follow the interactive menu:

1. **New config**: type `1` and press Enter (with an existing config, type `2` to add a bot).
2. **Create the bot**: type `1` → **Scan-to-create (recommended)**: scan with the Lark mobile app and a PersonalAgent app is created with AppID/AppSecret persisted automatically, **with event subscriptions + bot capability pre-configured** — no manual browser navigation. Uses the official `@larksuiteoapi/node-sdk` device flow. (You can also type `2` to paste AppID/Secret manually — see "Create the app manually" folded below.)
3. **Pick the CLI**: choose the CLI to bridge (e.g. type `1` for Claude Code).
4. **Default working dir**: usually the **parent directory** of your git projects (e.g. `~/projects`); new topics scan **downward** for git repos (up to 3 levels). Avoid `~` (too many folders to traverse).

Then comes the **2nd scan**: botmux's built-in Feishu Web login automatically imports permissions, configures the `http://127.0.0.1:9768/callback` redirect URL, and creates + submits a publish version. On failure it falls back and prints the manual steps (folded below) without affecting the config already written; importing only part of the permissions still counts as success — add the rest later on the Open Platform.

> ✅ **Both Feishu (feishu.cn) and Lark international (larksuite.com) tenants are supported.** Scan-to-create auto-detects the tenant brand (China / international) and remembers it — no manual choice needed; the manual paste path asks once. Each bot connects to its own brand's domain, so one machine can run Feishu and Lark bots side by side, with login credentials isolated per app.

At the end, setup validates credentials with a `tenant_access_token` call (only writing `bots.json` on success) and writes the full scope JSON to `~/.botmux/lark-scopes.json` for reference.

### 3. Start

```bash
botmux start
```

> `start` re-validates credentials before forking workers; missing scopes only WARN, they don't block the daemon. If you later need to verify the event subscription, Lark requires the daemon to be running so it can detect the WebSocket connection.

### 4. Create a Group and Start Chatting

1. Create a **topic-enabled group** in Lark
2. Open group settings → Group Bots → add the bot you just created
3. Send a message in the group — the bot responds automatically

![Add bot to group](docs/setup/add-bot-to-group.png)

### 5. Enable Boot-time Autostart (recommended)

After confirming the bot can send/receive messages, run:

```bash
botmux autostart enable
```

<details>
<summary><b>Manual Open Platform config: create app / permissions / redirect / publish (fallback)</b> —— handled automatically by botmux setup during the 2nd scan; expand only if auto-config failed or you want to verify manually</summary>

<br>

**Create the app manually**: go to the [Lark Open Platform](https://open.larkoffice.com/app), create a "Custom App", copy **App ID / App Secret** from "Credentials & Basic Info", and in `botmux setup`'s "Create the bot" step choose `2` to paste them back.

![Create App](docs/setup/create-app.png)

**Add permissions**: run the copy-to-clipboard command setup printed, then go to "Permissions & Scopes" → "Batch Import/Export" and paste. Submit for review — visibility "only me" auto-approves.

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

**Add redirect URL (optional)**: if you plan to use `/login` inside Lark to let botmux act on your behalf for docs / calendar / wiki / sheets, add a redirect URL under "Security Settings" → "Redirect URL": `http://127.0.0.1:9768/callback`. Skip this if you only need bot messaging.

**Publish**: go to "Version Management & Release", click "Create Version" and publish. Set availability to "Visible to me only" for automatic approval.

![Publish](docs/setup/publish.png)

</details>

<details>
<summary><b>Troubleshoot — bot not receiving messages</b></summary>

<br>

PersonalAgent apps come with event subscription + bot capability configured by default, so normally you don't touch this. If the bot **receives no messages at all** (not even DMs) after following the steps above, verify these two:

- **Event subscription**: Open Platform → your app → Events & Callbacks → should subscribe to `im.message.receive_v1` + `card.action.trigger` (subscribed by default; add manually if missing). The delivery method must be "Receive events via long connection" (WebSocket), with the botmux daemon running.
- **Bot capability**: Open Platform → your app → Features → Bot should be enabled (on by default); name/avatar are editable.

Then restart the daemon: `botmux restart`.

</details>

---

## Features

### Streaming Cards

Each conversation turn gets a live-updating Feishu card — your main window for sensing and driving the CLI from phone/Lark:

- **Live terminal screenshot streamed to the card** (rendered headlessly via xterm into a PNG, faithfully reproducing the CLI's TUI); one-tap "show/hide output", "export text", "page up/down"
- **Live status**: Starting → Analyzing → Working / Executing → Idle; marks "limit reached · retryable" when quota runs out
- **Act right from the card**: open (writable) terminal, 🔑 get write link, restart / close / take over the session, re-send last task
- **One new card per turn**, the previous one frozen as an archive; after `/relay` moves a session to another group, the old card auto-freezes as an archive
- **Closing leaves a resumable card** (with the CLI's native resume command) — click back in anytime


### Web Terminal (Interactive)

Each session exposes a web terminal at `http://<WEB_EXTERNAL_HOST>:<port>`.

- **Read-only link** — shown on the streaming card in the group thread
- **Write-enabled link** — sent via DM on demand (click "Get Write Link" on the card)

On mobile/tablet, a floating shortcut toolbar provides Esc, Ctrl+C, Tab, arrow keys and other control keys missing from virtual keyboards — full CLI control from your phone.

### Multi-Bot Collaboration

Run multiple Lark bots on a single machine, each mapped to a different CLI. In the same group chat, messages are routed via @mention — each bot gets its own isolated CLI process. With a single bot in the group, it responds automatically without @. In a regular (non-topic) group, `@<bot1> @<bot2> /t xxx` spawns one independent thread per mentioned bot anchored at the same message. Send `@<bot1> @<bot2> /introduce` once so they register each other's open_id; afterwards each bot can explicitly @-mention the others from within its own session (commands: [📖 Docs · Slash Commands](https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/slash-commands)).

### Multi-Topic Collaboration

The next level up from "Multi-Bot Collaboration": a lead bot (the **orchestrator**) splits one large task into multiple **sub-projects**, **automatically opens several topics** in the group, dispatches a team of bots into each topic to drive it in parallel (commonly "one writes the code + one reviews"), uses a single **Lark task list** as the shared progress board everyone reads from, and finally collects the results and aggregates them. A single regular group becomes a parallel workbench, and you can see overall progress at a glance from the Lark task panel.

**How it runs** — the `botmux-orchestrate` skill walks the orchestrator through the full flow:

> Split into sub-projects → propose a "sub-project ↔ bot" assignment → send it to you for **a single approval** (confirmable via card) → create the Lark task list → open each topic and dispatch → collect the reports → aggregate

Under the hood, dispatching is done by `botmux dispatch`: it seeds a topic in the group and @-mentions the chosen bots, spawning an independent session for each.

```bash
botmux dispatch --title "Implement login module" \
  --bot "ou_xxx:Alice:coder" --bot "ou_yyy:Bob:reviewer" \
  --repo /path/to/repo --brief-file /tmp/brief.md
```

- `--repo <dir>` — presets each sub-bot's working directory (absolute path, must exist on the sub-bot's machine), so the session spawns straight into it and **skips the "select repo" card**.
- `--standby` — **must be paired with `--repo`** (and cannot be combined with `--into`): sends `/repo` once to bring the bot up in the given directory on standby without a brief; activate it later with `--into ... --brief(-file)`.
- `--into <topic root>` — return to an existing topic and append one message (activate standby bots / add coordination); still requires `--bot`, and outside standby mode must carry `--brief` or `--brief-file`.

When a sub-bot finishes, it reports progress/completion back with `botmux report` from inside its own sub-topic. This routes the report into the orchestrator's **own** session (which still holds full context) instead of @-mentioning the orchestrator inside the sub-topic — where it has no session and the @ would spawn a fresh, context-less one. The orchestrator then aggregates the collected reports.

**Collaboration boundaries:**

- **"Own" bots in the same deployment trust each other** — the orchestrator can run operate-level commands like `/repo` directly against them (same conversation permissions as your own bots). Authorization for external bots is two-tiered: `/grant @bot` only grants "talk / be spawned by chat-scope" permission (talk-only — it does not touch `allowedUsers` and cannot run operate-level commands); to let an external bot run operate-level commands like `/repo`, add it to `allowedUsers` (or grant operate-level access later). `/introduce` only handles discovery / registering open_id and **grants no permissions**.
- Sub-bots must already be in the group and @-mentionable (i.e. have the `im:message.group_at_msg.include_bot` permission).
- A single topic can hold multiple bots, and they @-mention each other to collaborate within the topic (e.g. the coder @-mentions the reviewer once the code is done).

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
/adopt              # Selection card: ① take over a running session ② resume a past session from disk
/adopt 0:2.0        # Directly adopt a tmux pane (or pass a past session id to resume-import it)
```

- **Import past sessions** — The card's second filter lists this host's past sessions for the CLI (claude-code / seed / codex / traex / antigravity); pick one to rebuild it as a standard Botmux session via `--resume` in its original working dir — no live process required, no need to move it into tmux first
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
Gemini / OpenCode / Antigravity / GitHub Copilot), with no MCP protocol support required.

### Dashboard

> `botmux dashboard` issues a one-time-token URL — manage every daemon/bot from the browser.

- One-click locate back to the Feishu thread / open Web Terminal / multi-select batch close
- Create a new group with auto owner-transfer + @-mention notification
- Disband or leave a chat (associated sessions auto-closed)
- **Session Insights** (owner-only, read-only): parse each session's transcript to view action spans / work timeline / context curve / failure aggregates + diagnostic suggestions; send `/insight` in chat for the current session's summary card
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

---

### Per-Bot Environment Variables (run a bot on GLM / a third-party provider)

Each `bots.json` entry can define its own `env` object, injected into **that bot's CLI process**. Typical use: run one bot on a GLM Coding Plan / third-party Anthropic·OpenAI-compatible provider while another keeps using official Claude — just point the former at the provider's endpoint and key:

```json
{
  "cliId": "claude-code",
  "workingDir": "~/projects",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "your GLM Coding Plan key"
  }
}
```

> For GLM in China use `https://open.bigmodel.cn/api/anthropic`. For an OpenAI-protocol CLI like Codex, set `OPENAI_BASE_URL` / `OPENAI_API_KEY` (the provider's OpenAI-compatible endpoint) instead of `ANTHROPIC_*`. Also handy for `HTTPS_PROXY` or CLI feature flags.

Notes:

- `env` accepts valid env-var names with string/number/boolean values; botmux-reserved keys (`BOTMUX_`, `LARK_APP_`, …) are ignored, so config can't hijack session routing or creds.
- Injected **per session** into the CLI process (effective from the next session). On the tmux/zellij backends it goes in via each pane's `/usr/bin/env` prefix, **never the shared server env**, so one bot's provider config can't leak into another's.
- Also editable in the dashboard ("Bot defaults → Environment variables", owner-authenticated) or via `/config set env '{...}'`.
- Not a secret vault: values live in `bots.json` and the process environment in plaintext, visible to local diagnostic tools.

---

## 📖 Documentation

The full reference — commands, config, best practices, troubleshooting — lives in the docs site; not duplicated here —

### 👉 https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/

| Topic | Docs |
|-------|------|
| Slash commands / CLI commands / agent-facing subcommands | [Commands](https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/slash-commands) |
| `bots.json` fields / env vars / file locations | [Configuration](https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/bots-json) |
| Multi-CLI adapters (incl. wrapper / gateway integration) | [Adapters](https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/adapters) |
| Scenario-based best practices (Oncall / alerting-ops / solo dev / team) | [Best Practices](https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/best-practices) |
| Common pitfalls / FAQ | [Pitfalls](https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/pitfalls) · [FAQ](https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/faq) |
| Features: scheduled tasks / Oncall / Dashboard / multi-bot / session relay | [Schedule](https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/schedule) · [Oncall](https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/oncall) · [Dashboard](https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/dashboard) · [Multi-bot](https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/multi-bot) · [Relay](https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/relay) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
