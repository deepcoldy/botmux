# Permissions & Authorization

botmux permissions answer just two questions:

| Permission | Meaning | Examples |
|------------|---------|----------|
| **Talk** (canTalk) | Can this person talk to the bot and give it work | @mention the bot with a question, keep chatting in a topic |
| **Operate** (canOperate) | Can this person change the session itself | `/cd`, `/restart`, `/close`, admin buttons on cards |

Most ways of granting access **give talk only**. Operate rights belong to admins (`allowedUsers`) by default.

## Common operations

Start with this table — it covers most needs:

| What you want | How |
|---------------|-----|
| Let **the whole group** ask, no message limit | Send `@bot /grant` (or `/grant all`) in the group. Revoke with a bare `/revoke`. In a topic group it covers every topic |
| Give **specific people** a short trial | `@bot /grant @Alice @Bob` — the bot replies with a grant card, defaulting to 3 messages / 1 hour per person |
| Set the count directly | `@bot /grant @Alice 20` — 20 messages each; the duration is still picked on the card |
| Fine-tune on the card | Duration: **1 hour / 8 hours / 1 day / 7 days / permanent**. Message quota: an integer from 1 to 1000; **leave blank for unlimited**. Whichever runs out first ends the grant |
| Revoke someone's access | `@bot /revoke @Alice` (you can @ several people at once). It removes their per-group and global grants; **if they are also on the `allowedUsers` admin list, that entry is removed too**, and the reply names the affected scopes. Revoking the owner, or a revoke that would leave the bot with no admin, is refused |
| Duty-group instant Q&A, no repo picking | `/oncall bind ~/projects/foo` — see [On-Call Mode](/en/oncall) |
| Grant in bulk from a web page | Dashboard **Group Management** → the group's **Manage** → **Member access** tab (screenshot below) |

Only owners / admins can run `/grant` and `/revoke`. Granted people (guests) can only talk.

![The Member access tab under Group Management in the Dashboard](/img/permissions-group-member-access.png)

On the **Member access** tab you can:

- **Grant selected**: pick members (up to 50 at a time), with an optional message quota and duration. Membership is re-checked live before anything is written.
- **Whole-chat grant / Revoke whole-chat grant**: same as a bare `/grant` / `/revoke` in the group.
- **Block / Unblock**: add someone to or remove them from the block list, see [Block list](#block-list-blockedusers).
- Grants are written from one bot's point of view. If the group has several bots, pick the bot under **Bot viewpoint** at the top first.

## All the ways to grant access

From "a few people" to "anyone at all":

| Method | Who gets access | Scope | Quota / expiry | Operate | How to turn it on |
|--------|-----------------|-------|----------------|---------|-------------------|
| **Admins** `allowedUsers` | People on the list | Every group and DM of this bot | Long-lived | Talk + operate | `botmux setup`, edit `bots.json`, `/botconfig set allowedUsers` |
| **Guest (this group)** `chatGrants` | Named people (humans or bots) | Only the group it was granted in (all topics in a topic group) | 3 messages / 1 hour by default, adjustable on approval | Talk only | `@bot /grant @someone` grant card; Dashboard Member access; for bots in a group, [`botmux grant chat`](#grant-chat-cli) |
| **Guest (global)** `globalGrants` | Named people | Any group | Same as above | Talk only | **Grant talk globally** on an owner-initiated grant card |
| **Whole group open** `allowedChatGroups` | **Everyone in the group** (leaving revokes it automatically, new members can use it at once) | One group | No quota, no expiry, until revoked | Talk only | Bare `/grant` in the group; Dashboard **Whole-chat grant** |
| **On-call group** | Everyone in the group | One group | Always allowed, never quota-limited | Talk only; new topics go straight to the bound directory, no repo picking | `/oncall bind <dir>`; Dashboard on-call toggle |
| **Open DMs** `p2pOpen` | Everyone inside the Lark app's availability scope | DMs only | — | Talk only | Dashboard **Bot Config**, `bots.json`, `/botconfig set p2pOpen on` |
| **Open mode** | **Anyone** | Everywhere | — | Talk + operate | The fallback when **none** of the lists above is configured; not recommended long-term |

Notes:

- A bot created through normal onboarding always has its owner in `allowedUsers`, so it is **restricted** by default: only listed people can use it.
- Setting only `p2pOpen` without any admin still counts as restricted: groups are not opened, and nobody can run admin actions.
- Same-team bots and platform team members have their own trust rules, see [Roles & Teams](/en/roles). For bots on the same machine, see [Bots on this machine](#bots-on-this-machine-admin-commands-and-delegated-grants-trustsameownerbots) below.
- Guest grants (per group / global), with their quotas and expiry, are kept in a local grant store, `grants.sqlite`, not in `bots.json`. Expired grants are cleaned up automatically every hour. Field details: [bots.json](/en/bots-json#permissions-and-authorization).
- The meeting assistant has a separate, off-by-default switch, **Let inviters manage this meeting** (Dashboard **Global Settings → Meeting Listener → Meeting role presets → Per-bot meeting switches**). It only lets the inviter manage the meeting they invited the assistant to, and grants nothing else on the bot.

## Being added to a group is not authorization

**Pulling the bot into a group does not open up that group.**

- On a **restricted bot** (one with an owner / admin list — every onboarded bot is one), people not on the list are **blocked** when they @mention the bot, and the bot automatically sends the owner a [grant request card](#grant-request-cards). One click from the owner and they're in.
- **Only an open-mode bot with no lists configured at all** can be used by anyone. That is a fallback state, unrelated to being added to a group.
- "Auto-start when added to a group" (`autoStartOnGroupJoin`) is not authorization either. It has its own gate: the group must contain at least one admin before the bot auto-starts a session.

To control who can add the bot to groups, use the Lark developer console (app availability scope, who can add bots to groups).

## Grant request cards

On a restricted bot, when someone without access explicitly @mentions the bot in a group, the bot sends the owner a request card:

- The card has **Grant talk in this chat** and **Deny**; quota and duration can be changed right on the card.
- The card the owner gets from their own `@bot /grant @someone` also has **Grant talk globally** (works in any group).
- After approval, **the message that triggered the request** is fed into the session automatically, so the person doesn't need to resend it.
- Pending cards still work after a daemon restart.
- When the duration or quota runs out, the grant is revoked automatically.

What the requester sees if they message the bot again while waiting:

| Situation | What they see |
|-----------|---------------|
| The card was posted as a reply to their own message | No extra reply — the card itself shows it's waiting for an admin. New messages sent meanwhile are not processed |
| The card was forwarded to the owner's DM (see below) | A one-line "still waiting for the admin" (once per card). That message is not processed; send it again after approval |
| Within 10 minutes of a denial | A one-line "not approved" (once per denial). After 10 minutes, a new message sends a fresh card |

Special cases:

- **Turn off automatic cards**: Dashboard **Bot Config → Authorization & Quota → Auto grant card for blocked @mentions** (`autoGrantRequestCards`, on by default). When off, messages are still blocked, just silently.
- **A blocked DM is silent by default**: there's no owner in that DM, and replying with a card would go to the stranger (useless to them, and it would reveal the owner), so no card is sent.
- **Blocked users** never trigger request cards.

### Forward request cards to the owner's DM

The switch is `grantRequestToOwnerDm`, off by default. Useful when the owner doesn't want to join groups, or people often DM the bot.

When it's on and **no admin in the conversation can click the card**, the card goes to the primary owner's DM instead:

- no admin is found in the group (e.g. **auto-invite owner** `autoInviteOwnerOnGroupAdd` is off and the owner isn't in the group), or
- a DM was blocked.

What happens:

- The requester only gets a neutral acknowledgement that doesn't reveal who the owner is. After the owner approves or denies, the outcome is posted back to the original conversation.
- Once the quota runs out, the next message re-applies automatically.
- If an admin is in the group, or the member lookup fails, the card is posted in the group as before.
- Anti-spam: each owner gets at most 20 forwarded cards per hour (failed sends don't count). Over the cap or on a send failure, no card is sent this time; the next message retries.
- In groups the member list is checked on every request (60-second cache). If the app lacks the member-read scope (`im:chat.members:read`), or the group has more than 2,000 members (no complete list), the card is posted in the group as before.

Turn it on in the Dashboard (**Bot Config → Authorization & Quota → Forward grant requests to the owner's DM**), in `bots.json`, or with `/botconfig set grantRequestToOwnerDm on`.

## Block list `blockedUsers`

The block list is a per-**sender** veto, maintained in the Dashboard **Bot Config**, or directly with **Block** on a group's **Member access** tab.

- Applies to **both groups and DMs**. A blocked person is stopped in on-call groups, whole-group-open groups and team groups alike — switching groups doesn't help.
- Blocked people **don't** trigger request cards to the owner, so you aren't bothered repeatedly.
- **Owners / admins cannot be blocked** — the write is refused, so you can't lock yourself out.
- The block list governs talk only. [Message listeners](/en/bots-json#message-listener) (rules that make a bot watch messages automatically) have their own matching scope and are not affected.

## Advanced: defaults and command permissions

| What you want | Setting | Where |
|---------------|---------|-------|
| Change the grant card's default duration | `grantDefaultDurationMs`: 1 hour / 8 hours / 1 day / 7 days; default 1 hour | Dashboard **Bot Config → Authorization & Quota → Default access duration** |
| Change the grant card's default message count | `messageQuota.defaultLimit`: 1–1000; default 3. Guests only — on-call groups are never metered; `/grant @someone N` still uses N | Same section, **Message quota override** |
| Guests may chat but not use any slash command | `restrictGrantCommands: true`. Only affects people let in by per-group / global guest grants; owners, admins, on-call groups and whole-group-open members are unaffected | Same section, **Restrict grantees to plain conversation**, or `/botconfig set restrictGrantCommands on` |
| Let people with talk access use certain botmux commands | `canTalkDaemonCommands`, e.g. `/status /help`. Only commands botmux handles itself are accepted; typos and passthrough commands are ignored. Be careful opening up state-changing commands like `/cd` or `/restart` | Dashboard **Bot Config → Slash commands → canTalk-allowed daemon commands**, or `/botconfig set canTalkDaemonCommands /status,/help` |

`/grant` and `/revoke` are not affected by `canTalkDaemonCommands`; they always require an admin.

## Bots on this machine: admin commands and delegated grants `trustSameOwnerBots`

"Bots on this machine" means the other bots in the same `bots.json` on the same machine. They can already talk to each other. If the other bot's **owner is the same person as this bot's**, it gets three more abilities (on by default):

- **Talk before it is recognized**: its messages get through, with no grant card, even before this bot has learned who it is — for example when it posts a top-level message in a topic group without @mentioning this bot and this bot has `autoStartOnNewTopic` on. For this reason `botmux create-group` no longer writes pairwise chat grants between same-owner bots on this machine (bots with a different owner still get them).
- **Admin commands**: it can run `/cd`, `/repo`, `/restart`, `/close` and other admin commands on this bot, on par with team bots from other deployments. Commands that only accept the admin list, such as `/botconfig`, `/dashboard` and `/term`, are unaffected.
- **Delegated grants**: when it @mentions this bot in a group, the other people it @mentions in the same message get **talk access in that group**, just like the owner clicking **Grant talk in this chat** (talk only, with the grant card's default quota / duration; `restrictGrantCommands` still applies). A result card is posted under that message, @mentioning the granted humans (other bots are shown by name only, without a notification). People who can already talk, @all, the sender itself and blocked users are skipped; groups only.

How it decides:

- **Is it a bot on this machine**: the union_id Lark stamps on the message must match exactly one other app in this machine's `bots.json` (`apiOnly` bots excluded). Display names are not used.
- **Same owner**: **every** admin of the other bot must also be an admin of this bot. One extra admin this bot doesn't recognize rules it out — otherwise that person could operate this bot through the other one. The two sides may write admins differently (email, phone number, `on_`, `ou_`); each is converted to a union_id before comparing, and if any admin can't be converted (e.g. the app lacks contact read permission), it's ruled out too. After an admin change it takes effect again within about 30 seconds.
- Whoever can drive the other bot (its guests, people in its on-call groups) may also drive this bot through it. That's inherent to trust between bots; turn the switch off if that's not acceptable.
- When one machine hosts bots for several people, bots with a different owner can still only talk.

To turn it off: Dashboard **Bot Config → Authorization & Quota → Trust bots on this machine with the same owner**, `trustSameOwnerBots: false` in `bots.json`, or `/botconfig set trustSameOwnerBots off`. When off, every bot on this machine can only talk (picking a repository with `/repo` is not affected). If you turn it off for existing groups, a bot pair that was never recognized has no earlier chat grant to fall back on and needs a new `/grant`.

### Carry the sender over on @ handoffs (`delegateOnMention`) {#delegate-on-mention}

The trust above decides whether bots on this machine may operate each other; this setting decides whose identity the work runs under after a handoff.

When this bot hands work to another bot on the same machine with `botmux send --mention` in **a turn a person started directly**, the receiving bot runs `lark-cli` / `bytedcli` **as that person**, not as itself or as whatever is logged in on the machine.

- **On by default**, but it only takes effect when the handing-off bot itself has [Run CLI calls as the message sender](/en/bots-json#trigger-user-auth) on (`enabled` is `true` and `tools` is not empty): a bot that doesn't run its own tools as the sender has no verified sender to hand over.
- The receiving bot must have that setting on too, and it still checks that this person may talk to it and is in the chat.
- Only between bots on the same machine; bots on other machines never receive it. Handing work out with `botmux dispatch` is not affected by this switch; see [whose identity a dispatch carries](/en/multi-topic#advanced-whose-identity-a-dispatch-carries).
- To turn it off: untick **Hand the sender over on @ handoffs to bots on this machine** under Dashboard **Bot Config → Security → Trigger-user auth**, or add `"delegateOnMention": false` to `triggerUserAuth`. When off, the receiving turn of an @ handoff has no usable sender.

## Grant-delegate bots `grantDelegateBots`

This is the **second delegation source** besides same-owner bots on this machine: a list of external bots the owner explicitly trusts. The two don't affect each other. The delegated grant works exactly as in the previous section — only "who counts as a delegate" differs.

Typical case: an external platform creates a group with its own bot and posts a kickoff card that @mentions this bot and the person making the request. In restricted mode that person is blocked when they @mention this bot and must wait for the owner's approval. Adding the platform bot to the list removes that step.

- Entries are the trusted bot's open_id as seen by this bot (`ou_…`) or its app_id (`cli_…`).
- When a listed bot **@mentions this bot** in a group, everyone else it @mentions in the same message gets **talk access in that group**: talk only, with the grant card's default quota / duration; `restrictGrantCommands` still applies.
- A result card is posted under that message, @mentioning the granted humans (other bots are shown by name only, to avoid waking them).
- Skipped: people who can already talk, the sender itself, @all, blocked users; never in DMs. A delegate bot that is itself blocked is ignored entirely.
- **Trust boundary**: this hands the listed bots the power to pick who can talk to this bot in a group. They can't grant operate rights, can't change `allowedUsers` / `allowedChatGroups` / `globalGrants`, and the grant only covers the group the message was posted in. List only platform bots you fully trust.
- The list is empty by default, which behaves the same as not configuring it.

Configure it in the Dashboard (**Bot Config → Authorization & Quota → External bots with delegated grants**), via `grantDelegateBots` in `bots.json`, or with `/botconfig set grantDelegateBots ou_xxx,cli_yyy` (`/botconfig unset grantDelegateBots` clears it).

## Grant a bot in a group from the command line `botmux grant chat` {#grant-chat-cli}

To let a bot talk to a bot on this machine in **one specific group** from a script, use `botmux grant chat`. It only writes a this-group guest grant (`chatGrants`) and gives talk only.

```bash
# Recommended: pass the other bot's App ID; the receiver resolves its own open_id for it
botmux grant chat --bot <receiver> --chat-id oc_xxx --subject-bot cli_xxx

# If you already know the open_id as seen by the receiver
botmux grant chat --bot <receiver> --chat-id oc_xxx --subject-open-id ou_xxx

# Revoke
botmux grant chat revoke --bot <receiver> --chat-id oc_xxx --subject-open-id ou_xxx

# Check whether a grant exists
botmux grant chat readback --bot <receiver> --chat-id oc_xxx --subject-open-id ou_xxx
```

| Flag | Meaning |
|------|---------|
| `--bot` | The receiver: the bot on this machine that will accept messages from the subject. Use the full App ID, display name, or a unique cliId; ambiguous refs are rejected. Its daemon must be online |
| `--chat-id` | The group's `oc_…` ID; exactly one |
| `--subject-bot` | The granted bot's App ID (`cli_…`); repeatable. **Grant only** |
| `--subject-open-id` | The granted bot's `ou_…` as seen by the receiver; repeatable |

Key points:

- Use either `--subject-bot` or `--subject-open-id`, not both. Up to 50 subjects at once.
- **Grant** checks the group's bot members live. Every subject must be a bot currently in the group; if any one isn't, the whole batch is rejected and nothing is written. If the lookup fails, the grant is rejected too, with no fallback to past records.
- **Revoke** doesn't check membership, so you can still clean up a grant after the bot has left. Revoke and readback only accept `--subject-open-id`.
- **Readback** only answers for the subjects you ask about; it never lists all grants.
- Grants made with this command have **no message limit and no expiry** until revoked. If the subject had a quota or duration before, granting again makes it unlimited.
- It doesn't change `allowedUsers`, `allowedChatGroups`, or team trust, and doesn't grant admin commands such as `/repo`, `/cd`, `/restart`.
- Run it on the machine where the daemon runs; the command reads the local `.dashboard-secret` to call the receiver daemon.
- On success it prints one line of JSON to stdout; on failure it prints the error to stderr and exits non-zero.

## Common questions

- **On-call vs bare `/grant`?** Both give talk only. On-call also binds the group to a working directory so new topics skip repo picking; `/grant` only opens talk.
- **How do I give someone exactly 3 messages?** The card from `@bot /grant @someone` defaults to 3 messages / 1 hour; you can also add a number after the mention or change it on the card.
- **Does every new member need owner approval?** No. With whole-group open (bare `/grant`) or on-call, anyone in the group can use the bot right away. Per-person grants and request cards are for when you want to keep the gate.
- **A granted person's messages get no response?** First check whether their quota or duration has run out; then check whether `restrictGrantCommands` is on and they sent a slash command.

For more Q&A see the [FAQ / Troubleshooting](/en/faq); for when you must @mention the bot, see [@ Policy](/en/mention-mode).
