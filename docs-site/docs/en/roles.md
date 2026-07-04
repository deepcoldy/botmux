# Roles and Teams

Give each bot an independent persona per group, and form a "team roster" during multi-bot collaboration. The command is `/role`.

## Two-Tier Role (Persona)

| Command | Effect |
|------|------|
| `/role` | View the currently **effective** Role (source: this-group override > default role > none) |
| `/role set <Markdown>` | Set the **this-group** Role (overrides the default role) |
| `/role delete` | Delete the this-group Role |
| `/role team set <Markdown>` | Set the **default role** (this bot's default persona **across all groups**; the command name keeps `team`) |
| `/role team delete` | Delete the default role |

- **This-group Role** has the highest priority: the same bot can have different personalities / responsibilities in different groups (e.g., a "strict reviewer" in group A, an "approachable Q&A assistant" in group B).
- **Default role** is the bot's cross-group default persona, which takes effect when no this-group Role is set.
- Role content is Markdown, injected into the CLI's system prompt, with a maximum of about 4096 bytes.
- Role resolution stays exactly: **this-group role > default role > none**.

> 💡 The most intuitive way to set the **default role** is on the **Bot Config** page of `botmux dashboard` — every bot card has a "**Default Role**" editor (it writes to the same config as `/role team set`; it's a bot-level global default persona, so it fits better under Bot Config). The **Team** panel only provides a **read-only view** entry; do all editing on the Bot Config page.

![Dashboard Bot Config — Default Role editor](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780051089378_default-role-shot.png)

## Role Profiles

A role profile is a reusable suite of bot-specific **this-group roles**. It is not a third runtime role layer, and it does not support template inheritance such as `{{teamRole}}`.

Typical commands:

```bash
/role profile list
/role profile show collab-main
/role profile set collab-main <Markdown>
/role profile save collab-main
/role profile apply collab-main --quiet
```

How it works:

- Each bot owns only its own profile entry, keyed by its `larkAppId`.
- `save` stores this bot's current effective role into the profile: this-group role first, then default role, otherwise it fails.
- `apply` writes this bot's profile entry into the current group's role file. If the current group already has a role, apply refuses unless `--force` is passed.
- Missing entries are safe: nothing is written, and the bot keeps falling back to its default role if one exists.

In the Dashboard, **Role Profiles** is a first-class entry:

- Open or create a profile from the left list.
- Check which bots already have entries and edit each bot's Markdown role.
- Pick a target group in the Apply panel, **Preview Apply** first, then **Apply Profile** when the overwrite behavior is clear.
- From the **Groups** page, click a group's "Apply Profile" action to open Role Profiles with that group preselected.

For new collaboration groups, create the group and bootstrap the profile in one command:

```bash
@botA @botB @botC /g --role-profile collab-main War Room
```

The creator applies its own entry directly, then posts `@botB @botC /role profile apply collab-main --quiet` inside the new group so peer bots apply their own local entries. No bot writes another daemon's role storage.

## Capability Tags (Roster)

```bash
/role cap set <one-liner>   # Set this bot's capability tag
/role cap clear             # Clear it
```

Capability tags show up in the "roster" — when `botmux bots list` lists the bots in the current group, each bot carries its `cap` one-liner summary, making it easy for you and other bots to know "who's good at what," so you can pick the right one during multi-bot collaboration / handoffs.

## Relationship to Multi-Bot Collaboration

Role + capability tags are the infrastructure for [multi-bot collaboration](/en/multi-bot): giving each bot a clear identity and responsibilities makes the model less likely to get confused when @-mentioned in the group, with each one playing its part (e.g., one orchestrating, one doing implementation / review).

## Team Collaboration (Cross-Deployment)

On the **Team** panel of `botmux dashboard`, you can invite **someone else's deployment** (a botmux that a colleague runs themselves) into the same team, so you can discover each other's bots and create groups across deployments to collaborate.

![Dashboard Team — cross-deployment collaboration](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033301213_dash-team.png)

- **Bind identity**: use the bot credentials to automatically identify your Lark identity; after binding, creating a group will add you to the group, and the bots will be attributed to you.
- **Team roster**: aggregates all bots from this deployment + any joined teams (possibly across deployments), searchable and filterable by name / capability / CLI, and annotates who has a capability tag / default role (roles are **read-only view** here; do editing on the Bot Config page).
- **Cross-deployment group creation**: just check the bots in any team to create a group in one click, automatically bringing along each one's owner — a single group gathering different CLIs from different colleagues' deployments to collaborate.
- **Team management**: creating a team, generating an invite code, and joining someone else's team are all on the "Team Management" subpage.

> Suitable for multi-person / multi-machine collaboration: everyone runs their own botmux deployment, discovers each other's bots through a team federation, and collaborates in the same Lark group.
