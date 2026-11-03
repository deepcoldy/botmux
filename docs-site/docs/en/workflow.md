# Workflow (Experimental)

One fuzzy goal → auto-interrogate, orchestrate a DAG, execute concurrently; a flow that works can be saved as a **Saved Workflow** and reused. Runs are stored in `~/.botmux/v3-runs`; their state lives in the **Dashboard's v3 view** (every Feishu card carries a "Web details" link straight to it).

> ⚠️ Workflow is **off by default**. Turn on the "Workflow" switch on the Dashboard settings page, or set `BOTMUX_WORKFLOW_ENABLED=true`. While it is off, ad-hoc orchestration and running/saving Saved Workflows are refused, but in-flight runs can still be managed with `botmux workflow cancel / retry / grant`.

## Ad-hoc workflow

### How to use it

State your goal in the Feishu topic, or send `/workflow <goal>` explicitly (equivalent to `/workflow new <goal>`). The bot walks you through end to end, one question at a time in the current topic — all you do is answer and confirm:

1. **Interrogate (grill)**: the bot asks one question at a time, each with a recommended default. Say "use the defaults / stop asking" any time.
2. **Gate-1: confirm the requirement**: the bot gives you a summary (which steps, what each produces, acceptance criteria, explicit non-goals) and you confirm.
3. **Auto-orchestrate the DAG**: the system compiles the requirement into an executable dependency graph.
4. **Gate-2: confirm the flow**: the bot explains the nodes, the dependency order, and which nodes pause for approval at execution time; confirm and it starts.
5. **Concurrent execution**: nodes run concurrently in dependency order (up to 4 at a time by default), popping cards in the topic as needed (see below).

### What you'll encounter once it's running (human-in-the-loop)

Once nodes start, these card types may pop in the topic for you to handle:

- **Approval card**: a node marked for approval at authoring time (e.g. an outbound send) pops a card **before** doing its work — you tap "✅ Approve / ❌ Reject". Options and approvers are customizable.
- **Mid-run question**: if a node needs you to decide or supply information partway through, it pops a card — a multiple choice (buttons) or a fill-in-the-blank (text input). Once you answer, it re-runs that step with your answer and continues.
- **Grant another loop iteration**: when a rework loop (see below) hits its iteration cap without passing, a card asks whether to "➕ grant 1 more round"; if you don't, it stays blocked.
- **Permit a revisit**: when downstream sending an upstream node back for redo hits its budget cap, a card asks whether to "➕ permit one more revisit".
- **Node retry**: when a node is blocked by a contract / semantic problem, a card lets you tap "🔄 Retry" to re-run it as a fresh attempt.

> These cards persist to disk — they survive a daemon restart (and get re-posted), so no approval is lost on a restart.

### What a workflow can express (node capabilities)

The architect uses these structures when orchestrating, so the flow you see at Gate-2 may not be a straight line:

- **Sequential dependencies + concurrency**: nodes with no dependency run in parallel.
- **Conditional branching**: after a node produces a structured result, downstream edges activate by that result — only the matched branch runs; un-taken branches are skipped at zero cost; multiple upstreams can join by "all / any / quorum".
- **Structured rework loop**: model "fix it until it passes" as a loop node (e.g. `code → test` repeated until the test passes); at the iteration cap it pauses to ask whether to grant more rounds.
- **Automatic revisit**: when downstream finds an upstream product inadequate, it can send the upstream (and its downstream cone) back for redo, carrying a "why / what was wrong" note; a budget cap prevents infinite loops.

### Intervening mid-run (CLI)

Besides tapping cards, you can drive it by command (`runId` is the key throughout):

| Command | Effect |
|------|------|
| `botmux workflow start <runId>` | After approve-dag, hand to the daemon to run (with Feishu approval cards) |
| `botmux workflow retry <runId> [--node <id>]` | Re-run a blocked node |
| `botmux workflow grant <runId> [--loop <id>]` | Grant one more round to a loop that ran out of iterations |
| `botmux workflow cancel <runId> [--reason <text>]` | Cancel an in-flight run |

Changed your mind: requirement → `botmux workflow revise-spec <runId>` (steps back to re-clarify, old DAG discarded); flow only → `botmux workflow revise-dag <runId>` (re-orchestrate only).

> The three "continue" entry points are not interchangeable: a blocked node uses `retry`, a loop out of iterations uses `grant`; and "revisit budget exhausted" can **only be permitted by tapping the Feishu card — there's no CLI command for it**.

### Hand nodes to bots in the chat (experimental, off by default)

By default each node runs in a temporary CLI process the daemon starts and discards. The Dashboard's global settings have an experimental switch next to "Enable the workflow feature": **Hand workflow nodes to bots in the chat**. When it is on:

- **Only runs approved afterwards are affected**: the executor is frozen into the run at Gate-2 approval (or Saved Workflow launch); runs already in flight keep theirs.
- **One topic per node**: the main bot posts a node card as a new topic (no mention), then a handoff card in it that mentions the bot executing the node (the main bot itself when none is assigned). The handoff lists the goal, acceptance, inputs (upstream products arrive as attachments), required outputs, deadline and the exact submit command; the node card is updated in place as the node progresses.
- **Completion is the structured submission**: the bot runs `botmux report --dispatch-root <handoff message id> --status completed --output <key>=<path> --result-file result.json --content-file summary.md`; the node completes only when it validates, otherwise the command lists what is missing and the bot can resubmit in the same turn. `--status blocked "reason"` blocks the node. Files are capped at 4 MiB each and 8 MiB per submission — put branch names or links for bigger products into result.json.
- **The node's session only does that node**: it is not offered the workflow skills or the skills that pass work on to other bots (`botmux-orchestrate`, `botmux-handoff`), and `botmux skill show` refuses them. Two exceptions: an existing session reused for a handoff in the main topic (it loaded them when it started), and CLIs whose skill injection is set to the global directory (the files live in a directory shared by every session on the host).
- **Timeouts and cancellation** stop the executing bot's current turn (its session is kept).
- **Who executes which node**: telling the grill "let the docs bot do this step" records a named bot (`assignee`) on that node, and the architect must use it; every other node gets a bot the architect picks from the bots currently usable in the chat (in the chat, online, supported CLI) with a one-line reason, defaulting to the main bot when unsure. The Gate-2 summary lists "node → bot (CLI): reason" and marks with ⚠️ every named bot that cannot be used (not in the chat, offline, no bot of that name). Change an assignment by revising the spec.
- **"Reassign" on the blocked card**: when a node is blocked, its blocked card has a "reassign" picker listing the bots approved for this run that are usable now. Only the person who started the workflow can confirm; the node then runs as a new attempt on the new bot. Bots that were not approved for the run cannot be picked yet.
- Private-chat runs, runs without a topic root, or a disabled multi-topic switch keep temporary processes; the approval says why. Approval is refused (with a per-node reason) when a node's bot is not configured on this host, not in the chat, offline, cannot get the in-chat collaboration grant, or (in a normal group) folds topics into one group session (reply mode chat / shared); nodes with directory outputs are refused too. Bots are never added to chats automatically. `approve-dag --working-dir` is not supported in this mode yet. A submission made while the main bot is offline is staged and committed when it comes back.

### Limits

- An ad-hoc workflow's nodes can currently only use bots on the **claude-code / codex / seed** CLIs; orchestrating to a bot on another CLI errors out at startup.
- The `host` node (deterministic side-effect nodes like feishu-send that don't route through an LLM) is reserved in the schema but not yet enabled — all products are produced by `goal` (LLM) nodes.
- `botmux workflow start` is the real run path with Feishu approval cards; `botmux v3 run` is the dev-terminal path (see the last section) without approval cards.

### The underlying state machine (advanced)

Under the hood an ad-hoc workflow is a state machine driven by a series of `botmux workflow` subcommands — usually invoked by the bot, but you can drive them by hand when troubleshooting:

| Command | State transition |
|------|----------|
| `botmux workflow new "<goal>"` | Create the run, returns `runId` / `specPath` → `grilling` |
| `botmux workflow spec-finalize <runId>` | Validate spec.md → `spec_ready` |
| `botmux workflow approve-spec <runId>` | Gate-1 passed → `spec_approved` |
| `botmux workflow architect <runId>` | Orchestrate and validate the DAG → `dag_ready` |
| `botmux workflow approve-dag <runId>` | Gate-2 passed → `dag_approved` |
| `botmux workflow start <runId>` | Hand to the daemon to drive execution |

## Save and reuse (Saved Workflow)

Once an ad-hoc workflow works, save it as a Saved Workflow and rerun it with different params:

| Entry point | What it does |
|------|------|
| Feishu `/workflow save last [name]` / CLI `botmux workflow save [last\|runId] [name]` | Save the latest (or a given runId) run as a Saved Workflow |
| Feishu `/workflow run <name> [key=value ...]` / CLI `botmux workflow run <name\|workflowId> [--param key=value ...]` | Run a Saved Workflow |
| Feishu `/workflow list` / CLI `botmux workflow list [--json]` | List saved workflows |
| Feishu `/workflow show <name>` / CLI `botmux workflow show <name\|workflowId>` | Show a definition |

Params: on the CLI pass scalars with `--param key=value` and objects / arrays with `--param-json key=<json>` (e.g. `--param-json tags='["urgent","cn"]'`). Params are for **business variables** (chat id, mode switches, thresholds); don't pass a whole task instruction through params — a node's task definition belongs in the workflow itself.

## Legacy v2 templates (retired)

The v2 template runtime is retired: `/template run`, `botmux workflow ls / tail / resume / validate` and friends now fail with an error. If you still have old `~/.botmux/workflows/*.workflow.json` definitions or historical runs, use the offline tools:

| Command | Description |
|------|------|
| `botmux template migrate-v3 [workflowId\|path ...] [--all]` | Dry-run by default; `--commit` converts eligible v2 definitions into v3 Saved Workflows |
| `botmux template archive-runs [--commit] [--verify <archiveId\|path>]` | Scan, archive or verify terminal v2 runs; never executes a v2 workflow and never deletes history directly |

## Dev / self-test: `botmux v3 run`

`botmux v3 run <dag.json> [--max-parallel <n>]` runs a **hand-written** v3 dag.json on a real local ephemeral worker pool, with humanGate over terminal y/N and **no Feishu cards**. It's only for developing / debugging v3 orchestration; for a real ad-hoc workflow run, go through Feishu `/workflow` + `start`.

> Workflow is an experimental capability and still evolving. For everyday use, `/workflow <goal>` in Feishu is all you need; the rest of this page is for ops / troubleshooting and orchestration development.
