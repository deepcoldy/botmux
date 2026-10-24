# Decision Board and Steward

Make one bot your **steward**: it pushes forward the development tasks you hand it, and writes anything that needs your call onto the **decision board**. You write a decision per item (and paste screenshots), then click **Submit** once — the whole batch reaches the steward's session as **one message**, and the steward executes it item by item and writes the results back.

> Off by default. Deployments without a steward get no extra files, pages or prompt text.

## Turning it on

Dashboard → **Bot Config** → pick the bot → **Steward** section:

- **Use as steward**: this bot's sessions can maintain the board with `botmux board`, and a "Decision board" entry appears in the sidebar.
- **Steward chat**: where you hand tasks to the steward; submitted batches are delivered to this chat's session. A regular chat with just you and the steward works best.
- **Prompt**: the built-in steward rules are shown read-only. **Append** your own rules (e.g. your merge standard, or a different tool for posting messages) or **replace** them entirely.

In Feishu you can also run `/config set steward {"enabled":true,"chatId":"oc_…"}`.

## How the steward works

- In the steward chat each turn carries one extra system line pointing at the board and at `botmux board guide`; the rules themselves are not resident.
- By default the steward posts in other chats **as its own bot** (`botmux send`). Target bots must accept the steward bot's messages (enable "receive messages that @ this bot from other bots" in the Feishu developer console, and grant the steward bot talk permission in botmux).
- Anything it cannot decide, or anything irreversible, becomes a "needs decision" item with options, consequences and a recommendation.
- Scheduled patrols are not part of this feature. Use a [scheduled task](./schedule.md) for the steward if you want one.

## The board

- **Overview**: Needs your decision / In progress / All. ● = the steward wrote something since you last looked; ✎ = you have an unsubmitted draft.
- **Item page**: summary, current progress, the question and options (recommended one marked), your decision (with images), the history timeline, and linked PRs / chats / sessions / commits.
- **Drafts** are saved on the server and never sent on their own. Your desktop and the Feishu sidebar share the same draft.
- **Submit N decisions** turns the selected drafts into one batch = one turn in the steward session (queued behind a running turn). Failed deliveries show the reason and can be retried; undelivered batches are retried automatically after the daemon restarts.

There are six states: needs decision, needs review, in progress, waiting, done, closed. Finer workflow words (in review, fixing, mergeable …) go into the free-text stage.

## Opening inside Feishu

Every item link opens in the **chat's right sidebar** on Feishu desktop (`applink …/client/web_url/open?mode=sidebar-semi`) and inside the client on mobile. Links carry no credentials:

| Deployment | Sign-in after opening |
|---|---|
| Bound to the central platform with remote access on | Platform Feishu SSO; only the machine owner and co-managers get in |
| Dashboard Feishu H5 login configured (`BOTMUX_DASHBOARD_FEISHU_H5_*`) | Seamless in-Feishu login for listed users; H5 identities only gain the board APIs |
| Neither | The Dashboard login page; the Feishu webview remembers it afterwards |

## Steward commands

```bash
botmux board guide
botmux board list [--view decide|active|all]
botmux board show <n|key>
botmux board add <title> --key pr:owner/repo#12 --link pr=owner/repo#12 --link chat=oc_…
botmux board set <n> --state decide --ask "question" \
  --option "A=approach → outcome" --option "B=…" --recommend A --reason "why"
botmux board history <n> "what was done" --handled
botmux board attach <n> shot.png --note "repro"
botmux board pending
```

See `botmux board --help` for every option.

## Data

The board lives in `<data dir>/decision-board.sqlite` (partitioned per steward bot) with images under `<data dir>/decision-board/<app_id>/files/`, created on first use. Turning the steward off keeps the data.
