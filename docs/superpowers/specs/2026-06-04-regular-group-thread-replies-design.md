# Regular Group Thread Replies Design

## Background

botmux currently treats regular Lark group chats as chat-scope conversations by default. A top-level `@bot` message in a regular group routes to `scope='chat'` with `anchor=chatId`, so the bot's replies are posted as regular group messages and `botmux history` reads the whole group tail.

That is useful for a "one bot watches the whole group" workflow, but it is noisy for task-oriented conversations. Users often want the bot response to open a focused Lark topic under the triggering message, then keep later replies and history inside that topic.

The repository already supports this shape through `/t` / `/topic`: a regular group message can be forced to thread-scope, anchored at the inbound message id, and `botmux send` will reply with `reply_in_thread=true`. This feature makes that behavior configurable per bot instead of requiring `/t` on every request.

## Goals

- Add a per-bot setting for regular groups: when enabled, top-level addressed messages open a Lark topic under the original message.
- Keep the default behavior unchanged for existing deployments.
- Reuse the existing thread-scope session model and `reply_in_thread=true` send path.
- Let Dashboard users configure the setting per bot.
- Make `botmux history` default to the opened topic for these sessions.

## Non-goals

- No per-chat override in this first version.
- No migration of existing chat-scope sessions.
- No change to topic groups, existing Lark topics, or direct messages.
- No new Lark API primitive beyond the existing message reply API.
- No change to `botmux send --top-level` or `botmux send --into`.

## Configuration

Add an optional boolean to `BotConfig`:

```ts
regularGroupReplyInThread?: boolean;
```

The field is absent by default. Absent or `false` preserves current regular-group chat-scope behavior. `true` means this bot prefers thread-scope sessions for new top-level messages in regular groups.

Dashboard's Bot Defaults page should expose the setting as a per-bot checkbox. It can use the existing `/api/bots/:appId/card-prefs` storage path because that path already persists per-bot behavior toggles to `bots.json` and syncs the in-memory bot registry without a daemon restart.

## Routing Behavior

`decideRouting(larkAppId, message)` remains the single source of truth for inbound Lark message scope:

- Messages with both `root_id` and `thread_id` stay thread-scope with `anchor=root_id`.
- Topic-group top-level messages stay thread-scope with `anchor=message_id`.
- Direct-message top-level messages keep the existing thread-scope behavior.
- Regular-group top-level messages:
  - if `getBot(larkAppId).config.regularGroupReplyInThread === true`, return `scope='thread'` and `anchor=message_id`;
  - otherwise return `scope='chat'` and `anchor=chat_id`.

The existing `/t` force-topic override still works. With the new setting enabled, `/t` is mostly redundant for top-level regular-group messages, but it remains useful and unchanged for compatibility.

## Chat Mode Cache Revalidation

The dispatcher currently has a reverse conversion guard for stale chat-mode cache: if cached mode says "topic" but a force-refresh says the chat is now a regular group, it reroutes the message back to chat-scope.

With `regularGroupReplyInThread=true`, that reroute would undo the configured behavior. The guard should still force-refresh to detect stale cache, but when the fresh mode is `group` it should choose the regular-group default through the new setting:

- setting enabled: keep or set `scope='thread'`, `anchor=message_id`;
- setting disabled: reroute to `scope='chat'`, `anchor=chat_id`.

The forward conversion guard, where an existing stale chat-scope session is detected after a group becomes topic-mode, remains relevant for old chat-scope sessions and should stay intact.

## Session And History Semantics

When the setting is enabled and a regular-group top-level message is addressed to the bot, `handleNewTopic` creates a thread-scope session:

- `session.rootMessageId = message_id`
- `session.scope = 'thread'`
- active-session key uses the message id
- `botmux send` replies to that message with `reply_in_thread=true`
- `botmux history` defaults to thread history for that opened topic

Existing chat-scope sessions are not migrated. If a bot already has an active chat-scope session in a regular group and the setting is later enabled, a new top-level addressed message should open a new thread-scope session instead of being routed into the old chat-scope session. The old session remains resumable/closable through existing mechanisms.

## Dashboard

Add the checkbox under Bot Defaults, near the existing proactive-start / behavior controls:

- Chinese label: `普通群回复开话题`
- Chinese help: `开启后，普通群里 @ 该 bot 的新顶层消息会在原消息下开话题回复；未开启时保持整群会话。`
- English label: `Thread replies in regular groups`
- English help: `When enabled, new top-level @mentions in regular groups open a topic under the original message; when off, regular groups keep the shared chat session behavior.`

The checkbox auto-saves through the existing card-prefs update helper. The `/api/bots` response should include the resolved boolean so the page can render the current state.

## Tests

Focused tests should cover:

- `card-prefs-store` default is false, persists true, removes the key when toggled off, and syncs the in-memory config.
- `decideRouting` / dispatcher routes a regular-group top-level `@bot` message to thread-scope when the setting is enabled.
- The same message continues to route to chat-scope when the setting is unset.
- Stale topic-cache reverse revalidation keeps thread-scope when the setting is enabled and fresh mode is `group`.
- A real Lark topic with `root_id + thread_id` remains thread-scope regardless of the setting.
- `/t` behavior remains compatible.

Validation should run:

```bash
pnpm test -- test/event-dispatcher.test.ts test/card-prefs-auto-start.test.ts
pnpm build
```
