# Botmux Role Profile Plan

> Date: 2026-06-17
> Branch: `plan/role-profile-suite`
> Status: design plan

## Background

Botmux currently has a simple and useful role model:

```text
chat role > team/default role > none
```

This should stay true. The problem is operational: default roles should be
solo-safe and reusable everywhere, but users who frequently create temporary
multi-bot collaboration groups need a fast way to apply a whole set of
collaboration roles to the bots in that group.

The proposed feature is **role profiles**: named, reusable suites of per-bot
chat roles. A profile is not a runtime role layer. Applying a profile writes the
matching entry into the current group's chat role for each bot that handles the
command.

## Goals

- Keep the runtime role model unchanged: `chat > team/default > none`.
- Let default roles stay short and solo-safe.
- Add a reusable profile suite that maps `bot -> chat role`.
- Let one command apply a profile to multiple mentioned bots in a new or
  existing group.
- Let one command save the current effective role for multiple mentioned bots
  into the same profile.
- Add Dashboard support in the existing Roles management area.
- Make group creation flows optionally apply a role profile without crossing
  daemon ownership boundaries.
- Keep all UI compatible with the existing Dashboard visual system, responsive
  layout, dark/light themes, and named skins.

## Non-Goals

- Do not add a third runtime role layer.
- Do not inject multiple `<role>` XML blocks.
- Do not add `{{teamRole}}` or any template inheritance syntax.
- Do not add per-chat "disable default role" behavior. With solo-safe defaults,
  fallback to default role is the intended behavior.
- Do not let one bot directly write another bot's local role/profile storage.
- Do not infer whether a user wants collaboration from group shape alone.

## Core Model

### Existing runtime model

No change:

```text
resolveRole(larkAppId, chatId):
  if chat role exists: return chat role
  else if team/default role exists: return team/default role
  else: none
```

### New profile model

A role profile is a named suite:

```text
profile: collab-main
entries:
  <larkAppId A> -> markdown role for bot A in this collaboration mode
  <larkAppId B> -> markdown role for bot B in this collaboration mode
  <larkAppId C> -> markdown role for bot C in this collaboration mode
```

Applying the profile in a group materializes only the matching entry:

```text
@A /role profile apply collab-main
  -> if profile has entry for A, write roles/<A>/<currentChat>.md
  -> if profile has no entry for A, do not write; A keeps default fallback
```

When a message mentions multiple bots, each bot receives the same command and
applies its own entry. This preserves the cross-daemon boundary: every daemon
writes only its own local state.

## Storage

Add `src/services/role-profile-store.ts`.

Suggested on-disk layout:

```text
{dataDir}/role-profiles/
  collab-main/
    cli_a.md
    cli_b.md
  release-war-room/
    cli_a.md
    cli_review.md
```

Rules:

- `profileId` is a stable slug: `[A-Za-z0-9._-]`, max 64 chars.
- Entry key is `larkAppId`.
- Entry content is Markdown.
- Use the same max size as roles: 4096 UTF-8 bytes.
- Use atomic writes.
- Expose file mtime as `updatedAt`; optionally add richer metadata later.
- Listing profiles scans local entries only. Cross-deployment entries are not
  magically visible unless a future federation API adds that view.

Store API sketch:

```ts
listRoleProfiles(dataDir): ProfileSummary[]
listRoleProfileEntries(dataDir, profileId): ProfileEntry[]
readRoleProfileEntry(dataDir, profileId, larkAppId): string | null
writeRoleProfileEntry(dataDir, profileId, larkAppId, content): void
deleteRoleProfileEntry(dataDir, profileId, larkAppId): boolean
deleteRoleProfileIfEmpty(dataDir, profileId): boolean
```

## Slash Commands

All commands live under `/role profile ...`, handled alongside the existing
`/role`, `/role set`, `/role team`, and `/role cap` commands.

### List

```text
/role profile list
```

Shows local profile names and whether the current bot has an entry in each.

### Show

```text
/role profile show <profile>
/role profile show <profile> --all
```

- Default: show the current bot's entry.
- `--all`: show local entries known to this daemon. This is not a federated
  global view.

### Set

```text
/role profile set <profile> <markdown>
```

Writes the provided Markdown as the current bot's entry in the profile.

This is the explicit authoring command. In multi-bot groups it should normally
be used with one bot at a time because each bot needs a different Markdown
body.

### Save

```text
/role profile save <profile>
```

Saves the current bot's **effective role** into the profile entry:

- If current group has a chat role, save that.
- Else if the bot has a team/default role, save that.
- Else fail with a clear "no effective role to save" message.

This command naturally supports multiple mentioned bots:

```text
@A @B @C /role profile save collab-main
```

Each bot saves its own effective role into `collab-main`. This is useful after
tuning roles in an experimental group and then capturing them as a reusable
profile suite.

### Delete Entry

```text
/role profile delete <profile>
```

Deletes only the current bot's entry in the profile. It does not delete other
bots' entries.

### Apply

```text
/role profile apply <profile> [--preview] [--force] [--quiet]
```

Behavior:

- If the profile has an entry for the current bot:
  - `--preview`: show what would be written, including byte count and source.
  - default: write it into the current group's chat role only if there is no
    existing chat role.
  - `--force`: overwrite the current group's chat role.
- If the profile does not have an entry:
  - do not write anything;
  - keep the bot on its team/default fallback;
  - report a concise configuration hint.
- `--quiet`: suppress success acknowledgements, but still report missing entry,
  overwrite refusal, invalid profile, or other failures.

This supports the common collaboration-group bootstrap:

```text
@A @B @C /role profile apply collab-main --quiet
```

Each mentioned bot applies its own profile entry. Missing entries are safe:
that bot falls back to its solo-safe default role.

## Group Creation Integration

### `/g` / `/group`

Add an optional flag:

```text
@A @B @C /g --role-profile collab-main <group name>
```

Implementation should not let the leader write peer daemon state. After the
group is created, the leader posts a bootstrap message into the new group:

```text
@A @B @C /role profile apply collab-main --quiet
```

The same model works for same-daemon and cross-daemon bots.

Default overwrite behavior is enough for new groups because they should not
already have chat roles. If a new group somehow has existing roles, apply will
refuse unless the generated bootstrap includes `--force`; v1 should not include
`--force`.

### `/relay --create`

Optional follow-up:

```text
@A @B /relay --create --role-profile collab-main <group name>
```

This is more subtle because relayed sessions keep the existing CLI process and
memory. The new group chat role will affect future botmux prompt wrappers, but
it will not rewrite old model context. Treat this as P2 after the `/g` flow is
stable.

## Dashboard Plan

### Placement

Use the existing **Roles** management area.

Rationale:

- Bot Defaults already owns solo-safe default roles.
- Roles already owns per-group chat roles.
- Role profiles are reusable chat-role suites, so they belong beside Roles.
- Team pages should stay focused on federation, roster, and group creation.

Add a two-tab or segmented-control layout inside `src/dashboard/web/roles.ts`:

```text
Roles
  [By Group] [Profiles]
```

Do not add a new top-level sidebar item for v1 unless the page becomes too
large after implementation.

### Profiles View

Left pane:

- searchable profile list;
- profile name;
- local entry count;
- warning badge when no local bots have an entry.

Right pane:

- selected profile details;
- local bot roster table/cards;
- per-bot status: configured / missing;
- editor for the selected local bot's profile entry;
- actions: Save Entry, Delete Entry, Apply To Group, Preview Apply.

Apply UX:

- user selects a target group from known groups;
- user selects one or more bots in that group;
- dashboard calls the same daemon endpoints per bot, or produces/copies the
  equivalent Lark bootstrap command;
- missing entries are shown as warnings, not fatal errors for the whole batch.

### Team / Group Creation UI

Add an optional role profile selector to the existing team/federated group
creation flow:

```text
Role profile: None | collab-main | release-war-room | ...
```

After the group is created, reuse the same bootstrap-message approach:

```text
@selected bots /role profile apply <profile> --quiet
```

This avoids cross-daemon writes and keeps behavior consistent with the slash
command.

### UI Standards

Follow the current Dashboard conventions:

- Use existing page shell, panels, editor layout, buttons, badges, and search
  patterns from `roles.ts` and `bot-defaults.ts`.
- Use CSS variables from `style.css` such as `--surface`, `--fg`, `--muted`,
  `--border`, `--accent`, `--danger`, and `--warning`.
- Avoid hard-coded light or dark colors.
- Keep card radius at the existing small radius; do not nest cards inside
  cards.
- Keep dense operational layout: this is a management surface, not a marketing
  page.
- Text areas use monospace and byte-count feedback matching the existing role
  editor.
- Long profile names and bot names must truncate or wrap without layout shift.
- Narrow screens should stack panes vertically.

### Multi-Theme / Skins Compatibility

The implementation must work under:

- default light theme;
- default dark theme;
- at least one named skin with custom background assets.

Requirements:

- Use only semantic CSS tokens for new colors.
- Avoid inline colors.
- Avoid translucent overlays that assume a light or dark backdrop.
- Test contrast for configured/missing/warning badges in light and dark modes.
- Ensure search inputs, segmented controls, modals, and textareas remain readable
  on named skins.

## Backend / API Plan

### Daemon IPC

Add endpoints to `src/core/dashboard-ipc-server.ts`:

```text
GET    /api/role-profiles
GET    /api/role-profiles/:profileId
GET    /api/role-profiles/:profileId/:larkAppId
PUT    /api/role-profiles/:profileId/:larkAppId
DELETE /api/role-profiles/:profileId/:larkAppId
POST   /api/role-profiles/:profileId/apply
```

`POST apply` body:

```json
{
  "chatId": "oc_xxx",
  "larkAppId": "cli_xxx",
  "force": false,
  "preview": false
}
```

The daemon must enforce that it only writes entries and chat roles for bots it
owns.

### Dashboard Proxy

Mirror/proxy the endpoints in `src/dashboard.ts`, following the existing
`/api/roles/:larkAppId/:chatId` pattern.

For multi-bot dashboard apply, the frontend can issue one request per selected
bot. That preserves partial-success reporting and avoids introducing a
cross-daemon transaction.

## Documentation Plan

Update:

- `docs-site/docs/zh/roles.md`
- `docs-site/docs/en/roles.md`
- `docs-site/docs/zh/slash-commands.md`
- `docs-site/docs/en/slash-commands.md`
- relevant Dashboard docs if the UI gets a new Profiles tab

Docs should state clearly:

- default role is the solo-safe fallback;
- profile is a reusable suite of bot-specific chat roles;
- applying a profile writes chat roles;
- missing profile entries fall back to default role;
- no template inheritance is supported.

## Test Plan

### Unit Tests

- `role-profile-store`:
  - slug validation;
  - write/read/delete entry;
  - list profiles;
  - max-byte handling;
  - atomic persistence.
- command handling:
  - `profile set`;
  - `profile save` from chat role;
  - `profile save` from team/default role;
  - `profile save` fails with no effective role;
  - `profile apply` writes chat role;
  - `profile apply` refuses to overwrite without `--force`;
  - `profile apply --preview` does not write;
  - missing entry keeps fallback and reports hint;
  - `--quiet` suppresses success but not failures.
- group creation:
  - `/g --role-profile` posts bootstrap apply command to the new group.

### Dashboard Tests / Checks

- API proxy tests for profile endpoints.
- Frontend build/typecheck.
- Manual or browser smoke:
  - Profiles tab renders profile list and editor;
  - save/delete entry works;
  - apply preview shows correct target bots;
  - missing entries display warnings;
  - group creation selector posts/applies the profile.

### Visual Checks

Use Playwright screenshots or equivalent smoke for:

- desktop light;
- desktop dark;
- mobile/narrow layout;
- one named skin.

Check that:

- no text overlaps;
- buttons do not resize on state changes;
- long names do not break layout;
- badges are readable in all themes.

## Rollout Phases

### Phase 1: CLI and Store

- Add role profile store.
- Add `/role profile` subcommands.
- Add command tests.
- Update slash command docs.

### Phase 2: Dashboard Profile Management

- Add Profiles tab inside Roles page.
- Add daemon/dashboard APIs.
- Add profile editor and per-bot entry table.
- Add theme-compatible CSS.

### Phase 3: Group Creation Integration

- Add `/g --role-profile`.
- Add Dashboard group creation selector.
- Use bootstrap-message apply, not direct peer writes.

### Phase 4: Relay Integration

- Consider `/relay --create --role-profile` after the group flow is proven.
- Document that relayed model memory is not rewritten.

## Open Questions

- Should `profile save` overwrite an existing entry by default, or require
  `--force`? The ergonomic default is overwrite; auditability can be handled by
  showing byte count and source in the acknowledgement.
- Should Dashboard "Apply To Group" call daemon APIs directly, or show/send a
  Lark bootstrap command? Direct APIs are smoother for same-deployment bots;
  bootstrap command is more faithful for cross-deployment bots.
- Should profile IDs be globally shared across federated teams in a future
  version, or remain per deployment with best-effort same-name convention?

## Acceptance Criteria

- Existing role behavior remains unchanged when no profile command is used.
- Default roles can stay solo-safe without losing collaboration ergonomics.
- A user can tune roles in a group, run one multi-mention `profile save`, create
  a new group, and run one multi-mention `profile apply`.
- Missing entries are safe and visible.
- Dashboard can create/edit/apply profiles without breaking existing Roles and
  Bot Defaults flows.
- UI works in light, dark, mobile, and named-skin contexts.
