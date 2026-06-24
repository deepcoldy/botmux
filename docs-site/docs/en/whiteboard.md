# Local Whiteboard

Multiple bots / sessions in the same Lark group share a **local markdown whiteboard** that captures the "current project state" (goals / how work is organized / core plan / key progress / next steps) across sessions and bots.

The board is a **latest-state snapshot**: `update` overwrites the whole thing instead of appending history, so a later agent reads the current consensus directly instead of scrolling chat history. It fits multi-agent collaboration, long-task checkpoints, and cross-topic handoff.

> Disabled by default. It's an optional enhancement — when off, no board is created, no session is bound, no prompt is injected, and an agent's read/write commands are rejected.

## Enable / Disable

```bash
botmux whiteboard enable      # turn the capability on (does not create a board)
botmux whiteboard disable     # turn off (existing boards stay on disk; Dashboard can still view them read-only)
botmux whiteboard status      # show enabled state + board count
```

You can also toggle it on the **Dashboard → Settings** page.

**`enable` only turns the capability on — it does not create a board**; a board is created **lazily** the first time a group needs one.

## Sharing Granularity: Per Group

Different bots and working directories in the same group share **one** board by default (binding key `chat:<chatId>:default`). A group is thus a single shared context board — whoever updates it, everyone else sees it on their next turn.

## How Agents Use It

Once enabled, the daemon injects a `<whiteboard>` hint block into each prompt telling the agent the current board id and how to read/write it (**only the board id + commands are exposed, never local file paths**, with a reminder not to store secrets / private data). Recommended flow:

1. Read first to get the content and version:

```bash
botmux whiteboard read --id <id> --json
# { "id": "...", "updatedAt": "2026-...", "content": "..." }
```

2. Merge new information and **rewrite the whole thing** into one complete current state.

3. Write back with the version you just read (optimistic concurrency / CAS):

```bash
botmux whiteboard update --id <id> --expected-updated-at <updatedAt> "the full new state"
```

If another agent changed the board in the meantime, you get `whiteboard_cas_mismatch` (exit code 2) — just re-read the latest content and re-merge.

Agents can also use the `botmux-whiteboard` Skill directly: asking it to "update the whiteboard" or "show the project context" triggers it.

## Concurrency & Safety

- **Serialized writes** — each board has its own file lock, so two agents running `update` at once never produce a half-written file, with dead-lock recovery (the lock auto-expires if the holding process is killed).
- **CAS conflict detection** — `--expected-updated-at` rejects an overwrite when the board changed since you last read it, avoiding silent lost updates; omitting it falls back to a direct overwrite (backward-compatible).
- **Empty content rejected** — writing blank content is refused so a shared board can't be accidentally blanked.
- **No paths / no secrets** — the prompt only exposes the board id and commands, and reminds the agent not to write secrets or private data to the board.

## Dashboard Whiteboard Page

The Dashboard provides a whiteboard page grouped by "group → board":

- The left list is grouped by chat; the right detail panel shows the selected board's metadata and a preview of the current content.
- **Protected deletion** — deleting requires the dashboard token (removes board files + clears index bindings + clears session references).
- The whiteboard read/write API is **not exposed to anonymous read-only visitors** by default (fail-closed), so it never leaks board content or local paths.

## Command Reference

| Command | Description |
| --- | --- |
| `whiteboard status` | Show enabled state + board count |
| `whiteboard enable` / `disable` | Turn the capability on / off |
| `whiteboard list` | List local boards (read-only, works even when disabled) |
| `whiteboard current [--create]` | Show the current group's default board; `--create` creates it on demand |
| `whiteboard read --id <id> [--json]` | Read board.md; `--json` emits `{ id, updatedAt, content }` |
| `whiteboard update --id <id> [--expected-updated-at <ts>] <content>` | Overwrite the current state (content via args / stdin / `--content-file`) |
| `whiteboard write --yes --id <id> <content>` | Force-overwrite escape hatch (requires `--yes`) |
| `whiteboard create [--id ID] [--title T]` | Explicitly create a new board |
