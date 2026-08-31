# Prerequisites

Before installing botmux, make sure these are in place — **many "installed but won't connect / sessions won't start" issues trace back to a missing prerequisite here** (CLI not logged in, tmux missing, not on PATH).

**Applies to**: any machine that will run the botmux daemon (dev machine / devbox / server).
**Doesn't apply**: if you only @ a bot in a group someone else already set up — you don't need to install anything locally.

## Runtime environment

- **botmux itself: no Node required.** The default [curl install](/en/quickstart) delivers a self-contained single-file binary with its runtime embedded. **Node ≥ 22 is required only on the npm install path** — that's a requirement of running `npm i -g`, not of running botmux. (Plugin-development commands like `botmux plugin init` shell out to npm and need Node too.)
- **AI coding CLI / local agent app**: at least one **installed and authenticated**, with the executable on your `PATH`:
  - `claude` (Claude Code), `codex`, `cursor-agent` (Cursor), `gemini`, `opencode`, `coco` (Trae / CoCo), `agy` (Antigravity), `hermes`, etc. (full `cliId` list in [CLI Adapters](/en/adapters)).
  - ⚠️ botmux is only a bridge — it doesn't manage login. **Run the CLI once in a terminal to confirm it can chat** before wiring it into botmux.
  - ⚠️ Those CLIs have their own runtime requirements: many ship as npm packages (`claude` / `codex` / `gemini`, …) and still need Node to install. "botmux needs no Node" is about botmux itself.
- **tmux ≥ 3.x** (**the default backend — strongly recommended to install**): **in the default configuration** the session backend is tmux, so you need it to start sessions — when tmux isn't available botmux **no longer silently downgrades to pty**; it hard-gates the session and posts a card asking you to install tmux (see [tmux Session Persistence](/en/tmux)). To run a tmux-free environment, pick an explicit backend: `BACKEND_TYPE=pty` / per-bot `backendType` (`pty`/`herdr`/`zellij`) — pty doesn't survive daemon restarts; herdr/zellij need their own binaries. (riff is a cloud agent and doesn't occupy a local backend.)

## Recommended deployment

Deploy on an **always-on dev machine / devbox** (rather than a laptop), so the daemon stays online long-term, tmux sessions persist, and you can remote-control from your phone anytime. Pair it with `botmux autostart enable` for automatic recovery across restarts.

## Common failures

- `botmux: command not found` right after installing → `~/.botmux/bin` isn't on PATH yet. The installer writes your shell's startup file, but **you need a new terminal for it to take effect**; if it's still missing, see [Common Pitfalls](/en/pitfalls).
- Installing via npm with `node -v` < 22 → upgrade Node (22+ via nvm / fnm), or switch to the curl install and skip Node entirely.
- CLI not on PATH / not logged in → sessions won't start or the first message gets no response; get the CLI working manually first, then see [FAQ · session won't start](/en/faq).
- CLI installed but botmux can't find it → PATH not effective in a non-interactive shell, see [Common Pitfalls](/en/pitfalls).

**Next**: once the environment is ready, go to the [5-Minute Quickstart](/en/quickstart).
