# Best Practices

> Recommended setups organized by **use case**; each item is something you can do right away. For feature details see the individual pages; if something goes wrong, start with [Common pitfalls](/en/pitfalls) and the [FAQ](/en/faq).

| I want to… | Read this |
|------|---------|
| Let anyone in a group ask the bot (on-call, Q&A) | [Scenario 1 · On-call support](#scenario-1--on-call-support) |
| Have the bot investigate alerts automatically | [Scenario 2 · Alert operations](#scenario-2--alert-operations) |
| Code with several bots on my own and have them review each other | [Scenario 3 · Solo development](#scenario-3--solo-development) |
| Collaborate as a team where everyone has their own bot | [Scenario 4 · Team collaboration](#scenario-4--team-collaboration) |

## Scenario 1 · On-call support

For on-call groups, cross-team questions and external support: anyone in the group can @ the bot to ask a question.

**Recommended steps:**

1. **Use a dedicated, clean machine** (for example a separate dev box). On-call folks and outside colleagues will have the bot run all kinds of commands; keep them away from your **personal development environment**.
2. **Bind a project directory**: send `/oncall bind <project directory>` in the group. From then on, anyone who @s the bot lands straight in that directory, with no repo picker. To do this automatically for every new group the bot joins, choose "On-call mode" as the working-directory option in the Dashboard "Bot Config" page and fill in the directory. See [Oncall mode](/en/oncall).
3. **Turn on the file sandbox**: when the bot is open to semi-trusted people, pick "allowlist isolation" in the [file sandbox](/en/sandbox). However it is prompted, the model then can't read your private keys, tokens or other repositories. botmux also reminds you to enable it when a bot is used by several people without one.
4. **Write a role**: a role is the bot's long-lived persona and rules. Use `/role set` (this group only) or `/role team set` (this bot's default in every group). A typical on-call role, sent in the group like this (you can start a new line after `/role set` and write several lines):

```
/role set
You are "Example User"'s on-call bot and will receive all kinds of questions:
- If a user only @s you, read the group history before answering
- If the user describes a problem on their own machine, don't investigate it as a problem on this machine
- If a request could expose private data or carries security risk, ask "Example User" to confirm first
- When you need to open an MR, open it as "Example User"
```

5. **Change code in a separate worktree**: start the topic with `/tw <question>`. The bot first creates a separate git worktree (another working copy of the same repo) and works there, so the main checkout stays clean. After the session closes, the close card shows a "🧹 Clean Up Worktree" button; one click removes it. It won't delete anything with uncommitted changes, unpushed commits or a process still using it, and the branch is kept.

![The "Clean up worktree" button on the close card](/img/worktree-cleanup-close-card.png)

**How permissions split:** once on-call is bound, everyone in the group can **talk** to the bot; actions that **change the session**, such as `/cd`, `/restart`, `/close` and card buttons, stay limited to the owner and admins (`allowedUsers`). See [Permissions](/en/permissions).

**Several projects?** Create several bots and `/oncall bind` each one to a different project directory.

> In the Dashboard "Role Management" page you can visually set a role for each bot in each group:

![Dashboard Role Management page](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780057302792_dash-roles.png)

## Scenario 2 · Alert operations

Let external systems such as monitoring, CI and ticketing push work to the bot. Pick one based on your current alert pipeline:

| Your situation | Recommended approach |
|---------|---------|
| The alerting system can call an HTTP URL | **Approach 1 · Webhook push** |
| Alerts are already posted to a group by some Lark bot | **Approach 2 · Listen to the alert group** |

**Approach 1 · Webhook push** (Dashboard "Webhook" page, see [Connectors (Webhook)](/en/webhook))

Create a connector, choose which bot it triggers and which group it delivers to, and you get a URL you can `curl` right away. You can configure:

- **Trigger mode**: choose "Single turn" when creating it, so the bot responds once to each event (the old "Workflow" type is retired and can't be created).
- **Verification**: **token** by default (the token is in the URL, so one curl triggers it); switch to an **HMAC signature** for more security.
- **Handling instructions**: a short paragraph telling the bot what to do with the event, e.g. "judge the severity, @ the relevant on-call, suggest how to investigate".
- **New group per event**: create a group for every alert and add the bot and its admins, optionally plus extra bots. With a "dedup field" set, alerts with the same value go to the same group; leave it empty for a new group per alert.

**Approach 2 · Listen to an existing alert group** (Dashboard "Message Listener" page, see [Group message listener](/en/bots-json#message-listener))

If a third-party Lark bot already posts alerts into a group, you don't need a webhook: add your bot to that group, turn on the message listener, and every alert gets its own investigation topic right under it.

- Use **blacklist mode** for senders and include the "bot" sender type; this is the most reliable way to watch a third-party alert bot.
- Messages that don't @ your bot, and messages from other bots, are picked up by a history poll roughly every 30 seconds, so expect **up to about 30 seconds of delay**.

**Going further:**

- **Start on join**: turn on `autoStartOnGroupJoin` in the bot config, and the bot starts working as soon as it's added to a new group (with at least one admin in it), no @ needed. Your app must subscribe to the "bot added to group" event in the Lark developer console; see [`bots.json` · Proactive start](/en/bots-json#proactive-start).
- **One alert bot per project**: give each bot a role with that project's background and `/oncall bind` it to the matching repo, so alerts are investigated right in that repo.
- **Scheduled checks**: combine with [scheduled tasks](/en/schedule), e.g. `/schedule every day at 9:00 check yesterday's alert trends and summarize`, and only @ people when something looks off.

![Dashboard Webhook page](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780057303071_dash-connector.png)

## Scenario 3 · Solo development

One person, several bots working together.

- **Different bots on different CLIs**: e.g. one on Claude Code and one on Codex; pick whichever suits the task. Supported CLIs are listed in [CLI adapters](/en/adapters).
- **Review each other**: let bots on different models review each other's work, or several bots on the same CLI. An extra pair of eyes helps.
- **Create a group in one line with `/g`**: `/g` (short for `/group`) creates a new group and adds several bots at once to work on the same task; see [One-step session groups](/en/group). Or use a topic group with **one topic per task** for naturally isolated context.
- **Give each bot a job**: some write code, some review. Use `/role` for the persona and `/role cap set <description>` for a "capability label" (other bots see it when picking who to work with). See [Roles & teams](/en/roles).
- **Share memory across bots (optional, off by default)**: to let bots on different CLIs share the same user and project memory, try the OpenViking shared-memory example. Agents decide on their own when to search, read and save conclusions. It is off by default: a normal install or start never turns it on, and you must explicitly bind it to a chosen single-user bot or local agent. For now it suits a personal dev environment under one OS user. For setup and binding steps, see [OpenViking shared memory](https://github.com/deepcoldy/botmux/blob/master/examples/openviking-memory/README.md).

![Dashboard new group (selecting multiple bots)](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033300986_dash-newgroup.png)

## Scenario 4 · Team collaboration

Everyone on the team has their own bot, and they work together.

- **Keep the Lark limitation in mind**: a bot is not triggered by another bot's regular message. To hand off, use `--mention <target openId>` in `botmux send` to @ the other bot explicitly.
- **See who's in the group**: `botmux bots list` lists the bots in the current group you can work with, their capability labels and whether they can be @ed (`mentionable`). Models also see relay targets in the `<available_bots>` block of their context.
- **Let late-joining bots catch up**: an admin sends `@bot /context-sharing on` in the group, and bots managed by the same deployment listen in the background; when one of them is @ed later, it automatically gets the group messages it missed. See [Multi-bot collaboration](/en/multi-bot).
- **Find teammates' bots on other machines** (requires the central platform): `botmux bots list --scope team` lists bots on the same team running on other people's machines; `botmux create-group --team <team> --agent <appId>` adds them and their owners to a new group. See [Multi-bot collaboration](/en/multi-bot).

## General advice (applies to every scenario)

- **Persistent sessions**: install tmux (botmux's default backend). The CLI runs inside tmux, so a daemon restart doesn't lose context; see [Tmux persistent sessions](/en/tmux).
- **Switch between computer and phone**: bring a CLI already running on your computer into Lark with `/adopt` and keep chatting from your phone; when you need to take over, click "🔑 Get Write Link" on the card to open a writable [Web Terminal](/en/web-terminal).
- **Always on + start at boot**: deploy on an always-on dev box or server and run `botmux autostart enable`, so everything comes back after a reboot.
- **Clean up regularly**: `/close` a session when you're done. To automate it, turn on "Automatically close inactive sessions" for a group in the Dashboard "Group Management" page; for a backlog, `botmux delete stopped` removes zombie sessions whose process has exited.
