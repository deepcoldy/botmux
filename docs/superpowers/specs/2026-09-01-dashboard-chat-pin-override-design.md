# Dashboard per-chat Pin override design

## Goal

Resolve #1124 by exposing the existing per-chat streaming-card Pin override in
Dashboard Group Manage. This changes only automatic Pin behavior and never
controls whether streaming cards are sent.

## Existing policy

- pinStreamingCard === true is the bot master switch and defaults off.
- noPinStreamingCardChats is the negative set maintained by
  setChatStreamingCardPin(larkAppId, chatId, enabled).
- Effective Pin is masterEnabled && chatEnabled.
- Dashboard already exposes the master switch under Bot Defaults -> Cards; this
  change adds no second master control.

## API and data flow

Each daemon GET /api/groups row exposes three booleans for its own bot:

~~~ts
pinStreamingCardMasterEnabled: boolean;
pinStreamingCardChatEnabled: boolean;
pinStreamingCardEffectiveEnabled: boolean;
~~~

The daemon accepts PUT /api/chat-pin-streaming-card/:chatId with
{ enabled: boolean }. The dashboard accepts
PUT /api/groups/:chatId/pin-streaming-card/:appId and proxies the same body to
the owning daemon. The daemon delegates to setChatStreamingCardPin, preserving
the existing atomic disk/live update, per-bot serialization, and hot reconcile.
Successful writes invalidate the group matrix and the UI force-reloads it.

## UI

Group Manage renders one Pin row per bot currently in the chat. The row shows
the master state, chat override switch, and effective state. The chat switch
means “allow this chat to inherit the bot master”; it cannot force-enable an
off master. Master-off rows remain editable so an operator may persist the
desired override, but explicitly explain that effective Pin remains off.

The Pin toggle presentation is a shared component used by Bot Defaults and
Group Manage, preventing accessibility and label drift. A failed save rolls
back optimistic chat state and shows an inline error.

## Security and verification

The anonymous public-read group DTO must strip all three policy booleans.
Tests cover daemon state/validation, the real dashboard proxy, aggregation,
redaction, shared component behavior, master-off messaging, rollback, and
forced refresh. Pin reconciliation remains fail-open.
