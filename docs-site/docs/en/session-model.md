# Session & Topic Model

The key to understanding botmux is figuring out "which session a given message lands in" — **confusions like "why does every @ feel like a fresh start that lost my context" and "how does a new group pull in history" all trace back to this**.

**Applies to**: when you're unsure which session a message went to, want to control new-vs-reused sessions, or are configuring in-group permissions.

## Three group shapes

| Shape | Behavior |
|------|------|
| **Topic group (THREAD)** | Each new topic = an independent CLI session. Messages within the same topic go to the same session; different topics are isolated from each other. Most recommended. |
| **Regular group (DEFAULT)** | By default, top-level @mentions reply flat and reuse the group session, while user-created native topics are isolated (`chat-topic`). A per-chat reply mode can make the group fully flat, use topic UI with shared context, or open a fresh topic every time. `/t <text>` always forces a new topic. |
| **Direct message** | Chat directly with the bot, effectively a single long-running session. |

> When “show a status card while a task runs” is off, `/t <text>` still produces a visible topic reply first so Lark expands the thread immediately; reactions are only progress indicators.

## Per-chat reply modes for regular groups

| Mode | Top-level reply | Session and context |
|------|------|------|
| `chat` | Flat in the group | One session for the whole group; native topics fold back into it too |
| `chat-topic` | Flat in the group | Shared top-level session, isolated native-topic sessions (default) |
| `topic` / `shared` | A thread under the trigger | Display-only change; the whole group still shares one session |
| `new-topic` | A new thread under the trigger | Every top-level @mention gets an isolated session and context |

The effective priority is “this bot's per-chat override > this bot's `regularGroupReplyMode` > `chat-topic`.” For example, if Agent1 defaults to `chat` and only Group A overrides to `new-topic`, every other group inherits `chat`. Choosing “Inherit bot default” for A clears its override, after which A follows later changes to Agent1's default too. A concrete selection remains pinned instead. Native topic groups do not participate in this precedence and always reply independently in the current topic.

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

## Common confusions

- **"Every @ feels like starting over, losing context"**: in a **topic group**, different topics are different sessions — what feels like a follow-up actually opened a new topic = a new session. To keep going, reply **in the same topic**; to truly reuse one session, see below.
- **A new group / topic can't pull in earlier chat**: a new session starts clean by default. To have it read group history, just say "look at the earlier chat history" (the bot needs group-message read permission, see [FAQ](/en/faq)).
- **Switch the underlying CLI while keeping context**: not possible today — there's **no lossless hot-swap across CLIs**; native session history isn't translated into another CLI. To switch CLIs, start a new bot / session and have the old bot emit a handoff summary. ([`/relay`](/en/relay) moves the **same session** to another group without changing the CLI; [`/adopt`](/en/adopt) attaches an existing local tmux/zellij / resumable session into Lark, also without changing the CLI.)

**Next**: permission details in [FAQ · permissions](/en/faq); moving a session to another group in [Relay](/en/relay).
