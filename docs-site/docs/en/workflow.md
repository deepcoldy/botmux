# Workflow (experimental)

Workflow turns a goal that **takes several steps** into a flow that runs on its own:

- the bot first asks you questions, one at a time, until the requirement is clear;
- it then compiles the requirement into a **DAG** (a step graph with dependencies; each step is a "node");
- once you confirm, it runs automatically, with independent steps in parallel;
- a flow that worked can be saved as a **Saved Workflow** and rerun with one command.

It fits tasks with **a clear end and one deliverable**, like "research three competitors and produce a comparison report" or "pull the logs, analyze them, and make charts". You don't need it for single-step questions or ordinary code changes, and it is not meant for long-running projects where several bots keep splitting and coordinating work.

## Turn it on first

Workflow is **off by default**. Turn it on either way:

- Dashboard → "Global settings → Workflow" → enable **"Enable the workflow feature"**;
- or set the environment variable `BOTMUX_WORKFLOW_ENABLED=true`.

The switch takes effect on the next session, no restart needed. If the environment variable is set, it wins and the Dashboard switch has no effect. While it is off, starting an ad-hoc flow, running or saving Saved Workflows, and `botmux goal run` are refused; runs already in flight can still be wound down with `botmux workflow cancel / retry / grant`.

## Quick start: an ad-hoc workflow

Send this in a Feishu topic:

```
/workflow Research pricing of three competitors and put it in a comparison table
```

`/workflow <goal>` is the same as `/workflow new <goal>`. You can also just describe a multi-step task in plain words: the bot will first ask "should I run this as a workflow?" and only starts after you agree. Sending `/workflow` skips that question.

Everything then happens in the current topic. You only answer questions and click confirm:

```
 ① Grill ──▶ ② Confirm spec ──▶ ③ Compile ──▶ ④ Confirm flow ──▶ ⑤ Run
  (Q&A)       (Gate-1)           (DAG)         (Gate-2)          (nodes in parallel)
```

| Step | What happens | What you do |
|---|---|---|
| ① Grill | The bot asks one question at a time, each with a recommended answer | Answer; say "use defaults / stop asking" when it's enough |
| ② Gate-1: confirm spec | The bot summarizes: the steps, what each produces, acceptance criteria, what is out of scope | Confirm, or point out what to change |
| ③ Compile | The system turns the spec into a flow graph | Wait |
| ④ Gate-2: confirm flow | The bot explains the nodes, their order, and which nodes will stop for your approval | Confirm to start |
| ⑤ Run | Nodes run in dependency order; independent ones run at the same time | Handle cards as they pop up (next section) |

Changed your mind?

- The requirement changes → `botmux workflow revise-spec <runId>` goes back to clarification and discards the current flow;
- Only the flow changes → `botmux workflow revise-dag <runId>` recompiles just the flow.

You can follow runs on the Dashboard **"Workflows"** page; the "Web 详情（需登录）" (Web details, login required) button on Feishu cards jumps straight to the run.

## Cards you may see while it runs

| Card | When | Buttons |
|---|---|---|
| Approval card | **Before** a node marked for approval acts (e.g. sending a message out) | "✅ 通过 / ❌ 拒绝" (approve / reject), or custom options; who may approve can be restricted |
| Mid-run question | A node needs your decision or more information halfway | Click an option, or type into the input box; the step reruns with your answer |
| Extend a loop | A rework loop used up its rounds without passing | "➕ 追加 1 轮" (add 1 round); if you don't click, it stays blocked |
| Allow a revisit | The downstream has used up its "send upstream back for rework" budget | "➕ 准许回溯 +1" (allow +1 revisit); if you don't click, it stays blocked |
| Blocked card | A node is blocked, e.g. its output doesn't meet the contract or a permission is missing | "🔄 重试" (retry) reruns the node as a new attempt |
| Progress card | Progress summary of the whole run | "Web 详情（需登录）" |

All of these cards are persisted to disk and survive a daemon restart (or are re-sent), so approvals are never lost.

## What a flow can contain

The compiled flow isn't always a straight line. It can include:

- **Parallelism**: nodes that don't depend on each other run at the same time.
- **Conditional branches**: after a node produces a structured result, only the matching branch runs; the others are skipped at no cost. When several upstreams join, you can require "all done / any done / a quorum".
- **Rework loops (loop)**: "keep fixing until it passes" becomes one loop node, e.g. `write code → run tests` repeated until tests pass. When it hits the round limit it stops and asks whether to add rounds.
- **Automatic rework (revisit)**: a downstream node that finds the upstream output wrong can send the upstream (and its downstream) back for rework with "what's wrong and why". There is a limit to prevent endless loops: 1 per node pair and 8 per run by default.
- **External action nodes (host nodes)**: no model involved, they do one deterministic thing. There are three kinds today: send a message to the chat (`feishu-send`), reply in the topic (`feishu-reply`), and create a scheduled task (`botmux-schedule`). These nodes **always go through an approval card first**, and the card shows the exact content about to be executed; they are never placed inside a loop or a revisit range, so they can't fire twice.

## Save and reuse (Saved Workflow)

Once an ad-hoc workflow finishes, you can save it as a Saved Workflow and run it again later:

| To do this | In Feishu | On the command line |
|---|---|---|
| Save the latest run | `/workflow save last [name]` | `botmux workflow save last [name]` |
| Save a specific run | `/workflow save <runId> [name]` | `botmux workflow save <runId> [name]` |
| Run | `/workflow run <name> [key=value ...]` | `botmux workflow run <name\|workflowId> [--param key=value ...]` |
| List saved ones | `/workflow list` | `botmux workflow list [--json]` |
| Show a definition | `/workflow show <name>` | `botmux workflow show <name\|workflowId>` |
| Cancel a running run | `/workflow cancel <runId>` | `botmux workflow cancel <runId> [--reason <text>]` |

Things to know:

- **Only runs that have stopped can be saved** (succeeded, failed or blocked). If it is still running (or waiting for approval), you'll be told to save after it finishes.
- **The final effective version is saved**: if the flow was edited mid-run, what's saved is the version that actually ran, and the confirmation says how many times it was edited.
- **Where it's saved**: by default it is visible **in this chat only**. To use it in the bot's other chats too, send `/workflow save last <name> --global` yourself in Feishu (you need operate permission on the bot).
- **Parameters**: saving an ad-hoc run directly makes an exact replica with no parameters. To turn concrete values (a region, a date) into parameters, send `/workflow save last <name> --distill` yourself in Feishu: you first get a parameter summary card and the workflow is saved to this chat only after you confirm the whole set. This is still experimental: it currently supports only Claude Code bots on Linux without a launch wrapper, and can't be combined with `--global` or `--ack-unsafe`.
- **Passing values**: in Feishu write `key=value`, and quote values with spaces: `key="multi word"`. On the command line, use `--param key=value` for plain values and `--param-json key=<json>` for objects or arrays, e.g. `--param-json tags='["urgent","cn"]'`. Parameters are for **business variables** (chats, switches, thresholds); the task itself belongs in the flow, not in a parameter.
- **Possibly sensitive content**: if saving detects something that looks like a secret or a local absolute path, it refuses and lists the warnings. Once you've checked it's safe, resend the original command with `--ack-unsafe` at the end. `--global`, `--distill` and `--ack-unsafe` can only be sent by you in Feishu; the bot never adds them for you.
- To start an ad-hoc goal that begins with the word `run`, write `/workflow new run ...`; otherwise it is treated as running a Saved Workflow.
- A run started from a Saved Workflow can also be edited mid-run; that only affects this run. To update the saved definition, save again.

## Intervening from the command line

Besides clicking cards, you can use commands. The `runId` identifies a run throughout and is shown on cards and in the Dashboard. The main bot usually calls these for you in the conversation; you can also use them by hand when troubleshooting:

| Command | What it does |
|------|------|
| `botmux workflow start <runId>` | Hand the run to the daemon after Gate-2 approval (with Feishu approval cards) |
| `botmux workflow retry <runId> [--node <id>] [--reason <text>]` | Rerun a blocked node |
| `botmux workflow grant <runId> [--loop <id>]` | Add one round to a loop that ran out |
| `botmux workflow cancel <runId> [--reason <text>]` | Cancel an in-flight run |
| `botmux workflow status <runId> [--json]` | Show the current version, node states and pending edits |
| `botmux workflow edit <runId> --patch-file <file\|-> --base <version> [--reason <text>]` | Edit the flow mid-run (next section); `--base` is the version read from `status` |
| `botmux workflow ask-human <runId> --node <id> --reason <text>` | Hand a node to a human: stop its current attempt, mark it blocked and post a blocked card |

Don't mix up the three "continue" paths: a blocked node uses `retry`, an exhausted loop uses `grant`; **an exhausted revisit budget can only be released from the Feishu card**, there is no command for it.

## Editing the flow mid-run

After a run starts, the flow can still change: add or remove nodes; change a node's goal, completion criteria, outputs, timeout, approval or dependencies; reassign the executing bot; or redo a finished node.

**How**: tell the main bot in the main topic what to change. It reads the current version and submits the edit.

- Every edit creates a new version (v2, v3, …);
- the items in one edit apply all together or not at all;
- when two people edit at once, the first wins; the main bot reads the latest version and resubmits the later one.

### Whose edits need confirmation

| Who proposed it | Result |
|---|---|
| **The initiator** (asking the main bot in the main topic) | Applies directly. One exception: adding or changing an external action node (send a message, create a scheduled task) needs the initiator to click "Agree" on a "flow edit confirmation" card |
| **Other chat members** | Always becomes a "flow edit confirmation" card; applies only after the initiator clicks "Agree" |
| **The main bot on its own** (including a turn triggered by a scheduled task) | Needs the initiator's confirmation if any rule below matches; otherwise applies directly |

For the main bot's own edits, confirmation is needed when it:

- uses a bot this run hasn't approved yet (a new node or a reassignment);
- adds or changes an external action node;
- removes or loosens a human approval (removes an approval, changes approve options, changes approvers; **adding** an approval needs no confirmation);
- raises limits: a higher loop maximum, a longer timeout, or more than twice the node count approved at the start.

When the initiator makes these changes they apply directly, and any new bot used joins the run's approved set, so it can be picked when reassigning from a blocked card later.

<details>
<summary>Fine print: interjections, concurrent edits, waiting for confirmation</summary>

- Whether an edit "came from the initiator" depends on **who sent the message that triggered this turn**. In a turn the main bot started on its own (run event or scheduled task), an interjection by the initiator still counts as the main bot's edit (it may not have seen that message yet); an interjection by another member counts as that member's edit. Automatic turns queued after it (sub-task reports, another event wake-up, a scheduled task) are not interjections.
- The confirmation card lists added, removed and changed nodes, any new bots, and why confirmation is needed.
- While waiting, the affected nodes pause dispatch and the rest keep running; question cards on those nodes can't be answered and blocked cards can't reassign until the confirmation card is handled.
- If another edit applies before confirmation: when both touch the same nodes, or the pending content would change on the new version, the pending card is voided and the main bot explains why; if they're unrelated, the pending edit rolls forward to the new version and keeps waiting, the card updates in place, and clicking the old card still counts.

</details>

### What happens to a node you edit

| Node state | After the edit |
|---|---|
| Running | The current attempt is voided (its process or bot turn is stopped and anything it submits later is ignored), and it restarts with the new definition |
| Waiting for approval | The approval card is voided, showing "the flow changed, this approval is void", and approval starts over with the new definition |
| Blocked | A definition-only change keeps it blocked until retried; a reassignment reruns it on the new bot right away. If it had been approved before, it needs approval again; its earlier question card is voided and only shows "🔄 按新定义重跑（需重新审批）" (rerun with the new definition, needs re-approval), which you must click |
| Not started | Scheduled with the new definition |
| Skipped / cancelled | Can't be edited; add a new node if needed |
| Loop running | Its body can't be edited; its downstream can |

### Finished nodes can only be redone

A finished node can't be deleted or redefined (its output may already be used downstream). You can only **redo** it, or add nodes after it. A redo reruns the downstream nodes that used its old output, and consumes the revisit budget (shared with automatic rework: 1 per node pair and 8 per run by default). When the budget runs out:

- a redo asked for by the initiator tops the budget up automatically and applies, no card needed;
- otherwise an "add redo budget" card appears in the main topic; after the initiator clicks "➕ 追加 1 次" (add 1), ask the main bot to resubmit the edit. Old cards say they've expired when clicked.

### Where to see versions

- **Progress card**: shows "第 N 版 · 最近修改：…" (version N · last edit: …), and notes when an edit is waiting for confirmation.
- **Dashboard Workflows page**: draws the currently effective version and marks new, changed and pending nodes; the "flow versions" panel lists each version's time, actor, summary and whether it was confirmed.

> ⚠️ **Don't downgrade the daemon while edited runs exist.** An older daemon doesn't understand version records: it ignores the edits and continues on version 1, which can run deleted nodes, run edited nodes with their old definitions, and bypass pending edits. If you must downgrade, cancel those runs or wait for them to finish first. Runs showing a version above 1 on the board are the edited ones.

## Hand nodes to bots in the chat (experimental, off by default)

By default each node runs in a temporary CLI process started by the daemon and destroyed when done; the chat doesn't see the work.

Turn on **"Hand workflow nodes to bots in the chat"** under Dashboard "Global settings → Workflow", and nodes are executed by bots in the chat, in their own sessions, visible to everyone:

```
Main topic (where the run started)
 ├─ Node topic A: node card + handoff card @DocBot ──▶ DocBot works ──▶ botmux report submits outputs
 ├─ Node topic B: node card + handoff card @CodeBot ──▶ ...
 └─ Small jobs in the main topic: handoff card replies in the main topic @SomeBot
```

- **Only runs approved afterwards are affected**: the execution mode is fixed at approval (Gate-2, or when a Saved Workflow starts); runs already in flight finish the old way.
- **Temporary processes are still used** for runs started in a private chat, runs without a topic root, or when [multi-topic collaboration](/en/multi-topic) is off on this machine; the approval result says why.
- If unsure, or if the chat shouldn't get extra node topics and bot conversations, leave it off.

### Who runs which node

- Say "let DocBot do this step" while clarifying, and that node is assigned to it.
- Unassigned nodes get a bot picked from those currently available in the chat (in the chat, online, CLI supported), with a one-line reason; when unsure, the main bot takes it.
- The Gate-2 summary lists "node → executing bot (CLI): reason"; an assigned bot that can't be used (not in the chat, offline, not found) is marked ⚠️. Go back to the draft to change it.

### Two placements: node topic / main topic

| Placement | Good for | What it looks like |
|---|---|---|
| **Node topic** (default) | Most nodes | The main bot posts a node card as a new topic, then a handoff card in it @-mentioning the executing bot. The handoff card states the task, completion criteria, inputs (upstream outputs attached), outputs to deliver, deadline and the submit command; the node card updates in place as status changes |
| **Main topic** | Small one-step jobs: summarize, rewrite, format, look up a number | The handoff card replies in the main topic @-mentioning the executing bot, with a status line on top that updates in place; no extra topic |

Compilation assigns each node a placement with a reason, and every line of the Gate-2 summary says "main topic" or "node topic". Before approval you can rearrange with `revise-dag`; after the run starts, only nodes that haven't started can change.

<details>
<summary>Main-topic placement rules and limits</summary>

- If the executing bot already has a session in the main topic it is reused, otherwise a new one is opened; the main bot's own nodes run in the main session.
- If that session is busy, the handoff queues; being queued counts as accepted, and the deadline starts when the turn actually begins. It waits at most one more node timeout (at least 1 hour); if it never starts it becomes blocked with the reason, and a node topic is suggested instead.
- A bot has only one session in the main topic, so two main-topic nodes of the same bot must depend on each other; the same applies to the main bot's own main-topic nodes. If another run hands a main-topic node to that busy bot, the node becomes blocked with the reason.
- If the main bot uses "one session for the whole chat" mode in this chat, main-topic placement can't be used. If the executing bot's daemon is too old to support main-topic handoff, the node becomes blocked with the reason.
- While the node runs, whatever you say to that bot in the main topic is part of the node, and stops with it when the node is stopped (timeout, cancel, reassign); a message merged into that turn needs resending. To chat about something else, wait for the node to finish or use a node topic.
- That session doesn't turn into a node session: its skills don't change, and submissions are only accepted during this execution — not while queued and not after it ends.
- The Dashboard node details show the handoff time and handoff card title for main-topic nodes, so you can find them in the main topic.

</details>

### How the executing bot delivers

When done, the executing bot runs:

```bash
botmux report --dispatch-root <handoff message id> --status completed \
  --output <key>=<path> --result-file result.json --content-file summary.md
```

- The node completes only when the submission passes its contract; otherwise the missing items are listed, and it can resubmit in the same attempt after fixing them.
- If it can't do the job, `botmux report ... --status blocked "reason"` marks the node blocked and posts a retry card in the main topic.
- Each file ≤4 MiB, ≤8 MiB per submission; for bigger outputs, put a branch name or link in `result.json`.
- If the main bot is offline, submissions still go through: results are held and recorded once the main bot is back.
- A node session only does that node: it can't see workflow skills or the skills for handing work on (`botmux-orchestrate`, `botmux-handoff`). Exceptions: an existing session reused in the main topic, and CLIs whose skill injection mode is "global directory".

### Timeouts, blocks and reassignment

- **Timeout**: 30 minutes by default, counted from acceptance. On timeout the node becomes blocked and the executing bot's current turn is stopped.
- **Cancel**: cancelling the workflow stops each node's current turn but doesn't close their sessions.
- **Reassign**: blocked cards get a "选择接手的 Bot" (pick a bot to take over) dropdown listing bots approved for this run that are still available (chosen at approval, plus those added by mid-run edits). Only the initiator can click "🔀 确认改派" (confirm reassign); the node then reruns on the new bot. For a bot outside that set, have the main bot submit a flow edit for the initiator to confirm.

### When the main bot is woken

The main bot doesn't watch every node. It is woken only when:

1. a node is blocked or fails;
2. an executing bot reports it can't do the job;
3. a node marked as a **checkpoint** (`checkpoint: true`) finishes.

The main bot then decides to retry, reassign (within the run's approved bots), edit the flow, or hand it to a human with `botmux workflow ask-human`, and says what it did in the topic. Automatic retries, reassignments and redos must give a reason; the node card shows the latest "main bot auto retry / reassign / redo: reason" or "handed to a human: reason", and the Dashboard node details list every record.

- If the main session is busy, the wake-up waits for that turn to end and then starts its own turn, never mixing into someone else's; if there's no active session in the main topic, a new one is opened.
- Each event wakes it once, even across daemon restarts.
- A node handed to a human stops and shows "waiting for a human"; a blocked card (retry / reassign / cancel) appears in the main topic with no timeout. After that, a submission from the executing bot no longer counts.

**Checkpoints** suit nodes where "we need to see the result before deciding what's next". Compilation marks them automatically, and you can ask to add or remove one before Gate-2; changing it mid-run applies directly. When a checkpoint finishes, nodes that depend on it pause until the main bot has looked and its turn ends. If the wake-up can't be delivered, the main bot's session is closed, or it doesn't finish within an hour, the flow continues as planned and the node card and board say so. Checkpoints only work in runs whose nodes are handed to bots in the chat.

### What's checked before approval

Every node's executing bot must be configured on this machine, already in this chat, with its daemon online, and able to set up in-chat collaboration with the main bot; in an ordinary group its reply mode can't be "one session for the whole chat"; and nodes can't declare directory outputs. Otherwise approval is refused with a per-node reason list. botmux **never adds bots to chats automatically**.

<details>
<summary>Set a working directory: approve-dag --working-dir</summary>

`botmux workflow approve-dag <runId> --working-dir <dir>` makes every node run in the same directory. Since nodes run in each executing bot's own session, the directory must be allowed for **every** executing bot (including the main bot): its default working directory (or Oncall directory), or its repo directories (`workingDir` / `workingDirs`) themselves or anything under them.

- The directory must already exist; it isn't created. Before comparing, `~` is expanded, a trailing `/` removed and symlinks resolved, so a symlink inside the allowed range pointing outside doesn't count.
- If not allowed, approval is refused with "node → bot: reason" for each one. Without the flag, each bot uses its own default directory.
- The directory is fixed at approval. Before an executing bot opens a node session it checks again against its configuration **at that time**: if the configuration changed and the directory is no longer allowed, the node becomes blocked (it never silently falls back to the default directory). Add the directory to its configuration and click "Retry", or reassign.
- New bots brought in by mid-run edits are checked the same way when they open a session.
- If the node topic already has a session of that bot running in another directory (someone @-mentioned it earlier, or ran `/cd`), the node is blocked too; close that session and retry.
- If the executing bot's daemon is older than the main bot's and doesn't understand the directory, the node is blocked with "version too old".

</details>

### Hand the initiator's identity to node bots (experimental, off by default)

The other switch in the same section, **"Hand the initiator's identity to node bots"**, only applies to runs whose nodes are handed to bots in the chat.

- **Off (default)**: the executing bot works as itself.
- **Runs approved after turning it on**: at approval the initiator is recorded (for an ad-hoc run, whoever approved Gate-2; for a Saved Workflow, whoever sent `/workflow run`, in their own message in the chat), along with the tools that person could use as themselves on the main bot (the main bot's "trigger-user auth" tools). On each handoff, an executing bot with "trigger-user auth" enabled calls those tools as the initiator, never with more scope than the initiator had on the main bot.

<details>
<summary>Where the delegation is valid, and exceptions</summary>

- **Valid only during this handoff**: the run isn't over, the handoff hasn't been cancelled / timed out / replaced by a retry or reassignment, and the node hasn't finished; only in this chat; only for bots in the run's approved set. It is revoked as soon as the node submits or the handoff stops, and checked again on every tool call. Removing the initiator from the chat doesn't interrupt the current turn; it takes effect from the next handoff.
- **Missing identity never blocks the flow**: approval and handoff proceed without the initiator's identity, and the approval result and handoff say why. Typical causes: approved in a scheduled task or another automatic turn, the main bot lacks contacts scope, the main bot doesn't have "trigger-user auth" on, the initiator left the chat or can't talk to the executing bot, or the executing bot isn't in the approved set.
- When the executing bot actually needs a tool that requires personal authorization, it is asked to authorize (via `botmux auth request` as usual), or it can `botmux report --status blocked` to say what's needed; **it never falls back to the bot's or owner's identity**.
- If a bot in a node hands work on with `botmux dispatch` or `botmux send --mention` to a bot in the run's approved set in this chat, the identity follows (only narrower) and expires with this handoff; handing to other bots works as usual but without the identity.

</details>

### Viewing the flow in the Feishu sidebar

In this mode, node cards, handoff cards and the executing bot's reply and report cards have a **"工作流 ›"** (Workflow) button at the right of the signature line; on the main topic's progress card, flow edit confirmation card and "add redo budget" card, the old "Web 详情" button is replaced by it too. Clicking it opens the run's live flow graph in the Feishu sidebar (refreshes every 2 seconds; click a node for details). Runs executed by temporary processes don't have this button.

What you see depends on who you are (the link itself carries no credentials):

| Who | Sees |
|---|---|
| Dashboard admin | The full view, same as the Dashboard detail page, including terminal and log entries |
| Current member of this chat | A compact view: node name, goal, assigned bot, status, duration, placement link, flow version history; no terminal, logs, output contents, parameter values or error details. Access is lost within a minute of leaving the chat |
| Anyone else | No access |

Chat members are identified through "Feishu H5 login". When H5 login is configured (`BOTMUX_DASHBOARD_FEISHU_H5_*`), members get a "workflow sidebar only" session and can't open other Dashboard pages. **Without H5 login only admins can view it**: the button opens the run's Dashboard detail page in the browser instead, using your existing Dashboard login.

## Concurrency limits

How many nodes of a run run at once is bounded by three limits; the tightest one wins:

| Layer | Meaning | Default |
|---|---|---|
| `global` | Nodes running at once across the whole run | 4 |
| `perBot` | Nodes running at once on the same bot (Feishu app) | 1 |
| `perCli` | Nodes running at once on the same CLI (claude-code, codex…) | 2 |

The defaults are conservative: every node starts a full CLI process, and nodes on one CLI usually share a subscription account, which hits rate limits easily. With the defaults, nodes on the same bot run one after another. Limits are per run; two runs at once each get their full limits.

If your CLI is billed per use and the machine has enough memory, raise them in `~/.botmux/config.json`:

```json
{
  "workflow": {
    "enabled": true,
    "concurrency": {
      "global": 16,
      "perBot": 4,
      "perCli": 2,
      "perCliById": { "claude-code": 8 }
    }
  }
}
```

- Every field is optional; missing ones keep the default. Values are integers 1–64; invalid values are ignored.
- `perCliById` sets a limit per CLI; CLIs not listed use `perCli`.
- The config is re-read each time a run is driven, so changes apply to the next start or resume without restarting the daemon.
- When nodes are handed to bots in the chat, only `global` and `perBot` apply; `perCli` doesn't.
- ⚠️ All nodes on one bot run in that bot's working directory. With `perBot` above 1, several nodes read and write the same directory at once; if nodes change files, make sure they touch different files, or give them different bots.

## Limitations

- Nodes run in temporary processes currently support bots on these CLIs only: **claude-code, codex, seed, traex, relay, minimax**. A flow that uses a bot on another CLI fails at start.
- External action nodes are limited to `feishu-send`, `feishu-reply` and `botmux-schedule`, and always require approval.
- For real runs use Feishu `/workflow` or `botmux workflow start` (with approval cards); `botmux v3 run` is for development and debugging only, without approval cards.

## Advanced

### The underlying state machine

Under the hood, an ad-hoc workflow is a state machine driven by `botmux workflow` subcommands. The bot normally calls them; you can drive them by hand when troubleshooting:

| Command | Transition |
|------|----------|
| `botmux workflow new "<goal>"` | Create a run, returns `runId` / `specPath` → `grilling` |
| `botmux workflow spec-finalize <runId>` | Validate the spec → `spec_ready` |
| `botmux workflow approve-spec <runId>` | Gate-1 passed → `spec_approved` |
| `botmux workflow architect <runId>` | Compile and validate the flow → `dag_ready` |
| `botmux workflow approve-dag <runId>` | Gate-2 passed → `dag_approved` |
| `botmux workflow start <runId>` | Hand to the daemon to run |

Run data lives in `~/.botmux/v3-runs`.

### Run one goal headless: `botmux goal run`

Skips Feishu, clarification and planning, and has one bot finish one goal in the background. Handy for scripts or other agents:

```bash
botmux goal run "Collect the stale links under docs/ into a list" --run-id docs-links-1 --json
```

| Option | Meaning |
|---|---|
| `<goal>` | The goal text; or use `--goal-file <file>` or `--stdin` instead. Pick exactly one |
| `--run-id <id>` | Run ID; generated if omitted. Set it yourself if you want to replay or resume |
| `--bot <id\|name>` | Which bot (App ID or name); defaults to the first bot in `bots.json` |
| `--working-dir <dir>` | Where to run; defaults to the bot's default working directory |
| `--timeout <seconds>` | Overall time limit, at most 14370 seconds; hitting it counts as a cancel. Without it, the default node timeout (30 minutes) applies |
| `--json` | On exit, print one line of JSON to stdout (`schemaVersion` is `botmux.goal-run-result/v1`) with `state`, `summary`, `artifacts`, `error` |

It is a single node with no approval card and no Feishu messages. It runs the same way as temporary-process nodes, so only the CLIs listed under "Limitations" above are supported. Data also lands in `~/.botmux/v3-runs/<runId>`.

**Read the result from the exit code**:

| Exit code | `state` | Meaning |
|---|---|---|
| 0 | `succeeded` | Done |
| 10 | `failed` | Failed |
| 11 | `blocked` | Blocked |
| 12 | `cancelled` | Cancelled: Ctrl-C, SIGTERM or timeout |
| 13 | `conflict` | Run ID conflict, or another process is driving this run |
| 14 | `error` | Bad arguments, Workflow off, no bots configured, etc. |

**Running again with the same `--run-id`** requires exactly the same arguments as the first time (goal, `--bot`, `--working-dir`, `--timeout`):

- Finished run: nothing reruns; you get the original result and exit code back, even if `bots.json` has since changed or been removed.
- Unfinished run (the process crashed, the machine rebooted): it resumes where it stopped, keeping the bot, directory and settings fixed on the first run rather than re-picking from current config. It still needs that bot's credentials in `bots.json`.
- Another process is driving the same run: you get a conflict (13) and nothing runs twice.
- Arguments differ from the first run: conflict (13). Use a new run ID for a new goal.

### Legacy v2 templates (retired)

v2 templates are retired: `/template run`, `botmux workflow resume / tail / validate` and similar commands fail right away. If you still have old `~/.botmux/workflows/*.workflow.json` definitions or historical runs, use the offline tools:

| Command | Description |
|------|------|
| `botmux template migrate-v3 [workflowId\|path ...] [--all]` | Preview only by default; add `--commit` to save convertible v2 definitions as v3 Saved Workflows |
| `botmux template archive-runs [--commit] [--verify <archiveId\|path>]` | Scan, archive or verify finished v2 runs; never runs a v2 workflow and never deletes history directly |

### Development self-test: `botmux v3 run`

`botmux v3 run <dag.json> [--max-parallel <n>] [--max-per-bot <n>] [--max-per-cli <n>]` runs a **hand-written** v3 dag.json on the real local temporary-process pool; approvals are y/N prompts in the terminal, with **no Feishu cards**. The three flags override the concurrency config above for this run only; `--max-per-cli` applies to every CLI and overrides `perCliById`.
