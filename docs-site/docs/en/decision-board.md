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

## Adding the steward to new chats

To post in a chat as itself, the steward has to be a member. So once a steward is on, every chat botmux creates (`/group`, the session chat created from a direct message, `/fork --create`, `/relay --create`, Dashboard group creation, `botmux create-group` and every other entry point) is checked: if the steward's owner is a member or the initiator of the new chat, the creating bot adds the steward as well.

- **On by default.** The switch is **Bot Config → Steward → Add the steward to new chats**; `/config set steward {"enabled":true,"chatId":"oc_…","autoJoinNewGroups":false}` turns it off too. If your steward does not post as its own bot (for example, it posts as the owner), you do not need it in new chats — turn this off.
- The steward **joins silently**: its group-join command, group-join hooks and "auto-start when added to a new chat" do not run, it does not pull its owner in, and it is left out of oncall binding, role suites and kickoff. It answers later only when someone @-mentions it, as usual.
- **Only the matching steward joins**: when several people on one machine each have a steward, only the one whose owner is in the new chat is added. Owners are matched by union_id; a steward with no owner (empty allowedUsers), or whose daemon has not resolved its owner's union_id yet (just started, or no contacts permission), is not added.
- **New chats with only one person and one bot are skipped by default**: for example the session chat created from a direct message, a chat made with `/group` or `/fork --create` in a direct message, or a meeting listener chat. You keep talking in those without an @, and the steward would make it two bots, so the original bot would need an @. This is decided from who actually joined. To add the steward there too, turn on **Also add it to chats with only you and one bot** (off by default, requires the switch above), or set `"autoJoinSoloGroups":true`.
- A steward that is already among the requested bots is not added twice. If adding it fails (app visibility, permissions, …) the chat is still created; the failure is logged and `botmux create-group` reports it.

## The board

- **Overview**: Needs your decision / In progress / All. ● = the steward wrote something since you last looked; ✎ = you have an unsubmitted draft. Under each title is the item's main chat ("+N more" when there are several), and **Open chat** on the right opens it in Feishu. Rows without a chat show "No chat: <reason>", or "⚠ No chat linked" when no reason was given either.
- **Item page**: right under the title, every chat of the item, main chat first and marked "Main", each with its own Open chat button; chats that could not be verified when linked are marked "Unverified". Below that: summary, current progress, the question and options (recommended one marked), your decision (with images), the history timeline, and linked PRs / sessions / commits. **Previous / Next** buttons at the top and under the decision box walk the list you came from (from "Needs you" they stay within it); opened straight from a Feishu link, they walk the view the item belongs to. Your draft is saved before switching.
- **Drafts** are saved on the server and never sent on their own. Your desktop and the Feishu sidebar share the same draft.
- **Submit N decisions** turns the selected drafts into one batch = one turn in the steward session (queued behind a running turn). Failed deliveries show the reason and can be retried; undelivered batches are retried automatically after the daemon restarts.
- What you submitted is also posted verbatim in the steward chat: each item's number, title, main chat link, chosen option and your note, followed by the images. Long content is split across several messages, never cut.

## Chats linked to items

Every item links the Feishu chat where the work happens, so the board can take you there in one click:

- **New items need a chat**: `botmux board add` is rejected without `--link chat=oc_…`. If there really is no chat (only an issue, not started, or the steward handles it itself), give the reason with `--no-chat "<reason>"`; the board shows "No chat: <reason>". Adding a chat later clears the reason. `board set` does not enforce this and existing items are not migrated; `board list` marks items with neither a chat nor a reason as missing a chat so the steward can fill them in.
- **Chats are verified when linked**: the steward bot's daemon looks the chat up (`im/v1/chats/:chat_id`) with the credentials of the bots on this machine: the steward bot first, then the other bots in turn (same owner as the steward, same brand, with Feishu credentials; on a machine shared by several people, other people's bots are never used; if the steward does not trust same-owner bots on this machine, only the steward bot itself is used). If found, the chat name becomes the default label (a label given by the steward wins). If no bot can find it, the write is rejected with each bot's reason; to write it anyway, add `--allow-unverified-chat` and the board marks it "Unverified". Credentials are only used inside the daemon process on this machine; they are never stored or printed. Linking an existing chat again re-verifies it: the chat name and verification status are refreshed, the steward's own label is left alone, and older links get their name filled in.
- **Main chat**: with several chats (a task chat plus some PR review chats) the first one is the main chat, opened by the overview's Open chat button; change it with `--primary-chat oc_…`. Batches posted in the steward chat carry each item's main chat link too.

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
botmux board add <title> --key pr:owner/repo#12 --link chat=oc_… --link pr=owner/repo#12
botmux board add <title> --no-chat "only an issue so far"            # no chat: say why
botmux board set <n> --link chat=oc_… --primary-chat oc_…            # add a chat / change the main chat
botmux board set <n> --state decide --ask "question" \
  --option "A=approach → outcome" --option "B=…" --recommend A --reason "why"
botmux board set <n> --unlink doc=https://old --link "doc=https://new|Board doc"   # remove / replace a link
botmux board history <n> "what was done" --handled
botmux board attach <n> shot.png --note "repro"
botmux board pending
```

In `--link kind=ref|label` everything after the last `|` is the label (write a literal `|` inside a URL as `%7C`). `--link` only appends; remove a wrong one with `--unlink kind=ref`. To write a chat that cannot be found, add `--allow-unverified-chat`. See `botmux board --help` for every option.

## Data

The board lives in `<data dir>/decision-board.sqlite` (partitioned per steward bot) with images under `<data dir>/decision-board/<app_id>/files/`, created on first use. Turning the steward off keeps the data.
