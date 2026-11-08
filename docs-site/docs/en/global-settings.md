# Global Settings (config.json)

Some switches apply to the **whole machine**, not to one bot: when to auto-update, whether to clean up idle sessions on a schedule, who gets pinged when the host is overloaded. They live on the Dashboard's "Global Settings" page. Saving writes them to `~/.botmux/config.json`, shared by every bot on this machine.

> To change a single bot (working directory, admins, CLI, and so on), see [bots.json](/en/bots-json). For environment variables used inside sessions, see [Environment Variables](/en/env).

## Where to change them

1. Open the Dashboard and click "Global Settings" in the left nav.
2. The page has its own table of contents with three modules: **General**, **Meeting Agent**, and **System & Maintenance**. Click an entry to jump to it.
3. Toggles save as soon as you flip them; text inputs (group prefix, proxy, callback URL, and so on) need their "Save" button. Most settings need no restart.

You can also edit `~/.botmux/config.json` directly. Every item below lists its JSON field name for hand edits or backups. If "Allow tokenless read-only dashboard access" is on, visitors without a token can view but not change anything.

## Quick reference

| I want to… | Dashboard location | Field | Default |
|---|---|---|---|
| Install new versions daily | System & Maintenance → Auto Maintenance → Auto update | `maintenance.autoUpdate` | Off |
| Restart after a new version is installed | System & Maintenance → Auto Maintenance → Auto restart | `maintenance.autoRestart` | Off |
| Close long-unused sessions on a schedule | General → Scheduled tasks → Auto-clean idle sessions on a schedule | `sessionCleanup` | Off |
| Get a DM when the host is overloaded | General → Host overload alert | `hostOverloadAlert` | Off |
| Run scheduled tasks in a specific timezone | General → Scheduled tasks → Timezone | `scheduleTimeZone` | Follow host |
| Prefix group names created by `/g` | General → Group Creation | `groupNamePrefix` | None |
| Hide worktrees in the repo picker | General → Repo Picker | `repoPickerMode` | Repos + worktrees |
| Put new worktrees on a larger disk | General → Worktrees | `worktreeRoot` | Next to the main repo |
| Download new versions through a proxy | System & Maintenance → Auto Maintenance → GitHub download proxy | `httpProxy` | Not set |
| Skip pasting the callback URL after `/login` | General → Access → OAuth callback base URL | `oauthRedirectBase` | Not set |

## Auto update and auto restart

Want botmux to upgrade itself every day → turn on "System & Maintenance → Auto Maintenance → Auto update" and pick a time.

- **Auto update** (off by default): once a day at the chosen time (default 04:00, Beijing time) it checks for a new version and, if there is one, updates using the way you installed botmux (npm / pnpm / Bun global install). It **installs only, no restart**; the new version takes effect on the next restart.
- **Auto restart** (off by default, requires auto update): restarts only when this run **actually installed a newer version**. No new version, no restart. It has no schedule of its own.
- If any session is busy at that time, the whole run is skipped and moves to the next day, so working sessions are never interrupted.
- Auto update is unavailable when running from source (local dev install); the page says so.

After an intentional restart (manual restart, restart after auto update, rollback), the first bot DMs its first administrator a restart report by default. To turn that off, put `"maintenance": { "notifyOnRestart": false }` in `config.json` (there is no toggle on the page for it).

```json
{
  "maintenance": {
    "autoUpdate": { "enabled": true, "time": "04:00" },
    "autoRestart": { "enabled": true }
  }
}
```

### Auto-upgrading Codex inside sessions

Location: General → Experimental → Automatically upgrade session Codex versions. Experimental, off by default.

When on and a newer Codex is installed on the machine, running Codex sessions switch to the new process **when it is safe and idle**, then resume the same thread without starting an extra turn. Sessions with background work, or whose state can't be confirmed safe, wait. The toggle takes effect immediately.

## Scheduled cleanup of idle sessions

Lots of open sessions eat memory. Want sessions nobody has used for a while to close on their own → turn on "General → Scheduled tasks → Auto-clean idle sessions on a schedule".

![Scheduled tasks block: timezone, Codex archive, idle cleanup](/img/settings-schedule-idle-cleanup.png)

| Option | Meaning | Default |
|---|---|---|
| Auto-clean idle sessions on a schedule (`enabled`) | Master switch | Off |
| Idle threshold (`olderThanHours`) | How old the last message must be: 24 hours / 72 hours / 7 days | 7 days (168) |
| Check interval (`intervalMinutes`) | Minutes between checks, minimum 5 | 60 |
| Archive Codex threads on close / cleanup (`archiveCodex`) | Archive the matching Codex thread when a session closes (manual close or idle cleanup), restore it on reopen | Off |

It uses **the same rules** as the manual "Clean idle" button on the Session Control page, just unattended. Only truly idle sessions are closed: sessions that are running, locked, waiting on a repo pick, or carrying an alert for you are left alone.

```json
{
  "sessionCleanup": { "enabled": true, "olderThanHours": 72, "intervalMinutes": 60 }
}
```

## Host overload alert

When the host is overloaded, new sessions tend to time out during cold start. Want to know right away → turn on "General → Host overload alert".

1. Turn on "Enable overload alert".
2. Pick a **notification Bot** (one per machine is enough). The page shows the recipient: that Bot's **first administrator**.
3. Adjust the two thresholds if needed.

That Bot then checks host load and memory every 30 seconds. It DMs the admin once when the host **enters overload** and once when it **recovers**. Bouncing in and out won't spam you (two "entered" alerts are at least 15 minutes apart).

| Threshold | Counts as overloaded when | Default |
|---|---|---|
| Load enter threshold (`enterLoadRatio`) | 15-minute load average > CPU cores × this value | 1.5 |
| Memory enter threshold (`enterMemUsedFrac`, entered as a percentage) | Used memory reaches this share | 92% |

The recovery lines are built in (load = cores × 1.0, memory 85%). If you set an enter line at or below its recovery line, the recovery line is pushed down to 95% of the enter line to avoid flapping.

Notes:

- The notification Bot must be able to send Feishu messages (not an API-only bot) and must have an administrator.
- Environment variables can tune it too: `BOTMUX_OVERLOAD_ENTER_LOAD_RATIO`, `BOTMUX_OVERLOAD_EXIT_LOAD_RATIO`, `BOTMUX_OVERLOAD_ENTER_MEM_FRAC`, `BOTMUX_OVERLOAD_EXIT_MEM_FRAC`, `BOTMUX_OVERLOAD_MIN_REALERT_MS`. They take priority over the page.
- `BOTMUX_OVERLOAD_ALERT=0` turns the feature off completely, whatever the page says.

## Memory protection (check before starting a session)

This is on by default and usually needs no attention. Before starting or resuming a session process, botmux checks memory. If:

- available memory is below the **reserve** (default 25% of total memory, capped at 4 GiB), or
- memory pressure (Linux PSI `full avg10`) reaches the **limit** (default 20%),

it doesn't start the process and replies in the session asking you to free memory and resend. When the shortfall is small, it first suspends a few idle sessions to free memory and tries once more.

There are no toggles for this on the page. Use the CLI to view and change it:

```bash
botmux worker-budget status                          # current memory, thresholds, and where they come from
botmux worker-budget set --min-available-mib 2048    # reserve 2 GiB
botmux worker-budget set --max-memory-full-avg10 30  # pressure limit 30%
botmux worker-budget set --memory-admission-enabled false   # turn the check off
botmux worker-budget set --session-memory-max-mib 4096      # cap each session at 4 GiB (needs cgroup v2)
botmux worker-budget unset                           # drop overrides, back to defaults
```

These map to the `worker` field in `config.json` (`memoryAdmissionEnabled`, `minAvailableMemoryBytes`, `maxMemoryFullAvg10`, `sessionMemoryMaxBytes`). They don't change how many sessions each bot keeps resident (that's `maxLiveWorkers` in bots.json).

## Scheduled task timezone

Location: General → Scheduled tasks → Timezone. Default: follow host.

[Scheduled tasks](/en/schedule) fire, parse phrases like "tomorrow 9:00", and display times on cards and the Dashboard in this timezone. If the server is abroad but you're in Beijing, pick `Asia/Shanghai`.

Priority (earlier wins):

1. Environment variable `BOTMUX_SCHEDULE_TIMEZONE`
2. Timezone chosen on the page (`scheduleTimeZone`)
3. Host system timezone

An invalid timezone name is skipped and the next level is used. The auto-update time is not affected; it always uses Beijing time.

## Group creation and repo picker

- **`/g` group name prefix** (General → Group Creation, `groupNamePrefix`): groups created with `/group` or `/g` get this text in front of their name, e.g. `AI-chat·`. Other ways of creating groups don't. Clear it and save to turn it off; takes effect within about 2 seconds. See [Create a session group](/en/group).
- **Repo picker card mode** (General → Repo Picker, `repoPickerMode`): `all` (default, repos plus their worktrees) or `repos` (main repos only). With `repos`, `/repo <worktree path>` still takes you into a worktree.
- **Worktree directory** (General → Worktrees, `worktreeRoot`): botmux creates new worktrees under this directory, e.g. `/data00/worktrees`. Useful when the system disk is small and a larger data disk is mounted. Worktrees are laid out under it by the main repo's own path: a worktree of `/root/iserver/botmux` becomes `/data00/worktrees/root/iserver/botmux-wt-…`, so repos with the same name in different places don't collide. Use an absolute path (may start with `~/`) to an existing, writable directory. Only affects worktrees created from then on; existing ones stay where they are and keep working, also if you change the directory again later. If the directory later goes missing or stops being writable (e.g. the data disk isn't mounted, or was remounted read-only), new worktrees are created next to the main repo instead and a warning is logged. Clear it and save to go back to creating them next to the main repo; takes effect within about 2 seconds.

## Network and access

| Setting | Location | Purpose |
|---|---|---|
| GitHub download proxy (`httpProxy`) | System & Maintenance → Auto Maintenance | HTTP proxy for GitHub downloads when the standalone binary updates itself, e.g. `http://127.0.0.1:7890`. If empty, `HTTPS_PROXY` / `HTTP_PROXY` are used, otherwise it connects directly. npm / pnpm / Bun installs use their own proxy settings |
| OAuth callback base URL (`oauthRedirectBase`) | General → Access | After a Feishu authorization (e.g. `/login`), Feishu redirects here and the Dashboard finishes it, so you don't paste the callback URL by hand. Useful when botmux doesn't run on your own computer. Enter scheme + host + port only, e.g. `http://10.1.2.3:7891`. After changing it, open any bot's "Session-group tag" row and click "Fix Open Platform callback", otherwise Feishu returns error 20029 |
| Remote terminal access (`remoteAccess`) | General → Access | Off by default. Shown only when this machine is bound to the central platform. When on, session terminals, card terminal buttons, and webhook URLs use platform links; off uses local links |

For the web terminal itself, see [Web Terminal](/en/web-terminal).

## How built-in skills reach the CLI

botmux's built-in skills (sending messages, creating schedules, and so on) need to be handed to the CLI. For CLIs that only have a global skills directory, such as Codex and OpenCode, there are three modes (`skills.builtinInjection`):

| Value | What it does |
|---|---|
| `prompt` (default) | Leaves the CLI's global directory alone; puts a short catalog in the session prompt and fetches full instructions on demand. Doesn't affect CLIs you run by hand |
| `global` | Installs into the CLI's global skills directory for the most native experience, but your own manual `codex` runs will see them too |
| `off` | Adds neither; only a pointer to `botmux --help` |

This is the machine-wide default. Change it with `botmux skills injection [global|prompt|off|unset]`; no argument shows the current value. If a bot sets `skillInjection` in bots.json, the bot's own value wins. See [Skill](/en/skill-cli).

## Separate sessions for each person in a group (XPI, experimental) {#xpi}

**Off by default.** While it's off, everyone in a group shares one session: a message someone sends while the bot is busy is queued as usual and handled after the current task.

When on, **each human in the same group gets their own CLI context and git worktree**, so people can work in parallel without interrupting each other:

- Messages are still public in the group; each person's just go to their own "lane".
- Quoting a task someone else is running goes through a suggestion / confirmation flow instead of jumping into their task; other messages continue in the sender's own lane.
- Send `/lane status` in a topic to see your lane's branch, worktree, uncommitted changes and unpushed commits; `/lane close` closes your lane safely (it refuses while a task is running or files are uncommitted, pushes unpublished commits before reclaiming, and never merges or deletes branches on its own).
- When an agent messages another bot, it has to say whether that's a separate task or input for the current one with `botmux send --as independent|suggestion`.

To turn it on: Dashboard **Global Settings → General → Experimental → Cross-principal interruption isolation (XPI)**, which is `dashboard.crossPrincipalInterruption: true` in `config.json`. It applies to every bot on this machine and **takes effect from the next message, no restart needed**. To force it on or off for a single daemon process, set `BOTMUX_XPI_ENABLED=true` / `false` in its environment; that wins over the Dashboard switch.

Keep it off when people need to share one context and set of files; turn it on when their tasks are fully independent.

## FAQ

**Do I need to restart after editing config.json?**
Most toggles on the page take effect as soon as you save. After hand-editing the file, check the values on the page; when in doubt, run `botmux restart`.

**Auto update is on, so why didn't it update?**
Possible reasons: a session was busy at that time (moved to the next day); botmux wasn't running at that time and came back more than an hour later (skipped for that day); you're already on the latest version; this is a local dev install or an unsupported install layout (shown next to the "Auto Maintenance" title).

**I never get overload alerts?**
Check that a notification Bot is selected, that Bot is online, and it has an administrator. Also check whether `BOTMUX_OVERLOAD_ALERT=0` is set.

**Should backups include config.json?**
Yes. When moving machines, take `bots.json`, `.env`, `config.json`, and `data/` together. See [Environment Variables](/en/env).
