# Feishu Doc Comment Watching (/watch-comment)

Turn a **Feishu/Lark cloud doc** into a session's input/output channel: after subscribing a doc, its **comments** feed into the session as messages, and the bot's replies are posted back into **that comment's thread**.

Without leaving the doc you're working in, `@the bot` in a comment to ask a question or request a change — the reply shows up right in the comment thread. Great for "drive the AI while reading the doc" and in-place collaboration.

## How to use

The shortest path is to mention the bot directly in a doc comment:

- The first mention from the bot owner auto-connects the doc in `mention-only` mode and creates a session anchored at `doc:<fileToken>`.
- A first mention from anyone else auto-connects the doc the same way and replies immediately, but **only after** botmux successfully DMs the bot owner an audit notice (who mentioned the bot, in which doc). If that owner notification fails—or no owner is configured—the reply is refused and the auto-connect is rolled back. This is a notify-not-approve model: the owner is always informed, but the reply is not held for approval. To stop responding in a doc, the owner runs `/watch-comment off <doc link>`.

To bind doc comments explicitly to a Feishu topic, send this inside that topic:

   ```
   /watch-comment <Feishu doc link> [--dir <local project path>] [--all]
   ```

When `/watch-comment <doc link>` is run explicitly, botmux immediately creates a topic session if needed and starts the CLI with a meeting-preparation prompt. The AI reads the document, builds working context, and then waits for comments. Later comments can be answered incrementally, and replies are posted into the original comment thread. With `--all`, a mention is not required.

Only the zero-command path—first mentioning the bot in a previously unknown document—creates a doc-native session anchored at `doc:<fileToken>`.

## `/watch-comment` vs `/subscribe-lark-doc`

- `/watch-comment` is the botmux product capability: watch comments, create or bind an AI session, and post replies back into the comment thread. Its management subcommands (`list`/`off`) are owner-only.
- `/subscribe-lark-doc` keeps its original behavior: require a doc-scoped User Token, call Feishu's per-file subscribe API, and bind the subscription to the current session. It does not own Watch modes.

| Command | Description |
|---------|-------------|
| `/watch-comment <doc link> [--dir <path>] [--all|--mentions-only]` | Create or bind the current topic session, start the CLI immediately, pre-read the doc, and wait for comments |
| `/watch-comment list` | List the current session's watches, or all of this bot's doc-comment watches when no session exists |
| `/watch-comment off [doc link|all]` | Stop one watch or every watch in the current scope |
| `/subscribe-lark-doc <doc link>` | Use a doc-scoped User Token to call Feishu's subscribe API |
| `/subscribe-lark-doc list` / `off` | List or remove the current session's API subscriptions |

> Supports Feishu cloud docs (docx) and Wiki links.

## Interaction model

- **Inbound**: a doc comment (by default requires `@the bot`) → fed into the bound session as a message, equivalent to messaging in a group.
  - Botmux also injects the document URL/file token, selected source text for inline comments, and earlier replies in the same comment thread. When the question depends on the full body, the agent is instructed to read the document with an available Feishu/Lark document tool instead of guessing.
- **Outbound (reply)**: the bot's reply to a doc-comment-triggered turn is posted back into that comment's thread —
  - posted as the **bot's identity** (not yours);
  - `@`-ing the original commenter by default;
  - long replies are auto-split into multiple comments.
- **Status cards / terminal links / buttons**: stay in the real Feishu topic when one is bound. A `doc:`-native session posts no cards and replies only in the comment thread.

One session can subscribe to many docs; one doc binds to a single active session at a time.

## Trigger range (per-bot, configurable in Dashboard)

The default comment trigger range for new subscriptions, configurable per bot in **Dashboard → Bot Defaults**:

| Value | Meaning |
|-------|---------|
| Only comments that `@` me (default) | Triggers only when a comment `@`s the bot — avoids noise |
| Every new comment | Any new comment on the doc triggers — suits dedicated docs |

Maps to the `bots.json` field `docSubscribeDefaultMode` (`"all"` enables "every new comment"; default is "only @").

Automatic first-mention onboarding always starts in `mention-only` mode. Re-run `/watch-comment <link> --all` or use Dashboard to receive every comment.

## Authorization

`/watch-comment` needs no User Token and does not call the per-file subscribe API. `mention-only` receives `@bot` notifications over the app long connection. `all` uses the app identity to incrementally read the comment list every 5 seconds, so ordinary comments can trigger without mentioning the bot. The polling cursor is persisted; registration or the first upgraded run establishes a history baseline instead of replaying old comments.

For `/subscribe-lark-doc`, a doc-scoped User Token remains a hard prerequisite. If it is missing, the command generates its dedicated OAuth link and asks the user to authorize before retrying.

You also need to do two one-time things in the **Feishu Open Platform console**:

1. Under "Permissions", enable the doc-comment scopes (`docs:document.comment:read` / `docs:document.comment:create` / `docs:document.subscription`, etc.) and publish a version;
2. Under "Event Subscriptions", add the **`drive.notice.comment_add_v1` (doc comment added)** event, using long-connection delivery.

If a scope is missing or the event isn't subscribed, the bot DMs the admin during its startup self-check.

## Lifecycle

- `/close` removes `/watch-comment` watches bound to the session; legacy `/subscribe-lark-doc` bindings still call Feishu's unsubscribe API.
- After a daemon restart, active watches and their `--all` incremental cursors are restored automatically.

## Limitations & notes

- **One doc binds to one session**: running `/watch-comment` or `/subscribe-lark-doc` again moves the doc to the current session.
- **`--all` has up to about 5 seconds of latency**: ordinary comments are found by app-identity polling. Real `@bot` comments can still arrive immediately over the long connection, and botmux deduplicates the two paths.
- **Zero-command onboarding depends on event delivery**: if the Open Platform does not push comments from an unwatched doc, the daemon cannot see the first mention. Explicitly run `/watch-comment <doc link>` and verify permissions/event subscriptions; use `/subscribe-lark-doc` when you need to force the per-file Feishu subscribe API.
- **Threaded-reply fallback**: a few comments (e.g. some resolved/restricted ones) don't allow API replies; in that case the bot falls back to creating a new whole-doc comment as the reply, so the answer always lands in the comment area.
- Doc comments are a plain-text channel; rich interactions (cards / buttons / terminal links) still go through the Feishu topic.
