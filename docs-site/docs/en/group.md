# Create a Session Group in One Step

`/group <group name>` (alias `/g`): automatically **creates a new Lark group**, invites you in, and transfers ownership to you, with **the entire group serving as a single, independent CLI session** (chat-scope). Great for spinning up a clean collaboration space dedicated to one project / task.

```bash
/g card race-condition bug
```

The bot replies with a card: "✅ Created group 'card race-condition bug' 👉 <join link>". Click in and start chatting right away — the whole group is one independent session.

> When the group name is empty, a timestamp is used as a fallback. After creation, **no session is started automatically**; enter the group and message the bot to start chatting.

## Create a Group with Multiple Bots

Bots @-mentioned in the command are **added into the new group together** (the first @-mentioned bot is in charge of creating the group):

```bash
@Claude @Codex /g review group authorization
```

The reply lists "Bots in group: Claude, Codex". This makes the new group a natural multi-bot collaboration space — go in and @ whoever you want to do the work.

## Create a Group in the Dashboard

If you'd rather not use commands, the **Groups** panel in `botmux dashboard` can also create groups visually: pull specified bots into the group, automatically transfer ownership, and @-notify. You can also disband a group / have a bot leave a group (associated sessions are cleaned up automatically). See [Dashboard Control Panel](/en/dashboard).

![Create Group in Dashboard](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033300986_dash-newgroup.png)
<p class="cap">"New Group": fill in the group name, bind a directory, and check the bots to pull into the group</p>
