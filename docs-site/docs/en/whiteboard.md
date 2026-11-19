# Local Whiteboard

The whiteboard is a markdown note stored on your machine. All bots and sessions in the same Feishu group share one. It records where the project stands right now: goals, roles, approach, progress, next steps.

When a new session or a different bot takes over, the agent reads the whiteboard and catches up without scrolling through chat history. Useful for multi-agent work, resuming long tasks, and handing off across topics.

The whiteboard is a **snapshot, not a log**: every update rewrites the whole thing as the latest state. Old content is not kept.

> Off by default. While off, no boards are created, no sessions are bound, nothing is added to prompts, and agent read/write commands are rejected.

## Quick start

1. Turn the feature on (either way):
   - CLI: `botmux whiteboard enable`
   - Dashboard: **Settings → Local Whiteboard → Enable project whiteboards**
2. Start a topic in a group and talk to a bot as usual. When the session starts (or on the next turn after you turn the feature on), a board for that group is created and bound automatically.
3. To have the agent record something, just say "update the whiteboard" or "write the current progress to the whiteboard". To restore context, say "check the whiteboard".
4. View the content on the **Whiteboards** page in the Dashboard.

No daemon restart needed: new sessions and later turns follow the new setting. Turning it on does not create a board by itself; a board is created the first time a session needs one.

## How boards are shared

| Situation | Which board |
| --- | --- |
| Sessions in a Feishu group | One default board per group, shared by every bot and every working directory in that group |
| Not in a group (e.g. running commands from a local terminal) | One board per working directory |
| Adopted local sessions (`/adopt`) | No board is bound automatically |

Once a session is bound to a board it keeps using it. If the board is deleted, a new one is created automatically on that session's next turn.

New boards start from a template that guides the agent to fill in these sections:

```markdown
# 当前状态
## 项目目标
## 组织方式
## 核心方案
## 关键进展
## 下一步
```

(The template is in Chinese: Current state / Goals / Organization / Approach / Key progress / Next steps.)

## How agents read and write

Once enabled, every turn of a session bound to a board gets a `<whiteboard>` block telling the agent the board id and the read/write commands. The block **only contains the id and commands, never the board content or the local file path**, and reminds the agent not to write secrets or private data.

CLIs that support Skills also get the `botmux-whiteboard` Skill, which triggers when the user mentions things like "whiteboard", "project context", or "handoff".

The recommended pattern is "read, merge, write the whole thing back":

1. Read the content and its version:

   ```bash
   botmux whiteboard read --id <id> --json
   # { "id": "wb_...", "updatedAt": "2026-...", "content": "..." }
   ```

2. Merge the new information and rewrite it as one complete current state (don't just append this turn's notes).

3. Write it back with the version you just read:

   ```bash
   botmux whiteboard update --id <id> --expected-updated-at <updatedAt> "new full content"
   ```

   Content can also come from a pipe (`cat note.md | botmux whiteboard update --id <id>`) or `--content-file <path>`, which is easier for long text.

If another agent changed the board in the meantime, step 3 fails with `whiteboard_cas_mismatch` (exit code 2). Run step 1 again to get the latest content and merge again.

Inside a session you can omit `--id`; the session's bound board is used. If `update` finds no board, it creates one using the sharing rules above.

## Protection against bad writes

| Protection | What it does |
| --- | --- |
| Version check | With `--expected-updated-at`, the write is rejected if the board changed since you read it, so you never silently overwrite someone else's update. Without it, the write simply overwrites |
| Write lock | Two agents writing at once are queued, so no half-written file. If the lock holder is killed, the lock is released automatically |
| No empty content | Empty or whitespace-only content is rejected, so the shared board can't be wiped by accident |
| `write` needs confirmation | `write` is a force overwrite and requires `--yes`. Use `update` for normal updates |

There is no version history; overwritten content cannot be recovered. Keep a separate copy of anything important.

## Dashboard Whiteboards page

The **Whiteboards** page in the Dashboard sidebar lists all boards by group (this page's labels are currently shown in Chinese only):

- Boards are grouped by chat on the left. Select one to see its group, scope, last update time, source directory, and a read-only preview of `board.md` on the right.
- **删除白板** (Delete whiteboard) removes the board files and unbinds it from the group and sessions. You must be logged in to the Dashboard, and it cannot be undone.
- Anonymous read-only visitors cannot see the board list or content.
- When the feature is off, the page shows a notice at the top. Existing boards can still be viewed read-only and deleted.

You can reword the `<whiteboard>` prompt on the Dashboard **Customization** page (search for "whiteboard").

## Command reference

| Command | Description |
| --- | --- |
| `botmux whiteboard status` | Show whether it's enabled and how many boards exist |
| `botmux whiteboard enable` / `disable` | Turn the feature on / off. Existing boards stay on disk when off |
| `botmux whiteboard list` | List all local boards (works even when off) |
| `botmux whiteboard current [--create]` | Show the current session's board; `--create` makes one if missing |
| `botmux whiteboard read [--id <id>] [--json]` | Read the content; `--json` prints `{ id, updatedAt, content }` |
| `botmux whiteboard update [--id <id>] [--expected-updated-at <ts>] <content>` | Overwrite with the latest state (content via args / pipe / `--content-file`) |
| `botmux whiteboard write --yes [--id <id>] <content>` | Force overwrite; `--yes` required |
| `botmux whiteboard create [--id <id>] [--title <title>]` | Create a board manually |
| `botmux whiteboard path [--id <id>]` | Print where the board's files live on this machine |

Outside a session, use `--session-id`, `--chat-id`, or `--working-dir` to set the context. When the feature is off, `current` / `create` / `read` / `update` / `write` exit with an error (exit code 2).
