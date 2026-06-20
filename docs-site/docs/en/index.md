# botmux

<p class="lead">Turn a Lark topic group into a remote control for AI coding CLIs. One message launches a dedicated coding session.</p>

botmux is a bridge: a persistent **daemon** listens to Lark messages and automatically launches a dedicated AI coding CLI process (Claude Code / Codex / Cursor / Gemini / OpenCode / Antigravity, etc.) for each new topic. It renders terminal output into Lark **streaming cards** in real time, and provides an interactive **Web Terminal**. Phone, computer, and Lark stay in sync — wherever you are, your coding session follows.

> Project: <https://github.com/deepcoldy/botmux> ｜ npm: `npm install -g botmux`

## Design philosophy: not an SDK wrapper — bridge the CLI directly

botmux **does not reimplement** agent capabilities; it bridges directly to existing AI coding CLIs. Memory, context management, tool calls, permission systems, plan mode, `/` commands, the MCP ecosystem — these are all capabilities the CLIs themselves are iterating on rapidly. botmux chooses to **stand on top of that evolution** rather than rebuild a parallel copy. Every time a CLI ships an upgrade, botmux benefits automatically with zero adaptation.

At the same time, botmux uses **structured prompt injection** (XML tags) inside the daemon to separate user content from system instructions before feeding it to the CLI — this is the prompt format that models reliably handle best. But everyday users neither need to nor should hand-write XML; just send plain language as usual, and botmux handles the wrapping for you.

## Core advantages

Compared to approaches like OpenClaw that are "rebuilt on top of an Agent SDK":

| Feature | botmux | SDK-based approach |
|------|--------|----------------|
| Underlying architecture | Bridges directly to the **full CLI process** | Rebuilt on top of an Agent SDK |
| CLI capabilities | Full runtime (hooks / memory / plan mode / Skill / `/` commands / MCP) | A subset of the SDK API; missing features must be added manually |
| CLI upgrades | Benefit automatically with zero adaptation | Must track SDK version changes |
| Memory / context | Reuses the CLI's built-in memory directly, enhanced as the CLI iterates | Must build your own, duplicating the CLI's native capabilities |
| Multiple CLIs | One-click switching among 6+ | Bound to a single SDK |
| Web Terminal | Fully interactive terminal, synced across three surfaces | Usually read-only output |
| Multi-bot collaboration | Multiple bots in one group with @mention routing, process isolation | Usually a single bot |
| Direct terminal access | `tmux attach` into the process, identical to local | Cannot operate the underlying terminal |

## Highlights

- **Streaming cards** — One live-updating Lark card per conversation turn, with terminal output rendered as Markdown
- **Interactive Web Terminal** — Not just viewing: operate the CLI directly in the browser; mobile has a floating shortcut toolbar
- **Multi-bot collaboration** — Put multiple bots with different CLIs in one group, @ whoever you want to work, and have Claude Code and Codex review code together
- **Persistent tmux sessions** — Restarting the daemon doesn't interrupt CLI processes
- **Session adopt** — Adopt a CLI running in a local tmux into Lark with one click, and continue on another device
- **Scheduled tasks** — Configure recurring tasks in natural language; they resume in the original topic when due
- **On-Call Mode** — Anchor a group to a project so anyone in the on-call group can @ for instant answers

➡️ Next: [5-minute quick setup](/en/quickstart)
