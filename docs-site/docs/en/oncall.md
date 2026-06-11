# On-Call Mode

Add a bot to an on-call / duty / alert group and bind it to a project directory. Then **any member** of the group can @ the bot to ask questions — no need to pick a repository, no need to start a new session — going straight into that project directory to chat. Especially suited to "many people, asking anytime, all asking about the same project" scenarios like duty groups, alert groups, and cross-team Q&A.

## How to Enable (pick one of three)

You can enable it **per group**, or set a default in the **bot config** so every group enables it automatically.

### Option 1: Send a command in the group

The fastest way — just send a line in the group:

```
/oncall bind ~/projects/your-service
```

This anchors the current group to that directory, and the initiator automatically becomes the owner. Good for when you just spun up a group and want to use it immediately.

### Option 2: Enable per group (Dashboard)

Go to the Dashboard's **Groups** page, click **Manage** on a group, and in the card that pops up, check the bots to enable under **On-Call Mode**, fill in the working directory, and click **Save**.

> Once enabled, group members can @ the bot; new topics use the bound directory directly.

This affects **only this one group** — good for enabling a specific few groups one by one.

![Enable On-Call Mode per group](https://magic-builder.tos-cn-beijing.volces.com/uploads/oncall-group-card.jpg)

### Option 3: Enable by default per bot (Dashboard)

Go to the Dashboard's **Bot Config** page, turn on the **Enter on-call mode by default** toggle, fill in a default working directory, and click **Save**.

From then on, **all of the bot's unbound groups** automatically bind to this directory the next time they open a new topic — no need to set each group individually, and newly created groups work out of the box.

> - Groups that were manually bound / manually unbound will **not** be overwritten.
> - Old groups that already existed **before** the toggle was turned on are unaffected (it only takes effect for subsequent new topics).

![Enable On-Call Mode by default per bot](https://magic-builder.tos-cn-beijing.volces.com/uploads/oncall-bot-default.jpg)

> This corresponds to the `defaultOncall` field in `bots.json`, which can also be edited manually. See [bots.json configuration](/en/bots-json).

## Commands

| Command | Description |
|------|------|
| `/oncall bind <path>` | Bind the current group to a project directory; the initiator automatically becomes the owner |
| `/oncall unbind` | Unbind (owner only) |
| `/oncall status` | View the current binding |

## Permission Tiers

- **Everyone** in the group can talk to the bot (ask questions, check logs, read code)
- Only the **owner** can switch session state (`/cd`, `/restart`, `/close`, clicking the streaming card buttons)
- This prevents external group members from accidentally messing up the session

> Want semi-trusted members' **changes to also never touch the real repo**? Enable the [File Sandbox](/en/sandbox) — all writes are isolated and only land after the owner reviews the diff.

## Take Off with Scheduled Tasks

In an on-call group, send `/schedule 每天9:00 检查昨天的报警趋势并总结` to feed a report into the group at a fixed time every day — even when you're off duty, the bot keeps an eye on things for you. The reply card automatically "sends to @asker / cc @owner", so you can stay on top of group activity remotely too.

**Typical scenarios**: duty groups, alert groups (Argos alert analysis), cross-team consultation groups, on-call Q&A.

![On-Call Mode demo](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780419243198_oncall.png)
