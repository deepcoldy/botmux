# botmux

<video src="../img/video-v0-overview-en.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

<p class="lead">Remote-control your AI coding CLI from Lark. One message starts a session, and every session gets its own CLI process.</p>

botmux is a bridge. It runs a background service (the **daemon**) on your dev machine that listens to Lark messages:

- Each new topic gets its own AI coding CLI (30+ supported, including Claude Code, Codex, Cursor, OpenCode, and Antigravity)
- Every turn of CLI output is streamed live into a Lark **streaming card**
- When you want to take over, a card button opens the **Web Terminal**, so you can drive the same CLI from a browser or phone

Whether you're on your phone, at your desk, or in a terminal, you're looking at the same session.

## 5-minute start

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
botmux setup     # scan a QR code to create the Lark app → pick a CLI → pick a working directory (permissions and release are configured for you)
botmux start     # start the daemon; run botmux autostart enable to start on boot
```

Then DM the bot, or open the management page with `botmux dashboard` and create a group to start chatting.

- What you install is a **self-contained single-file binary** that doesn't need Node on the machine. It supports Linux / macOS (x64 / arm64); on Windows, use WSL2
- Prefer npm? `npm i -g botmux` works too and ships the same binary
- On a Mac you can also install the [macOS Desktop App](/en/desktop) to start and stop the service, open the Dashboard, and read logs with a click
- To upgrade later: `botmux update`, or rerun the curl command above (releases older than v3.18.0: curl only), then `botmux restart`

For the full walkthrough (Lark international, manual permission setup, troubleshooting), see [Quick start](/en/quickstart).

## What problems it solves

| Your pain | What botmux does |
|---|---|
| The CLI runs on your dev machine, so you can't see or steer it when you're away | Each turn is pushed to a Lark card; check, follow up, or interrupt from your phone, and open the Web Terminal when you need hands-on control |
| The CLI has no idea what's happening in Lark | Add the bot to a group and @ it to start working in your local codebase; `/relay` moves a running session (same CLI process, same AI memory) to another group so you can keep going there |
| One agent isn't enough | Put several bots backed by different CLIs in one group and @ whoever should do the work, e.g. have Claude Code and Codex review the same change |

## Common features

| I want to... | See |
|---|---|
| Understand the live-updating card and its buttons | [Streaming cards](/en/cards) |
| Drive the CLI from a browser or phone | [Web Terminal](/en/web-terminal) |
| Have several bots in one group split the work | [Multi-bot collaboration](/en/multi-bot) |
| Split a big task into parallel topics | [Multi-topic orchestration](/en/multi-topic) |
| Pin a card in the group that tracks a project's goal, to-dos, and sub-tasks | [Project Progress Card](/en/project-card) |
| Hand dev tasks to a steward and collect everything you need to decide in one place | [Decision Board and Steward](/en/decision-board) |
| Bring a CLI already running in a local terminal into Lark | [Session adopt (/adopt)](/en/adopt) |
| Move a session to another group | [Session relay (/relay)](/en/relay) |
| Run tasks on a schedule (alert analysis, group digests, etc.) | [Scheduled tasks](/en/schedule) |
| Trigger tasks from an external system | [Webhook](/en/webhook) · [API task trigger](/en/api-task-trigger) |
| Run sessions from scripts or CI without a Lark group | [Headless Automation Sessions](/en/headless-session) |
| Ask the AI directly in Lark doc comments | [Doc comment watching](/en/doc-comment) |
| Let anyone in an on-call group @ the bot for answers | [On-Call Mode](/en/oncall) |
| Switch CLIs, or pick a CLI for one session | [CLI adapters](/en/adapters) |
| Manage bots, sessions, and config in a web UI | [Dashboard](/en/dashboard) · [Global Settings](/en/global-settings) |
| Watch several sessions' progress and terminals at once | [Agent Workbench](/en/workbench) |

More: [Roles & teams](/en/roles) · [File sandbox](/en/sandbox) · [Voice summary](/en/voice) · [Local whiteboard](/en/whiteboard) · [Persistent tmux sessions](/en/tmux) · [Feedback storage](/en/feedback-storage) · [Model Proxy (experimental)](/en/model-proxy) · [Slash commands](/en/slash-commands) · [CLI commands](/en/cli-commands) · [Architecture overview](/en/architecture) · [Best practices](/en/best-practices)

## Design philosophy: bridge the CLI, don't rebuild the agent

botmux **does not reimplement** agent capabilities. Memory, context management, tool calls, permissions, plan mode, `/` commands, and MCP are left to the CLI itself. When a CLI upgrades, most new capabilities just work in botmux (only when a CLI changes its flags, output format, or resume behavior does the matching adapter need an update).

Just write in plain language. The daemon wraps your message and the system instructions separately in a structured format (XML tags) before handing them to the CLI, so you never have to write any special format yourself.

Compared with approaches "rebuilt on top of an Agent SDK", the difference is mainly in how things are integrated:

| Aspect | botmux | Agent SDK-based approach |
|---|---|---|
| What gets bridged | The full CLI process, with its own hooks / memory / plan mode / MCP / `/` commands | Whatever the SDK exposes |
| CLI upgrades | Most capabilities benefit directly | Depends on the SDK version and your integration |
| Memory / context | Uses the CLI's built-in memory | Depends on the SDK or your own build |
| Multiple CLIs | 30+ adapters, switch with one config change | Depends on SDK coverage |
| Multiple bots | Several bots in one group, dispatched by @ | Depends on implementation |
| Direct terminal access | With the tmux backend, `tmux attach` into the real CLI process | Depends on implementation |

➡️ Next: [Quick start](/en/quickstart)

> Project: <https://github.com/deepcoldy/botmux>
