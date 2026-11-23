# hc Session Backend (herdr-core)

[herdr-core](https://github.com/herdrdev/herdr-core) (command `herdr-core` / `hc`) is a headless terminal server: a long-running core process hosts the terminals, and clients create, read and attach to them over a local socket. With `hc` as the botmux session backend, the CLI runs in an hc terminal: it survives daemon restarts, the in-browser Web Terminal works as usual, and you can attach to the same session from a local terminal with `botmux list`.

First, check whether it fits:

| You want | Use hc? |
|---|---|
| Many sessions on one machine, with the tmux server saturating a CPU core | Yes |
| A long-lived CLI that survives daemon restarts, plus the Web Terminal | Yes, same as tmux |
| A file sandbox (`sandbox`) | Yes, same as tmux |
| `/adopt` an existing terminal session | No, use tmux / Herdr / Zellij |
| A daemon running on macOS | No, the hc backend is Linux only |

hc is **explicit opt-in**: the default backend is still tmux, botmux does not install hc, and finding `hc` on the machine never makes botmux pick it automatically.

## Why switch

With tmux, every session is handled by one single-threaded tmux server, and botmux also polls each screen to read it. With many sessions that server process becomes the bottleneck. In a load test with 200 terminals each redrawing 5 times a second, the tmux server used about 32% of a CPU core, and about 59% counting botmux's screen polling; under the same load hc used about 8% and 11%. At 20 redraws a second tmux capped out around 66%, while hc used about 33–36%.

hc pushes output to botmux, which keeps a local screen mirror, so reading a screen no longer means polling every session. With only a few sessions there is no noticeable difference; staying on tmux is fine.

## 1. Get herdr-core

You need **herdr-core 0.1.19 or newer**, on **Linux**.

botmux looks for the executable in this order and uses the first one it finds:

1. The absolute path in the `BOTMUX_HC_BIN` environment variable. When it is set, botmux uses only that path and looks nowhere else.
2. `~/.botmux/bin/herdr-core` (`bin/herdr-core` under the botmux data root; it moves with a custom data directory).
3. `herdr-core` on `PATH`.
4. `hc` on `PATH`.

The file must run `--version` and print `hc X.Y.Z` with a version of at least 0.1.19; otherwise it counts as unavailable. The second location is recommended, so botmux's binary stays separate from any `hc` you use yourself:

```bash
mkdir -p ~/.botmux/bin
cp /path/to/herdr-core ~/.botmux/bin/herdr-core
chmod +x ~/.botmux/bin/herdr-core
~/.botmux/bin/herdr-core --version   # should print hc 0.1.19 or newer
```

Do this as the **same system user** that runs the botmux daemon. Checking the version starts no core; don't use this binary to run other subcommands by hand, for the reason given under "botmux's private core" below.

## 2. Turn on hc

**For a single bot (recommended)**, either way works:

- Dashboard → **Bot config** → set the bot's **Backend type** to `hc`. It applies to new sessions; running sessions keep their original backend.
- Add `backendType` to the bot in `~/.botmux/bots.json`:

  ```json
  {
    "name": "codex-hc",
    "cliId": "codex",
    "backendType": "hc"
  }
  ```

  Then run `botmux restart`.

**As the default for the whole deployment**: set this in `~/.botmux/.env`, then `botmux restart`.

```bash
BACKEND_TYPE=hc
```

A per-bot `backendType` takes priority over this global default.

Before every new hc session, botmux checks that herdr-core runs and is new enough. If not, it refuses to start and tells you in the topic why and where to put the binary. It **never silently switches to another backend**.

The daemon also checks once at startup: when any bot uses hc it prints the version it found, or a warning when it found none. The daemon refuses to start only when herdr-core is missing entirely and every bot and every active session uses hc; while other backends are in use it only warns and leaves them alone.

:::warning Check old sessions before switching
Each session remembers the backend it was created with, so changing a bot's `backendType` does not move existing sessions. The exception is sessions created by very early versions that never recorded a backend: they follow the bot's new setting, their original tmux session can no longer be reattached, and the next message cold-starts them.
:::

## 3. botmux's private core

botmux uses only its own hc core, fully separate from any hc you use yourself:

| Item | botmux's core |
|---|---|
| Core name (`HC_SESSION`) | `botmux` |
| Socket | `$XDG_RUNTIME_DIR/herdr-core/botmux.sock` (`/run/user/<uid>/herdr-core/botmux.sock` when `XDG_RUNTIME_DIR` is unset) |
| Config directory | `~/.botmux/hc/config`; botmux writes its `herdr-core/config.toml` |
| State directory | Next to the socket: `…/herdr-core/botmux.state` |

- botmux never reads, connects to or modifies your own core (usually `default`) or the config in `~/.config/herdr-core`.
- When botmux calls hc it drops inherited `HC_*` variables and sets the items above explicitly, so `HC_SESSION` or `HC_SOCKET` in your shell cannot steer a session to another core.
- All bot daemons of the same system user share this one core. Every terminal carries its session's full ID as a label, and botmux checks that label before reattaching or closing, so it never touches another session's terminal.
- The CLI inside a terminal sees the daemon's own `XDG_CONFIG_HOME` / `XDG_STATE_HOME`, not the private directories botmux gives the core.
- The socket path is limited to 107 bytes. If `XDG_RUNTIME_DIR` is too long, new sessions are refused with a hint to use a shorter directory.

:::warning Don't run hc commands against botmux's socket by hand
Any hc command starts a core by itself when it cannot connect, and the new core passes the environment of the process that started it to every later terminal. Running hc by hand against botmux's socket can therefore start botmux's core with your shell's environment, including any `HC_*` settings in it. Use `botmux list` to look at or attach to sessions: it drops `HC_*` variables and pins botmux's private config when it calls hc, and checks that a terminal belongs to the session before attaching.
:::

## 4. Enter the same session locally

```bash
botmux list
```

The list shows the actual backend of each session; hc sessions show as `hc: bmx-xxxxxxxx`. Select one and press Enter to attach; press **Ctrl+\\** to detach (detaching leaves the session running). A suspended session is resumed first.

Before attaching, botmux asks the core directly whether the terminal is still live and labelled for this session, then attaches to that verified terminal address. It refuses, instead of opening an empty shell that pretends to be the original CLI, when:

- botmux's core is not running;
- the terminal has ended or no longer exists;
- a terminal with the same name belongs to another session.

The hc backend is Linux only, so the one-click **💻 Open …** button on Feishu cards (offered only by daemons on macOS) does not apply to hc sessions.

## 5. Session lifecycle

Each session maps to an hc terminal with a fixed name, `bmx-<first 8 characters of the session ID>`, labelled with the full session ID.

| What happened | The CLI | What botmux does |
|---|---|---|
| `botmux restart` | Keeps running | Reattaches without restarting the CLI |
| The hc core restarts or crashes | Keeps running | Reconnects, checks the terminal is still this session's, reattaches and refreshes the screen |
| The machine rebooted and the terminal is gone | Already exited | Keeps the session record; the next message resumes the previous conversation |
| `/close`, the close button, or `botmux delete` | Ended | Ends and removes the terminal after checking its label; a terminal with a different label is left alone |

If you run `botmux delete` while the daemon is offline and the terminal's label does not match, herdr-core is unavailable, or the query gives no answer, the delete is refused and the session is kept, rather than marking it closed and leaving an unmanaged CLI behind.

The core (socket) a terminal lives on is recorded when the session is first created. Even if the daemon's environment changes later (for example a different `XDG_RUNTIME_DIR`), botmux still looks for it on that original core.

When `XDG_RUNTIME_DIR` is `/run/user/<uid>`, hc runs the core and its terminals in systemd user units outside the daemon's process group, so a daemon restart does not take them down.

:::warning Upgrading herdr-core
Replacing the binary on disk does not replace a core that is already running. If the running botmux core is older than 0.1.19, new sessions are refused, and the error names that core's socket and pid. botmux does not restart it for you, because ending the core ends every terminal in it; once you have confirmed no session needs keeping, end that process and try again.
:::

## 6. Differences from tmux and limitations

- **Linux only**, and you provide herdr-core yourself.
- **No `/adopt`**: botmux does not scan terminals in hc. To adopt an existing external session, use tmux / Herdr / Zellij.
- **No tmux copy mode**: scrolling in the Web Terminal comes from the browser's own scrollback; when a worker reattaches it restores up to about 3000 lines of history.
- **Terminal size between workers**: while no worker is attached (for example during the few seconds of a daemon restart), the terminal stays at 160×50 instead of being resized.
- **Strict process environment, `launchShell`, and removing session environment variables** all take effect in the terminal's launch script, the same as with tmux.

## 7. Pending upstream fixes

botmux works around the following; once they are fixed upstream the workarounds can go:

- An observer attaching or detaching resets the terminal size to the core's default ([herdrdev/herdr-core#199](https://github.com/herdrdev/herdr-core/pull/199)).
- A core with a different state directory unconditionally removes an existing socket before binding, taking over from the core that is serving it ([herdrdev/herdr-core#200](https://github.com/herdrdev/herdr-core/pull/200)). botmux therefore pins the state directory next to the socket.
- Attaching with history adds one extra blank line where the history meets the screen.
- Features still under discussion upstream: turning off "start a core when none answers", removing environment variables when creating a terminal, and an input client that does not take over the size.

## 8. Troubleshooting

| Symptom | Check first |
|---|---|
| New sessions fail with herdr-core unavailable | As the daemon's user, run `~/.botmux/bin/herdr-core --version` (or wherever you put it) and confirm it prints `hc 0.1.19` or newer; when `BOTMUX_HC_BIN` is set, only that path is used |
| The core is reported older than 0.1.19 | See "Upgrading herdr-core" above |
| The runtime directory is missing or the socket path is too long | Check `XDG_RUNTIME_DIR` in the daemon's environment: the directory must exist and the path must be short enough |
| `botmux list` says the terminal has ended or no longer exists | Send the session a message in Feishu; it resumes the previous conversation, and you can attach after that |
| Your own `hc ls` doesn't show `bmx-*` terminals | Expected: they live in botmux's private core, not in your `default` core |

## For contributors

The default unit tests don't need herdr-core. Cases that start a real hc need a 0.1.19+ binary in `BOTMUX_HC_TEST_BIN` and are skipped without one; they all run in a private temporary `XDG_RUNTIME_DIR` and never reach the real sockets under `/run/user/<uid>`.
