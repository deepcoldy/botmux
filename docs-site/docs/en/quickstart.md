# Quickstart

<video src="../img/video-v1-quickstart-en.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

Follow these 3 steps to add your first AI bot to Lark. If you only use a bot in a group someone else has already set up, you don't need to install anything.

## Before you start

You'll need a Linux / macOS machine, a Lark account, and an AI CLI such as Claude Code or Codex that is **installed, signed in, and working in a terminal**. See [Prerequisites](/en/prerequisites) for tmux and the other requirements.

## Step 1 · Install

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
```

**Open a new terminal** afterwards so the `botmux` command becomes available. The self-contained program doesn't need Node to run; on Windows, use WSL2.

You can also run `npm install -g botmux` (Node ≥ 22 is required for installation). Both installation methods provide the same program.

> **Mac desktop app**: [GitHub Releases](https://github.com/deepcoldy/botmux/releases) provides a signed and notarized DMG. In the current version, if you've never configured a bot, you still need to complete one command-line initialization with steps 1 and 2 on this page before clicking “Start” in the app. An existing `~/.botmux` configuration opens directly. See [macOS Desktop App](/en/desktop).

## Step 2 · Scan to configure the bot

```bash
botmux setup
```

Use the arrow keys and Enter to complete these choices:

1. **Create a Lark app**: choose “One-scan create new app,” name the bot, then scan with Lark. botmux configures permissions and publishes the app for you; the person who scans becomes the admin.
2. **Choose a CLI**: pick the AI CLI this bot will use. You can type to search.
3. **Choose a working directory**: for your first bot, choose the pinned default directory and enter an existing project directory such as `~/projects/my-app`. New topics will start there directly.

If you already have an app, enter its App ID and secret manually. Selecting an existing app to fetch its credentials automatically is available for Feishu tenants only; on Lark international, enter the App ID and secret manually instead. If automatic configuration doesn't finish, follow the wizard's instructions and see [FAQ · Finish Open Platform setup manually](/en/faq#manual-open-platform-setup).

> Press `Esc` to cancel setup without writing any configuration. Your scan login is remembered on this machine, so adding another bot usually only requires confirming the account.

## Step 3 · Start and chat

```bash
botmux start
```

If the first run asks about “feedback storage,” **press Enter to use the default SQLite option**. Then in Lark:

1. Create a topic group (a regular group works too), and add your new bot under “Group settings → Group bots.”
2. **@ the bot** with a message such as “@bot How do I build this project? Please run the tests too.”
3. Watch its card update as it works, then continue the conversation in the same session.

![Reply card: in progress and finished](/img/unified-reply-card-preview.png)

- **Do I always need to @ it?** Groups require an @ by default; follow-ups can work without one in an eligible active topic. See [Mention policy](/en/mention-mode).
- **Don't want a group?** Just DM the bot.
- **Want it to start after a reboot?** Once everything works, run `botmux autostart enable`. See [Start on boot](/en/cli-commands#autostart).

## What to try next

Give it a few everyday tasks:

- “Fix this error and add a test for it.”
- “Summarize the changes made to this project over the past week.”
- “Every weekday morning, report this group's open tasks and risks.” ([Scheduled tasks](/en/schedule))

See [Everyday uses on the documentation home](/en/#everyday-uses) for more ideas.

## No response? Check these two commands

```bash
botmux status   # Is the service running?
botmux logs     # Connection, permission, and CLI startup errors
```

Remember to @ the bot in a group, and run `botmux restart` after changing configuration. For the full guide, see [FAQ · The bot doesn't reply](/en/faq#the-bot-doesnt-reply) and [Common Pitfalls](/en/pitfalls).

## Advanced configuration, when you need it

| I want to… | Reference |
|---|---|
| Add bots from scripts or use botmux locally only | [CLI Commands · Scripted setup](/en/cli-commands#scripted-setup) |
| Add permissions beyond the built-in list | [CLI Commands · Extra scopes](/en/cli-commands#extra-scopes) |
| Set a first-launch welcome message | [bots.json · Welcome message](/en/bots-json#welcome-message) |
| Finish app setup manually or configure optional events | [FAQ · Manual setup](/en/faq#manual-open-platform-setup) · [Optional events](/en/faq#optional-events) |
| Upgrade, install a specific version, or update a source install | [CLI Commands · Upgrade](/en/cli-commands#upgrade) |
| Change feedback storage | [Feedback storage and migration](/en/feedback-storage) |
