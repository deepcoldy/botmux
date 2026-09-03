# Skill + CLI Interaction

When a CLI enters a botmux session, it automatically gets `~/.botmux/bin` in its PATH, along with a set of ready-to-use capabilities. This is the channel through which a CLI agent can **proactively** interact with a Lark topic — and "terminal has output but nothing was sent to Lark" usually traces back to the model not using this channel (see [FAQ · C](/en/faq#c-terminal-has-output-but-nothing-sent-to-lark)).

## Out-of-the-Box Capabilities

Inside a session the agent can call these `botmux` subcommands directly (session info is inferred, no id to pass):

| Command | Purpose |
|------|------|
| `botmux send` | Send a message to the current topic (text / image / file / interactive card JSON / @mention) |
| `botmux history` | Read the current session's message history (topic groups pull within the topic; regular groups pull the whole group) |
| `botmux quoted <message_id>` | Read the quoted message |
| `botmux bots list` | List the bots in the current group and their open_id (for `--mention`) |
| `botmux schedule` | Create, list, update, and delete scheduled tasks |

> These are the most-used set; the real command surface is larger (e.g. `botmux ask` for interactive questions, and workflow / goal / dispatch orchestration entry points) — see `botmux --help` and the injected Skill catalog for the full list. Handoff / orchestration are separate **Skills** (`botmux-handoff` / `botmux-orchestrate`), which are Skills, not executable subcommands.

### The @-decision hard gate on `botmux send`

A `botmux send` **must carry an @-decision**, or it refuses to send: `--mention <openId>` (name someone), `--mention-back` (@ the triggerer), or `--no-mention` (don't @). `--no-mention` is mutually exclusive with the other two. Only the explicit `--top-level` flag (or globally disabling the gate) is exempt — **ordinary topic / quote replies still have to pick one of the three**. This gate ensures "the ones that should be @-ed aren't missed, and the ones that shouldn't don't spam the group."

## Wrapper Mechanism

In-session commands rely on `~/.botmux/bin/botmux` — **maintained automatically by the daemon at startup** and added to the worker's PATH, so its **version always matches the daemon** and no separate install is needed. What it points at depends on how the daemon itself is running: with a curl install that path **is the self-contained binary** (the daemon detects this and skips rewriting, so it never overwrites itself with a script); with an npm install it's a one-line `exec "<binary inside the platform subpackage>"` shim; in a source checkout it's `exec node <this daemon's dist/cli.js>`. (Dev helpers like `bun run use:here` re-point it manually with identical, idempotent content.)

Session info is inferred automatically from **ancestor-process markers**: when the worker launches the CLI it writes a marker keyed by the child PID (carrying sessionId / turnId), and the agent's commands walk up the process tree to the nearest marker to know which session they belong to — so the agent never passes a session id. If the process tree is broken (detached / `setsid` / deeply nested), it falls back to the `BOTMUX_SESSION_ID` environment variable.

## Injection Mechanism (varies by CLI)

The channel through which routing guidance and the Skill catalog are **injected varies by CLI** — it's not one-size-fits-all:

- **Claude family (claude-code / seed / relay)**: routing / identity via `--append-system-prompt`; Skills via `--plugin-dir` (not stuffed into the system prompt).
- **genius**: both routing and the Skill catalog go through `--append-system-prompt`; **grok** uses its equivalent flag `--rules`.
- **Most other CLIs** (codex / gemini / opencode / cursor / coco / traex, etc.): under the default `skillInjection=prompt` mode, routing and the Skill catalog are **inlined into the first prompt**, consuming no system-prompt flag.

> Skill catalog injection is governed by the per-bot `skillInjection` mode (genius/grok too): `prompt` (default) inlines a compact catalog into the prompt and pulls full text on demand via `botmux skill show <name>`; `global` installs the skill files into the CLI's shared skills dir (your hand-run CLI sees them too); `off` installs no catalog, leaving only routing guidance + `botmux --help`. The `global`/`off` mechanics differ from the "inline" case above.
>
> Injected guidance is generated dynamically per the current locale, so it respects your configured language.

## Why Skill + CLI Instead of MCP

Compared with an MCP-based approach, the Skill + CLI combination:

- The CLI **doesn't need an MCP handshake** on startup, the core `botmux send` / `history` channels have zero MCP dependency, and it doesn't consume tool-list tokens (a gateway only starts when an adapter explicitly opts in *and* a plugin actually contributes MCP servers).
- The **shell / routing layer is universal** — as long as a CLI can read a system prompt and run shell commands, `~/.botmux/bin/botmux` + PATH work, covering Claude Code / Codex / Cursor / Gemini / OpenCode, and more.

> ⚠️ But the **out-of-box Skill layer is not equal across every CLI**: a few (e.g. Antigravity, which only recognizes SKILL.md inside plugin bundles, not a flat `skills/` dir) get routing guidance only, without a Skill catalog. So "universal" holds for the shell/routing channel, and is "most" rather than "all" for the Skill catalog.
