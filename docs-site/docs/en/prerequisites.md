# Prerequisites

## Runtime environment

- **Node.js ≥ 22**
- **AI coding CLI / local agent app**: at least one installed and authenticated, with the executable on your `PATH`:
  - `claude` (Claude Code), `codex`, `cursor-agent` (Cursor), `gemini`, `opencode`, `coco` (Trae / CoCo), `agy` (Antigravity), `hermes`, etc.
- **tmux ≥ 3.x** (optional): once installed, session persistence is enabled automatically. You can also install Herdr and set `backendType: "herdr"` explicitly in a bot config.

## Recommended deployment

We recommend deploying on an **always-on dev machine** (rather than a laptop), so the daemon stays online long-term, persistent sessions survive, and you can remote-control from your phone anytime. Pair it with `botmux autostart enable` for automatic recovery across restarts.
