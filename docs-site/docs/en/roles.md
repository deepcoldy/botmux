# Roles and Teams

Give a bot a "persona" (Role): who it is in the group, what it's responsible for, and how it talks. The same bot can play different roles in different groups. The command is `/role`.

What's on this page:

| I want to | Section |
|------|------|
| Give a bot a persona (global default / just for one group) | [Set a persona](#set-a-persona) |
| Control how often the persona is injected, reply privately to the asker, and other per-group switches | [Per-group switches](#per-group-switches) |
| Apply a set of personas to a new group in one go | [Role profiles](#role-profiles) |
| Let other bots know "who's good at what" | [Capability tags](#capability-tags) |
| One bot with several roles, each with its own memory (advanced) | [Role switch](#role-switch-advanced) |

## Set a persona

There are two levels:

- **Default role**: the bot's persona in **every group**.
- **Group role**: applies only to the **current group** and overrides the default role.

The order is always: **group role > default role > none**. For example, the same bot can be a "strict code reviewer" in group A, a "patient Q&A helper" in group B, and use its default role everywhere else.

### With commands in the group

@-mention the bot in the group and send:

| Command | Effect |
|------|------|
| `/role` | Show the persona in effect and where it comes from (group / default) |
| `/role set <Markdown>` | Set the group role; multi-line is fine |
| `/role delete` | Delete the group role and fall back to the default role |
| `/role team` | Show the default role |
| `/role team set <Markdown>` | Set the default role (the command keeps the old name `team`; it means "default role") |
| `/role team delete` | Delete the default role |

Example:

```text
/role set You are this group's technical advisor.
- Give the conclusion first, then the reasoning
- Flag risks before any production change
```

- Personas are written in Markdown and injected into the CLI as a `<role>` block.
- Each persona can be up to 32 KB (about 10,000 CJK characters); anything beyond that is truncated.
- After a change, "every turn" mode picks it up from the next message; "only once" mode picks it up on a new or rebuilt session (see [Per-group switches](#per-group-switches)).

### In the Dashboard

If you'd rather not type commands, open `botmux dashboard`:

| What to change | Where |
|------|------|
| Default role | **Bot Config** page, each bot's "**Default Role**" section (same config as `/role team set`; saving it empty deletes it) |
| Group role | **Role Management** page → "By Group": expand a group, pick a bot, edit |
| Jump there from a group | **Group Management** page: in a bot's settings for that group, click "Edit chat role" |

![Dashboard Bot Config — Default Role editor](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780051089378_default-role-shot.png)

When you use "Duplicate" on the Group Management page to copy a group, you can tick "Also copy chat roles" to carry the source group's group roles (plus the per-group switches below) into the new group. Default roles are inherited automatically, so they don't need copying.

## Per-group switches

On the **Role Management** page, select a bot in a group. Besides editing the persona, you can set the options below. Each is saved per "group + bot" and takes effect immediately.

| Switch | Default | What it does |
|------|------|------|
| **Injection** | Every turn | "Every turn" sends the persona with every message; "Only once (first turn)" injects it only when a session starts or is rebuilt, which suits long personas and saves tokens. You can change the default per bot in the "Default Role" section of the Bot Config page, then override it for individual groups |
| **Prefer private replies to the requester** | Off | When on, the answer is sent to the asker in a private chat first; if that fails, it's posted publicly in the original topic. You can also set a "Group notice" (e.g. "Sent to you privately to avoid noise") shown in the original topic after a successful private reply; leave it empty for no notice |
| **Topic task reporting mode** | Off | See below |

**Topic task reporting mode**: when this bot uses `botmux dispatch` in this group to hand a task to another bot, the assignee still uses `botmux report` to hand the result back to the dispatcher's session. With this switch on, the assignee also posts "completion + output location/summary" with `botmux send --no-mention` in the topic where it received the task, so people can see the result right in the group. It doesn't mention the dispatcher or open a new topic. `--standby` (reserve a bot without sending a task) doesn't involve this step.

> In project groups, the coordinator bot also receives Botmux's fixed project-state protocol (for tracking progress and the pinned project card). It applies alongside the Role and is not affected by the Role's injection mode. For project groups, see `/project` in [Slash Commands](/en/slash-commands).

## Role profiles

A profile is a **reusable bundle of group roles**: write a persona for each of several bots, save them under a name (e.g. `collab-main`), and apply them to a new group in one step later.

It's only a shortcut for writing: once applied, it becomes an ordinary group role. It doesn't add another persona layer and doesn't support template inheritance.

### Commands

| Command | Effect |
|------|------|
| `/role profile list` | List all profiles and show whether the current bot has its own entry |
| `/role profile show <name>` | Show the current bot's persona in that profile; add `--all` to see every bot's |
| `/role profile set <name> <Markdown>` | Write the current bot's entry directly |
| `/role profile save <name>` | Save the current bot's effective persona (group role, or the default role if there's none) into the profile |
| `/role profile delete <name>` | Delete the current bot's entry |
| `/role profile apply <name>` | Write the current bot's entry as the group role |

Flags for `apply`:

- `--preview`: preview only, write nothing.
- `--force`: if the group already has a role, apply refuses by default; add this to overwrite.
- `--quiet`: no reply on success (less noise when applying in bulk).

Notes:

- Each bot only manages its own entry and never changes another bot's persona.
- If the profile has no entry for the current bot, `apply` writes nothing and the bot keeps using its default role.
- Profile names may only use letters, digits, `.`, `_` and `-`, up to 64 characters.

### In the Dashboard

**Role Management** page → "Profiles" tab:

1. Open or create a profile on the left.
2. In the middle, see which bots have entries; select a bot to edit its persona.
3. Under "Apply To Group", choose the target group and the bots to apply. Click **Preview Apply** first to check whether existing roles would be overwritten, then **Apply Profile**. Tick "Overwrite existing group roles" when you do want to overwrite.

### Apply while creating a group

```text
@botA @botB @botC /g --role-profile collab-main War Room
```

Once the new group exists, the bot that created it applies its own entry, then posts `@botB @botC /role profile apply collab-main --quiet` in the new group so the other bots apply their own entries.

## Capability tags

A capability tag is a one-line self-introduction, such as "Good at frontend and UI review". It helps you and other bots pick the right one when collaborating.

```text
/role cap set Good at frontend and UI review   # set
/role cap                                      # show
/role cap clear                                # clear
```

- Tags are capped at 120 characters. One sentence is enough; use `/role set` for a full persona.
- When other bots run `botmux bots list` to see who's in the group, they see each bot's tag.
- Tip: put `workspace: required` / `optional` / `none` in the tag so dispatching bots know whether they must specify a repo or working directory when giving you a task.

Personas plus capability tags are the foundation of [multi-bot collaboration](/en/multi-bot): with clear identities and responsibilities, bots are less likely to get mixed up when @-mentioned in a group.

## Teams: collaborating across machines

The Dashboard used to have a "Team" page; it has been removed. To work with bots on **other people's machines**, your machine needs to be connected to the [central platform](/en/platform) and be in the same team. Then use the command line:

- `botmux bots list --scope team`: list bots that have joined your team.
- `botmux create-group --team <team> --agent <appId>`: pull them and their owners into a new group.

Full steps are in the "Team scope" section of [Multi-Bot Collaboration](/en/multi-bot).

## Role switch (advanced)

> ⚠️ Advanced feature: you need to deploy a "role library" first, and it currently supports Claude Code only. Deployment steps are in the repo's [role-system deploy runbook](https://github.com/deepcoldy/botmux/blob/master/docs/roles/deploy-runbook.md). Below is how to use it once deployed.

`/role` above means "one persona per bot". **Role switch** gives one bot **several full roles**, each with its own persona and **its own memory**. Switch to "After-sales" and it carries the after-sales persona and experience that belongs only to after-sales; switch to "Product manager" and it's a different set.

Roles apply **per topic**; a new topic starts from the default role.

### How to use it: just talk

| You say | What the bot does |
|------|-----------|
| "switch role" / "what roles are there" | Lists the roles you can use (shared ones + ones you created), numbered for you to pick |
| "switch to After-sales" or reply with a number | Confirms and switches; from then on this topic is answered by that role, and the card footer shows the role name |
| "new role: Xiaohongshu ops, familiar with our brand voice" | Drafts a persona for you to confirm, then creates it and switches to it |
| "distill knowledge" | Turns the role's recent memory into structured knowledge stored back in the role (optionally as a Lark doc for human review) |

Behind the scenes the model runs `botmux role switch <role-dir>`; you don't need to type it yourself.

### Good to know

- **Separate memory**: each role has one memory, shared across groups and topics, so it gets better at its domain the more it's used.
- **Context is kept**: switching restarts the CLI and resumes the previous conversation; the new role's persona and memory load automatically when the new session starts.
- **Private roles are not a security boundary**: "you only see shared roles and your own" is a convention in the role protocol file (`_role-protocol.md`) that the model follows. The daemon enforces only one thing: the target directory must be inside the role library `~/botmux-roles`. It does not isolate roles per sender. If you need real isolation, add OS-level permissions yourself.
- **Not the same as `/cd`**: `/cd <path>` (see [Slash Commands](/en/slash-commands)) is the general "change working directory and restart", works with any directory, and needs operate permission. Role switch only moves within the role library.

> The old command `botmux cd` has been renamed to `botmux role switch`. The old name now only prints an error and does not switch. When maintaining an older deployment, update `_role-protocol.md` in the role library to the new command.
