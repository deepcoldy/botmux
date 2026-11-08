# Session & Topic Model

In botmux, **a session = one running AI coding CLI process (such as Claude Code or Codex) + its context**. Every message you send lands in some session.

Questions like "why does every @ feel like starting over" or "why can't a new group see earlier chat" all come down to which session a message landed in. This page explains that, and how to start, continue, and recover sessions.

## At a glance: which session does a message go to

| Where you chat | How sessions are split by default | How to change it |
|----------------|-----------------------------------|------------------|
| **Topic group** | One session per topic; topics don't affect each other | Nothing to set up; recommended |
| **Regular group** | Top-level messages that @ the bot share one session; each topic opened in the group gets its own session | `/reply-mode`, see "Regular groups" below |
| **Direct message** | Your whole DM with the bot is one continuous session | `/reply-mode`, see "Direct messages" below |
| **Session group created with `/g`** | The whole group is one session | See [One-step session groups](/en/group) |
| **On-call group** | Bound to one project directory; anyone in the group can @ the bot and ask | See [On-Call Mode](/en/oncall) |

> Sessions are **per bot**. If you @ two bots in the same topic, that's two independent sessions that don't share context.

## Topic groups

Each new topic starts a new session; replying inside a topic continues that session. Topics are fully isolated, which makes them good for running several tasks in parallel.

## Regular groups

How a regular group splits sessions depends on its "reply mode". Each bot has a default, and a single group can override it with `/reply-mode`:

| Mode | Effect |
|------|--------|
| `chat-topic` (default) | Top-level @s all go into one session; each topic opened in the group is its own session |
| `chat` | The whole group is one session; messages in topics are folded in too |
| `new-topic` | Every @ opens a new topic and a new session |
| `topic` (also `shared`) | Replies show up in topics, but all topics share one session |

- See the current mode: `/reply-mode`; go back to the bot default: `/reply-mode inherit`.
- Change the bot default in Dashboard "Bot config", or set `regularGroupReplyMode` in `bots.json` (see [bots.json](/en/bots-json)).

**To open a dedicated topic for a task in a regular group**, use `/t`:

```text
Fix login page bug /t /repo my-app The login button does nothing, please take a look
```

- Text before `/t` is the topic title. After it you can add `/repo` (pick a repository), `/model` (pick a model), and the first task.
- Bare `/t` just sets up the topic. If a repository must be picked, a repo picker card appears; otherwise it waits for your next task or `/repo` in the topic, without starting an empty session.
- `/th` opens a topic in the current group session's working directory; `/tw` creates a worktree first, then opens the topic.
- Full syntax is in [Slash Commands](/en/slash-commands).

> When "show a status card while a task runs" is off, `/t <text>` still posts a visible reply first so Lark expands the topic right away; reactions are only progress hints.

## Direct messages

By default your whole DM is one continuous session, so everything builds on earlier context. Each person's DM with the bot is separate. To change this:

| Command | Effect |
|---------|--------|
| `/reply-mode chat` (default) | The whole DM is one continuous session |
| `/reply-mode topic` | Each top-level DM message starts its own session; replying in that message's thread continues that session |
| `/reply-mode group` | Each top-level DM message creates a dedicated "you + bot" group and runs the session there; see [One-step session groups](/en/group) |

The DM mode applies to **all DMs** with that bot, and maps to `p2pMode` in `bots.json`.

## Common tasks: start, continue, recover

| You want to | Do this |
|-------------|---------|
| Continue where you left off | Reply in the **same topic** (topic group), or go back to the same group / DM |
| Start a new session | Post a new topic in a topic group; use `/t` in a regular group |
| Work on something else in parallel with the current context | `/fork <task>` opens a forked topic that inherits the full context |
| Find topics still open in this group | `/sessions`, then click "back to topic" to jump there |
| End a session | `/close`. The next message starts a new session |
| Bring back a closed session | Click "▶️ Resume session" on the close card, or send `/resume` |

![/sessions card: lists the topic sessions still open in this group](/img/sessions-command-card.png)

## A session's lifecycle

| Stage | What's happening |
|-------|------------------|
| Starting | The first message arrived and the bot is launching the CLI |
| Working | The CLI is thinking and running; the status card refreshes live |
| Awaiting input | This turn is done; you can send the next message |
| Dormant | After a long idle period, or when too many sessions are live, the CLI process exits to free memory. The topic stays, and the next message restores the context automatically |
| Closed | Someone sent `/close` or clicked the close button. A new message starts a new session; resume it to continue the old one |

Each turn gets a new status card, and the previous card freezes in its final state so you can look back. Card colors and buttons are in [Live Streaming Cards](/en/cards); what triggers dormancy and whether a daemon restart loses context are in the [FAQ](/en/faq).

## The four names of a session

"I renamed it, so why didn't Lark change?" Because a session has four separate names:

| Name | Where it shows | How to change it |
|------|----------------|------------------|
| **Lark group name** | The group's own name, visible to everyone in it | Have the agent run `botmux chat rename "New group name"` inside the session. This renames the **whole group**, so every topic in a topic group sees it |
| **Lark topic name** | Lark's topic list | **Can't be changed.** Lark has no API for topic titles; the topic list always shows the topic's first message. If you want a nice title, write it before `/t` |
| **botmux session title** | Dashboard and the `/sessions` list | Send `/rename <title>` in the chat, or have the agent run `botmux session rename "<title>"` inside the session. Up to 200 characters |
| **The CLI's own session name** | The resume list in Claude Code, Codex, and other CLIs | Synced when you change the botmux title; skipped if the CLI is offline or doesn't support it, which doesn't affect the botmux title |

About `botmux session rename`:

- It only works inside a session. It detects the current session automatically and takes no argument for picking another one, so it can't rename someone else's session.
- A good title shape is "type | subject", e.g. `Debug | payment-link timeout`.
- It only changes the botmux title, not the Lark group name.

When an agent renames the group on its own because the task moved to a new phase, it adds `--proactive`, which prevents repeated renames within 10 minutes.

## Who can do what (three permission tiers)

| Tier | What it allows | Who has it |
|------|----------------|------------|
| **Talk** | Ask questions, have it check logs, read code | Admins (`allowedUsers`), everyone in allowlisted groups (`allowedChatGroups`), guests granted access (`/grant`), on-call group members, and so on; anyone in `blockedUsers` is always denied |
| **Operate** | botmux slash commands (such as `/cd`, `/restart`, `/close`, `/rename`, `/card`) and card buttons | Admins (`allowedUsers`). If no allowlist is configured at all, everyone has it |
| **Manage** | `/grant` / `/revoke` to authorize others, toggling on-call, etc. | The bot owner and admins |

- botmux commands need operate access by default. A few only need talk access, such as `/resume`.
- To let people with talk access run specific commands, add those commands to `canTalkDaemonCommands` in `bots.json`.

With these tiers you can safely add the bot to an on-call group: everyone can ask, but only admins can change session state, and a stray click from someone else won't break the session. Full rules (quotas, expiry, "joining a group ≠ being authorized", block list, grant request cards) are in [Permissions & Access](/en/permissions).

## Common confusions

- **Every @ feels like starting over**: in a topic group, a new topic is a new session. To keep going, reply **in the same topic**. In a regular group set to `new-topic`, every @ also opens a new session; check with `/reply-mode`.
- **A new session doesn't know what was said earlier in the group**: new sessions start blank. Just tell it "look at the earlier chat history" (the bot needs permission to read group messages, see [FAQ](/en/faq)). An admin can also run `/context-sharing on` in the group, so the bot automatically catches up on group messages it missed whenever it's @-ed; see [Multi-Bot Collaboration](/en/multi-bot).
- **Switching to another CLI while keeping context**: not possible. CLIs don't share session history, so there's no lossless switch. To change CLIs, start a new bot or session and have the old bot write a handoff summary first. [`/relay`](/en/relay) moves the same session to another group, and [`/adopt`](/en/adopt) brings an existing local CLI session into Lark; neither changes the CLI.

**Next**: [Permissions & Access](/en/permissions) · [Mention Policy](/en/mention-mode) · [Slash Commands](/en/slash-commands) · [Relay](/en/relay)
