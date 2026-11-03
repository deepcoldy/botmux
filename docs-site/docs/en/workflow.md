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
| `botmux workflow status <runId> [--json]` | Show a running flow's current version, node states and any change awaiting confirmation (used in the run's main topic, normally by the main bot) |
| `botmux workflow edit <runId> --patch-file <file\|-> --base <version>` | Change a running flow: one set of changes that takes effect as a whole or not at all; `--base` is the current version read with `status` (normally used by the main bot, see the next section) |

Changed your mind: requirement → `botmux workflow revise-spec <runId>` (steps back to re-clarify, old DAG discarded); flow only → `botmux workflow revise-dag <runId>` (re-orchestrate only).

> The three "continue" entry points are not interchangeable: a blocked node uses `retry`, a loop out of iterations uses `grant`; and "revisit budget exhausted" can **only be permitted by tapping the Feishu card — there's no CLI command for it**.

### Changing a flow while it runs

Once a run has started its flow can still change: add or remove nodes, change a node's goal / acceptance / outputs / timeout / approval, change dependencies, move a node to another bot, or redo a finished node. Just tell the main bot in the main topic what to change; it reads the current version and submits the change. Every change makes a new version (version 2, 3, …), and the parts of one change take effect together or not at all. When two people change the flow at the same time the first one wins; the main bot re-reads the latest version and resubmits the other.

**Who can change it**

- In the main topic, a change the **initiator** asks for takes effect directly, or becomes a confirmation card under the rules below.
- A change asked for by **anyone else** in the chat always becomes a "flow change" confirmation card for the initiator to approve or reject; nothing changes until then.

**Changes the initiator must confirm**

Any of these posts a "flow change" card in the main topic that only the initiator can decide; everything else takes effect directly:

- Using a bot this run has not approved (in a new node or a reassignment). Once the initiator approves it on the card, the bot is part of the run's approved bots: using it again, or picking it on a blocked card's reassign picker, needs no further confirmation.
- Adding or changing a node with an external action (host nodes such as sending a Feishu message or creating a scheduled task).
- Removing or relaxing a human approval: removing it, changing its options, or changing who may approve. Adding an approval needs no confirmation.
- Raising a budget: a loop's maximum rounds, a timeout longer than the node had, or more than twice as many nodes as were originally approved.

The card lists the nodes added, removed and changed, and any new bots. While it waits, the nodes it touches are not dispatched and everything else keeps running; questions on those nodes cannot be answered and their blocked cards cannot reassign until the card is decided.

**What happens to a node that is running or waiting for approval**

- **Running**: the current round is voided (the process or the bot's current turn is stopped, and anything it submits afterwards no longer counts), and the node starts over with the new definition.
- **Waiting for approval**: that approval card is voided — frozen as "the flow changed, this approval no longer applies" — and the node goes through approval again with the new definition.
- **Blocked**: a definition-only change leaves it blocked for a later retry; a reassignment re-runs it on the new bot right away. If its approval had already passed, a changed definition needs approval again: a retry or reassignment first posts a new approval card and runs only once it is approved. A question it had asked is voided too: the card keeps only "🔄 Re-run with the new definition (needs approval again)", and nothing starts until someone taps it.
- **Not started**: scheduled with the new definition.
- Skipped and cancelled nodes cannot change (add a new node instead); a running loop's body cannot change, but what comes after the loop can.

**A finished node can only be redone**

A finished node cannot be removed or redefined (downstream nodes may already use its products); it can only be redone, or get new nodes after it. Redoing it also re-runs the downstream nodes that used its old products, and spends revisit budget (shared with automatic rework: by default once per node, 8 times per run). When the budget is spent, a "more redo budget" card appears in the main topic: once the initiator taps "➕ Add 1", have the main bot submit the change again. One card is posted per exhaustion; when the budget runs out again a new card is posted, and the old one says it has expired.

**Seeing the version**

- **Progress card**: shows "version N · last change: …"; while a change awaits confirmation it adds "version N awaits the initiator's confirmation; the nodes it touches are paused".
- **Board (Dashboard v3 view)**: drawn from the version in effect; added, changed and pending nodes are marked, and the "flow versions" panel lists each version's time, author, summary and whether it was confirmed.

**Saving as a Saved Workflow**

`/workflow save last` saves the run's **final version in effect** — the flow that actually ran — and the save confirmation card says how many times the run was changed while running. A run started from a Saved Workflow can be changed while running too; that only affects the run. To update the saved definition, save again.

**Both execution modes**

Changing a running flow works whether nodes run in temporary processes or are handed to bots in the chat (next section). For a node handed to a bot, a changed definition or a reassignment sends a new handoff in the same place, saying the requirements changed.

> ⚠️ **Do not downgrade the daemon under a run whose flow was changed.** An older daemon does not know about versions: it ignores the changes and keeps running version 1 — it may run nodes that were removed, run changed nodes with their old definition, and skip changes still waiting for confirmation. If you must downgrade, cancel those runs first or wait for them to finish. Runs whose version on the board is above 1 are the changed ones.

### Hand nodes to bots in the chat (experimental, off by default)

By default each node runs in a temporary CLI process the daemon starts and discards. The Dashboard's global settings have an experimental switch next to "Enable the workflow feature": **Hand workflow nodes to bots in the chat**. When it is on:

- **Only runs approved afterwards are affected**: the executor is frozen into the run at Gate-2 approval (or Saved Workflow launch); runs already in flight keep theirs.
- **One topic per node**: the main bot posts a node card as a new topic (no mention), then a handoff card in it that mentions the bot executing the node (the main bot itself when none is assigned). The handoff lists the goal, acceptance, inputs (upstream products arrive as attachments), required outputs, deadline and the exact submit command; the node card is updated in place as the node progresses.
- **Completion is the structured submission**: the bot runs `botmux report --dispatch-root <handoff message id> --status completed --output <key>=<path> --result-file result.json --content-file summary.md`; the node completes only when it validates, otherwise the command lists what is missing and the bot can resubmit in the same turn. `--status blocked "reason"` blocks the node. Files are capped at 4 MiB each and 8 MiB per submission — put branch names or links for bigger products into result.json.
- **The node's session only does that node**: it is not offered the workflow skills or the skills that pass work on to other bots (`botmux-orchestrate`, `botmux-handoff`), and `botmux skill show` refuses them. Two exceptions: an existing session reused for a handoff in the main topic (it loaded them when it started), and CLIs whose skill injection is set to the global directory (the files live in a directory shared by every session on the host).
- **Timeouts and cancellation** stop the executing bot's current turn (its session is kept).
- **Who executes which node**: telling the grill "let the docs bot do this step" records a named bot (`assignee`) on that node, and the architect must use it; every other node gets a bot the architect picks from the bots currently usable in the chat (in the chat, online, supported CLI) with a one-line reason, defaulting to the main bot when unsure. The Gate-2 summary lists "node → bot (CLI): reason" and marks with ⚠️ every named bot that cannot be used (not in the chat, offline, no bot of that name). Change an assignment by revising the spec.
- **"Reassign" on the blocked card**: when a node is blocked, its blocked card has a "reassign" picker listing the bots approved for this run that are usable now (the ones chosen at approval, plus any the initiator approved on a revision card). Only the person who started the workflow can confirm; the node then runs as a new attempt on the new bot. To move it to a bot outside that set, have the main bot submit a flow revision for the initiator to confirm. While a revision touching the node waits for confirmation, decide that card first.
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
