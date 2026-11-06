# Tmux Session Persistence

A "session backend" is how botmux hosts the CLI process. **The default backend is tmux**: each topic's CLI runs inside a tmux session, so when botmux itself restarts, the CLI keeps running.

So the most common question, "will restarting botmux lose my context?", has a simple answer: **no**.

## What happens to a session in each case

Two terms first:

- **Re-attach**: the CLI process stayed alive and botmux simply reconnects to it. Context is intact and no extra tokens are spent.
- **Cold resume**: the CLI process is gone. When the next message arrives, botmux starts a new process from the CLI's own saved conversation (for example Claude Code's `--resume`). The topic and context are kept; it just takes a few more seconds.

| What happened | tmux session | What you see |
|---|---|---|
| `botmux restart` / daemon restart | Kept | **Re-attached** automatically. After a restart botmux reconnects to live sessions on its own (attach only; it does not start a new turn by itself) |
| `/close` in the topic, or the close button on the card | Destroyed | The session ends and the CLI exits with it |
| The CLI exits or crashes on its own | Ends with it | The CLI is restarted automatically. More than 3 crashes in a row within 1 minute stops auto-restart; deterministic failures such as exit code 77 (identity/credential problem) or 127 (command not found) are retried only once. Once stopped, the Web terminal shows what went wrong, and sending another message tries again |
| The session is "suspended" (over the resident limit, or idle too long) | Ends, memory freed | The topic stays; the next message **cold-resumes** it. Rules and settings are in the [FAQ](/en/faq) |
| The machine reboots | All of tmux is gone | The topic stays; the next message **cold-resumes** it |

## Enter a session from your local terminal

The easiest way is `botmux list`:

```bash
botmux list           # interactive list
botmux list --plain   # plain-text table, good for scripts
```

Keys in the list:

| Key | Action |
|---|---|
| `↑` / `↓` | Select a session |
| `Enter` | Connect to the session; a suspended session is resumed first, then connected |
| `d` | Delete (close) the session, confirmed with `y` |
| `q` | Quit the list |

You can also use tmux directly:

```bash
tmux -L botmux ls                               # list every session botmux manages
tmux -L botmux attach -t bmx-<first 8 chars of session ID>  # enter a session
```

Press `Ctrl+B`, then `D` to leave; the CLI keeps running in the background.

What you see inside is an ordinary terminal, exactly like running the CLI locally. The Lark topic, the [Web terminal](/en/web-terminal) and your local tmux all show **the same process**, and actions on any side stay in sync.

## Why botmux uses its own tmux server

botmux sessions live on a dedicated tmux server (`tmux -L botmux`) instead of mixing with your own tmux. So whether you slip, or a bot runs `tmux kill-server` inside its own terminal, only your own sessions on the default server are closed, not every bot session at once.

- **Old sessions that were running before the upgrade** stay on the default server (`tmux attach -t bmx-…` still works) and move to the dedicated server the next time they have to be created again (for example a CLI restart or a cold resume). `botmux list`, the Web terminal and the Dashboard terminal page find each session wherever it lives.
- **`/adopt` is unaffected**: it takes over terminals you opened on your default server; see [Session Adoption (Adopt)](/en/adopt).
- **To get the old behaviour back**, set `BOTMUX_TMUX_SOCKET=default` in `~/.botmux/.env`; new sessions then go back to the default server. You can also pick another name (letters, digits and `_` `.` `-` only); an invalid value falls back to `botmux`, never silently to the default server.
- `TMUX_TMPDIR` works as usual; the socket file is `$TMUX_TMPDIR/tmux-<uid>/botmux`.

## tmux is missing or doesn't work

- **Auto-install**: when `botmux start` / `botmux restart` can't find tmux, it first tries to install it for you, and if that fails it prints a manual install command and stops (unless you explicitly set `BACKEND_TYPE=pty`). See [Prerequisites](/en/prerequisites).
- **No silent backend switch**: if tmux doesn't work when a new session starts, botmux refuses to start it and posts a card in Lark with the reason and the install command (`brew install tmux` on macOS, `sudo apt-get install -y tmux` on Debian/Ubuntu).
- **tmux is installed but won't start**: this usually means a container's seccomp/sandbox policy blocks the `clone3` / `clone` system calls. In that case the card doesn't ask you to install tmux; it tells you to allow those two system calls.
- **Emergency workaround**: the card mentions `BACKEND_TYPE=pty` as a temporary bypass, but pty sessions don't survive a botmux restart.
- Sessions that are already running are not affected by a single failed probe and can still be re-attached.

## Switch to another backend

Day to day you only need tmux. If you really need to switch, use the `BACKEND_TYPE` environment variable globally, or `backendType` in bots.json for a single bot (see [bots.json configuration](/en/bots-json)):

| Backend | When to use it | Re-attached after a restart? |
|---|---|---|
| `tmux` | Default, recommended | Yes |
| `pty` | Emergency: tmux really can't run on this machine | No, the next message cold-resumes |
| `herdr` / `zellij` | You already use one of these terminal tools and want to see bot sessions inside it | Yes |
| `zmx` | You want the lightweight ZMX to host sessions; see [ZMX session backend](/en/zmx) | Yes |

```bash
# Example: temporarily run the whole machine on pty (emergency only)
BACKEND_TYPE=pty botmux start
```

A few things to keep in mind:

- **Only new sessions are affected**: each session remembers the backend it was created with, so existing sessions don't move when you change the setting.
- **Bots with the sandbox enabled** can only use `tmux` or `pty`. `herdr`, `zellij` and `zmx` don't support the sandbox's file isolation and are blocked before launch; see [Sandbox](/en/sandbox).
- **Remote-style CLIs bring their own backend**: `riff`, `mojo` and `remote-runner` don't run a process on this machine, so the backend automatically follows the CLI; you don't (and can't) set it separately. Conversely, if an ordinary CLI is configured with one of these backends, it automatically falls back to a local backend.

## herdr: where sessions are placed

With the `herdr` backend, by default each topic gets a new workspace in the herdr session `botmux`, which botmux manages itself. To have bot sessions show up in the herdr you are already using, change the placement.

| Field | Values | Notes |
|---|---|---|
| `sessionName` | Session name, default `botmux` | Which herdr session to use. When it points to another session, that session must already be running; botmux won't start it for you |
| `placement` | `workspace` (default) / `tab` / `split` | `workspace`: a new workspace per topic; `tab`: a new tab in the target workspace; `split`: a split pane in the target tab |
| `workspace` | Workspace id or label | Used by `tab` / `split`. If nothing matches, the focused workspace is used |
| `tab` | Tab id or label | For `split`, the tab to split; if it isn't found, a tab with this name is created. For `tab`, the label of the new tab |
| `splitDirection` | `right` (default) / `down` | Only used with `split` |
| `chatTypes` | `group`, `p2p` | Only new sessions of these chat types use the placement; other sessions still go to `botmux`. Leave it out to apply to every session |

There are two places to configure it. They are merged field by field, and bots.json wins:

- **Whole machine**: `BOTMUX_HERDR_SESSION_NAME`, `BOTMUX_HERDR_PLACEMENT`, `BOTMUX_HERDR_WORKSPACE`, `BOTMUX_HERDR_TAB`, `BOTMUX_HERDR_SPLIT_DIRECTION` and `BOTMUX_HERDR_CHAT_TYPES` (comma-separated, e.g. `group,p2p`) in `~/.botmux/.env`.
- **Single bot**: the `herdr` block in bots.json. Fields you set override the matching environment variable; fields you leave out keep the environment value.

```json
{
  "backendType": "herdr",
  "herdr": {
    "sessionName": "default",
    "placement": "split",
    "tab": "3",
    "chatTypes": ["group"]
  }
}
```

A few things to keep in mind:

- **You need at least `sessionName` or `placement`** (after merging both places). Setting only sub-fields such as `workspace` or `tab` does nothing; sessions still get a new workspace in the default `botmux` session.
- **Only new sessions are affected**; existing sessions stay where they are.
- **When sessions go into your own herdr session**, closing a topic only closes the bot's own pane, never your session.
