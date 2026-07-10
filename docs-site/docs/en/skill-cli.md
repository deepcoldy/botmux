# Skill + CLI Interaction

When a CLI enters a botmux session, it automatically gets `~/.botmux/bin` in its PATH, along with a set of ready-to-use Skills. This is the channel through which a CLI agent can **proactively** interact with a Lark topic.

## Out-of-the-Box Capabilities

| Command / Skill | Purpose |
|------|------|
| `botmux send` | Send a message to the current topic (text / image / file / interactive card JSON / @mention) |
| `botmux history` | Read the current session's message history (topic groups pull within the topic; regular groups pull the whole group) |
| `botmux quoted <message_id>` | Read the quoted message (when a user @-mentions the bot via the quote UI) |
| `botmux bots list` | List the bots in the current group and their open_id (for `--mention`) |
| `botmux schedule` | Create, list, update, and delete scheduled tasks |

These capabilities are injected via `--append-system-prompt` plus Skill descriptions that automatically guide the agent to use them.

## Why Skill + CLI Instead of MCP

Compared with Anthropic's official MCP-based approach, the Skill + CLI combination:

- The CLI **doesn't need an MCP handshake** on startup, and doesn't consume tool-list tokens
- It is **universal** across Claude Code / Codex / Cursor / Gemini / OpenCode / Antigravity — all it needs is a CLI that can read a system prompt and run shell commands; it doesn't depend on any MCP protocol support

## Wrapper Mechanism

In-session commands rely on the wrapper script at `~/.botmux/bin/botmux`, which the daemon writes automatically at startup and adds to the worker's PATH, so its **version always matches the daemon** (no separate `npm i -g` needed). Session info is inferred automatically from ancestor-process markers, so the agent doesn't need to pass a session id manually.
