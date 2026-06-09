# Session Relay

Relay a **running AI session** from one group to another to continue there — **the Lark message history stays in the source group, but the AI's memory / context carries over**, so you can switch groups and keep chatting seamlessly. The command is `/relay`.

A half-finished session can **move house entirely**, without losing any context: get a plan working in a private chat, then move it into the team group with one command so everyone can continue from that same context. What moves over is the **same CLI process and the same memory** — not a copy spun up fresh.

![Session Relay](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780419243529_relay.png)

> Difference from [Adopt](/en/adopt): Adopt brings a process from your local tmux into Lark; Relay moves a session that's already running inside botmux from group A to group B.

## Two ways to use it

**1. `/relay` (picker mode) — "pull" a session into the target group**

In the group you want to relay **into**, send `/relay`. A card pops up listing **your active sessions, as owner, for the same bot in other groups**. Pick one to pull it over.

**2. `/relay --create` (create-group mode) — "move" the current session to a new group**

In the current session, send `@botA @botB /relay --create`: this automatically creates a new group, adds all the @-mentioned bots into it, and relays the current session (along with the @-mentioned collaborators' sessions in this topic) over together.

```bash
/relay                      # In the target group: pull one of your remote sessions over
@Claude @Codex /relay --create   # Move the current session to a newly created group, bringing collaborators
```

## The post-relay notice

After a successful relay, the new group receives something like:

> 📋 Session relayed from "source group".
> ⚠️ The Lark message history stays in the source group; the AI memory has carried over.
> @ the corresponding bot to continue the conversation.

The streaming card in the source group freezes into an archive (buttons removed, to avoid accidental actions affecting the live session in the new group).

## Limitations

- Picker mode is only available in **regular groups** (a one-on-one chat has no collaborators; topic groups route by topic and have no thread anchor).
- Only the **session initiator (owner)** can relay their own session.
- A session **that is processing (mid-turn) cannot be relayed**; wait until the current turn is idle, then send.
- An external tmux session brought in via `/adopt` cannot be relayed (the CLI lives on your computer and botmux doesn't control its lifecycle).
- If the target group already has an active session for that bot, you must `/close` it first, then relay.
