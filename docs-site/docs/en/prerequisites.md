# Prerequisites

## Runtime environment

- **Node.js ≥ 22**
- **AI coding CLI / local agent app**: at least one installed and authenticated, with the executable on your `PATH`:
  - `claude` (Claude Code), `codex`, `cursor-agent` (Cursor), `gemini`, `opencode`, `coco` (Trae / CoCo), `agy` (Antigravity), `hermes`, etc.
- **tmux ≥ 3.x** (optional): once installed, session persistence is enabled automatically — restarting the daemon doesn't interrupt the CLI.
- **zmx ≥ 0.7.1** (optional, macOS / Linux): enabled only through an explicit `backendType: "zmx"` or `BACKEND_TYPE=zmx`; 0.7.1 is treated as the first release assumed to contain the `send` behavior from [PR #202](https://github.com/neurosnap/zmx/pull/202), and the [ZMX backend guide](/en/zmx) covers installation and complete prerequisites.

## Recommended deployment

We recommend deploying on an **always-on dev machine** (rather than a laptop), so the daemon stays online long-term, tmux sessions persist, and you can remote-control from your phone anytime. Pair it with `botmux autostart enable` for automatic recovery across restarts.
