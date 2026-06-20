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

> 💡 The most intuitive way to set the **default role** is on the **Bot Config** page of `botmux dashboard` — every bot card has a "**Default Role**" editor (it writes to the same config as `/role team set`; it's a bot-level global default persona, so it fits better under Bot Config). The **Team** panel only provides a **read-only view** entry; do all editing on the Bot Config page.

![Dashboard Bot Config — Default Role editor](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780051089378_default-role-shot.png)

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
