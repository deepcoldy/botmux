# ZMX Session Backend

[ZMX](https://github.com/neurosnap/zmx) is an optional persistent-session backend for botmux. It is intended for macOS and Linux hosts that want a lightweight session daemon to keep the CLI alive, with a native local attach available whenever the complete terminal experience is needed.

ZMX is an **explicit opt-in** backend. botmux does not install ZMX, and merely finding it on `PATH` never makes botmux select it automatically.

## Install and probe

botmux requires **zmx >= 0.7.0**. That floor is the fix for upstream [issue #201](https://github.com/neurosnap/zmx/issues/201) — commit [`8ba312d7` *fix(send): preserve client leadership*](https://github.com/neurosnap/zmx/commit/8ba312d7), shipped in [v0.7.0](https://github.com/neurosnap/zmx/releases/tag/v0.7.0) (2026-07-23): `zmx send` now uses a dedicated `.Send` IPC tag that only queues input into the PTY buffer, without claiming the leader or rewriting terminal size. ZMX officially supports macOS and Linux.

```bash
# Homebrew (macOS / Linuxbrew)
brew install neurosnap/tap/zmx

# or mise
mise use -g github:neurosnap/zmx@latest

# Verify the daemon user's PATH and control plane
zmx version
zmx list
```

On other hosts, download the prebuilt binary for your architecture from the [official ZMX installation instructions](https://github.com/neurosnap/zmx#install), then put `zmx` on the `PATH` of the same system user that runs the botmux daemon.

Before creating a new ZMX-backed session, botmux checks the executable, version, and `zmx list` control plane. Any failure **fails closed** with an actionable session error; botmux never silently falls back to PTY.

> **⚠️ Upgrading from 0.6**: replacing the `zmx` binary on disk does not replace per-session daemons that are already running; after upgrading to 0.7.0+, manually stop and recreate every session launched by 0.6, then restart botmux. botmux performs **no automatic cold migration**, and `botmux restart` alone is insufficient. ZMX's IPC `Tag` enum is non-exhaustive (unknown tags fall through the `_` arm and are ignored), so a 0.6 daemon **discards** the new `.Send` tag outright while `zmx send` still exits 0 — the command reports success and the input never arrives.

For contributors, the default `bun run test` command runs mocked/pure unit tests and **does not require ZMX to be installed**. Coverage that launches a real `zmx` binary lives in `*.e2e.ts`, runs only when E2E is requested explicitly, and skips automatically when ZMX is unavailable—the same pattern already used by the tmux and Herdr E2E suites.

## Enable ZMX

Prefer enabling it only for the bots that need it in `~/.botmux/bots.json`:

```json
{
  "name": "codex-zmx",
  "cliId": "codex",
  "backendType": "zmx"
}
```

To make ZMX the deployment-wide default backend, set this in `~/.botmux/.env` instead:

```bash
BACKEND_TYPE=zmx
```

Run `botmux restart` after editing. A per-bot `backendType` overrides the deployment default.

## Runtime model

botmux assigns each managed session the deterministic name `bmx-<first 8 chars of sessionId>`. The ZMX daemon owns the CLI's PTY. Instead of keeping a fake attach leader alive, botmux uses three leaderless interfaces:

- `zmx tail` is used only as a low-latency change/liveness signal. botmux drains stdout but never gives its payload bytes to the worker: the current upstream `zmx tail` ANSI filter deletes multi-byte UTF-8, so Chinese and emoji cannot rely on this stream.
- `zmx send` queues raw input bytes into the PTY without attaching, changing the leader, or resizing it.
- `zmx history` is the sole authoritative plain-text screen source. Tail/send wake asynchronous capture immediately; a staggered 250ms hot poll and at-most roughly 1.5s cold safety poll also catches pure Unicode that produces no tail event. Before idle completion, botmux forces one post-call capture (bounded retries, then the last successful snapshot).

A new session briefly uses one non-interactive client for creation only; output and input then use the interfaces above. A local `zmx attach` can therefore become the real leader and let the local terminal control size and the full TUI. Input sent from Lark through botmux does not steal that leadership.

| Event | ZMX session / CLI | botmux behavior |
|------|-------------------|-----------------|
| `botmux restart` | Stays alive | Rebuilds workers and `tail` observers in staggered batches without restarting the CLI |
| Backing session is missing during restore | Original process is gone | Retains the active/transcript record instead of destroying it as a zombie; lazily resumes on the next message |
| Worker / `tail` observer disconnects | Stays alive | Rebuilds the observer after confirming that the ZMX session still exists |
| `/close` or close button | Destroyed / terminated | Force-kills the backing session instead of leaving an unmanaged process behind |

## Display, input, and terminal-size boundary

This integration deliberately uses eventually consistent plain-text screen semantics. Its persistent-session lifecycle is close to tmux, but it is not a complete terminal mirror:

- ZMX exposes an **eventually consistent plain-text screen** from `history`; it does not preserve color, cursor state, OSC, or the alternate screen. Capture is single-flight per session and a dirty latch forces one follow-up when activity arrives during a capture.
- The ZMX backend does not provide botmux's interactive Web TUI or resize the backing PTY. Use local `zmx attach` when you need raw ANSI, a fullscreen TUI, or terminal-size negotiation.
- A local attach leader controls terminal size. Without one, the ZMX session keeps its existing size; botmux's `send` does not change it. ZMX exposes no leaderless resize primitive, so botmux's `resize()` is a deliberate no-op. botmux creates sessions from a non-TTY client, which lands on ZMX's `getTerminalSize` fallback, so **managed sessions run at a fixed 120×24** and the CLI wraps its TUI at 120 columns — the width you see in Lark. Use a local `zmx attach` to take leadership if you need a different size.
- Upstream `send` currently provides no delivery ACK or backpressure. botmux sends 1 KiB chunks and rejects any single backend input over 64 KiB before writing a prefix. It never retries an ambiguous result automatically because the input may already be queued and a retry could duplicate it; the backend reports failure to its caller instead of hiding a retry internally.
- `zmx history` can restore only the bounded scrollback still retained by ZMX / ghostty; older output is evicted once the upstream scrollback budget is exceeded. It reconstructs the eventually consistent observable state rather than a lossless transcript or terminal recording; transient output after the daemon has exited cannot be recovered. Workflow raw PTY replay logs therefore do not have tmux's lossless semantics.

## Enter the same session locally

```bash
botmux list
```

`botmux list` shows the effective backend for every session. Select a ZMX row and press Enter to attach safely to its existing `bmx-*` session. If the backing session has disappeared, the command refuses to create an empty shell that could masquerade as the original CLI.

When the daemon runs on macOS, you can also explicitly enable **Native CLI opening** under Dashboard Settings and keep **Attach current session** mode selected. The Lark card's **Open CLI** button will then attach iTerm2 / Terminal to the same ZMX session instead of starting a second CLI. This feature is off by default and requires operate permission.

## Unsupported combinations

- **Adopt**: ZMX is not scanned or accepted as a `/adopt` source. Use the supported tmux / Herdr / Zellij path when adopting an existing external session.
- **Runners that depend on hidden OSC completion events**: `codex-app`, `mira`, and `mir` lose their final/thread events in plain history, so these combinations fail closed at startup. Use tmux / PTY for those CLIs.
- **File sandbox and read isolation**: the child PTY belongs to the ZMX session daemon, so botmux cannot currently apply its bwrap / Seatbelt filesystem boundary. Combining `backendType: "zmx"` with `sandbox: true`, global `BOTMUX_SANDBOX=1`, or the legacy `readIsolation: true` flag therefore **fails closed on every platform**; config migration folds `readIsolation` into the unified sandbox request, and the worker gate enforces that same decision before startup. The worker posts an actionable session notification before refusing to start. When isolation is required, enable the sandbox and switch to tmux / PTY; otherwise explicitly disable the corresponding isolation setting.

## Troubleshooting

1. Run `zmx version` and `zmx list` as the same user that runs the daemon to verify version 0.7.0 or newer, `PATH`, and the socket directory.
2. After an upgrade from 0.6, manually stop and recreate old session daemons; botmux does not cold-migrate them automatically, and restarting botmux alone does not replace them. Check this first if `zmx send` succeeds but the CLI receives nothing.
3. If you set `ZMX_DIR`, make sure the daemon and the shell used for local attach share the same value. botmux preserves `ZMX_DIR`, but strips inherited `ZMX_SESSION` / `ZMX_SESSION_PREFIX` so nested sessions and prefixes cannot rewrite the deterministic `bmx-*` target.
4. Inspect `botmux logs`. When a probe is inconclusive, botmux conservatively refuses to start/recreate a session so it cannot launch a duplicate CLI or delete a still-live one.

Dashboard session queries can report the ZMX backend and deterministic session name, but those fields are not liveness checks. See [Dashboard external read-only queries and security boundary](/en/dashboard#external-read-only-queries).
