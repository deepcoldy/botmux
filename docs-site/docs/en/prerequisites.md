# Prerequisites

Before installing botmux, make sure these are in place — **many "installed but won't connect / sessions won't start" issues trace back to a missing prerequisite here** (Node version, CLI not logged in, not on PATH).

**Applies to**: any machine that will run the botmux daemon (dev machine / devbox / server).
**Doesn't apply**: if you only @ a bot in a group someone else already set up — you don't need to install anything locally.

## Runtime environment

- **Node.js ≥ 22** (`node -v` to check; below 22 causes native-module / syntax errors).
- **AI coding CLI / local agent app**: at least one **installed and authenticated**, with the executable on your `PATH`:
  - `claude` (Claude Code), `codex`, `cursor-agent` (Cursor), `gemini`, `opencode`, `coco` (Trae / CoCo), `agy` (Antigravity), `hermes`, etc. (full `cliId` list in [CLI Adapters](/en/adapters)).
  - ⚠️ botmux is only a bridge — it doesn't manage login. **Run the CLI once in a terminal to confirm it can chat** before wiring it into botmux.
- **tmux ≥ 3.x** (**the default backend — strongly recommended to install**): **in the default configuration** the session backend is tmux, so you need it to start sessions — when tmux isn't available botmux **no longer silently downgrades to pty**; it hard-gates the session and posts a card asking you to install tmux (see [tmux Session Persistence](/en/tmux)). To run a tmux-free environment, pick an explicit backend: `BACKEND_TYPE=pty` / per-bot `backendType` (`pty`/`herdr`/`zellij`) — pty doesn't survive daemon restarts; herdr/zellij need their own binaries. (riff is a cloud agent and doesn't occupy a local backend.)

## Recommended deployment

Deploy on an **always-on dev machine / devbox** (rather than a laptop), so the daemon stays online long-term, tmux sessions persist, and you can remote-control from your phone anytime. Pair it with `botmux autostart enable` for automatic recovery across restarts.

## Common failures

- `node -v` < 22 → upgrade Node (install 22+ via nvm / fnm; make sure the botmux shell's startup file picks it up).
- CLI not on PATH / not logged in → sessions won't start or the first message gets no response; get the CLI working manually first, then see [FAQ · session won't start](/en/faq).
- CLI installed but botmux can't find it → PATH not effective in a non-interactive shell, see [Common Pitfalls](/en/pitfalls).

**Next**: once the environment is ready, go to the [5-Minute Quickstart](/en/quickstart).
