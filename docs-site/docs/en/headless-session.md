# Headless Automation Sessions

`botmux session` lets scripts, CI jobs, or scheduled jobs start an AI session **without a Feishu group**: send a prompt, wait for it to finish, and read the result. When people need to see it, one command publishes the session to a new group or binds it to an existing group / topic, and the conversation continues in Feishu.

Good fits:

- In CI, let the AI review code first, and only open a group to notify people when something is wrong;
- Run batch analysis from a script when you only want the text result and no chat noise;
- Do the investigation in the background, then hand the team "the existing context + a summary" in one go.

> How the two command sets relate: `botmux session` is the **stable, automation-facing entry point**; `botmux headless` is the layer underneath. Prefer `session` in scripts. Use `headless` when you need finer control (for example, post one turn's result without moving the session).

## Three steps

Prerequisite: the botmux daemon is running on this machine (`botmux start`).

```bash
# 1. Start a session, run the first turn, and wait for it
botmux session start --headless --bot <bot-name> --working-dir ~/repo \
  --prompt-file task.md --json > start.json
SID=$(jq -r .sessionId start.json)       # session ID, starts with hl_
jq -r '.output.content' start.json       # reply to the first turn

# 2. Optionally ask follow-ups, or fetch the result again
botmux session send "$SID" --prompt-file followup.md --wait --json
botmux session result "$SID" --json

# 3. Hand it to people: create a group and publish the session there
botmux session publish "$SID" --create-group --name "Dependency upgrade check"
```

Step 3 does three things:

1. Creates a new Feishu group with this bot (with `--chat-id` it uses an existing group instead);
2. Opens a topic in the group and **moves** the session into it;
3. Asks the AI to **summarize the context so far** (what was done, key findings and evidence, open questions, suggested next steps), then posts the summary in the topic.

From then on, replying in that topic talks to **the same session with the same memory**.

## Session IDs

Starting a session gives you two IDs; commands accept either:

| ID | Looks like | Notes |
|---|---|---|
| Session ID (`sessionId` / `headlessId`) | starts with `hl_` | Save this one in scripts |
| botmux session ID (`botmuxSessionId`) | UUID | Same ID you see in `botmux ls` and other commands |

`botmux headless` subcommands also accept an ID prefix (it must match uniquely); `session publish` needs the full ID.

## `session` commands at a glance

| I want to… | Command |
|---|---|
| Start a session and run the first turn | `botmux session start --headless --bot <bot> [--working-dir <dir>] --prompt-file <path>` |
| Send another turn to a session | `botmux session send <id> --prompt-file <path> [--wait]` |
| Wait for the current turn to finish | `botmux session wait <id> [--trigger-id <triggerId>]` |
| Check the result now (no waiting) | `botmux session result <id> [--trigger-id <triggerId>]` |
| List headless sessions on this machine | `botmux session list [--bot <larkAppId>]` |
| Bind to an existing group / topic | `botmux session bind <id> --chat-id <oc_xxx> [--into <om_xxx>]` |
| Summarize and publish to a new group | `botmux session publish <id> --create-group --name "Task name"` |
| Summarize and publish to an existing group | `botmux session publish <id> --chat-id <oc_xxx> [--name "Topic title"]` |
| Model-only structured call | `botmux session invoke <start\|result\|cancel\|capabilities> --bot <larkAppId>`, see below |

Every command supports `--json`, which prints JSON that is easy to parse with `jq`. Without it you get compact text:

- `start`: the first line is the session ID, followed by the reply;
- `send --wait` / `wait` / `result`: the reply when finished, otherwise the state (such as `running`);
- `publish`: the first line is the group ID, the second is the `triggerId` of the summary turn.

`send` / `wait` / `result` / `list` / `bind` (and `create` / `run`) are passed straight through to the matching `botmux headless` subcommand with the same arguments.

## Common options

| Option | Used by | Notes |
|---|---|---|
| `--bot` | `start` | Bot name or larkAppId. Optional when only one daemon is online on this machine; required when there are several |
| `--working-dir` | `start` | Working directory for the session. Defaults to the bot's default directory, then the daemon's current directory |
| `--prompt-file` / `--prompt` | `start` / `send` | Where the prompt comes from, pick one; with neither, it is read from stdin. `--prompt-file -` also means stdin |
| `--model` | `start` | Model for this session |
| `--reasoning-effort` | `start` | Reasoning effort: `low` / `medium` / `high` / `xhigh` / `max` / `ultra` |
| `--timeout` | `start` / `send` / `wait` | **Maximum seconds the command waits**, 1–86400, default 300 |
| `--name` | `start` / `publish` | In `start`, the session title; in `publish --create-group`, the group name (required), also used as the topic title |
| `--trigger-id` | `wait` / `result` | A specific turn; defaults to the latest one |
| `--json` | all | Print JSON |

> `--timeout` only controls how long the command waits. When it runs out, the command exits normally while the AI **keeps working**; fetch the result later with `session wait` or `session result`. With `--json`, a timed-out result includes `"timedOut": true` and the state is still `running`.

Result states (`state`):

| State | Meaning |
|---|---|
| `running` | Still running |
| `completed` | Done; the reply is in `output.content` |
| `failed` | Failed |
| `interrupted` | Interrupted |
| `not_found` | No such session or turn |

Exit codes: non-zero when the state is `failed` or `not_found`; 2 for invalid arguments.

> When `session start` fails (non-zero exit), it prints the raw JSON from the underlying `headless run`, not the compact format above; the session ID is in `created.headlessId`.

## Publish and bind: hand it to people

| I want to… | Use | Where the session goes | What the group sees |
|---|---|---|---|
| Hand it to the team with a summary first | `session publish` | Moved into a new topic | Topic title + a fresh summary from the AI |
| Move it into an existing topic | `session bind --into <om_xxx>` | Moved into that topic | The latest reply |
| Move it into an existing group as a new topic | `session bind --chat-id <oc_xxx>` | Moved into a new topic (titled with the session title) | The latest reply |
| Post one turn's result without moving the session | `headless publish` | Stays in the background | That turn's reply |

Notes:

- **The bot must be in the target group**, or the post fails. With `--create-group`, the bot creates the group itself and invites the first user in that bot's `allowedUsers`.
- A group made by `--create-group` is bound to the session's working directory, so new topics in that group start there too.
- To change what the summary asks for, `publish` accepts `--summary-prompt "<text>"` or `--summary-prompt-file <path>` to replace the default summary prompt.
- The session must be **idle** to be moved. If the AI is in the middle of a turn, the move is refused; try again after the turn ends.
- What moves is the same CLI process and the same memory — the same mechanism as [Session Relay](/en/relay).
- `bind` re-posts the latest reply into the group by default. In that case the latest turn must be finished and have a reply, or the bind is refused; add `--replay none` to skip the re-post.

## `botmux headless`: the lower layer

Use it directly when you need finer control.

| Subcommand | What it does |
|---|---|
| `create` | Create a session without sending a prompt. Accepts `--bot` `--title` `--working-dir` `--model` `--reasoning-effort` |
| `run` | Send one turn. Without `--session` it creates a session first; it only waits with `--wait` |
| `send --session <id>` | Send a turn to an existing session (the ID can also be the first argument) |
| `wait <id>` | Wait for a turn to finish, 300 seconds max by default |
| `result <id>` | Check a turn's result now |
| `list` / `ls` | List sessions; filter with `--bot <larkAppId>` |
| `publish <id>` | Post one turn's result as text to a group: `--chat-id` picks the group (defaults to the bound group), `--into <om_xxx>` replies in a topic |
| `bind <id> --chat-id <oc_xxx>` | Move the session into a group, see below |

`bind` options:

| Option | Default | Notes |
|---|---|---|
| `--scope thread\|chat` | `thread` | `thread`: a topic session; `chat`: the whole group is the session |
| `--into <om_xxx>` | none | Bind to the topic this message belongs to. Without it, a title message is posted to start a new topic. Required with `--scope chat` (as an anchor message) |
| `--title` | session title | Title of the new topic |
| `--replay latest\|none` | `latest` | Whether to post the latest reply (or the turn given by `--trigger-id`) into the group |

`session start` is equivalent to `headless run --wait --json`, with the output reshaped into a shorter JSON (`sessionId`, `triggerId`, `state`, `output`; the full raw response is in `raw`).

## `session invoke`: model-only structured calls

This is a different mode: **no agent loop, no tools at all** — the model just returns a structured result that matches your JSON Schema. Good for "ask once, get JSON" tasks such as classification or extraction.

```bash
botmux session invoke capabilities --bot <larkAppId>      # check whether this bot supports it
botmux session invoke start  --bot <larkAppId> --request-file req.json --wait-ms 60000
botmux session invoke result --bot <larkAppId> --request-id job-001 --wait-ms 30000
botmux session invoke cancel --bot <larkAppId> --request-id job-001
```

Example `req.json`:

```json
{
  "requestId": "job-001",
  "prompt": "Is this log a network timeout? ...",
  "model": "<model-name>",
  "deadlineMs": 60000,
  "outputSchema": {
    "type": "object",
    "properties": { "timeout": { "type": "boolean" }, "reason": { "type": "string" } },
    "required": ["timeout", "reason"],
    "additionalProperties": false
  }
}
```

Key points:

- `--bot` must be the **larkAppId** here.
- The requirements are strict: the bot must be a dedicated [Core-only](/en/api-core-only) bot without sandbox, extra env vars, and so on; only some CLIs support it so far (Claude Code, Codex, OpenCode, Pi, and a few others). The `supported` field from `capabilities` is the source of truth.
- `deadlineMs` (100–300000) actually stops inference when reached; `--wait-ms` (up to 300000) only controls how long the command waits.
- The schema supports a small set of keywords (`type` `properties` `required` `additionalProperties` `items` `enum` `description`); objects must list every property in `required` and set `additionalProperties: false`.
- Output is always one line of JSON. Exit code is 0 when the state is `running` or `completed`, otherwise 1.

## FAQ

**I get `no online botmux daemon` or `daemon not online for bot ...`.**
The daemon for that bot isn't running. Run `botmux start`, then check with `botmux status`.

**I get `multiple daemons online; pass --bot`.**
Several bots run on this machine; pick one with `--bot` on `start`.

**Does the session post anything in Feishu?**
No. Until it is published or bound, the session has no group: no cards, no messages, results are only available through the commands. These turns are also outside what the [Turn Results](/en/turn-results) API collects.

**How does this relate to HTTP triggers?**
Under the hood, `botmux headless` sends the local daemon a task request with `source.type` set to `headless`. To call the HTTP API directly, see [Trigger botmux Tasks via API](/en/api-task-trigger).

**`publish` failed. Is the session still there?**
Yes. `publish` runs "create group → bind → summarize → post the summary" in order and stops with an error at the step that fails. If binding already succeeded, the session is already in the group's topic; just continue there.

## Related

- [Session Relay](/en/relay): move sessions between groups, topics, and DMs
- [Trigger botmux Tasks via API](/en/api-task-trigger): start tasks and fetch results over HTTP
- [Core-only (apiOnly) API Control](/en/api-core-only): botmux with only the HTTP API, no Feishu
- [CLI Commands](/en/cli-commands)
