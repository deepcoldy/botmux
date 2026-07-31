# Botmux

Botmux bridges chat conversations to AI coding command-line tools while keeping
the conversation anchored to the chat where the work started.

## Language

**Agent CLI**:
An AI coding command-line tool that botmux can run on behalf of a chat, such as
Claude Code, Codex, Gemini, Cursor, or OpenCode.
_Avoid_: agent cli, CLI bot

**Bot**:
A chat-visible identity configured to route messages into one selected
**Agent CLI**.
_Avoid_: agent, app

**Session**:
A continuing conversation between one chat anchor and one **Agent CLI**.
_Avoid_: thread, task

**Token Usage**:
Token counts reported by an **Agent CLI** or its persisted transcript for a
**Session**. Token In is the Agent CLI's native input-side total, including
cache read/create tokens when the CLI reports them; Token Out is the native
output-side total. Botmux does not estimate token counts from message text.
_Avoid_: token estimate, cost estimate

**Usage Ledger**:
Append-only daily JSONL files under `~/.botmux/usage/` recording per-turn
**Token Usage** deltas per **Session**. Each record is a self-describing JSON
line (recordId, ts, session/bot/chat context, caller open_id, token deltas
plus cumulative totals). Baselines are anchored at worker spawn so resumed or
pre-botmux transcript history is never recorded. External trackers (e.g.
kaboo) consume this directory; botmux never uploads it anywhere itself.
Zero-delta records with `kind: "ownership"` are written at worker spawn (and
when the CLI-native session id is first learned) so consumers can exclude a
session from their native parsers before its first positive delta lands; they
are markers, not accounting events, and never re-seed baselines.
_Avoid_: usage log, billing database

## Example Dialogue

Dev: "This Bot uses Codex as its Agent CLI."

Domain expert: "Good. When the user replies in the same Session, botmux should
route that reply back to the same Agent CLI conversation."

Dev: "Cursor did not expose Token Usage for this Session."

Domain expert: "Then botmux should say the Token Usage is unavailable, not guess
from the visible text."
