# Session & Topic Model

The key to understanding botmux is figuring out "which session a given message lands in" — **confusions like "why does every @ feel like a fresh start that lost my context" and "how does a new group pull in history" all trace back to this**.

**Applies to**: when you're unsure which session a message went to, want to control new-vs-reused sessions, or are configuring in-group permissions.

## Three group shapes

| Shape | Behavior |
|------|------|
| **Topic group (THREAD)** | Each new topic = an independent CLI session. Messages within the same topic go to the same session; different topics are isolated from each other. Most recommended. |
| **Regular group (DEFAULT)** | Does not auto-open topics by default. `/t <text>` opens a topic and submits the first task, starting after repository selection when needed; bare `/t` opens the topic setup entry: it shows the repository picker when selection is needed, while a pinned working directory or no selectable project waits for the next task or `/repo` without starting an empty session. |
| **Direct message** | Chat directly with the bot, effectively a single long-running session. |

> When “show a status card while a task runs” is off, `/t <text>` still produces a visible topic reply first so Lark expands the thread immediately; reactions are only progress indicators.

## On-call groups & chat-scope groups

- **On-call group**: `/oncall bind <path>` anchors the entire group to a single project directory, skips repository selection, and any member of the group can ask and get an answer just by @-mentioning the bot. See [On-Call Mode](/en/oncall).
- **chat-scope group**: `/group <group name>` creates a new group in one step, with the entire group acting as a single independent session.

## Session state machine

The status indicator at the top of the streaming card:

- 🟡 **Starting** — the worker is spinning up the CLI process
- 🔵 **Working** — the CLI is thinking/executing, output refreshing in real time
- 🟢 **Ready** — the CLI is idle, waiting for your next message

Each reply creates a **new** streaming card; the previous card freezes at its final state, making it easy to review history.

## The four names of a session

"I renamed it — why didn't the name change in Lark?" A session carries four name layers at once, and each is independent:

| Layer | What it is | Who changes it / how |
|-------|------------|----------------------|
| **Lark group name** (the `oc_` group) | The name of the group itself, visible to everyone in it | Run `botmux chat rename "New group name"` from inside a session (the `botmux-chat-rename` skill; an agent renaming proactively on a phase change adds `--proactive`, with a 10-minute debounce). This renames the **whole group**: in a topic group every topic and every member sees the new name |
| **Lark topic name** (`omt`) | The name a topic shows in Lark's topic list | **Cannot be changed**: the Lark Open Platform has no topic-title API, so the topic list always shows the topic's **first message**. This is a platform limitation — don't expect botmux to rename it |
| **botmux canonical title** | The session title shown across Dashboard views and in the `/sessions` list | Humans send `/rename <title>` in the group (talk access suffices); agents inside a session use `botmux session rename "<title>"` (see below). Up to 200 characters; Dashboard and lists update instantly |
| **CLI-native session name** | The resume-list name kept by Claude Code / Codex / other CLIs | botmux syncs it **best-effort** when renaming; when the CLI is offline or doesn't support native renaming it simply isn't synced, which doesn't affect the botmux title |

`botmux session rename` is the new in-session primitive from this batch:

- It works **only inside a session**; the session id is read solely from the session environment, and it takes **no `--session-id`-style argument** — you cannot rename someone else's session.
- Recommended title shape is "type | subject", e.g. `Debug | payment-link timeout` (the `botmux-session-rename` skill).
- It changes **only the botmux/Dashboard title**: the Lark group name is untouched (that's `botmux chat rename`), and the Lark omt topic name cannot be changed by the platform.

## Permission model (three tiers)

| Tier | Capabilities | Controlled by |
|------|------|---------|
| **Talk (canTalk)** | Ask questions, view logs, read code | Several allow legs: `allowedUsers`, `allowedChatGroups` (everyone in the group), quota-scoped `chatGrants` / `globalGrants`, on-call, open mode; plus the `blockedUsers` global deny |
| **Operate (canOperate)** | Switch directory `/cd`, `/restart`, `/close`, `/card`, `/cot`, `/mention-mode`, click card buttons | `allowedUsers` (owner + admin list); in open mode everyone passes |
| **Management commands** | `/grant` / `/revoke` to authorize others, on-call toggles | owner / admins (`allowedUsers`) |

This tiered model lets you confidently add the bot to an on-call group: everyone can ask, but only admins can change session state, and an external member clicking by mistake won't mess up the session. For the full layer model (quota, expiry, "being added ≠ authorized", block list, grant request cards) see [Permissions & Access](/en/permissions).

## Common confusions

- **"Every @ feels like starting over, losing context"**: in a **topic group**, different topics are different sessions — what feels like a follow-up actually opened a new topic = a new session. To keep going, reply **in the same topic**; to truly reuse one session, see below.
- **A new group / topic can't pull in earlier chat**: a new session starts clean by default. To have it read group history, just say "look at the earlier chat history" (the bot needs group-message read permission, see [FAQ](/en/faq)).
- **Switch the underlying CLI while keeping context**: not possible today — there's **no lossless hot-swap across CLIs**; native session history isn't translated into another CLI. To switch CLIs, start a new bot / session and have the old bot emit a handoff summary. ([`/relay`](/en/relay) moves the **same session** to another group without changing the CLI; [`/adopt`](/en/adopt) attaches an existing local tmux/zellij / resumable session into Lark, also without changing the CLI.)

**Next**: permission details in [Permissions & Access](/en/permissions) and the [FAQ](/en/faq); the mention policy in [Mention Policy](/en/mention-mode); moving a session to another group in [Relay](/en/relay).
