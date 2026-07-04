# Feishu Doc Comment Entry (/subscribe-lark-doc)

Turn a **Feishu/Lark cloud doc** into a session's input/output channel: after subscribing a doc, its **comments** feed into the session as messages, and the bot's replies are posted back into **that comment's thread**.

Without leaving the doc you're working in, `@the bot` in a comment to ask a question or request a change — the reply shows up right in the comment thread. Great for "drive the AI while reading the doc" and in-place collaboration.

## How to use

1. Start a session normally in a Feishu topic (the entry point is unchanged; status cards / terminal links all live here).
2. Subscribe a doc from within the session:

   ```
   /subscribe-lark-doc <Feishu doc link>
   ```

   The first time, the bot guides you through a doc-permission authorization (see "Authorization" below).
3. Then **comment in that doc and @the bot** — the comment feeds into this session as a message; the bot's reply is posted back into **that comment's thread** (as the bot, `@`-ing you back).

| Command | Description |
|---------|-------------|
| `/subscribe-lark-doc <doc link>` | Subscribe the doc; its comments feed into the current session |
| `/subscribe-lark-doc list` | List docs subscribed by the current session |
| `/subscribe-lark-doc off` | Unsubscribe all docs of the current session |

> Supports Feishu cloud docs (docx) and Wiki links.

## Interaction model

- **Inbound**: a doc comment (by default requires `@the bot`) → fed into the bound session as a message, equivalent to messaging in a group.
- **Outbound (reply)**: the bot's reply to a doc-comment-triggered turn is posted back into that comment's thread —
  - posted as the **bot's identity** (not yours);
  - `@`-ing the original commenter by default;
  - long replies are auto-split into multiple comments.
- **Status cards / terminal links / buttons**: still go to the **session origin** (the Feishu topic), not the doc comment (comments are plain text and can't carry rich cards).

One session can subscribe to many docs; one doc binds to a single active session at a time.

## Trigger range (per-bot, configurable in Dashboard)

The default comment trigger range for new subscriptions, configurable per bot in **Dashboard → Bot Defaults**:

| Value | Meaning |
|-------|---------|
| Only comments that `@` me (default) | Triggers only when a comment `@`s the bot — avoids noise |
| Every new comment | Any new comment on the doc triggers — suits dedicated docs |

Maps to the `bots.json` field `docSubscribeDefaultMode` (`"all"` enables "every new comment"; default is "only @").

## Authorization

Subscribing to doc comments needs a **user authorization with DOC permissions** (read/write comments + event subscription), which differs from the generic [`/login`](/en/slash-commands) scopes. On the first `/subscribe-lark-doc`, the bot hands you a doc-scoped authorization link directly — authorize, then resend the command.

You also need to do two one-time things in the **Feishu Open Platform console**:

1. Under "Permissions", enable the doc-comment scopes (`docs:document.comment:read` / `docs:document.comment:create` / `docs:document.subscription`, etc.) and publish a version;
2. Under "Event Subscriptions", add the **`drive.notice.comment_add_v1` (doc comment added)** event, using long-connection delivery.

If a scope is missing or the event isn't subscribed, the bot DMs the admin during its startup self-check.

## Lifecycle

- `/close` automatically unsubscribes all docs bound to the session.
- After a daemon restart, subscriptions for still-active sessions are restored automatically.

## Limitations & notes

- **Per-doc subscription is required**: Feishu cloud-doc events are per-instance — there's no "subscribe once, receive all docs" (even user identity can only subscribe docs it owns/admins, still one at a time).
- **Threaded-reply fallback**: a few comments (e.g. some resolved/restricted ones) don't allow API replies; in that case the bot falls back to creating a new whole-doc comment as the reply, so the answer always lands in the comment area.
- Doc comments are a plain-text channel; rich interactions (cards / buttons / terminal links) still go through the Feishu topic.
