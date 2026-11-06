# Prerequisites

Before installing botmux, take a minute to check the items below. Most "installed but won't connect" or "sessions won't start" problems come from something missing here: the CLI isn't logged in, tmux isn't installed, or a command isn't on PATH.

- **Read this if**: you'll run the botmux daemon (the background process) on your own machine (dev machine / devbox / server).
- **Skip this if**: you only @ a bot in a group someone else already set up. You don't need to install anything locally.

## Checklist

| What you need | Required? | How to check |
|---|---|---|
| Linux or macOS (x64 / arm64) | Yes | `uname -sm` |
| At least one AI coding CLI, installed and logged in | Yes | Run it in a terminal (e.g. `claude`) and confirm you can chat |
| tmux | Yes, by default | `tmux -V` |
| A Feishu / Lark account | Yes | Used to scan the QR code that creates your bot |
| Node ≥ 22 | Only for npm installs | `node -v` |

## Operating system

- **Linux and macOS** are supported, on both x64 and arm64. On musl systems such as Alpine, the installer picks the musl build automatically.
- On a Mac you can also use the [macOS desktop app](/en/desktop). It bundles its own runtime and starts with a double-click.
- **Windows**: the daemon only runs on Unix-like systems. Install it inside **WSL2**.

## botmux itself: no Node needed

The default [curl install](/en/quickstart) gives you a self-contained single-file program with its runtime bundled in. Installing and running it don't need Node.

You only need Node (≥ 22) in two cases:

- You install with `npm i -g botmux`. That's npm's own requirement; once running, it behaves exactly like the curl install.
- You develop plugins. Commands like `botmux plugin init` call npm.

## AI coding CLI: at least one, working on its own first

botmux is just a bridge between Feishu and the CLI. **It doesn't log in to the CLI for you.** So:

1. Install the CLI you want, such as `claude` (Claude Code), `codex`, `cursor-agent` (Cursor), `opencode`, `traex` (TRAE CLI 2.0), `agy` (Antigravity), `hermes`, and so on. The full list is in [CLI Adapters](/en/adapters).
2. Make sure its command is on `PATH` (typing its name in a terminal finds it).
3. **Run it once by hand in a terminal and confirm it can chat**, then connect it to botmux.

> Note: "botmux needs no Node" is about botmux itself. Many CLIs (like `claude` and `codex`) are npm packages and still need Node to install. Follow each CLI's own install guide.

## tmux: the default session backend

A "session backend" is how botmux hosts the CLI process. The default is tmux. Its benefit is that CLI sessions stay alive and botmux can reattach to them after a daemon restart (see [tmux Session Persistence](/en/tmux)).

- **Automatic install**: when you run `botmux start` / `botmux restart` and tmux is missing, botmux first tries to install it for you (trying brew, conda, then the system package manager; it only asks for a sudo password when there's an interactive terminal). If that fails, it prints a manual install command.
- **If it can't be installed**: when tmux is truly missing and your bots use the tmux backend, `botmux start` refuses to start and tells you to install it. When tmux is installed but doesn't work, the session is blocked and a card in Feishu tells you why. **botmux never silently switches to another backend.**
- **Version**: the tmux 3.x shipped with common distros is fine.

Don't want tmux? Pick another backend explicitly: globally with the `BACKEND_TYPE` environment variable, or per bot with `backendType` in bots.json:

| Backend | Notes |
|---|---|
| `pty` | No extra software, but sessions don't survive a daemon restart |
| `herdr` | Needs herdr; botmux can install it for you |
| `zellij` | You install zellij yourself |
| `zmx` | You install zmx (≥ 0.7.0) yourself, see [ZMX Session Backend](/en/zmx) |

## Where to deploy

We recommend an **always-on dev machine / devbox** rather than a laptop. The daemon stays online, sessions stay alive, and you can control things from your phone anytime. After installing, run `botmux autostart enable` so botmux comes back up on its own after the machine reboots.

## Common problems

| Symptom | Cause and fix |
|---|---|
| `botmux: command not found` right after installing | The installer already added `~/.botmux/bin` to your shell startup file, but you need to **open a new terminal** for it to take effect. Still missing? See [Common Pitfalls](/en/pitfalls) |
| npm install fails and `node -v` is below 22 | Upgrade to Node 22+ with nvm / fnm, or switch to the curl install and skip Node entirely |
| Sessions won't start, or the first message gets no reply | Usually the CLI isn't on PATH or isn't logged in. Get the CLI working by hand first, then see the [FAQ](/en/faq) |
| The CLI works in your terminal but botmux can't find it | botmux looks the command up through your login shell, but a CLI installed somewhere unusual can still be missed. Set `cliPathOverride` in bots.json to the CLI's absolute path, see [CLI Adapters](/en/adapters) |
| `botmux start` says tmux is missing | Install tmux with the suggested command, or switch to another backend from the table above |

**Next**: once everything is ready, go to the [5-Minute Quickstart](/en/quickstart).
