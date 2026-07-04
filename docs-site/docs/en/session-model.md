# Session & Topic Model

The key to understanding botmux is figuring out "which session a given message lands in."

## Three group shapes

| Shape | Behavior |
|------|------|
| **Topic group (THREAD)** | Each new topic = an independent CLI session. Messages within the same topic go to the same session; different topics are isolated from each other. Most recommended. |
| **Regular group (DEFAULT)** | Doesn't auto-open topics by default; use `/t <prompt>` to actively open a new topic (pops up a repository selection card). |
| **Direct message** | Chat directly with the bot, effectively a single long-running session. |

## On-call groups & chat-scope groups

- **On-call group**: `/oncall bind <path>` anchors the entire group to a single project directory, skips repository selection, and any member of the group can ask and get an answer just by @-mentioning the bot. See [On-Call Mode](/en/oncall).
- **chat-scope group**: `/group <group name>` creates a new group in one step, with the entire group acting as a single independent session.

## Session state machine

The status indicator at the top of the streaming card:

- 🟡 **Starting** — the worker is spinning up the CLI process
- 🔵 **Working** — the CLI is thinking/executing, output refreshing in real time
- 🟢 **Ready** — the CLI is idle, waiting for your next message

Each reply creates a **new** streaming card; the previous card freezes at its final state, making it easy to review history.

## Permission model (three tiers)

| Tier | Capabilities | Controlled by |
|------|------|---------|
| **Talk (canTalk)** | Ask questions, view logs, read code | `allowedChatGroups` (everyone in the group) / `globalGrants` (global list) / `/grant` |
| **Operate (canOperate)** | Switch directory `/cd`, `/restart`, `/close`, click card buttons | `allowedUsers` (owner list) |
| **Owner-only** | `/grant` / `/revoke` to authorize others | owner |

This tiered model lets you confidently add the bot to an on-call group: everyone can ask, but only the owner can change session state, and an external member clicking by mistake won't mess up the session.
