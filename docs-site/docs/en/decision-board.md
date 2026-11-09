# Decision Board and Steward

Make one bot your **steward**: you hand it development tasks and it pushes them forward in the relevant chats. Anything that needs your call goes onto the **decision board**. You write a decision per item (screenshots welcome), click **Submit** once, and the whole batch reaches the steward as **one message**. The steward executes it item by item and writes the results back to the board.

```text
You hand a task to the steward ──▶ steward creates an item, pushes in the related chats
                                        │
                                        ▼  something needs your call
                              Board: "Needs you"
                                        │  you write a decision, paste images (auto-saved draft)
                                        ▼  click "Submit N decisions"
                              One message to the steward ──▶ executed item by item, written back
```

> Off by default. Bots without a steward get no extra files, pages or prompt text.

## Turn it on in three steps

1. Open Dashboard → **Bot Config** → pick the bot → the **Steward** section under the "Sessions" category.
2. Turn on **Make this bot a steward** and pick a chat under **Steward chat**. A regular chat with only you and the steward works best; a topic chat works too, but each batch is posted as a new topic.
3. A **Decision board** entry appears in the sidebar. From now on, just hand tasks to the steward in its chat.

With "Make this bot a steward" on but no chat picked, you can still read the board and write drafts, but submitted decisions have nowhere to go; the page tells you to pick a chat.

Settings in the Steward section:

| Setting | What it does | Default |
|---|---|---|
| Make this bot a steward | This bot's sessions can maintain the board with `botmux board` | Off |
| Steward chat | Where you hand out tasks; submitted decisions go to this chat's session | Not set |
| Decision cards in Feishu | See "Deciding on a Feishu card" below | On |
| Add the steward to new chats | See "Adding the steward to new chats" below | On |
| Also add it to chats with only you and one bot | Same | Off |
| Find items that are ready to close | See "Finding items that are ready to close" below | Off |
| Instructions | The built-in rules are shown read-only; **append** your own (e.g. your progress standard or the path to your merge standard) or **replace** them entirely | Append |

You can also use `/botconfig` in Feishu:

```text
/botconfig set steward {"enabled":true,"chatId":"oc_…"}
/botconfig set steward {"enabled":true,"chatId":"oc_…","guideMode":"append","guideText":"Progress standard: …"}
/botconfig set steward {"enabled":true,"chatId":"oc_…","decisionCards":false}   # no decision cards
/botconfig unset steward          # turn the steward off; board data is kept
```

`guideMode` is `append` (after the built-in rules) or `replace` (replace them; `guideText` is then required).

## How the steward works

- **Rules on demand**: each turn in the steward chat carries just one extra system line pointing at the board and at `botmux board guide`. The rules themselves are not kept in context.
- **Posts as itself**: by default the steward posts in other chats as its own bot (`botmux send`). Target bots must receive its messages: enable "receive messages that @ this bot from other bots" in the Feishu developer console, and grant the steward bot talk permission in botmux.
- **Hands you the hard calls**: anything it cannot decide, or anything irreversible, becomes a "needs decision" item with two or three options, their consequences and its recommendation. Without a progress standard it only reports and nudges; it never merges, closes, releases, deploys or deletes on your behalf.
- **Not a workflow node**: a bot with the steward on is never assigned [workflow](./workflow.md) nodes and cannot be the orchestrator bot.

### Scheduled patrol

Want the steward to check in regularly → tell it in its chat, for example, "patrol every day at 9:30". It creates a silent [scheduled task](./schedule.md) in the steward chat. Each patrol:

1. **Wraps up**: checks unfinished board items against reality, closes what is done, updates what changed.
2. **Discovers**: looks at the owner's open PRs and new activity in linked chats from the last 7 days, and writes what needs your call as decision items.
3. **Reports only what is new**: it only flags new decision items; with nothing new it stays quiet.

The rules are the "Scheduled patrol" section of `botmux board guide`; change them (for example the time window) in the custom prompt. Use `botmux schedule` to change the frequency, pause or delete it.

`botmux board add` with an existing dedupe key (`--key`) updates that item, but it is refused when the item is done or closed, so a patrol cannot bring old items back. To really reopen one, use `botmux board set`.

### Finding items that are ready to close

A PR merged long ago, or the work an item waited on is done, yet the board still says "In progress". Turn on **Steward → Find items that are ready to close** (or `"closeHints":true`) and the daemon checks the board every 5 minutes (no model calls):

| Situation | Mark on the board |
|---|---|
| All linked PRs are merged (the default when no close condition is set), or the `--close-when` condition holds | Suggest closing |
| Every item in `--depends-on` has ended, or the PR used to judge closing was closed without merging | Suggest moving on |
| The `--next-check` time has passed with no update to the item since | Check in |

- **Hints only, no state change**: the mark shows on the overview row and the item page, and one history entry is added. The steward verifies and changes the state itself.
- **Steward notice**: new hints from one run are combined into **one** message in the steward chat and sent to the steward session; each hint is sent once. A failed delivery is retried on the next run.
- **Dismissing**: changing the item's state, or `botmux board set <n> --dismiss-hint`, clears the hint; the same hint does not come back.
- **Items without conditions are untouched**: an item with no linked PR, dependencies or check time is ignored.
- PR checks use this machine's GitHub credentials (`GITHUB_TOKEN` / `GH_TOKEN`, `~/.botmux/.env`, or `gh auth login`), and fall back to anonymous requests (60 per hour, shared by the whole machine). Open or closed PRs are checked at most every 10 minutes (a closed PR may be reopened, so it keeps being rechecked); only a merged PR is final and is not checked again. PRs that cannot be checked (not on GitHub, no access, rate limited) are left undecided for that run.

## Deciding on the board

### Overview

Three views: **Needs you** (including "needs review") / **In progress** / **All**, with search by title, repo or number at the top.

| Mark | Meaning |
|---|---|
| ● | The steward has new progress or a new reply since you last looked |
| ✎ | You have an unsubmitted draft |
| Open chat | Opens the item's main chat in Feishu; "+N more" under the title when there are several |
| No chat: (reason) | There really is no chat; the steward gave a reason |
| ⚠ No chat linked | Neither a chat nor a reason |
| 💡 Suggest closing / Suggest moving on / Check in | A hint from the board check (see "Finding items that are ready to close"), followed by the reason |

### Item page

From top to bottom:

- **Chats**: every chat of the item, main chat first and marked "Main", each with its own Open chat button; chats that could not be verified when linked are marked "Unverified".
- **Summary** and **current progress**.
- **Explainer** (when the steward attached one): pages are embedded right in the item page, with **Full screen** and **Open in new tab**; videos play in the page and can be scrubbed. Pages are generated by the steward and shown as untrusted content: no scripts, nothing external is loaded, only inlined images and styles, and they cannot read the Dashboard's sign-in or APIs. The overview and the Feishu card mark items that have an explainer.
- **Your decision is needed**: the question and options, with the steward's recommended option marked and its reasoning.
- **Your decision**: pick an option, write a note, paste or drop images (png / jpg / gif / webp, up to 10MB each, at most 8 per item).
- **History** timeline, plus linked PRs / sessions / commits.

**Previous / Next** at the top and under the decision box walk the list you came from (from "Needs you" they stay within it); opened straight from a Feishu link, they walk the view the item belongs to. Your draft is saved before switching.

### Drafts and submitting

- **Drafts are saved** on the server and never sent on their own. Your desktop and the Feishu sidebar share the same draft.
- If the steward changed the item after you started your draft, you get a "take another look before submitting" hint.
- Click **Submit N decisions** (on an item page: "Submit this decision" or "Submit (this + N other drafts)"). A dialog lists the drafts; unchecked ones stay as drafts.
- The checked drafts become one batch, delivered as **one turn** in the steward session; if the steward is busy, it queues behind the current turn.
- If delivery fails, "Recent submissions" shows why and offers **Deliver again**; undelivered batches are retried automatically after the daemon restarts.
- What you submitted is also posted verbatim in the steward chat: each item's number, title, main chat link, chosen option and your note, followed by the images. Long content is split across several messages, never cut.

### Deciding on a Feishu card

When the steward turns an item into a decision item or changes its options, a decision card for that item appears in the steward chat, so you can decide without opening the board:

- The card shows the title, a one-line status and the question, with one button per option; the steward's recommendation is marked and highlighted. Type a note in the box above to send it along with the option, or click **Send note only**. **Open in board** is at the bottom.
- Only you (the owner of the steward bot) can click; anyone else gets a no-permission message.
- A click works like submitting on the board: the item goes to the steward as its own batch and shows up in the timeline and "Recent submissions". The card switches to "Picked X, sending to the steward" and then "sent to the steward"; if delivery fails it shows why, and you can deliver it again on the board or click the same option again.
- Each item has one card. Later changes (new options, a web submission, the steward handling it, the item closing) update that card in place instead of posting a new one.
- When both the card and the web page submit for the same item, **the later one wins**, and the card says which batch it superseded or was superseded by. If the earlier batch has not reached the steward yet, it is voided and no longer pending. If it already reached the steward, which may be working on it, it stays pending, and the new batch tells the steward to mark that one as it actually went before acting on the new decision. Consecutive web submissions still run batch by batch as before.
- A web draft written before the steward changed the options (the chosen option is gone), or for an item no longer awaiting a decision, is still delivered when submitted, but does not supersede the card decision.
- With more than 6 options, content too long for a card, or an item that no longer awaits a decision (including closed or done), the card only shows the status and the board link.

To turn cards off, switch off **Decision cards in Feishu** in the Steward section of the bot settings. It only applies to bots with the steward on and a steward chat picked; other chats are unaffected.

### States

There are six: needs decision, needs review, in progress, waiting, done, closed. Finer workflow words (in review, fixing, mergeable, waiting on author …) go into the free-text stage.

## Chats linked to items

Every item links the Feishu chat where the work happens, so the board can take you there in one click.

- **New items need a chat**: `botmux board add` is rejected without `--link chat=oc_…`. If there really is no chat (only an issue, not started, or the steward handles it itself), give the reason with `--no-chat "<reason>"`; adding a chat later clears it. `board set` does not enforce this and existing items are not migrated; `board list` marks items with neither a chat nor a reason as missing a chat so the steward can fill them in.
- **Chats are verified when linked**: the steward bot's daemon looks the chat up with the credentials of bots on this machine. The steward bot goes first, then the other bots in turn (only those with the same owner, same brand and Feishu credentials; on a machine shared by several people, other people's bots are never used; if the steward does not trust same-owner bots on this machine, only the steward itself is used).
  - Found: the chat name becomes the default label (a label given by the steward wins).
  - Not found by any bot: the write is rejected, listing each bot's reason. To write it anyway, add `--allow-unverified-chat`; the board marks it "Unverified".
  - Credentials are only used inside the daemon process on this machine; they are never stored or printed.
  - Linking an existing chat again re-verifies it: the chat name and verification status are refreshed, the steward's own label is left alone. Older links can get their name filled in this way.
- **Main chat**: with several chats (a task chat plus some PR review chats) the first one is the main chat, opened by the overview's Open chat button; change it with `--primary-chat oc_…`.

## Adding the steward to new chats

To post in a chat as itself, the steward has to be a member. So once a steward is on, whenever botmux creates a chat (`/group`, the session chat created from a direct message, `/fork --create`, `/relay --create`, Dashboard group creation, `botmux create-group` and every other entry point) and the steward's owner is a member or the initiator, the creating bot adds the steward too.

- **On by default.** If you do not need it (for example the steward posts as the owner instead), turn off **Steward → Add the steward to new chats**, or run `/botconfig set steward {"enabled":true,"chatId":"oc_…","autoJoinNewGroups":false}`.
- **Joins quietly**: the steward does not speak or start a session. Its group-join command, group-join hooks and "auto-start when added to a new chat" do not run, it does not pull its owner in, and it is left out of oncall binding, role suites and kickoff. It answers later only when someone @-mentions it, as usual.
- **Only the matching steward**: when several people on one machine each have a steward, only the one whose owner is in the new chat is added. Owners are matched by union_id; a steward with no owner (empty `allowedUsers`), or whose daemon has not resolved its owner's union_id yet (just started, or no contacts permission), is not added.
- **One-person-one-bot chats are skipped by default**: for example the session chat created from a direct message, chats made with `/group` or `/fork --create` in a direct message, or meeting listener chats. You keep talking in those without an @; adding the steward would make it two bots, and the original bot would then need an @. This is decided from who actually joined. To add it anyway, turn on **Also add it to chats with only you and one bot** (requires the switch above), or set `"autoJoinSoloGroups":true`.
- A steward already among the requested bots is not added twice. If adding it fails (app visibility, permissions …) the chat is still created; the failure is logged, and Dashboard group creation and `botmux create-group` show the reason.

## Opening the board inside Feishu

Item links from the steward open in the **chat's right sidebar** on Feishu desktop and inside the Feishu client on mobile. Links carry no credentials; how you sign in depends on the deployment:

| Deployment | Sign-in after opening |
|---|---|
| Bound to the central platform with remote access on | Platform Feishu SSO; only the machine owner and co-managers get in |
| Dashboard Feishu H5 login configured (`BOTMUX_DASHBOARD_FEISHU_H5_*`) | Seamless in-Feishu login for listed users; H5 identities only gain the board APIs |
| Neither | The Dashboard login page; Feishu remembers it after you sign in once |

## Steward commands

The steward calls these itself inside its session; you normally do not type them. Knowing them helps when writing custom rules:

```bash
botmux board guide                                    # steward rules (built-in + custom)
botmux board pending                                  # submitted decisions not yet handled
botmux board list [--view decide|active|all]          # list items, each with a Feishu link
botmux board show <n|key>
botmux board add <title> --key pr:owner/repo#12 --link chat=oc_… --link pr=owner/repo#12
botmux board add <title> --no-chat "only an issue so far"            # no chat: say why
botmux board set <n> --link chat=oc_… --primary-chat oc_…            # add a chat / change the main chat
botmux board set <n> --state decide --ask "question" \
  --option "A=approach → outcome and risk" --option "B=…" --recommend A --reason "why"
botmux board set <n> --unlink doc=https://old --link "doc=https://new|Board doc"   # remove / replace a link
botmux board history <n> "what was done, result" --handled   # --handled: latest decision executed
botmux board attach <n> shot.png --note "repro"
botmux board attach <n> explainer.html demo.mp4 --note "before / after"   # explainer
botmux board set <n> --close-when "item:66 done" --depends-on 66,70 --next-check +2d   # when it can close
botmux board set <n> --dismiss-hint                   # dismiss the board hint
```

- `--link kind=ref|label`: everything after the last `|` is the label (write a literal `|` inside a URL as `%7C`).
- `--link` only appends; remove a wrong one with `set <n> --unlink kind=ref`.
- To write a chat that cannot be found, add `--allow-unverified-chat`.
- `--close-when`: `"pr:owner/repo#12 merged"`, `"item:66 done"`, `manual` (only the steward decides; linked PRs no longer trigger the default hint) or `auto` (remove it, back to the default). `--depends-on` replaces the whole list; `none` clears it. `--next-check` takes `+2h` / `+3d` / `+1w` or a time with a timezone (`2026-11-10T09:30+08:00`); `none` clears it.
- `attach` with an explainer: an `.html` page is a single file (images inlined as data URLs, UTF-8, at most 10MB); `.mp4` / `.webm` videos are at most 50MB, mp4 in H.264 with `-movflags +faststart`. Up to 4 per attach, alongside screenshots if you like. The steward guide (`botmux board guide`) covers how to write the page and has a minimal template.
- See `botmux board --help` for every option.

## Where the data lives

The board lives in `<data dir>/decision-board.sqlite` (one file per machine, partitioned per steward bot) with images and explainers under `<data dir>/decision-board/<app_id>/files/` (pages / videos uploaded but not attached yet sit in the sibling `staging/` and are removed after an hour), created on first use. Turning the steward off keeps the data.
