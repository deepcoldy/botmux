# ZMX Session Backend

[ZMX](https://github.com/neurosnap/zmx) is a lightweight terminal session manager. With ZMX as the botmux session backend, the CLI runs inside a ZMX session process: it survives daemon restarts, and you can `zmx attach` from a local terminal at any time to keep working with the full terminal UI.

First, check whether it fits:

| You want | Use ZMX? |
|---|---|
| A long-lived CLI that survives daemon restarts, plus native local takeover | Yes |
| botmux's in-browser Web Terminal | No, use [tmux](/en/tmux) |
| `/adopt` an existing terminal session | No, use tmux / Herdr / Zellij |
| A file sandbox (`sandbox`) | No, use tmux / PTY |
| Run `codex-app`, `mira`, `mir`, or `dsh` | No, use tmux / PTY |

ZMX is **explicit opt-in**: botmux does not install it, and finding `zmx` on `PATH` never makes botmux pick it automatically.

## 1. Install ZMX

You need **zmx 0.7.0 or newer**. ZMX officially supports macOS and Linux.

```bash
# Homebrew (macOS / Linuxbrew)
brew install neurosnap/tap/zmx

# or mise
mise use -g github:neurosnap/zmx@latest
```

On other hosts, download the binary for your architecture from the [official ZMX install instructions](https://github.com/neurosnap/zmx#install).

Then check it **as the same system user that runs the botmux daemon**:

```bash
zmx version   # must be >= 0.7.0
zmx list      # listing works (even if empty) = the control channel is usable
```

Why 0.7.0: from that release on, `zmx send` only queues input into the session. It no longer takes over the terminal's "leader" (the client that decides terminal size) or changes the terminal size. Older versions scramble the screen botmux reads. See upstream [issue #201](https://github.com/neurosnap/zmx/issues/201).

:::warning Recreate old sessions after upgrading from 0.6
Replacing the `zmx` binary on disk does not replace session processes that are already running. After upgrading to 0.7.0+, manually stop and recreate every session started under 0.6, then restart botmux. botmux does not migrate them for you, and `botmux restart` alone is not enough.

The typical symptom if you skip this: `zmx send` reports success, but the CLI never receives the input (a 0.6 session process silently drops 0.7's new message type).
:::

## 2. Enable ZMX

**For a single bot (recommended)**, pick either way:

- Dashboard → **Bot Config** → set that bot's **Backend type** to `zmx`. It applies to new sessions; running sessions keep the backend they started with.
- Add `backendType` to that bot in `~/.botmux/bots.json`:

  ```json
  {
    "name": "codex-zmx",
    "cliId": "codex",
    "backendType": "zmx"
  }
  ```

  Then run `botmux restart`.

**As the default for the whole deployment**: set this in `~/.botmux/.env`, then `botmux restart`.

```bash
BACKEND_TYPE=zmx
```

A per-bot `backendType` takes priority over this global default.

Before every new ZMX session, botmux checks that `zmx` runs, the version is high enough, and `zmx list` works. If any check fails, it refuses to start and tells you why in the topic, with install commands. It **never silently switches to another backend**.

## 3. Enter the same session locally

```bash
botmux list
```

The list shows the actual backend of each session. Select a ZMX session and press Enter to attach to its ZMX session. If that session no longer exists, the command refuses instead of opening an empty shell that pretends to be the original CLI.

When the daemon runs on **macOS**, you can also open it from the Lark card:

1. Dashboard → **Global Settings** → turn on **Enable native CLI opening** (off by default).
2. Keep **Native CLI open mode** on **Attach current session (recommended)**.
3. Cards then show a "💻 Open …" button (for example "💻 Open Claude Code"). Clicking it attaches iTerm2 / Terminal to the same ZMX session instead of starting a second CLI. Only people with operate permission can use it.

Once you attach locally, you are the session's leader: your terminal decides the size and the fullscreen UI. Messages you keep sending from Lark do not take that away.

## 4. Session lifecycle

Each session maps to a ZMX session with a fixed name: `bmx-<first 8 chars of the session ID>`.

| What happens | The CLI | What botmux does |
|---|---|---|
| `botmux restart` | Keeps running | Reconnects in batches without restarting the CLI |
| ZMX session is gone at restore time (e.g. host reboot) | Has exited | Keeps the session record instead of cleaning it up; the next message starts it again, continuing the earlier conversation |
| Worker or output watcher disconnects | Keeps running | Reconnects after confirming the ZMX session is still there |
| `/close` or the close button | Is stopped | Force-stops the ZMX session too, so no unmanaged process is left behind |

The ZMX socket directory (the local directory ZMX uses to communicate) is recorded when the session is first created. Even if the daemon's environment changes later (for example a different `XDG_RUNTIME_DIR`), botmux still looks in the original directory and does not mistake a live session for a missing one.

## 5. Limits compared with tmux

The ZMX lifecycle is close to tmux, but what botmux gets from ZMX is a **plain-text screen**, not a full terminal picture:

- **No color, cursor, or fullscreen UI**: botmux reads the current screen as plain text through `zmx history`, and that text is what you see in Lark. For the raw colored UI, `zmx attach` locally.
- **No Web Terminal**: session cards do not offer botmux's browser terminal.
- **Fixed terminal size**: without a local attach, botmux-managed sessions run at a fixed **120×24**, the CLI wraps at 120 columns, and that is the width you see in Lark. botmux cannot change it; for a different size, `zmx attach` locally and let your terminal decide.
- **At most 64 KiB per input**: ZMX gives no delivery acknowledgement for input, so botmux sends small chunks and rejects any single input over 64 KiB before sending. When the result is uncertain, it does not resend automatically, so the same content is never submitted twice.
- **Limited history**: botmux can only read the scrollback ZMX still keeps; older output gets pushed out. It is not a full recording, and output from the instant before the CLI exits may be missed. That is why Workflow's raw terminal replay is less complete on ZMX than on tmux.
- **Slight screen delay**: botmux reads as soon as output changes. Even without a change signal (for example, pure Chinese output), it re-reads on a timer, at most about 1.5 seconds apart. It also forces one more read before each turn ends so the final reply is complete.

## 6. Unsupported combinations

For these combinations botmux refuses at startup and tells you in the topic what to change:

- **`/adopt`**: ZMX sessions cannot be scanned or adopted. To adopt an existing external session, use tmux / Herdr / Zellij.
- **`codex-app`, `mira`, `mir`, `dsh`**: these CLIs tell botmux "this turn is done" through hidden terminal control sequences, which are lost in a plain-text screen. Use tmux / PTY for them.
- **File sandbox**: the CLI inside a ZMX session is not started directly by botmux, so botmux cannot wrap it in its file sandbox. Any time `backendType: "zmx"` meets `sandbox: true`, global `BOTMUX_SANDBOX=1`, or the legacy `readIsolation: true`, startup is refused on every platform. If you need isolation, switch to tmux / PTY; otherwise turn the sandbox setting off. See [File sandbox](/en/sandbox).
- **Antigravity zero-injection mode**: Antigravity cannot use `promptInjection: "none"` on ZMX. See the "Zero prompt injection" section in [bots.json configuration](/en/bots-json).

## 7. Troubleshooting

| Symptom | Check first |
|---|---|
| New sessions fail, saying zmx is unavailable | As the daemon's user, run `zmx version` and `zmx list`: version ≥ 0.7.0, `zmx` on `PATH`, socket directory writable |
| `zmx send` succeeds, but the CLI gets nothing | Most likely an old 0.6 session is still running; stop and recreate it (see the upgrade note above) |
| Local `zmx attach` cannot find a `bmx-*` session | If you set `ZMX_DIR`, make sure the daemon and your local shell use the same value; or just enter through `botmux list`, which uses the directory recorded for the session |
| A session is stuck or won't start for no clear reason | Check `botmux logs`. When a probe is inconclusive, botmux would rather refuse than start a duplicate CLI or delete a session that is still alive |

Two more notes:

- botmux keeps the `ZMX_DIR` you set, but clears inherited `ZMX_SESSION` / `ZMX_SESSION_PREFIX` so sessions cannot nest inside ZMX and a name prefix cannot rewrite `bmx-*`.
- The Dashboard session query endpoints report the ZMX backend and session name, but that does not mean the session is alive. See [Read-only query endpoints](/en/dashboard#read-only-query-endpoints).

## For contributors

The default `bun run test` runs only mocked and pure unit tests, so you **don't need ZMX installed**. Tests that launch a real `zmx` live in `*.e2e.ts`, run only when E2E is requested explicitly, and skip automatically when ZMX is missing, the same as the tmux / Herdr E2E suites.
