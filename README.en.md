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

> A single Lark QR scan in `botmux setup` creates the app, configures all permissions, and publishes a version in one flow (manual app creation / credential entry is also supported).

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
botmux setup                 # one scan to create app → pick CLI → pick working dir (auto-configured)
botmux start                 # start the daemon (botmux autostart enable for auto-start on boot)
```

- **Self-contained single-file binary**: Runtime and PTY are embedded — **no Node required on the host to install or run**. Supports Linux / macOS (x64 / arm64, stable Apple Developer ID signature for official macOS builds); on Windows, run inside WSL2.
- **Seamless upgrade**: Run `botmux upgrade` or re-run the curl command above for safe in-place upgrades.
- **Full Guide**: Lark international edition, manual permission configuration, and troubleshooting are in the **[5-Minute Quickstart](https://deepcoldy.github.io/botmux/en/quickstart)**.

<details>
<summary>Prefer the Node / npm ecosystem? npm works too (same binary)</summary>

```bash
npm install -g botmux        # requires Node >= 22 for installation
```

The npm package contains the identical binary with the same commands and capabilities.

</details>

Then DM the bot, or run `botmux dashboard` to create a group and start chatting.

## Core Scenarios

- **[Live streaming cards](https://deepcoldy.github.io/botmux/en/cards)** — one live-updating card per turn, relaying the terminal screen verbatim as a screenshot; one tap to show/hide output, scroll, or restart/close/adopt the session.
- **[Multi-bot collaboration](https://deepcoldy.github.io/botmux/en/multi-bot)** — multi-bot @mention routing in one group; different CLIs mean different models and natural diversity — have them critique each other on design reviews, code reviews, tech-stack choices.
- **[Zero prompt injection](https://bytedance.larkoffice.com/docx/IECddVsSFotuuXx8gf3cQdKqnCd)** — skips framework prompt / role / skill injection to pass clean task prompts straight to the CLI, capturing answers from transcripts. Perfect for lead-bot dispatching sub-bots.
- **[Principal lanes](docs/principal-lanes.md)** — isolate turns across users with independent CLI contexts and git worktrees within the same group.
- **[Multi-topic orchestration](https://deepcoldy.github.io/botmux/en/multi-topic)** — hand an orchestrator a big task and it seeds topics in the group, spins up an isolated session per bot to run a pipeline, and the Lark task board shows every subtask's progress at a glance.
- **[Interactive web terminal](https://deepcoldy.github.io/botmux/en/web-terminal)** — not just viewing output: drive the CLI directly from a browser / phone, with a floating shortcut bar on mobile (Esc, Ctrl+C, arrow keys).
- **[Adopt & relay sessions](https://deepcoldy.github.io/botmux/en/adopt)** — pick up a running tmux, Zellij, Herdr, or Orca (experimental) session from your phone with `/adopt`; `/relay` moves the whole session (same process, same memory) into a team group to continue.
- **[Scheduled tasks](https://deepcoldy.github.io/botmux/en/schedule) & [external triggers](https://deepcoldy.github.io/botmux/en/webhook)** — configure recurring tasks in natural language (alert analysis / group summaries); trigger programmatically from external systems via [Webhook](https://deepcoldy.github.io/botmux/en/webhook) or the [task-trigger API](https://deepcoldy.github.io/botmux/en/api-task-trigger).
- **[On-call mode](https://deepcoldy.github.io/botmux/en/oncall) & [voice summary](https://deepcoldy.github.io/botmux/en/voice)** — pull it into an on-call group and any member's @ triggers a probe in the project dir; once TTS is configured, each card footer gains a 🔊 voice-summary button that makes the model "speak plainly".

More: [Roles & teams](https://deepcoldy.github.io/botmux/en/roles) · [File sandbox](https://deepcoldy.github.io/botmux/en/sandbox) · [Final answer feedback](docs/feedback-capability-current-implementation.md) · [Dashboard](https://deepcoldy.github.io/botmux/en/dashboard) · [tmux persistence](https://deepcoldy.github.io/botmux/en/tmux) · [VC meeting agent (showcase)](https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg).

## Per-Bot Zero Prompt Injection

Designed for multi-agent dispatch pipelines (lead-bot delegating tasks to sub-bots). Bypasses all botmux system prompts, per-turn reminders, identity envelopes, roles, and skill directory injections, while automatically collecting final replies from CLI transcripts.

- ✨ **Showcase and Guide**: [Feishu Illustrated Showcase](https://bytedance.larkoffice.com/docx/IECddVsSFotuuXx8gf3cQdKqnCd)
- 📑 **Technical Spec & Compatibility**: [Zero Prompt Injection Spec](docs/zero-prompt-injection.md)

**Quick Setup**:
- **Dashboard**: Bot Config → Select Bot → Advanced → Toggle "Zero Injection" (or group bots under Agent Config).
- **`bots.json`**: Set `"promptInjection": "none"` on the corresponding bot entry (`"default"` or omitting restores default behavior).

## Supported CLIs & Agents

Switch with `cliId` in `bots.json`. **20+ adapters**, spanning local CLIs (process-isolated, reachable via `tmux attach`) and API / cloud agents:

`claude-code` · `codex` · `gemini` · `cursor` · `opencode` · `opencode2` · `mimocode` · `antigravity` · `copilot` · `grok` · `kimi` · `codem` ([CodeM](docs/codem.md)) · `kiro-cli` · `reasonix` · `dsh` · `aiden` · `coco` (TRAE) · `traex` · `mtr` · `hermes` · `ebsd` ([Configuration Guide](docs/ebsd.md)) · `mira` · `riff` (cloud agent) · `mojo` · `remote-runner` ([Remote Runner Protocol](docs/remote-runner.md)) · `minimax` ([MiniMax Code](docs/minimax-code.md)) · `zcode` (ZCode TUI; the adapter declares `interruptKey: 'esc'` and preempts a running turn when a new message arrives) …

- **Session-level CLI Selection**: Select a registered CLI for an upcoming session with `/cli <cliId>`.
- **Codex Multi-Account & Instances**: Configure multiple login homes and distribution strategies via [Session-level Codex Instances](docs/codex-instances.md).
- **Compatible Distributions**: Codex-compatible and Kimi-compatible distributions can declare independent identities via `cliRuntime`, see [Codex-compatible Distributions](https://deepcoldy.github.io/botmux/en/adapters#codex-compatible-distributions).
- **Shared Memory (Optional)**: Enable cross-agent persistent memory with [OpenViking Shared Memory](examples/openviking-memory/README.md).

Authoritative `cliId` list and wrapper setups are documented in [CLI Adapters](https://deepcoldy.github.io/botmux/en/adapters).

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

## Advanced Integrations

- **[Signed Chat Defaults](docs/signed-chat-defaults.md)** — Automated chat provisioning services can declare default `ambient` (mention-free) modes for standard groups via signed bindings.
- **[Model Proxy Mode](docs/model-proxy.md)** — External applications (such as [OpenCodeReview](https://github.com/alibaba/open-code-review)) can access CLI model capabilities through an authenticated local Chat Completions endpoint, backed by [constrained invocation interfaces](docs/constrained-invocations.md).

## Docs · Community · Contributing

- 📖 **Full docs** (commands / config / best practices / troubleshooting): **<https://deepcoldy.github.io/botmux/en/>**
- ✨ **Showcase** (illustrated + video): [*Create a really useful Feishu assistant in 5 minutes*](https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg)
- ❓ **FAQ / troubleshooting**: [FAQ](https://deepcoldy.github.io/botmux/en/faq) · [Common Pitfalls](https://deepcoldy.github.io/botmux/en/pitfalls)
- 💬 **Community**: the [About & Resources](https://deepcoldy.github.io/botmux/en/about) page has QR entries to join the internal / external "Botmux" chat groups.
- 🤝 **Contributing**: issues / PRs welcome. To add an adapter, see [CLI Adapters](https://deepcoldy.github.io/botmux/en/adapters).
- 📄 **License**: [MIT](LICENSE)

## Contributors

botmux may well be the most-contributed-to open-source project built specifically for Feishu/Lark — and that is entirely thanks to everyone who has taken part. Thanks to all who have contributed code, documentation, and issues:

<a href="https://github.com/deepcoldy/botmux/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=deepcoldy/botmux" alt="contributors" />
</a>

<p align="center">If it's useful, drop a ⭐ Star → <a href="https://github.com/deepcoldy/botmux">deepcoldy/botmux</a></p>
