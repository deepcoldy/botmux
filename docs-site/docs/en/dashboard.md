# Dashboard Control Panel

<video src="../img/video-v7-dashboard-en.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

The Dashboard is botmux's built-in web admin console. One page lets you manage sessions, groups, scheduled tasks, workflows, and configuration for **every bot** on this machine, without typing commands into each Lark group.

## Open the Dashboard

On the machine running botmux:

```bash
botmux dashboard          # Print the login link (creates a token on first run)
botmux dashboard rotate   # Switch to a new token; old links stop working immediately
```

`botmux dashboard current` does exactly the same as the bare command; it is just the explicit form.

The **first line of output is always the link and nothing else**, so scripts can use `botmux dashboard | head -1`. The following lines are:

- `工作台: …`: a link straight to the **Cockpit**, handy as a bookmark.
- A safety notice (see below).

The default port is `7891`; change it with the `BOTMUX_DASHBOARD_PORT` environment variable.

If you use the [macOS Desktop App](/en/desktop), you can open the Dashboard right from the App window.

### What the token in the link is

The token is a login credential, like a long-lived key:

- The same link logs you in again and again, and keeps working after `botmux restart`.
- Only `botmux dashboard rotate` changes the key, and the old link stops working.
- After you first open a `?t=<token>` link, the browser remembers the login and the token is removed from the address bar.

### When the link has no token

| How you deploy | What the link looks like | Why |
|---|---|---|
| Bound to the [central platform](/en/platform) (remote access on and bound) | `https://m-<machineId>.<platform-domain>/`, **no token** | The platform sends you through single sign-on first and knows who you are. The token does nothing here and would only be a leak risk |
| Your own reverse proxy (`BOTMUX_PUBLIC_URL`) or a Devbox short link | `https://<your-domain>/?t=<token>`, **with token** | The proxy only forwards requests and does not identify you, so the token is the only ticket in |
| LAN only | `http://<lan-ip>:7891/?t=<token>`, **with token** | Same as above |

The Dashboard itself decides whether to drop the token (it knows which address the link uses). When it cannot tell, it keeps the token: an extra token is a minor nuisance, a missing one can lock you out.

Once bound to the platform, the "local IP + token" direct link is hidden by default; it is only a fallback for when the platform has problems. If you really need it, rerun the command with the flag named in its output. That flag is deliberately left out of `--help` so an AI running automation does not add it by habit and write the token into a chat transcript.

:::warning The link is an admin password
Send a `?t=` link only to yourself. **Never paste it into a group chat**: chat history is kept for a long time and can be forwarded or screenshotted. When someone asks how to get in, tell them to run `botmux dashboard` on the server themselves.

If you suspect a leak, run `botmux dashboard rotate` right away; every old link stops working on the spot.
:::

### Browsing without logging in: read-only mode

Opening the Dashboard without a token puts you in **read-only mode** by default: you can see "watch the work" pages such as sessions, scheduled tasks, and the group list, but you cannot change anything, and admin pages like Bot Config, Skills, Webhook, and Terminal are hidden.

If you do not want people on your network to see this, turn off **Allow tokenless read-only dashboard access** under **Global Settings → General → Access**. The exact boundary is described in [Public read-only and the token boundary](#public-read-only-and-the-token-boundary).

## Pages at a glance

The left navigation has five groups. Pages marked 🔒 only appear after you log in with the token.

| Group | Page | What it is for |
|---|---|---|
| Overview | Workbench | Home: online bots, items waiting for you, sessions at work |
| Collaboration | Session Control | View and manage every session (Kanban / Table views); details below |
| | Decision board | Make decisions in one place on the web; see [Decision Board & Steward](/en/decision-board). Appears only once at least one bot is a steward |
| | Cockpit | Work with several sessions side by side, chat with them and watch their terminals; see [Agent Workbench](/en/workbench) |
| | Group Management | Create groups, add bots, tune per-group settings and member access; details below |
| | Scheduled Tasks | Create, edit, pause, and run scheduled tasks now; see [Scheduled Tasks](/en/schedule) |
| | Workflows | Watch workflow runs and cancel them; see [Workflow](/en/workflow) |
| Digital Workforce | Role Management 🔒 | Give each bot a per-group persona; see [Roles & Team](/en/roles) |
| | Skill Management 🔒 | Install skills from a GitHub / Git address or a local directory |
| | Customization 🔒 | Override built-in prompts and skills, with export / import and rollback |
| | Message Listener 🔒 | Let bots respond to group messages by rule without an @, configurable per group |
| | Doc watches 🔒 | Manage Lark doc-comment watches; see [Doc Comments](/en/doc-comment) |
| | Bot Config 🔒 | Each bot's default behavior; details below |
| | Agents 🔒 | Reusable execution profiles (CLI, model, directory, sandbox) that several bots can share |
| Analytics | Monitoring Board | Machine health, memory, and session pressure |
| | Data Insights 🔒 | Statistics on sessions and tool calls; details below |
| | Feedback 🔒 | Rating coverage, latest ratings, and failures for final answers; to switch storage (SQLite / PostgreSQL), see [Feedback Storage & Migration](/en/feedback-storage) |
| Management | Terminal 🔒 | Web terminal for the local shell / tmux / herdr, shown only to the local owner |
| | Webhook 🔒 | Connectors and invocation logs; see [Connectors](/en/webhook) |
| | Plugins 🔒 | Manage plugins; see [Plugins](/en/plugins) |
| | Whiteboards 🔒 | Local whiteboards; see [Whiteboard](/en/whiteboard) |
| | Global Settings | Global switches for access, Lark cards, scheduled tasks, auto-update, auto-start, and more; see [Global Settings](/en/global-settings) |

The top of the sidebar also has **Create session** and **Create bot** shortcut buttons.

## Global search (⌘K)

Want to jump to a session or a setting quickly → press `⌘K` (macOS) or `Ctrl+K` (other systems) on any page, or click the search box in the top bar.

![⌘K global search](/img/dashboard-command-palette.png)

What you can find:

- **Sessions**, including closed ones.
- **Settings**: individual options in Global Settings and Bot Config (for example the session mode for standard groups). Picking one jumps there and highlights the row. If the current bot does not have that option, it stops at the category and tells you why.
- **Bots**: by name or app id, straight to that bot's config.
- **Skills / Agents**.
- **Pages**, including sub-pages not in the sidebar such as the Session Monitor Room, Webhook invocation logs, role Profiles, and each Data Insights tab.
- **Quick actions**, such as switching the theme.

Both Chinese and English names work. Skills, agents, and bots only show up for logged-in administrators.

| Key | Action |
|---|---|
| `↑` `↓` | Move the selection |
| `↵` | Open |
| `⌘↵` / `Ctrl+↵` | Secondary action: when logged in, open an active session in the Cockpit; otherwise jump to its Lark thread |
| `Tab` | Switch category |
| `Esc` | Close |

With an empty query, the list shows recently used items.

## Session Control

This page lists the sessions of every bot, in two views you switch at the top:

- **Kanban**: columns for Backlog / Todo / In Progress / Needs You / Done. Sessions land in a column automatically by status (for example a session waiting for you to pick a repo or confirm something goes to Needs You), and you can drag them to another column. Nothing lands in Backlog automatically: drag a session there, or pick Backlog when you **Create session** (the group and bots are set up, but the CLI does not start yet). Dormant sessions stay off the board by default; see them in the Table view.
- **Table**: good for bulk actions, with columns you can choose.

Both views filter by status, bot, chat, CLI, and source (Feishu-native / External `/adopt`), and you can search by chat name, working directory, title, or ID.

Common actions:

| What you want | How |
|---|---|
| Go back to the Lark thread | Click **Locate Topic**: the bot posts a message in the original thread that only @-mentions the session owner; tap the notification to jump back |
| Open the chat | Click **Open chat** |
| Look at the terminal | **Open read-only terminal** to watch; **Take over terminal** to type |
| The CLI is stuck | **Restart CLI**. If the session still has unfinished work, the restart is refused for now so nothing is lost |
| Close sessions | **Close Session**, or multi-select and **Close selected** |
| Bring back a closed session | **Resume Session** |
| Clean up idle sessions in bulk | **Clean idle**, choosing idle for more than 24 hours, 72 hours, or 7 days. Sessions waiting for you and locked sessions are left alone |
| Keep a session safe from Clean idle | **Lock session** |
| Watch several sessions at once | Multi-select and **Add to monitor room** to see several terminals on one screen in the Session Monitor Room |
| See what a session did | **Insight**: counts tool calls, failures, and time spent, with suggestions |
| Reproduce how the CLI was launched | **Copy reproduce command**. It contains credentials such as tokens, so keep it private |

### Run status, task status and TODOs {#session-status-todo}

Automatic, nothing to configure. Session cards show status in two layers:

- **Run status**: whether the CLI is idle or working right now (working, starting, analyzing, and so on).
- **Task status**: whether the work is finished. When a Claude Code / Codex session record still has open TODOs, the card carries a "TODO done/total" badge. Hover to preview the list, click to pin it so you can select and copy.

So a session whose CLI is already idle but still has unfinished TODOs lands in the board's **Todo** column instead of blending in with idle ones. CLIs whose TODOs can't be read are unaffected and are placed by run status. TODO contents are hidden in read-only mode without a login.

## Group Management

![Group Management: standard group list](/img/dashboard-groups-list.png)

At the top you switch between two kinds of chats:

- **Groups**: groups you created or added bots to. Each row shows which bots are in it, with **Add Bots**, **Duplicate**, and **Manage** on the right.
- **Session chats**: groups a bot created automatically from a private chat, one per session, sortable by Recently active or Created.

Common actions:

- **New Chat**: pick the bots to add, and optionally bind a working directory (new threads start right there instead of asking you to pick a repo). After creating the group botmux adds you and tries to transfer group ownership to you.
- **Duplicate**: create another group with the same bots, bound directory, and chat roles in one click.
- **Manage**: opens the group settings drawer with six tabs:

| Tab | Contents |
|---|---|
| Overview | Every bot's settings in this group at a glance: chat role, reply mode, Oncall dir, default model, serial input, idle close, run card, pin card. Click a row to open that bot's settings |
| Bot settings | Per bot for this group: reply mode, Oncall, default model for new threads, serial handling of multi-person messages, idle auto-close, run cards, pinning the live card |
| Collaboration | Standard group (bots respond independently) or Project group (one coordinator bot orchestrates, each subtask gets its own thread) |
| Member access | Managed from one bot's point of view: multi-select members for a **batch grant** (up to 50 at a time, optional message quota and duration, membership re-checked before writing), a **whole-chat grant** (same as sending a bare `/grant` in the group), and **Block / Unblock** for a single member |
| Recall messages | Pick one of the bots in the chat and page through the group's messages (or open a topic to read replies). You can only select messages sent by that bot **itself**, up to 50 per batch, with a success or failure result for each message. Lark's recall time limit applies |
| Leave / Disband | Have selected bots leave, or disband the group (only works when a bot is the owner). Related sessions are cleaned up automatically |

### Serial input and idle close

Both options in **Bot settings** are set per group × bot. Both are off by default and take effect after saving, with no restart.

| Setting | What it does when on |
|---|---|
| Process group messages in order | While the bot is working on a turn, new messages in the group (your own included) wait in a queue. Once the turn is done they are handled one by one in arrival order, without interrupting the current turn. Applies only to messages received after saving, and is independent of Oncall. Sessions taken over with `/adopt` are not affected |
| Automatically close inactive sessions | Sessions in this group (existing and new) are closed automatically once no new message has arrived for the chosen duration. The duration is a positive whole number in **Days** or **Hours**, 1 day by default |

Auto-close only closes sessions that are idle or dormant. These are skipped:

- Sessions that are running, waiting for you to confirm or pick a repo, flagged as needing you (including usage limits), or still have queued messages.
- Locked sessions.
- Sessions taken over with `/adopt`.

In a group where idle close was never set, sessions are not closed for being idle.

## Bot Config

Each bot's default behavior lives here, in five categories: Common / Sessions / Security / Message cards / Advanced. Switching categories keeps unsaved input.

A few frequently used items:

- **Default Role**: the bot's default persona in every session; a single group can override it in Role Management.
- **Blocked users (`blockedUsers`)**: people on this list cannot trigger the bot.
- **Quiet mode preset**: one click turns off thinking cards, turns on silent emoji reactions, and turns off streaming cards. It is a one-time write; changing those three switches later is not affected.
- **Card Signature**: a personal signature in the footer of final-answer cards.

### Rename, avatar, and profile description

At the top of the Bot Config page you can change the bot's name, avatar, and Feishu profile description. Saving syncs to the Feishu Open Platform and publishes a new app version, which takes about 10 seconds. After that the group shows the new name and avatar.

This step uses the Feishu web login cached on the server. When that login is missing or expired, the page says so and shows a **Scan to log in to Feishu** button:

1. Click **Scan to log in to Feishu** to show a QR code.
2. Scan it with the Feishu app and confirm the login.
3. After a successful login, the rename or avatar change is retried automatically. The profile description is reloaded, and you need to click **Publish descriptions** again for your draft.

The login is stored only on this machine and is shared with `botmux setup`. The account you scan with must be a collaborator on the app, or you get a no-access warning. If the rename fails on the Feishu side, only the Dashboard display name is updated. International Lark tenants do not support automatic changes to the name, avatar, or description yet.

## Data Insights

Data Insights analyzes the tool calls (spans) in your sessions to show what is slow and what keeps failing. At the top you can filter by project, time (all time, or the last 1 / 7 / 30 days), and CLI, or narrow to sessions that are **Worth review**, **Has failures**, or **Has slow spans**.

| Tab | Question it answers |
|---|---|
| Overview | How are things overall: sessions, spans, failed spans, slow spans, read/write ratio, plus the top suggestions and the tools that fail most |
| Sessions | What did one session do: sort by recent, review score, failures, duration, and more; open one to see its action spans, subagents, and suggestions |
| Flow | Where does the time go: action count and time share for the research, edit, run, delegate, and discuss phases, plus each session's rhythm |
| Distribution | What is typical: per-session distributions of spans, failures, slow spans, agent time, read/write ratio, and lines changed, plus daily session counts for the last 4 weeks |
| Hotspots | What keeps coming back: files, commands, and errors that recur across sessions, the project breakdown, and the slowest sessions |

Durations count only tool execution time and leave out time spent waiting for your reply, so they are not wall-clock time. CLIs are measured differently (for example Codex reads files mostly through the shell, so its read/write ratio runs low), so cross-CLI comparisons are only a rough guide.

## Workflows

The workflow feature is off by default. To use it, first turn on **Enable the workflow feature** under **Global Settings → General → Workflow**.

- **Run list**: every workflow run and its status. With no runs yet, start one in Lark with `/workflow new`.
- **Run detail**: the node graph shows which bot owns each node, its current status, and how long it took; click a node for dependencies, placement, its instance terminal, and more.
- **Cancel run**: finished nodes are kept; running nodes are interrupted.

Two things are not done in the Dashboard:

- Human approval in a workflow (humanGate approve / reject) happens on a **Lark approval card**.
- Triggering a workflow with parameters goes through [Connectors (Webhook)](/en/webhook).

## Monitoring Board and Session Monitor Room {#monitoring}

There by default, and visible in read-only mode too: **Analytics → Monitoring Board** in the sidebar (`#/monitoring`) shows botmux's runtime health on this machine (is the data fresh, is the daemon online, are sessions piling up), memory use and session pressure in real time. Memory is counted as PSS (`phys_footprint` on macOS) and split into botmux itself and external CLIs, so adding up processes doesn't double-count shared memory.

To watch several sessions' terminals at once: select them in **Session Control**, click **Add to monitor room**, and they appear side by side in the **Session Monitor Room** (`#/monitor-room`).

## Agents and the links graph {#agents}

There by default, login required: **Digital Workforce → Agents** in the sidebar (`#/agents`). An Agent is a reusable run config (CLI, model, working directory, sandbox). One Agent can back many bots, and an edit syncs to new sessions of every linked bot.

1. Click **New Agent** and start from **Copy from a Bot** (identical to that bot's config; you can tick **Also link this Bot**) or **Blank**.
2. Switch between **Configure** and **Links** at the top of the page. In **Links**, drag from the dot on an Agent onto a bot to link them.
3. Once linked, the bot's run config is managed by the Agent; to change it on its own, unlink it in the links graph first.

Agents are optional: a single bot can still pick its CLI and model directly under **Bot Config → Common → Agent Config**.

## Customizing built-in prompts and skills {#customization}

There by default, login required: **Digital Workforce → Customization** in the sidebar (`#/customization`) lets you tune botmux's built-in framework prompt fragments and built-in skills. The page itself is in Chinese.

- Every entry can be rewritten; changes **apply from the next session, with no daemon restart**.
- Each entry can be reset on its own with **恢复出厂** (reset to factory), or all at once with **全部恢复出厂**. Every change stores a snapshot; **历史 / 回滚** (history / rollback) takes you back to any snapshot, and a rollback stores a snapshot too.
- **导出 bundle** (export) downloads your changes as a bundle; a teammate brings them in with **导入 bundle** (import; a snapshot is taken before importing).
- You can delete critical instructions (such as `botmux send`), but then the bot may be unable to post replies back to Lark; reset to factory if unsure.

## Host web terminal {#host-terminal}

There by default, **only for people who can manage this machine**: log in to the Dashboard with this machine's admin link, or open this machine's Dashboard from the central platform, and **Management → Terminal** (`#/terminal`) appears in the sidebar.

- **New shell** opens a login shell on this machine; you can also connect to existing tmux / herdr sessions on it from the list, including sessions botmux manages.
- Multiple tabs, full screen and font size are supported.
- Closing a shell tab ends that shell and anything still running in it; closing a tmux / herdr tab only disconnects and leaves the session alone.

It hands out a shell on this machine, which is a lot of power; don't share the admin link. This is not the same as the [web terminal](/en/web-terminal) on session cards, which only views and drives one session's CLI.

## Auto-start at boot

Under **Global Settings → System & Maintenance → Auto-start**, turn on **Start the botmux background service automatically** and botmux will come back by itself after a reboot or re-login. You must be logged in to see or change it.

The switch uses the same mechanism as the `botmux autostart` command. It only affects **the next boot** and does not start, stop, or restart the service that is running now.

## APIs for integrations

This part is for developers building monitors, status pages, or automation scripts. Everyday users can skip it.

### Rename a group

An authenticated integration can rename a Lark group as a specific bot:

```http
PUT /api/groups/{chatId}/name/{larkAppId}
Content-Type: application/json

{"name":"New group name"}
```

- URL-encode both path segments.
- The chosen bot must currently be in the group; on failure botmux does **not** retry with another bot.
- The name is at most 100 characters (Unicode code points) and may not contain control or invisible formatting characters.
- The request body is at most 4 KiB and accepts only `name`.
- Dashboard management rights are required; even with public read-only on, this write can never be anonymous.

### Read-only query endpoints

| Endpoint | Contents |
|---|---|
| `GET /api/dashboard/v1/summary` | A versioned, strongly redacted overall summary |
| `GET /api/sessions` | All current active + closed sessions |
| `GET /events` | The Dashboard's external SSE stream. `session.spawned` carries the full session in `body.session`; `session.update` carries changed fields in `body.patch` |

Each daemon also has a `/api/events` endpoint that listens only on loopback. It is the internal channel the Dashboard uses to aggregate data, not an external address.

### Summary `GET /api/dashboard/v1/summary`

Use it to plug botmux into an external status page, monitor, or orchestrator. It aggregates sessions and scheduled tasks from online daemons and returns only allow-listed statuses and counts. It **never** returns bot / session IDs, titles, group names, working directories, prompts, scheduled-task contents, or diagnostic logs. The 200, 429, and 503 responses all carry `Cache-Control: no-store`.

:::tip
This endpoint is served by the `botmux-dashboard` process that `botmux start` launches. `botmux serve --api-only` does not start the Dashboard, so the endpoint does not exist there; see [Core-only API Control](/en/api-core-only) for that mode's health check.
:::

Success returns HTTP 200. Note that 200 only means the snapshot was generated: when a configured bot is offline, `service.status` is still `degraded`.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-09T02:30:00.000Z",
  "service": { "status": "healthy" },
  "bots": { "online": 3 },
  "sessions": { "active": 7, "attention": 1 },
  "schedules": {
    "enabled": 2,
    "nextRunAt": "2026-08-09T04:00:00.000Z"
  },
  "dashboard": { "href": "/" }
}
```

| Field | Meaning |
|------|---------|
| `schemaVersion` | Version of the response format; currently `1` |
| `generatedAt` | When this snapshot was generated (ISO-8601) |
| `service.status` | `healthy` when the online bot count equals the configured bot count, otherwise `degraded` |
| `bots.online` | Number of daemons / bots online now |
| `sessions.active` | Sessions on online daemons whose status is not `closed` |
| `sessions.attention` | Active sessions that need a person: waiting for a repo choice, a TUI prompt, an agent asking for attention, or the `limited` / `stalled` states |
| `schedules.enabled` | Enabled scheduled tasks on online daemons |
| `schedules.nextRunAt` | Earliest next-run time among enabled scheduled tasks (ISO-8601), or `null` if none |
| `dashboard.href` | Relative path to the Dashboard home; resolve it against the current Dashboard address |

If any online daemon's data times out, errors, or is malformed, the endpoint returns HTTP 503 and **deliberately leaves out the counts**, so "could not read" is never mistaken for "zero":

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-09T02:30:00.000Z",
  "service": { "status": "degraded" }
}
```

**Anonymous rate limit**: requests without a valid token share one quota, at most 5 in any 10 seconds. The sixth returns HTTP 429:

```json
{
  "error": "rate_limited",
  "retryAfterSeconds": 7
}
```

The `Retry-After` header carries the same number of seconds (at least `1`, normally `1`–`10`); wait that long before retrying.

Requests with the current token are not rate limited. Authentication works like the browser login: visiting with `?t=<token>` first returns a 302, sets the `botmux_dashboard_token` cookie, and redirects to the address without the query. A pure API client that wants to skip the limit must keep this cookie and send it on later requests. `Authorization: Bearer` is **not** supported here.

### Optional fields in session data

These fields only appear in session data from `/api/sessions` and `/events`; the summary endpoint never returns them. They are all **optional**: older sessions or versions may omit them, so handle their absence:

| Field | Meaning |
|------|---------|
| `backendType` | The backend used at the latest launch (`pty` / `tmux` / `herdr` / `zellij` / `zmx`), for filtering and display; it may change after a cold resume if the config changed |
| `backendSessionName` | Present only for managed persistent-backend sessions; currently `bmx-<first 8 chars of sessionId>`. PTY sessions, adopted sessions, and some old rows lack it. It is locator information only and **does not mean the process or socket is still alive** |
| `titleUpdatedAt` | When the title was last updated (ISO-8601) |
| `titleSource` | Where the title came from: `initial` / `user` / `agent` / `cli` / `dashboard` / `system`. For display and debugging only, **not usable as identity or audit evidence** |

### Public read-only and the token boundary

Public read-only (`publicReadOnly`) is on by default. While it is on, these read endpoints are reachable on the Dashboard listener **without a token**:

- `GET /api/dashboard/v1/summary` (strongly redacted summary)
- `GET /api/sessions` (session list)
- `GET /api/schedules` (scheduled tasks; prompts are hidden for anonymous callers)
- `GET /api/settings` (read-only settings)
- `GET /api/groups` (bot names and group names)
- `GET /events` (event stream; scheduled-task prompts are hidden for anonymous callers)

So treat session names, titles, backend types, and other session metadata as "public to this network".

- All writes (POST / PUT / PATCH / DELETE), read endpoints not on the list above, and raw terminal output and diagnostic logs always need the current token. The list is "private by default": a read endpoint added later does not become public just because public read-only is on.
- With public read-only off, a tokenless summary request returns 401; a request with the current token still works and is not rate limited. With public read-only on, a wrong or rotated old token is treated as anonymous.
- The token only controls access at the Dashboard application layer; it does not replace a host firewall, VPN, or reverse-proxy authentication.
- If you do not need anonymous viewing, turn off **Allow tokenless read-only dashboard access** under **Global Settings → General → Access**. You can also set `BOTMUX_DASHBOARD_PUBLIC_READONLY=false` before starting; but once the switch has been saved on the settings page, the value in `~/.botmux/config.json` wins over the environment variable.

## Deployment details

The Dashboard is a separate process, `botmux-dashboard`, managed by the built-in supervisor; it starts and stops together with the daemon.

Each daemon exposes its internal API only on `127.0.0.1`. The Dashboard process forwards requests and checks signatures. The signing key lives in `~/.botmux/.dashboard-secret` (mode 0600), is used only between the daemon and the Dashboard, and is **never sent to the browser**; the browser uses the login token described above.
