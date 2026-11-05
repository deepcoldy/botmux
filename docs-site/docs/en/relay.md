# Session Relay

<video src="../img/video-v3-adopt-relay-en.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

`/relay` moves a **running AI session** to another group, another topic, or a DM, so you can keep going there.

- What moves is **the same CLI process and the same AI memory**, not a fresh copy.
- **The Lark chat history stays where it was.** The new place won't show the old messages, but the AI remembers what was discussed.

A typical case: work out a plan in your DM with the bot, then move it into the team group with one command so everyone continues from that context.

![Session Relay](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780419243529_relay.png)

> How it differs from [Adopt](/en/adopt): Adopt brings a CLI running in tmux on your computer into Lark. Relay moves a session that's already running inside botmux from place A to place B.

## The two ways at a glance

| I want to… | Send it in | Send |
|---|---|---|
| **Pull** a session from elsewhere **into here** | The target group / topic / DM | `/relay` |
| **Move** the current session **into a new group** | The current session | `@BotA @BotB /relay --create [name]` |

```bash
/relay                                     # In the target place: pick a session from the menu and pull it in
@Claude @Codex /relay --create Plan review  # Create group "Plan review" and move the current session plus the collaborating bots
/relay --create                            # In a DM: create a group with just you and this bot
```

## Option 1: `/relay` pulls a session in

1. Go to where you want the session to **land** (a regular group, a topic group, inside a topic, or your DM with the bot) and send `/relay`.
2. The bot replies with a picker card listing **your own active sessions for the same bot**, most recently active first.
3. Click a session to select it, then click "Confirm relay into this chat" ("Confirm relay into this DM" in a DM).
4. On success the card disappears and you see "✅ Relayed into this chat".

What the card shows:

| Item | Meaning |
|---|---|
| Type / Where | Group chat, topic chat, or direct message, plus the group name |
| Status | 🟢 Running / ⚪ Idle |
| Active | When the session last had a message |
| Search box | Search by title, group name, or path; search "dm" to find sessions in direct messages |
| Pages | 5 per page; use "← Prev / Next →" |

A few details:

- **Other topics in the same group are listed too**, so you can move a session between topics of one group. Only the session already at the current spot is left out.
- In a **regular group (not topic mode)** the card is **visible only to you**, so your session list isn't shown to the whole group. Inside a topic it appears as a normal reply in that topic.
- Only the person who summoned the card can use it. Anyone else who clicks is told to run `/relay` themselves.
- For a session that's busy, the confirm button reads "Session is running — cannot relay yet". Once it's idle, click the session again to refresh, then confirm.

## Option 2: `/relay --create` moves into a new group

In the current session, send `@BotA @BotB /relay --create [name]`:

1. A new group is created with you and the @-mentioned bots.
2. The current session, plus the @-mentioned bots' sessions **in this topic**, move into the new group.
3. The original session gets a result message: the new group link and whether each bot moved successfully.

More notes:

- **The name is optional.** Without one it defaults to "Session Relay MM/DD HH:mm". Names longer than 50 characters are cut off.
- **In a group you must @ at least one bot.** The first @-mentioned bot creates the group; the others don't create duplicates.
- **In a DM no @ is needed** (you can't @ other bots in a DM anyway). Just send `/relay --create`; the new group has you and this bot.
- If a bot didn't make it (for example its session isn't yours, or its service is offline), the result marks it as skipped or not migrated. The new group is still created; send `/relay` there to pull that bot's session in.

## What you'll see after a relay

The new place receives a notice:

> 📋 Relayed from "source group".
> ⚠️ Lark message history stays in the source chat; AI memory has been carried over.
> @ the corresponding bot to continue.

In a DM, the last line reads "Just send a message to continue".

The original streaming card freezes as an archive with the status "🔄 Relayed away" and all buttons removed, so a stray click can't affect the session that's now live elsewhere.

## Where the session lands

| Where you send `/relay` | Where the session lands |
|---|---|
| Inside a topic | That topic |
| Top level of a topic group | A new topic started from the `/relay` message |
| Regular group (default flat mode) | The whole group |
| Regular group (set to open a new topic per @, or `shared`) | A new topic started from the `/relay` message |
| DM (default continuous mode `chat`) | The whole DM |
| DM (`topic` or `group` mode) | A new topic started from the `/relay` message |

Switch group and DM modes with `/reply-mode`; see [Slash Commands](/en/slash-commands). For the different group types, see [Session Model](/en/session-model).

## When relay won't work

| Situation | What to do |
|---|---|
| You're not the session initiator (owner) | Only the initiator can move their own session; ask them to do it |
| The session is processing | Wait for the current turn to finish and go idle, then retry |
| No repo picked yet, so the CLI hasn't started | Go back to the original session and pick a repo first |
| The session was brought in via `/adopt` | Not supported. The CLI runs on your computer and botmux doesn't control its lifecycle |
| The target already has an active session for this bot | `/close` it in the target first, then relay |
| The session is closed | Closed sessions don't appear in the menu and can't be relayed |

"Target already has a session" is judged by where the session would land: when landing in a whole group or whole DM, the whole group counts; when landing in a topic, only that topic counts, so different topics in one group don't collide.

If a relay times out or fails, the session **is not lost**. The chat history and AI memory are still in the original place; just click "Confirm relay" again a bit later.
