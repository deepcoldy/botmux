# Project Progress Card

When you drive a multi-step project in an ordinary group, the coordinator bot can use `botmux project` to keep a **pinned project progress card**: goal, current focus, to-dos, blockers, milestones and the status of every subtask, all on one card that is **updated in place** instead of flooding the chat.

- Project state is stored on the host, not in chat history. If someone withdraws the card, the next update posts a new one and pins it again.
- Subtasks the coordinator sends out with `botmux dispatch` are **registered on the card automatically**, and progress that worker bots send back with `botmux report` is **synced to the same card**.
- One group has one project and one card.

> These commands are usually run by the AI itself. You tell the coordinator in the group "start project X" or "record that blocker", and it runs the matching command. The reference below helps you understand what it is doing; you can also ask it to run a specific command.

## When to use it

| What you need | Use |
|---|---|
| A project that runs for days, split across several bots, and everyone in the group should see progress at a glance | Project progress card (this page) |
| Just split a big task into parallel sub-topics; a Feishu task list is enough to track progress | [Multi-topic collaboration](/en/multi-topic) |
| A bounded multi-step task that finishes with one deliverable | [Workflow](/en/workflow) |

They combine: once the group has a project, subtasks dispatched through multi-topic collaboration also show up in the card's subtask section.

## Quick start

1. In an ordinary group, at the **top level of the group** (not inside a topic), @ the bot you want as coordinator:

   ```text
   @bot /project enable
   ```

   That bot becomes the **coordinator**, and the other bots in the group managed by this botmux become **workers** (bots that can receive dispatched work). A "project group ready" guide card is pinned in the group. Only the bot's owner / `allowedUsers` can run this command.

2. Still at the top level, @ the coordinator and say what you want:

   ```text
   @bot Start the "Website revamp" project. Goal: ship the new home page within two weeks. Please break it down and drive it.
   ```

   It's fine if the goal isn't clear yet. You can start with "I want to discuss…, help me clarify the problem and next steps first." Discussion is a valid project phase.

3. Once the coordinator creates the project, it posts a new **project progress card** at the current spot and pins it. The old guide card changes to "project started" and is unpinned. All later progress is updated on this card.

> `botmux project` also works without project group mode, as long as you are in a session at the top level of an ordinary group (except in groups that ran `/project disable` or were set to "ordinary group" in the Dashboard). Enabling the mode adds two things: the coordinator receives a fixed "maintain project state" protocol every turn (read state → update whenever something changes → check the card before reporting), and dispatching is restricted to the worker list (see "Dispatch rules in project group mode" below). For the full `/project` usage see [Slash Commands](/en/slash-commands).

## What's on the card

The card text is currently in Chinese; English names are given below.

| Area | Content | Comes from |
|---|---|---|
| Header | Project title + status tag: in progress / completed | `init --title`, `close`, `resume` |
| Goal | The project goal | `init --goal` / `update --goal` |
| Current focus | What the coordinator is working on right now | `--focus` |
| Summary | e.g. "1 blocked · 2 in progress · 3 completed" | Computed from subtask status |
| In progress / Planned / Done | Subtasks grouped by state, each with an "open topic" link; Planned also lists items from `--remaining` | Subtasks + `--remaining` |
| Decisions / blockers | Numbered list of all blockers | `--blocker`, plus subtasks reported as blocked |
| Subtask status | Name, description, owner, status and topic link for each subtask | `botmux dispatch` / `botmux report` |
| Recent milestones | The latest 3 milestones and the "next checkpoint", collapsed by default | `--milestone`, `--next-milestone` |

Subtasks have five states: pending, in progress, blocked, completed, failed. Blocked subtasks are listed first and completed ones last.

The table above describes the default "Status dashboard" template. With the "Compact list" template (see "Adjusting it in the Dashboard" below), the middle sections collapse into a one-line summary (summary · phase · next step), and subtasks become a one-per-line list.

## Common tasks: want X → do this

| What you want | Command |
|---|---|
| Create the project | `botmux project init --title "Website revamp" --goal "Ship the new home page within two weeks"` |
| See current state | `botmux project status` |
| Change phase / current focus | `botmux project update --phase "Build" --focus "Wire up home page APIs"` |
| Record overall completion | `botmux project update --progress 40` |
| Write down what's left | `botmux project update --remaining "API integration; mobile layout; launch checklist"` |
| Record a blocker | `botmux project update --blocker "Waiting for design sign-off on hero colors"` |
| Blockers resolved | `botmux project update --clear-blockers` |
| Record a milestone | `botmux project update --milestone "Home page design finalized"` |
| Set the next checkpoint | `botmux project update --next-milestone "QA on Friday"` |
| Finish the project | `botmux project close --milestone "New home page is live"` |
| Pick it up again after finishing | `botmux project resume --phase "Phase 2" --focus "Add analytics events"` |

## Full example: from kickoff to wrap-up

These are the commands the coordinator runs over the life of a project (you only talk to it in the group):

```bash
# 1. Kick off: only title and goal are required
botmux project init --title "Website revamp" --goal "Ship the new home page within two weeks" \
  --phase "Planning" --focus "Break down requirements and dispatch the first subtasks"

# 2. Dispatch: each subtask gets its own sub-topic and is registered on the card
#    (the title must be specific, at most 24 characters)
botmux dispatch ...   # e.g. "Home page frontend" to the frontend bot, "Home page regression" to the QA bot

# 3. While working: update promptly when the phase changes or a blocker appears
botmux project update --phase "Build" --focus "Wire up home page APIs" \
  --remaining "Mobile layout; launch checklist" --blocker "Waiting for design sign-off on hero colors"

# 4. Worker bots report from their own topics; the card syncs automatically
botmux report "Home page frontend done, preview link in the topic" --status completed

# 5. Blocker cleared, milestone reached
botmux project update --clear-blockers --milestone "Home page build done" --next-milestone "Launch on Friday"

# 6. Wrap up
botmux project close --milestone "New home page is live"
```

After `close` the card turns green and shows "completed": overall completion is set to 100, the phase becomes "completed", blockers are cleared and remaining work is set to "none". If you need to continue later, `resume` switches it back to "in progress".

## Command reference

`botmux project --help` is the source of truth.

### init: create the project

```bash
botmux project init --title <name> --goal <goal> [--phase <phase>] [--focus <current focus>]
```

- `--title` and `--goal` are required.
- `--phase` defaults to "planning" and `--focus` defaults to "break down and dispatch the first subtasks".
- A group can only have one project. Running `init` again fails; use `update` or `resume` to keep going.

### status: view state

```bash
botmux project status
```

Prints the full project state (JSON): goal, phase, blockers, milestones and every subtask.

### update: make changes

```bash
botmux project update [options…]
```

At least one option is required:

| Option | Effect |
|---|---|
| `--goal <goal>` | Change the goal |
| `--phase <phase>` | Change the phase, e.g. "planning", "build", "acceptance" |
| `--focus <current focus>` | Change "current focus" |
| `--progress <0-100>` | Record overall completion; must be an integer from 0 to 100. The number is only kept in the project state (visible in `status`); the card doesn't show it yet |
| `--remaining <to-do>` | Write down what's left; this **replaces** the previous value. Separate items with `；` `;` `·` or newlines; only the first 5 go into the card's Planned section |
| `--blocker <blocker>` | **Add** a blocker (duplicates are not added twice) |
| `--clear-blockers` | Clear all blockers |
| `--milestone <milestone>` | **Add** a completed milestone |
| `--next-milestone <checkpoint>` | Set the next checkpoint, shown in the milestone panel title |
| `--clear-next-milestone` | Clear the next checkpoint |

`--clear-blockers` and `--blocker` can be combined: clear first, then add the new one.

### close: wrap up

```bash
botmux project close [--milestone <completion note>]
```

Without `--milestone`, a "project completed" milestone is recorded.

### resume: start driving again

```bash
botmux project resume [--phase <phase>] [--focus <current focus>]
```

Switches the status back to "in progress". Defaults: phase "continue", focus "resume project".

### Common options

- `--json`: print the full state instead of a short result.
- `--session-id <id>`: target a specific coordinator session. Detected automatically when run inside a session, so you rarely need it.

## How subtasks reach the card

```
Coordinator botmux dispatch ──► opens a sub-topic, assigns a worker ──► new subtask row on the card
                                                                          │
Worker runs botmux report --status ... in the sub-topic ─────────────────► row status / report updated
```

- **dispatch**: every dispatched subtask adds a row with an "open topic" link and the assigned bots. It's "in progress" once the worker accepts, "pending" if it's only on standby (no task sent yet), and "blocked" if the dispatch wasn't accepted.
- **report**: workers can add these options to update their row:

  | Option | Effect |
  |---|---|
  | `--status` | `pending` / `in_progress` / `blocked` / `completed` / `failed`. Defaults to in progress when omitted |
  | `--progress <0-100>` | Completion of this subtask |
  | `--remaining <text>` | What's left for this subtask |
  | `--milestone <text>` | Add a milestone to the project |

- Reporting `--status blocked` puts the report text into the card's decisions / blockers list; reporting any other status later removes that blocker automatically.
- To mark a subtask done, pass `--status completed` explicitly. The card does not guess completion from the report text.

For full `dispatch` / `report` usage see [Multi-topic collaboration](/en/multi-topic).

## Dispatch rules in project group mode

After `/project enable`, dispatching is restricted so the card matches the real division of work:

- Only the coordinator bot can dispatch, and only from its session at the top level of this group.
- Work can only go to this group's workers, not to other groups.
- Every new subtask needs a specific title of at most 24 characters; plain "subtask" (`子任务` / `子项目`) is rejected.

The worker list defaults to "automatically enroll new bots": bots managed by the same botmux that join the group later become workers. To keep the list strict, turn this off in the Dashboard.

## Adjusting it in the Dashboard

Open Dashboard → Groups → a group's "Manage" → "Collaboration mode" (see [Dashboard](/en/dashboard)):

- Switch between ordinary group and project group; pick the coordinator bot and dispatchable workers.
- **Progress card display**: choose the "Status dashboard" template (with a subtask table, good for continuous monitoring) or "Compact list" (vertical summary, good on mobile); pick which modules to show (goal, blockers / decisions, subtasks and topic links, milestones); choose whether milestones are expanded by default. Saving refreshes the current card right away.
- "Current project (read-only)" shows project status and how many subtasks are done.

This only controls **how** the card looks. Goals and progress are still maintained by the coordinator in the group. Each agent's responsibilities in the group can be set with `@bot /project roles` or [Roles](/en/roles).

## FAQ

**"project 模式只能在普通群的 chat-scope 主控会话中使用" (project mode only works in an ordinary group's chat-scope coordinator session)**
`botmux project` only works in a session at the **top level of an ordinary group**. DMs, topic groups and sub-topics inside an ordinary group are not supported. Go back to the group's top level and @ the coordinator.

**`project_mode_disabled`**
The group was explicitly set to "ordinary group": either in the Dashboard or by running `/project disable`. That turns project commands off. Switch it back to "project group" in the Dashboard, or send `@bot /project enable`.

**`project_coordinator_required`**
Another bot is this group's coordinator. @ the right coordinator, or have the current one run `/project disable` first.

**`project_already_exists`**
The group already has a project. Use `update` to keep going, or `resume` if it was closed.

**Someone withdrew the progress card**
No project data is lost. The next `update` (or subtask report) posts a new card and pins it.

**If I leave project group mode, is the project kept?**
Yes. `/project disable` only leaves the mode; project state and the progress card are kept. While disabled, `botmux project` commands are refused (`project_mode_disabled`) and the card stops updating; run `/project enable` again with the same coordinator to continue.
