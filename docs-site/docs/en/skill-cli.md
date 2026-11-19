# Skill + CLI Interaction

<video src="../img/video-v8-skills-en.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

Inside a botmux session, the AI talks to Lark (sending messages, reading history, creating scheduled tasks…) through two things:

- **The `botmux` command**: added to the CLI's PATH when the session starts. The AI just runs it in the terminal.
- **Skills**: short `SKILL.md` guides that tell the AI when to use which command and how.

```
Lark message ──▶ botmux ──▶ AI inside the CLI
                              │  reads Skills, knows how to reply
                              ▼
Lark topic   ◀── botmux ◀── botmux send "…"
```

So when "the terminal shows output but nothing reaches Lark", the AI usually didn't run `botmux send`. See [FAQ · C](/en/faq#c-terminal-has-output-but-nothing-reached-lark).

## Commands available in a session

When run inside a session, botmux works out which session it is on its own. No session ID needed.

| What you want | Command |
|------|------|
| Send to the current topic (text, images, files, video, cards, @mentions) | `botmux send` |
| Read the session's message history | `botmux history` (inside the topic for topics, the whole group for regular groups; `--limit N` sets the count) |
| Read a quoted message (attachments are downloaded too) | `botmux quoted <message_id>` |
| List bots in the group and their open_id (for `--mention`) | `botmux bots list` |
| Ask people to choose via a button card | `botmux ask buttons --options "a,b" "<question>"` |
| Create / edit / delete scheduled tasks | `botmux schedule ...`, see [Scheduled Tasks](/en/schedule) |
| List this session's Skills, read one in full | `botmux skill list` / `botmux skill show <name>` |

For the full list see [CLI Commands](/en/cli-commands), or run `botmux --help` in a session. Most subcommands support `botmux <subcommand> --help`.

## `botmux send`: decide who to @ every time

`botmux send` must carry one of these three options, or it errors out and sends nothing:

| Option | When to use it |
|------|------|
| `--mention-back` | @ the person who messaged you this turn. Use it when there's a result they should see or decide on |
| `--mention <open_id>` | @ a specific person or bot. Can be repeated |
| `--no-mention` | @ nobody. Good for plain notes or low-priority progress |

```bash
botmux send --mention-back <<'EOF'
Fixed. The change is in src/foo.ts and all tests pass.
EOF
```

A few rules:

- `--no-mention` can't be combined with the other two.
- If more than one person (or bot) took part in this turn, `--mention-back` can't tell who to @ and is rejected. Name someone with `--mention` instead, or use `--no-mention`.
- With `--top-level` (post at the group's top level instead of into the topic), none of these checks apply.
- To drop the "must pick one of three" requirement, set `BOTMUX_REQUIRE_MENTION_DECISION=false`.
- Pass multi-line content with a heredoc (as above) or `--content-file`, not `"line one\nline two"`.

## Don't want the AI to send replies itself?

In three cases botmux sends the final reply to Lark for you, and the AI doesn't need `botmux send`:

| Case | What happens |
|------|------|
| `codex-app` (Codex App protocol) | The final reply is forwarded automatically. Use `botmux send` only for mid-turn progress, attachments, or @-ing another bot |
| `replyDelivery: "transcript"` | botmux takes the last answer of the turn from the CLI's transcript and sends it. The prompt stops mentioning `botmux send` |
| `promptInjection: "none"` (zero injection) | botmux adds nothing to the prompt and injects no Skills; the final answer is sent back automatically |

The last two only work with CLIs whose transcripts botmux can read. See [bots.json](/en/bots-json) for setup.

## Built-in Skills

No install needed; they're there when the session starts:

| Skill | What it covers |
|------|------|
| `botmux-send` | Sending to Lark and choosing who to @ |
| `botmux-history` | Reading message history |
| `botmux-quoted` | Reading a quoted message |
| `botmux-bots` | Listing bots in the group |
| `botmux-schedule` | Scheduled tasks |
| `botmux-chat-rename` / `botmux-session-rename` | Renaming the group / the session title |
| `botmux-handoff` | Handing the task to another bot |
| `botmux-orchestrate` | Long-running projects across multiple bots and topics (hidden when [Multi-topic](/en/multi-topic) is turned off) |

A few more appear only under certain conditions:

- `botmux-ask`: installed only when the CLI has no native question hook, so the AI can ask people via button cards.
- `botmux-whiteboard`: only after the [Whiteboard](/en/whiteboard) is enabled.
- `botmux-chat-manager`: only when the bot has the group-manager feature turned on.
- `botmux-workflow` and friends: with [Workflow](/en/workflow) on, the AI reads them on demand only when it actually runs a workflow, so they don't take up prompt space otherwise.

Note: `botmux-handoff` and `botmux-orchestrate` are Skill names, not commands you can run.

## How Skills reach the CLI

Each CLI accepts Skills differently, and botmux picks the right way automatically:

| CLI | How Skills get there | Affects the CLI you run by hand? |
|------|------|------|
| Claude Code (incl. seed / relay), Cursor, Pi, Oh My Pi | A plugin dir mounted per session (e.g. `--plugin-dir`) | No |
| CLIs with only a global skills dir: Codex, OpenCode, CoCo, TraeX, Kiro CLI, Genius, Grok, etc. | Depends on `skillInjection` (table below) | Not by default |
| Antigravity | No Skills, routing hints only | No |

`skillInjection` only affects the second group:

| Value | Effect |
|------|------|
| `prompt` (default) | Leaves the CLI's global dir alone. A compact Skill list goes into the session prompt, and the AI runs `botmux skill show <name>` to read one in full when needed |
| `global` | Installs the Skill files into the CLI's global skills dir. Most native experience, but you'll also see them when you run that CLI by hand |
| `off` | No Skills, only routing hints and `botmux --help`; the AI figures things out itself |

How to change it:

- One bot: set `"skillInjection": "global"` in bots.json, or change that bot's switch under Dashboard "Skill Management → Delivery".
- Machine-wide default: `botmux skills injection [global|prompt|off|unset]`. With no argument it shows the current value.

Routing hints (which group the AI is in, how to reply) also take different paths per CLI: Claude Code and Genius use `--append-system-prompt`, Grok uses `--rules`, and most other CLIs get them in the first message. The hints follow your language setting.

## Install your own Skills

Besides the built-ins, you can install Skills you wrote or found in the community, then assign them to specific bots.

**1. Install** (on the machine running botmux)

```bash
botmux skills install ./my-skills            # local directory
botmux skills install owner/repo             # GitHub shorthand; a GitHub web URL works too
botmux skills install https://git.example.com/team/skills.git --path skills/foo
```

If a source holds several Skills, pick with `--skill <name>` or install them all with `--all`. `--ref` picks a branch or tag. You can also paste a command like `npx skills add owner/repo` as the source.

**2. Assign to a bot**

- In Lark, send the bot `/skills attach <name>` (owner only), `/skills detach <name>` to remove, and `/skills` to see the current state.
- Or drag and drop under Dashboard "Skill Management → Bot Assignment".

Assignments apply from the **next new session**, and the CLI's own Skills stay available. For a session that's already running, `/restart` it or start a new one.

**3. Day-to-day upkeep**

| What you want | Command |
|------|------|
| See what's installed | `botmux skills list` |
| Update one | `botmux skills update <name>` |
| Remove one | `botmux skills remove <name>` (warns if a bot still uses it; add `--force` to remove anyway) |
| Check for broken installs | `botmux skills doctor` |
| See which Skills a bot will end up with | `botmux skills resolve --bot <name>` |

To give the same set of Skills to several bots, create a "Skill Pack": Dashboard "Skill Management → Skill Packs", or `botmux skills pack create ...`.

Under Dashboard "Skill Management → Delivery" you can also:

- Choose whether to read Skills from the workspace (`.agents/skills` and `.botmux/skills` in the project).
- Set the delivery mode: `Auto` (use the CLI's native channel when possible, otherwise the prompt), `Prompt` (works with every CLI), or `Native` (hand off to the CLI's own Skill mechanism only).

## Rewrite built-in prompts and Skills

If a built-in Skill or prompt doesn't suit you, rewrite or disable it on the Dashboard "Customization" page. You can restore factory defaults or roll back at any time, and export / import your changes for another machine. Changes apply from the next session without restarting the daemon. The command-line equivalent is `botmux customize`.

## How a command knows which session it belongs to

The in-session `botmux` command is `~/.botmux/bin/botmux`. The daemon maintains it on every start, so its version always matches the daemon and you don't need a separate install.

- curl install: this path is the botmux binary itself, and the daemon leaves it alone.
- Other installs: it's a tiny forwarding script that points at the botmux the daemon is using.

As for "which session": when botmux launches the CLI it leaves a marker keyed by process ID. The `botmux` command walks up the process tree to find it, which tells it the session and the turn. If the process has left the tree (e.g. started with `setsid` or `nohup`), read and send commands like history and send fall back to the `BOTMUX_SESSION_ID` environment variable, but commands that need to confirm identity, such as Workflow write operations, refuse to run. So try not to detach commands from the process tree.

## Why Skill + CLI instead of MCP

- **Fast startup, fewer tokens**: the CLI does no MCP handshake on startup, and core commands like `botmux send` / `history` don't depend on MCP at all or take up the tool list. MCP is only started when a plugin actually provides MCP servers and the CLI supports it.
- **Works with almost every CLI**: as long as a CLI can run shell commands, `botmux` works — Claude Code, Codex, Cursor, OpenCode, Antigravity and more.

The Skill layer isn't on every CLI, though: Antigravity, for example, only reads `SKILL.md` inside plugin bundles, so it gets routing hints without a Skill list.
