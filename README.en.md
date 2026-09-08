# botmux

<p align="center">
  <img src="cover.svg" alt="botmux" width="760">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/botmux"><img src="https://img.shields.io/npm/v/botmux.svg" alt="npm"></a>
  <img src="https://img.shields.io/badge/binary-no%20Node%20required-brightgreen.svg" alt="self-contained binary, no Node required">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
  <a href="https://github.com/deepcoldy/botmux"><img src="https://img.shields.io/github/stars/deepcoldy/botmux.svg?style=social" alt="Stars"></a>
</p>

<p align="center"><b>Drive your AI coding CLI from Lark (Feishu).</b> One message starts a session, each session runs its own isolated CLI process, streamed back in real time — synced across phone, desktop, and terminal.</p>

<p align="center">
  <a href="https://deepcoldy.github.io/botmux/en/"><b>📖 Docs</b></a> ·
  <a href="#5-minute-setup"><b>🚀 Quickstart</b></a> ·
  <a href="https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg"><b>✨ Showcase</b></a> ·
  <a href="README.md">中文</a>
</p>

<p align="center">
  <img src="docs/assets/botmux-product-panorama.png" width="1000" alt="botmux product panorama: Lark topics, live cards, web terminal, multi-agent orchestration, and 20+ CLI / agent adapters">
</p>

---

A daemon watches Lark messages and spawns an isolated session process for each new session, streaming the AI coding CLI / agent's output back as live Lark cards and offering an interactive web terminal. It **doesn't reimplement agent capabilities** — it bridges the tools you already use directly (**20+ CLI / agent adapters**, see [Supported CLIs & Agents](#supported-clis--agents)).

## What it solves

- **The agent can't reach you, and you can't drive it from your phone** — the CLI runs on a dev box, you're on your phone. botmux pushes every turn as a Lark card so you can view / follow up / interrupt anywhere, and open a writable web terminal to operate it directly.
- **The CLI is blind to your Lark context** — pull a bot into a topic group / on-call group and one @ runs it right in your local repo; a session can be moved to another group with `/relay`, keeping its full context.
- **A single agent isn't enough** — put several bots backed by different CLIs in one group, @ whoever should act, and have Claude Code and Codex review the same MR — each analyzing independently and pushing back when they disagree.

## 5-Minute Setup

> About 5 minutes: a single Lark QR scan in `botmux setup` creates the app, configures all permissions, and publishes a version in one flow (add `--no-open-platform-auto` to only create the app and skip the permission + publish automation, which you then complete manually; creating the app manually / pasting credentials is a separate option inside setup).

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
botmux setup                 # one scan to create the app → pick a CLI → pick a working dir (permissions + publish auto-configured)
botmux start                 # start the daemon (botmux autostart enable for auto-start on boot)
```

> botmux ships as a **self-contained single-file binary** with its runtime embedded — **neither installing nor running it needs Node on the machine** (whatever the AI coding CLI you bridge needs is its own matter). It installs to `~/.botmux/bin/botmux` (override with `BOTMUX_INSTALL_DIR`), picks the right binary for your OS/arch, verifies its SHA-256, and adds `~/.botmux/bin` to the startup file your shell actually reads (zsh / bash / fish each get the correct one), so **a new terminal has the command**.
>
> Nothing native is compiled during install (no Python / node-gyp / compiler): the PTY is already inside the binary. Supported: linux / macOS × x64 / arm64, with musl builds selected automatically on Alpine and similar. **On Windows, install inside WSL2** — the daemon needs PTY / tmux / Unix signals and does not run on native Windows; WSL2 reports as linux and is a fully supported first-class environment. An unsupported platform, or a binary that cannot run on this host, **fails with an explicit error and leaves your existing install untouched** rather than leaving you with a command that won't start.
>
> To upgrade: `botmux upgrade` (replaces the binary in place), or just **re-run the curl command** — also an in-place upgrade, and it won't append a second PATH line.

<details>
<summary>Already living in the Node ecosystem? npm works too (same binary)</summary>

```bash
npm install -g botmux        # requires Node >= 22 to run the install itself
```

The npm package carries **the same self-contained binary** (only the one matching your os/arch is installed); its postinstall points `~/.botmux/bin/botmux` at it and writes PATH the same way. So you end up with exactly **one** botmux version — no more "two Node versions each carrying their own global botmux, fighting each other / no idea which one I just updated".

The only difference is **who installs it and who upgrades it later**: the npm path needs Node ≥ 22 to run the install itself and hands upgrades back to `npm i -g botmux@latest`; the curl path never touches Node. Once running, the two are identical — same binary, same commands.

</details>

Then DM the bot, or run `botmux dashboard` to create a group, and start chatting. Full steps (Lark international, manual permission / publish setup after `--no-open-platform-auto`, troubleshooting) are in the **[5-Minute Quickstart](https://deepcoldy.github.io/botmux/en/quickstart)**.

## Core Scenarios

- **[Live streaming cards](https://deepcoldy.github.io/botmux/en/cards)** — one live-updating card per turn, relaying the terminal screen verbatim as a screenshot; one tap to show/hide output, scroll, or restart/close/adopt the session.
- **[Multi-bot collaboration](https://deepcoldy.github.io/botmux/en/multi-bot)** — multi-bot @mention routing in one group; different CLIs mean different models and natural diversity — have them critique each other on design reviews, code reviews, tech-stack choices.
- **[Multi-topic orchestration](https://deepcoldy.github.io/botmux/en/multi-topic)** — hand an orchestrator a big task and it seeds topics in the group, spins up an isolated session per bot to run a pipeline, and the Lark task board shows every subtask's progress at a glance.
- **[Interactive web terminal](https://deepcoldy.github.io/botmux/en/web-terminal)** — not just viewing output: drive the CLI directly from a browser / phone, with a floating shortcut bar on mobile (Esc, Ctrl+C, arrow keys).
- **[Adopt & relay sessions](https://deepcoldy.github.io/botmux/en/adopt)** — running halfway in local tmux, `/adopt` it from your phone; `/relay` moves the whole session (same process, same memory) into a team group to continue.
- **[Scheduled tasks](https://deepcoldy.github.io/botmux/en/schedule) & [external triggers](https://deepcoldy.github.io/botmux/en/webhook)** — configure recurring tasks in natural language (alert analysis / group summaries); trigger programmatically from external systems via [Webhook](https://deepcoldy.github.io/botmux/en/webhook) or the [task-trigger API](https://deepcoldy.github.io/botmux/en/api-task-trigger).
- **[On-call mode](https://deepcoldy.github.io/botmux/en/oncall) & [voice summary](https://deepcoldy.github.io/botmux/en/voice)** — pull it into an on-call group and any member's @ triggers a probe in the project dir; once TTS is configured, each card footer gains a 🔊 voice-summary button that makes the model "speak plainly".

More: [Roles & teams](https://deepcoldy.github.io/botmux/en/roles) · [File sandbox](https://deepcoldy.github.io/botmux/en/sandbox) · [Dashboard](https://deepcoldy.github.io/botmux/en/dashboard) · [tmux persistence](https://deepcoldy.github.io/botmux/en/tmux) · [VC meeting agent (showcase)](https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg).

## Supported CLIs & Agents

Switch with `cliId` in `bots.json`. **20+ adapters**, spanning local CLIs (process-isolated, reachable via `tmux attach`) and API / cloud agents (e.g. Mira, riff — reached over API / remote, not a local process; mojo is API-driven but executes tools on the bot host by default, set cloud: true for the remote sandbox). Representative ones:

`claude-code` · `codex` · `gemini` · `cursor` · `opencode` · `opencode2` · `antigravity` · `copilot` · `grok` · `kimi` · `kiro-cli` · `reasonix` · `dsh` · `aiden` · `coco` (TRAE) · `hermes` · `ebsd` · `mira` · `riff` (cloud agent) … · `mojo` (API-driven, host execution by default) …

The `ebsd` adapter uses a dedicated external service identity and native OMP session storage. Operators must provide the Diag Gateway token and ByteCloud service account through permission-restricted files, never through `bots.json`.

Store only non-secret metadata and credential file paths in `bots.json`:

```json
{
  "cliId": "ebsd",
  "workingDir": "/var/lib/botmux/ebsd-work",
  "sandbox": true,
  "env": {
    "EBSD_BOTMUX_DIAG_ENDPOINT": "https://ebsbot.example",
    "EBSD_BOTMUX_DIAG_TOKEN_FILE": "/run/secrets/ebsd-botmux/diag-token",
    "EBSD_BOTMUX_BYTECLOUD_ACCESS_KEY_FILE": "/run/secrets/ebsd-botmux/bytecloud-ak",
    "EBSD_BOTMUX_BYTECLOUD_SECRET_KEY_FILE": "/run/secrets/ebsd-botmux/bytecloud-sk",
    "EBSD_BOTMUX_SUBJECT": "botmux-ebsd@prod",
    "EBSD_BOTMUX_REPOSITORY_ROOT": "/srv/repos"
  }
}
```

The three credential files must be owner-held `0600` regular files, not symlinks. Never put their contents, the AK/SK, or the Gateway token in `bots.json`. Use a dedicated empty `workingDir`; repositories are exposed separately through the read-only `EBSD_BOTMUX_REPOSITORY_ROOT`. Linux hosts need bubblewrap before enabling `sandbox`, and startup fails closed if isolation cannot be established. The Gateway may accept current and previous keys during rotation while the subject remains stable.

The current full set of `cliId`s is authoritative in [`src/adapters/cli/registry.ts`](https://github.com/deepcoldy/botmux/blob/master/src/adapters/cli/registry.ts); per-CLI config and wrapper / gateway setups are in [CLI Adapters](https://deepcoldy.github.io/botmux/en/adapters).

### Session-level CLI selection

Before a session starts, select a registered CLI for that session with `/cli <cliId>`, for example:

```text
/cli codex
```

This switches only the bare CLI adapter. It does not inherit the bot's `wrapperCli`, `model`, or `startupCommands`. CLIs that require a `ttadk`, `aiden`, or other wrapper / gateway setup should therefore remain configured as the bot's default wrapper combination. Once the session starts, the CLI selection is frozen and is reused for later messages and restores.

## Design Philosophy: Bridge the CLI Directly, No SDK Wrapper

botmux doesn't reimplement memory, context management, tool calls, or permission systems — **most native CLI capabilities don't need reimplementing, and CLI upgrades usually benefit botmux directly** (when interfaces / params / output formats / resume semantics change, an adapter may still need to catch up). You keep talking in plain language; the daemon wraps context into structured prompts behind the scenes before feeding the CLI. An Agent-SDK-based approach is the inverse: capabilities depend on what the SDK exposes and on your own integration.

The table below compares only **verifiable integration boundaries** — it does not claim what other approaches "necessarily lack":

| Integration boundary | botmux | Agent-SDK-based approach |
|------|--------|--------------------------|
| What's bridged | The full CLI process (its built-in hooks / memory / plan mode / MCP / `/` commands) | Whatever the SDK exposes |
| CLI upgrades | Mostly benefit directly; adapter catches up when interfaces / resume change | Depends on SDK version and integration |
| Memory / context | Reuses the CLI's built-in | Depends on the SDK / self-built |
| Multi-CLI / agent | 20+ adapters, switch in one line | Depends on SDK coverage |
| Multi-bot | Multi-bot @mention routing in one group | Depends on the implementation |
| Direct terminal | Local CLIs can `tmux attach` into the real process | Depends on the implementation |

## Docs · Community · Contributing

- 📖 **Full docs** (commands / config / best practices / troubleshooting): **<https://deepcoldy.github.io/botmux/en/>**
- ✨ **Showcase** (illustrated + video): [*Create a really useful Feishu assistant in 5 minutes*](https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg)
- ❓ **FAQ / troubleshooting**: [FAQ](https://deepcoldy.github.io/botmux/en/faq) · [Common Pitfalls](https://deepcoldy.github.io/botmux/en/pitfalls)
- 💬 **Community**: the [About & Resources](https://deepcoldy.github.io/botmux/en/about) page has QR entries to join the internal / external "Botmux" chat groups.
- 🤝 **Contributing**: issues / PRs welcome. To add an adapter, see [CLI Adapters](https://deepcoldy.github.io/botmux/en/adapters).
- 📄 **License**: [MIT](LICENSE)

<p align="center">If it's useful, drop a ⭐ Star → <a href="https://github.com/deepcoldy/botmux">deepcoldy/botmux</a></p>
