# ZMX Session Backend

[ZMX](https://github.com/neurosnap/zmx) is an optional persistent-session backend for botmux. It is intended for macOS and Linux hosts that want native terminal features while only needing attach/detach and session persistence.

ZMX is an **explicit opt-in** backend. botmux does not install ZMX, and merely finding it on `PATH` never makes botmux select it automatically.

## Install and probe

botmux requires **zmx >= 0.6.0**. ZMX officially supports macOS and Linux.

```bash
# Homebrew (macOS / Linuxbrew)
brew install neurosnap/tap/zmx

# Verify the daemon user's PATH and control plane
zmx version
zmx list
```

On other hosts, download the prebuilt binary for your architecture from the [official ZMX installation instructions](https://github.com/neurosnap/zmx#install), then put `zmx` on the `PATH` of the same system user that runs the botmux daemon.

Before creating a new ZMX-backed session, botmux checks the executable, version, and `zmx list` control plane. Any failure **fails closed** with an actionable session error; botmux never silently falls back to PTY.

For contributors, the default `pnpm test` command runs mocked/pure unit tests and **does not require ZMX to be installed**. Coverage that launches a real `zmx` binary lives in `*.e2e.ts`, runs only when E2E is requested explicitly, and skips automatically when ZMX is unavailable—the same pattern already used by the tmux and Herdr E2E suites.

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

botmux assigns each managed session the deterministic name `bmx-<first 8 chars of sessionId>`. The worker runs one real `zmx attach` client inside node-pty. This single bidirectional path carries raw ANSI output, keyboard input, paste, and resize; it does not split transport across `zmx tail` and `zmx send`. On reconnect, ZMX's terminal snapshot is restored over that same attach path.

| Event | ZMX session / CLI | botmux behavior |
|------|-------------------|-----------------|
| `botmux restart` | Stays alive | Rebuilds workers in staggered batches and attaches to the original session without restarting the CLI |
| Backing session is missing during restore | Original process is gone | Retains the active/transcript record instead of destroying it as a zombie; lazily resumes on the next message |
| Worker / attach client disconnects | Stays alive | Reconnects after confirming that the ZMX session still exists |
| `/close` or close button | Destroyed / terminated | Force-kills the backing session instead of leaving an unmanaged process behind |

## Enter the same session locally

```bash
botmux list
```

`botmux list` shows the effective backend for every session. Select a ZMX row and press Enter to attach safely to its existing `bmx-*` session. If the backing session has disappeared, the command refuses to create an empty shell that could masquerade as the original CLI.

When the daemon runs on macOS, you can also explicitly enable **Native CLI opening** under Dashboard Settings and keep **Attach current session** mode selected. The Lark card's **Open CLI** button will then attach iTerm2 / Terminal to the same ZMX session instead of starting a second CLI. This feature is off by default and requires operate permission.

## Unsupported combinations

- **Adopt**: ZMX is not scanned or accepted as a `/adopt` source. Use the supported tmux / Herdr / Zellij path when adopting an existing external session.
- **File sandbox and read isolation**: the child PTY belongs to the ZMX session daemon, so botmux cannot currently apply its bwrap / Seatbelt filesystem boundary. Combining `backendType: "zmx"` with `sandbox: true`, global `BOTMUX_SANDBOX=1`, or the standalone effective `readIsolation: true` mode on macOS therefore **fails closed**; the worker posts an actionable session notification before refusing to start. On Linux, the bare legacy `readIsolation` flag is a no-op under the unified worker semantics: it neither provides isolation nor incorrectly gates ZMX. When isolation is required, enable the sandbox and switch to tmux / PTY; otherwise explicitly disable the corresponding isolation setting.

## Troubleshooting

1. Run `zmx version` and `zmx list` as the same user that runs the daemon to verify the version, `PATH`, and socket directory.
2. If you set `ZMX_DIR`, make sure the daemon and the shell used for local attach share the same value. botmux preserves `ZMX_DIR`, but strips inherited `ZMX_SESSION` / `ZMX_SESSION_PREFIX` so nested sessions and prefixes cannot rewrite the deterministic `bmx-*` target.
3. Inspect `botmux logs`. When a probe is inconclusive, botmux conservatively refuses to start/recreate a session so it cannot launch a duplicate CLI or delete a still-live one.

Dashboard session queries can report the ZMX backend and deterministic session name, but those fields are not liveness checks. See [Dashboard external read-only queries and security boundary](/en/dashboard#external-read-only-queries).
