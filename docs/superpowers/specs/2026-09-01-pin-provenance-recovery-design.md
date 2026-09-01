# Streaming-card Pin provenance recovery design

## Goal

Resolve #1125 by recovering safe Pin ownership from Feishu after daemon restart
and during explicit disable reconciliation, without a durable local journal or
risking removal of manual/other-bot Pins.

## Authorization invariant

A remote Pin is Botmux-owned only when its message id is in a request-time
snapshot of a local session's real streamCardId or frozen streaming-card ids,
and Feishu reports operator_id_type === 'app_id' plus operator_id equal to the
current bot app id. Message author, card content, id shape, or later session
state can never broaden that candidate set. Remote discovery only narrows it.

## Lark transport

listChatPins(larkAppId, chatId) calls im.v1.pin.list directly with page_size 50
and explicit page tokens. It returns normalized records and throws on non-zero
or missing response codes, missing/repeated continuation tokens, and SDK errors.
Worker code catches failures per chat, logs debug, and continues; failed lookup
is never represented as a trustworthy empty list.

## Reconciliation

A recovery request freezes active session identity, chat/session, and candidate
ids, groups candidates by chat, and lists each chat once. Exact same-app remote
matches map back to their frozen owner.

- Effective on restores process-local ownership; normal enabled reconciliation
  keeps the current card and retires predecessors.
- Effective off cleans matching ids through the existing per-message queue.
- Existing transition authority remains valid when listing fails; discovery
  augments it and never weakens it.
- Bot-wide off may retry an already opted-out chat only when remote provenance
  proves ownership, addressing a previous failed opt-out Unpin safely.

Startup recovery is queued after restoreActiveSessions and is fire-and-forget.
Startup and explicit disable share the per-bot FIFO. Candidate ids are frozen at
enqueue; no long-lived Pin-list cache is introduced.

## Safety and verification

No-transport sessions make zero list/mutation calls. One chat failure does not
stop other chats. Same-app non-candidates, humans, and other apps are untouched.
Tests cover pagination/error boundaries, provenance intersection, one query per
chat, partial failures, startup on/off behavior, no-transport, and FIFO ordering.
