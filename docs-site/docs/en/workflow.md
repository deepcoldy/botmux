# Workflow (Experimental)

botmux has two workflow engines that share the `botmux workflow` command prefix but serve different purposes:

| Engine | What it is | Entry point | Runs stored in |
|------|--------|------|----------|
| **v3 ad-hoc workflow** (LLM-driven, recommended) | A one-line fuzzy goal → auto-interrogate, orchestrate a DAG, execute concurrently | Feishu `/workflow <goal>` | `~/.botmux/v3-runs` |
| **v0.2 template workflow** (schema-driven) | A hand-written / generated reusable `workflow.json`, run repeatedly | `/template run <id>` | `~/.botmux/workflow-runs` |

> ⚠️ The two engines' runs are **not interchangeable**: `botmux workflow ls / tail / show / resume / cancel` only see v0.2 template runs; the state of a v3 ad-hoc workflow lives in the **Dashboard's v3 view** (every Feishu card carries a "Web details" link straight to it).

## Ad-hoc workflow (v3, recommended)

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

The architect uses these structures when orchestrating (or you declare them in a v0.2 template), so the flow you see at Gate-2 may not be a straight line:

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

Changed your mind: requirement → `botmux workflow revise-spec <runId>` (steps back to re-clarify, old DAG discarded); flow only → `botmux workflow revise-dag <runId>` (re-orchestrate only).

> The three "continue" entry points are not interchangeable: a blocked node uses `retry`, a loop out of iterations uses `grant`; and "revisit budget exhausted" can **only be permitted by tapping the Feishu card — there's no CLI command for it**.

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

## Reusable templates (v0.2)

For a fixed flow you run repeatedly, save it as a template and reuse it:

- Use the `botmux-workflow-create` skill to translate your description into `~/.botmux/workflows/<id>.workflow.json` (an **absolute, global path** — not `./workflows/` under the current directory, since the CLI agent and the daemon don't necessarily share a cwd).
- `botmux workflow validate <path>` validates the definition file.
- Run a template: Feishu `/template run <id> key=value` (real execution on the daemon), or CLI `botmux workflow run <id> --param key=value` (**offline stub — no real worker, end-to-end smoke test only**).

Params: on the CLI use `--param key=value` for scalars and `--param-json key=<json>` for object / array values (e.g. `--param-json tags='["urgent","cn"]'`); IM `/template run` doesn't yet support object / array params. Params are for **business variables** (chat id, mode switches, thresholds) — don't pass a whole task instruction through params; a node's task definition should live in the `workflow.json`.

### Ops & debugging commands for template runs

These commands operate on **v0.2 template runs** (read/write `~/.botmux/workflow-runs`, overridable via `BOTMUX_WORKFLOW_RUNS_DIR`), **don't require the daemon to be online**, and **can't see v3 ad-hoc workflow runs**:

| Command | Description |
|------|------|
| `botmux workflow ls [--all] [--status ...] [--wide] [--json]` | List template runs; non-terminal only by default |
| `botmux workflow tail <runId> [--from N] [--follow] [--json]` | Print a compact event table; `--follow` keeps tailing |
| `botmux workflow show <runId>` | Replay events and print a Snapshot summary JSON |
| `botmux workflow resume <runId>` | Cold-recover from the on-disk runDir (CLI does not spawn new workers) |
| `botmux workflow cancel <runId> [--reason <text>]` | Write cancelRequested and drive cancel recovery |

```bash
botmux workflow ls                         # See which template runs are in flight
botmux workflow tail wf-abc-123 --follow   # Tail a run's event stream
botmux workflow resume wf-abc-123          # Run stuck / restarted → cold recover
botmux workflow cancel wf-abc-123 --reason 'external dependency timed out'
```

## Dev / self-test: `botmux v3 run`

`botmux v3 run <dag.json> [--max-parallel <n>]` runs a **hand-written** v3 dag.json on a real local ephemeral worker pool, with humanGate over terminal y/N and **no Feishu cards**. It's only for developing / debugging v3 orchestration; for a real ad-hoc workflow run, go through Feishu `/workflow` + `start`.

> Workflow is an experimental capability and still evolving. For everyday use, `/workflow <goal>` in Feishu is all you need; the rest of this page is for ops / troubleshooting and orchestration development.
