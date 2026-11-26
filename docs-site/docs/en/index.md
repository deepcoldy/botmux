# botmux

<video src="../img/video-v0-overview-en.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

<p class="lead">Add AI coding tools to a Lark group, just like bringing in a teammate.</p>

Ask them to write code, investigate issues, review changes, or report progress on a schedule. Follow, reply, or interrupt from your phone, then pick up the same task when you're back at your computer.

## Get started in 3 steps

### 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
```

Linux and macOS (x64 / arm64) are supported, with no Node required to run botmux; on Windows, use WSL2.

### 2. Scan to configure your first bot

```bash
botmux setup
```

Follow the wizard to scan with Lark, choose an installed and signed-in CLI, and pick a default working directory. App creation, permissions, and publishing are handled for you.

### 3. Start it and add it to a group

```bash
botmux start
```

Add the bot to a Lark group and @ it with “How do I build this project?” or “Help me fix this error.” You can also DM the bot instead of creating a group.

➡️ Installing for the first time? Follow the [Quickstart](/en/quickstart) and check [Prerequisites](/en/prerequisites) for the CLI, tmux, and other requirements.

> Mac users can also install the signed and notarized [Botmux Desktop app](/en/desktop). In the current version, first-time use still requires one command-line initialization; an existing configuration opens directly.

## Everyday uses

| I want to… | Try this / learn more |
|---|---|
| Write code and fix issues | “@bot Fix this error and add a test for it.” · [Live cards](/en/cards) |
| Investigate incidents and answer on-call questions | “@bot What is the most likely cause in these logs?” · [On-call mode](/en/oncall) |
| Have several AIs review a change | Let different bots inspect it independently · [Multi-bot collaboration](/en/multi-bot) |
| Schedule updates | “Every weekday morning, summarize yesterday's progress and today's risks.” · [Scheduled tasks](/en/schedule) |
| Keep up from a phone | Reply or interrupt anytime, and take over when needed · [Web Terminal](/en/web-terminal) |
| Continue work from a computer | Adopt a running session or move it to another group · [Adopt](/en/adopt) · [Relay](/en/relay) |

## Explore more when you need it

- **Parallel work and orchestration**: [Multi-topic collaboration](/en/multi-topic) · [Project progress card](/en/project-card) · [Decision board and steward](/en/decision-board)
- **Teams and automation**: [Roles and teams](/en/roles) · [Webhook](/en/webhook) · [Headless sessions](/en/headless-session)
- **Management and customization**: [Dashboard](/en/dashboard) · [Voice summaries](/en/voice) · [File sandbox](/en/sandbox)
- **Multiple machines and teams**: [Central Platform (open source)](/en/platform); a single machine doesn't need it

[See the 30+ supported CLIs and agents](/en/adapters), or browse the feature pages in the sidebar for full guides.

## Advanced information

- **Configuration and commands**: [CLI commands](/en/cli-commands) · [Slash commands](/en/slash-commands) · [bots.json](/en/bots-json) · [Global settings](/en/global-settings) · [Best practices](/en/best-practices)
- **How it works**: [Architecture](/en/architecture) · [Session and topic model](/en/session-model)
- **Need help?**: [FAQ / Troubleshooting](/en/faq) · [Common pitfalls](/en/pitfalls)

> Project: <https://github.com/deepcoldy/botmux>
