# Prerequisites

## Runtime environment

- **Node.js ≥ 22**
- **AI coding CLI / local agent app**: at least one installed and authenticated, with the executable on your `PATH`:
  - `claude` (Claude Code), `codex`, `cursor-agent` (Cursor), `gemini`, `opencode`, `coco` (Trae / CoCo), `agy` (Antigravity), `hermes`, etc.
- **tmux ≥ 3.x** (optional): once installed, session persistence is enabled automatically — restarting the daemon doesn't interrupt the CLI.
- **zmx ≥ 0.6.0** (optional, macOS / Linux): a lightweight persistent-session backend selected explicitly with `backendType: "zmx"` or `BACKEND_TYPE=zmx`. botmux never installs or selects it automatically; use `brew install neurosnap/tap/zmx` with Homebrew, or see the [ZMX backend](/en/zmx) for other installation options.

## Recommended deployment

We recommend deploying on an **always-on dev machine** (rather than a laptop), so the daemon stays online long-term, tmux sessions persist, and you can remote-control from your phone anytime. Pair it with `botmux autostart enable` for automatic recovery across restarts.
