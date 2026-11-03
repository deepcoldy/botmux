# Create a Session Group in One Step

`/group <group name>` (alias `/g`): automatically **creates a new Lark group**, invites you in, and transfers ownership to you, with **the entire group serving as a single, independent CLI session** (chat-scope). Great for spinning up a clean collaboration space dedicated to one project / task.

```bash
/g card race-condition bug
```

The bot replies with a card: "✅ Created group 'card race-condition bug' 👉 <join link>". Click in and start chatting right away — the whole group is one independent session.

> When the group name is empty, a timestamp placeholder is used until the first message names the group (see below). After creation, **no session is started automatically**; enter the group and message the bot to start chatting.

## Automatic Group Name and Avatar

Without a group name, the group starts with the placeholder "New session MM/DD HH:mm". After the first substantive message in it, the bot summarizes a short title and renames the group, just like the session-group mode for DMs. An explicit group name always wins.

The avatar defaults to the session-group botmux logo on a gradient background; `--avatar name` uses a group-name text avatar instead (re-rendered after the automatic rename), and `--avatar off` keeps Lark's default. See [group creation options](https://github.com/deepcoldy/botmux/blob/master/docs/guide/group-creation.md) for the rest.

## Create a Group with Multiple Bots

Bots @-mentioned in the command are **added into the new group together** (the first @-mentioned bot is in charge of creating the group):

```bash
@Claude @Codex /g review group authorization
```

The reply lists "Bots in group: Claude, Codex". This makes the new group a natural multi-bot collaboration space — go in and @ whoever you want to do the work.

## Bootstrap a Role Profile

If you keep reusable collaboration personas in a [role profile](/en/roles), add `--role-profile <profile>` when creating the group:

```bash
@Claude @Codex /g --role-profile collab-main review group authorization
```

After the group is created, the creator bot applies its own entry directly, then posts `@Codex /role profile apply collab-main --quiet` for the other bots inside the new group. Each bot applies only its own local profile entry, which materializes as that bot's this-group Role. Missing entries are safe and fall back to the default role.

## Create a Group in the Dashboard

If you'd rather not use commands, the **Groups** panel in `botmux dashboard` can also create groups visually: pull specified bots into the group, automatically transfer ownership, and @-notify. The new-group dialog can select a Role Profile; an existing group's "Apply Profile" action opens **Role Profiles** with that group preselected as the Apply target. You can also disband a group / have a bot leave a group (associated sessions are cleaned up automatically). See [Dashboard Control Panel](/en/dashboard).

![Create Group in Dashboard](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033300986_dash-newgroup.png)
<p class="cap">"New Group": fill in the group name, bind a directory, and check the bots to pull into the group</p>

## Automatic names for DM-created session groups

Choose and save a mode under Dashboard **Bot config → Sessions → Private chat / dedicated group → Dedicated group naming**. Settings apply per Bot; **AI summary** remains the default.

| Option | Behavior |
| --- | --- |
| AI summary (`ai-summary`, default) | Create a placeholder, then independently generate a short title. |
| Reuse Agent session title (`session-title`, new) | Use the title published by the current resident Agent without another model call. Keep the placeholder until ready. |
| Truncate first message (`truncate`) | Keep the truncated first-message group name. |

Codex AI summaries now use the isolated app-server title generator instead of `codex exec`: low reasoning, a temporary `CODEX_HOME` containing the copied login credentials plus only the provider wiring from the source `config.toml` (`model` / `model_provider` / `model_providers`), and disabled hooks, plugins, MCP, tools and project instructions. Copying only the credentials would drop a gateway Bot's provider (`base_url` / `env_key` / inline `http_headers`) and silently fall back to Codex's built-in `openai` provider — either failing outright (placeholder kept) or billing the host account on the default endpoint. Every other user setting (hooks, plugins, MCP servers, `projects`/trust, `profiles`, features) is still excluded. If the source `config.toml` exists but cannot be read safely (symlink, hard link, oversized, changed mid-read) or does not parse, no title is generated at all rather than falling back to a provider the Bot never configured. Enter an available lightweight model ID in **Summary model (Codex)**, or leave it blank to inherit the Bot model. The override only applies to dedicated-group AI summaries; it does not change conversation or native-session-title models. Other CLIs retain their existing summary path. The shared generator also serves Codex `/g` summaries, which retain the Bot model and their existing launch eligibility gates.

Equivalent per-Bot `bots.json` configuration:

```json
{
  "sessionGroup": {
    "naming": { "mode": "session-title", "maxLen": 12 }
  }
}
```

For a separate summary model, use `"naming": { "mode": "ai-summary", "model": "your-available-lightweight-model-id" }`.

Reuse accepts Codex native semantic titles or titles published through Botmux session rename (including Agent renames and renames initiated by the user from the Dashboard or inside a session); it does not scan every CLI's private title store. The `[BotMux·Lark]` prefix is removed before applying length limits and `sessionGroup.namePrefix`. Naming stops after the first success. Ordinary groups and subtopics are unaffected. Manual group names are protected; legacy entries without a trusted birth name remain unchanged. Failed renames retain the candidate for bounded retries on later group messages.

## DM-created session groups: change the tag on close

With `p2pMode: "group"`, set **Tag after closing** under Dashboard **Bot configuration → Sessions → Session mode → DM dedicated group → Session-group tag**, for example “Closed”. Leave it empty to retain the current behavior. The equivalent per-bot `bots.json` configuration is:

```json
{
  "p2pMode": "group",
  "sessionGroup": {
    "tag": {
      "mode": "feed-group",
      "name": "Active",
      "closedName": "Closed"
    }
  }
}
```

After a clean `/close` (including the close-card action that uses this command), the chat is added to the configured destination and then removed from its original automatic group. The destination is reused or created by name. Neither group itself, other chats, nor chat history are deleted. Names are trimmed and limited to 60 Unicode codepoints.

- Supports personal `feed-group` mode only, using the **user who created the session group** and their existing tag authorization. Use `/login tags` if authorization is missing.
- Failed closes, unclean residuals, `/stop`, crashes, background cleanup, and ordinary groups/topics do not move tags.
- Migration runs in the background with a separate failure notification. Failed adds keep the original association; identical source and destination IDs are never removed.
- Resuming does not move the chat back. Clearing `closedName` disables this behavior without bulk-migrating existing chats.

## Disband a dedicated session group: `/dismiss`

Send `/dismiss` at the top level of a dedicated session group, review the impact notice, then send the returned confirmation command. Only its initiating human with Bot operator permission may confirm. The Bot must own the group or be its creator with `im:chat:operate_as_owner`.

The command safely closes the session before disbanding the group, then sends a private receipt. Other active sessions, failed closure or runtime residuals prevent deletion. If deletion fails, the session stays closed; send `/dismiss` again to confirm a retry. DMs, ordinary groups, subtopics and adopted sessions are excluded.

All group members are affected; resuming cannot recreate the original group. Code and worktrees are kept, and closed-tag migration is skipped. Use `/close` to keep the group and change its tag.
