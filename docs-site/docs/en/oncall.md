# On-Call Mode

<video src="../img/video-v6-oncall-voice-en.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

Add a bot to a duty, alert, or Q&A group and bind it to a project directory. From then on **anyone in the group** can @ it with a question. No repo picker, no access request: the bot answers from that directory.

It fits groups where "lots of people ask, at any time, about the same project": duty groups, alert groups, cross-team Q&A groups.

> **Adding the bot to a group does not open it up.** Everyone in the group can talk to it only after an on-call binding (or after a bare `/grant` opens the whole group). Without either, a non-listed member who @-mentions it is blocked and gets a grant request card. See [Permissions & Access · Being added to a group is not authorization](/en/permissions#being-added-to-a-group-is-not-authorization).

## What changes once it's on

| | Before binding | After binding |
|---|---|---|
| Who can @ the bot and chat | Only the owner, admins (`allowedUsers`) and granted users | **Everyone** in the group, including other bots in it |
| Message quota | Guests admitted by grant cards are quota-limited | **Unlimited** |
| Where new topics start | Repo picker card, or the bot's default directory | Straight into the bound directory |
| Who can change session state (`/cd`, `/restart`, `/close`, card buttons) | Owner / admins | Still only owner / admins |

Bindings are **per bot**: in a group with several bots, only the bound one opens up to the group.

## How to turn it on (pick one)

| You want to… | Use |
|---|---|
| Start using it in one group right now | Option 1: send `/oncall bind` in the group |
| Enable it group by group in a web UI | Option 2: Dashboard "Group Management" |
| Have it on automatically in every group the bot joins | Option 3: Dashboard "Bot Config" |

### Option 1: Send a command in the group

@ the bot in the group and send:

```
/oncall bind ~/projects/your-service
```

- Only the @-mentioned bot is bound. Bind several at once: `@bot1 @bot2 /oncall bind <path>`.
- The directory is created if it doesn't exist.
- Requires operate rights (owner / `allowedUsers`).
- From the **next new topic** in this group, the bot starts in this directory.

### Option 2: Per group in Dashboard "Group Management"

1. Open the Dashboard **Group Management** page, find the group, click **Manage**.
2. Switch to the **Bot settings** tab and pick the bot on the left.
3. Under **Oncall Mode**, click **Enable**, fill in the working directory, and click **Save**.

This affects only this bot in this group. The directory must already exist. Turn **Enable** off and save to unbind.

![Oncall Mode under Group Management · Bot settings](/img/oncall-group-manage-bots.png)

### Option 3: Every group via Dashboard "Bot Config"

Open the **Bot Config** page, select the bot, choose **On-call mode** under **Default Working Directory**, fill in a directory, and click **Save**.

That section is a three-way choice:

| Option | Effect |
|---|---|
| Pick a repo each time (default) | New sessions show the repo picker in Feishu first |
| Fixed default directory | New sessions start in this directory; permissions unchanged |
| **On-call mode** | Groups auto-bind to this directory and chat opens to the whole group |

With On-call mode selected:

- **When auto-binding happens**: the first time the bot receives a message in a group that isn't bound yet, it binds that group to this directory. New and existing groups alike. Binding happens before the permission check, so the first person (or alert bot) to speak doesn't get a grant card.
- **Groups that are already bound are left alone**, whether bound manually or by another bot.
- **A group that was unbound (`/oncall unbind`, or disabled in the Dashboard) is never auto-bound again.** To bind it again, send `/oncall bind <path>` in the group.
- **DMs and other sessions use this directory too**: the bot's new DM and topic sessions start here by default (DMs are not opened to everyone because of this).
- **When you switch back to one of the other two options**, groups that were auto-bound and still point at this directory are unbound together. Groups you bound manually to another directory stay as they are.

The bot card shows "N chats bound now · M chats auto-bound before". "Auto-bound before" is the size of the auto-bind list, not the current binding count: groups that were unbound, or released when switching modes, are counted too, and none of them will be auto-bound again.

![On-call binding counts in Bot Config](/img/oncall-bot-chat-counts-en.png)

## Commands

| Command | What it does |
|---|---|
| `/oncall bind <path>` | Bind this bot to the directory in this group; if already bound, switch to the new one. Several bots: `@bot1 @bot2 /oncall bind <path>` |
| `/oncall unbind` | Remove this bot's binding in this group; new topics go back to the repo picker |
| `/oncall status` | Show the directory this bot is bound to here (plain `/oncall` does the same) |

- Subcommands also accept Chinese: `绑定`, `解绑`, `状态`.
- All three must be used in a group and need operate rights.
- In DM session groups (groups created automatically from a private chat), the bot writes the binding when it creates the group, and `/oncall` can't change it. Groups created with `/g` aren't affected; `/oncall` works there as usual.
- After binding, `/cd <path>` inside a session changes the directory and stays in on-call mode.

## How permissions are split

- **Chat**: everyone in the group can ask questions, check logs and read code, with no quota. Users on the block list (`blockedUsers`) are still blocked.
- **Management**: changing directory, restarting, closing the session and clicking streaming-card buttons remain owner / admin only, so group members can't accidentally mess up the session.
- **Opening a few low-risk commands to group members**: add them under "canTalk-allowed daemon commands" in Bot Config (`canTalkDaemonCommands` in `bots.json`), e.g. `/status /help`. Commands that change state, like `/cd` and `/restart`, are best left closed.

> An on-call binding **does not restrict file access**. To keep group members away from secrets and other repositories, also enable [File Sandbox](/en/sandbox) allowlist isolation (the working directory stays writable and changes land on the host). To keep changes off your main branch, open the topic in a separate worktree with `/tw`.

## Who the reply @-mentions

In an on-call group, the "Sent to:" line at the bottom of the bot's reply card @-mentions **whoever asked this turn**, so the person who asked gets the notification. If the asker is another bot, it mentions the owner instead, so two bots don't keep pinging each other.

## Pair it with scheduled tasks

In the on-call group, send:

```
/schedule 每天9:00 检查昨天的报警趋势并总结
```

The bot posts a report to the group every day at that time, so someone's watching even when you're not. Scheduled tasks reuse the group's bound directory. See [Scheduled Tasks](/en/schedule) for more formats.

## Editing `bots.json` by hand

Dashboard settings are stored in `bots.json`, which you can also edit directly:

```json
{
  "oncallChats": [
    { "chatId": "oc_xxx", "workingDir": "~/projects/your-service" }
  ],
  "defaultOncall": { "enabled": true, "workingDir": "~/projects/your-service" }
}
```

- `oncallChats`: per-group bindings, each a chat ID plus a directory.
- `defaultOncall`: the "On-call mode" option.
- `defaultOncallAutoboundChats`: the auto-bind list, maintained by botmux; usually no need to edit it.

For other fields see [bots.json configuration](/en/bots-json).

## FAQ

**On-call mode is on, but a group still didn't get auto-bound?**
- The group was unbound before (`/oncall unbind`, or disabled in the Dashboard), or released when switching modes. Send `/oncall bind <path>` in the group.
- The configured directory doesn't exist on the machine, so auto-binding is skipped. Create it first.

**Want the whole group to be able to chat, without changing directory?**
A bare `/grant` opens the whole group. See [Permissions & Access](/en/permissions).
