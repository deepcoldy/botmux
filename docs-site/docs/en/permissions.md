# Permissions & Authorization

botmux permissions answer two questions: **who can talk to the bot** (canTalk) and **who can change session state** (canOperate — `/cd`, `/restart`, `/close`, card buttons). There are several authorization layers, from "a few named admins" to "the whole group can ask freely". This page covers all of them in one place.

## Authorization layers

| Layer | Who gets access | Scope | Quota / expiry | Operate rights | How it is written |
|-------|-----------------|-------|----------------|----------------|-------------------|
| **Admins** `allowedUsers` | Listed members | Every group and DM of this bot | Long-lived, maintained by hand | Talk **and** operate | `botmux setup`, editing `bots.json`, `/botconfig set allowedUsers` in a group |
| **Guest (per group)** `chatGrants` | Named members (people or bots) | Only the one group chosen when granting; in a topic group the grant is keyed by the `oc_` group and covers **all its topics** | **3 messages / 1 hour** by default, adjustable on approval | Talk only | `@bot /grant @someone` grant card; Dashboard member batch grant |
| **Guest (global)** `globalGrants` | Named members | Any group | Same, optional quota and expiry | Talk only | "Grant global talk" on the owner-initiated grant card |
| **Whole group open** `allowedChatGroups` | **Everyone in the group** (sender-independent; leaving the group revokes access automatically, new members take effect immediately) | One group | No quota, no expiry, until explicitly revoked | Talk only | Bare `/grant` in the group; Dashboard "authorize whole group" action |
| **On-call** | Everyone in the group | One group | **Always allowed, never quota-limited** | Talk only; new topics go straight into the bound directory, skipping repo picking | `/oncall bind <dir>`; Dashboard on-call toggle |
| **Open DMs** `p2pOpen` | Everyone inside the Lark app's availability scope | DMs only | — | Talk only | Bot config / `bots.json` |
| **Open mode** | **Anyone** | Everywhere | — | Talk and operate | The fallback state when **none** of the lists above is configured; not recommended for long-term use |

Notes:

- A bot created through normal onboarding always has its owner in `allowedUsers`, so it is a **restricted** bot by default — only listed people can use it.
- Team-trust legs: same-team peer bots / team bots can talk and run admin commands, platform team members get talk only; see [Roles & Teams](/en/roles). For bots on the same machine see [Bots on this machine](#bots-on-this-machine-admin-commands-and-delegated-grants-trustsameownerbots) below.
- Field-level reference: [bots.json · Permissions and authorization](/en/bots-json).

## Common operations

| What you want | How |
|---------------|-----|
| Let **the whole group** ask (no quota) | `@bot /grant` (or `/grant all`) in the group; revoke with bare `/revoke`. In a topic group it is keyed by the `oc_` group and covers all topics |
| Give **specific people** trial access for a few messages | `@bot /grant @Alice @Bob` — the bot replies with a grant card, defaulting to 3 messages / 1 hour per person |
| Set the count directly | `@bot /grant @Alice 20` — 20 messages each; the duration is still picked on the card |
| Fine-tune on the card | Duration: **1 hour / 8 hours / 1 day / 7 days / permanent**. Message quota: an integer from 1 to 1000; **leave blank for unlimited**. Whichever limit comes first ends the grant |
| Revoke someone's grant | `@bot /revoke @Alice`: removes the per-group and global guest grants; **if the person is also on the `allowedUsers` admin list, that entry is removed as well** (the reply names the affected scopes). Revoking the owner themselves, or a revoke that would leave the bot with no admin, is refused |
| Duty-group instant Q&A without repo picking | `/oncall bind ~/projects/foo` — see [On-Call Mode](/en/oncall) |
| Do it in bulk in the Dashboard | **Groups** page → the group's **Manage** modal: **member batch grant** (multi-select up to 50 members, live membership re-check before writing, optional quota and duration) and **authorize the whole group in one click** |

Only owners / admins (`allowedUsers`) can run `/grant`, `/revoke`, on-call toggles, and management commands such as `/card`, `/cot`, `/mention-mode`. Graduated guests can only talk.

## Being added to a group is not authorization

**Pulling the bot into a group does not write any allowlist entry.** When the bot receives the "added to chat" event it does not open up talk access for that group:

- On a **restricted bot** (one with an owner / allowlist — every bot created via onboarding is such a bot), a non-listed member @-mentioning the bot is **refused**, and the bot automatically sends the owner a **grant request card**. The owner approves in one click (after which the original message is replayed automatically, so the person doesn't need to resend it).
- **Only a fully unconfigured open-mode bot** can be used by anyone (operate rights included). That is a fallback state, not something "being added to a group" grants.
- "Auto-start when added to a group" (`autoStartOnGroupJoin`) is not an authorization either: it has its own gate — the group must contain at least one `allowedUsers` member before the bot auto-starts a session.

Precisely controlling who can add the bot to groups belongs to the Lark platform side (app availability scope / who can add bots); see the FAQ at the bottom.

## Block list `blockedUsers`

The block list is a **sender-dimension global deny**, maintained on the Bot config page (Dashboard **Bot Config**), with a quick "block" action available in the group-member modal as well:

- It applies to **both groups and DMs**; a blocked person is denied in on-call groups, whole-group-open groups, and team groups alike.
- The deny leg runs **before every allow leg** — on-call, whole-group open, guest grants, team trust — so there is no "works again in another group" escape.
- When a blocked person is rejected, **no grant request card** is sent to the owner (no approval-spam from someone you explicitly blocked).
- **Owners / admins cannot be blocked** — the write entry refuses it (self-lockout guard).
- The block list governs **talk access only**; the [message listener](/en/bots-json#group-message-listener) feature (rules that make a bot watch messages automatically) has its own matching configuration and is not affected by it.

## Grant request cards

On a restricted bot, when an unauthorized person explicitly @-mentions the bot in a group and the talk gate blocks them, a request card is sent to the owner by default (`autoGrantRequestCards`, on by default; can be turned off in Bot config, after which messages are blocked silently).

- On the request card the owner can **Grant talk in this group** or **Deny**, adjusting quota and duration right on the card.
- The owner-initiated `@bot /grant @someone` card additionally offers **Grant global talk** (effective in any group).
- After approval, the message that triggered the request is replayed into the session automatically; the requester doesn't need to @ again.
- Pending requests are throttled, so one person cannot spam cards. If the same person messages the bot again while their card is pending, they get a one-line "still waiting for the admin" reply (once per card); within 10 minutes of a denial they get a one-line "not approved" reply, and after that a new message sends a fresh card.
- **A rejected DM (p2p) is silent by default**: there is no owner present in that DM, and replying with a card would go to the stranger themselves (unusable for them, and it would expose the owner), so no card is sent.
- **Forward request cards to the owner's DM** (`grantRequestToOwnerDm`, off by default): when enabled and no admin in the conversation can click the card, the card goes to the primary owner's DM instead — both when no admin is in the group (e.g. `autoInviteOwnerOnGroupAdd` is off and the owner stays out) and when a DM is rejected. The requester only gets a neutral acknowledgement that does not reveal the owner; after the owner approves or denies, the outcome is posted back to the original conversation; once the quota runs out, the next message re-applies automatically. If an admin is in the group, or the member lookup fails, the card is posted in the group as before. DM forwarding has an extra per-owner cap (20 cards per hour; failed sends do not count). Over the cap or on a send failure no card is posted (the group is already known to have no admin, so an in-group card would be one nobody can click); the next message retries. The group path lists chat members on every request (60-second cache); if the app lacks the member-read scope (`im:chat.members:read`) or the group has more than 2,000 members (no complete list), the card is posted in the group as before. Toggle it in the Dashboard (**Bot Config → Authorization & Quota**), via `bots.json`, or with `/botconfig set grantRequestToOwnerDm on`.

## Bots on this machine: admin commands and delegated grants `trustSameOwnerBots`

Other bots on the same machine (the same `bots.json`) can already talk to this bot. A bot on this machine **whose owner is the same person** gets two more abilities (on by default):

- **Admin commands**: it can run `/cd`, `/repo`, `/restart`, `/close` and other admin commands on this bot, on par with team bots from other deployments. Commands that only accept the admin list, such as `/botconfig`, `/dashboard` and `/term`, are unaffected.
- **Delegated grants**: when it @mentions this bot in a group, the other people it @mentions in the same message get **talk access in that group**, exactly like the owner clicking "This group" on a grant card: written to `chatGrants`, talk only, with the `/grant` defaults for quota and duration (`messageQuota.defaultLimit` / `grantDefaultDurationMs`, 3 messages / 1 hour when unset); `restrictGrantCommands` still applies. A grant result card is posted under that message and @mentions the people who were granted (other bots are shown by name only, without an @ notification). People who can already talk, @all, the sender itself and blocked users are skipped; groups only.

How it decides:

- **Is it a bot on this machine**: the union_id Feishu stamps on the message must match exactly one other app in this machine's `bots.json` (`apiOnly` bots excluded). Display names are not used.
- **Same owner**: **every** admin of the other bot (`allowedUsers`) is also an admin of this bot. One extra admin this bot does not recognize is enough to rule it out — otherwise that person could operate this bot through the other one. The two sides may write admins differently (email, phone number, `on_`, `ou_`): each bot converts its own admins to union_ids with its own app credentials, and those are compared; if any of the other bot's admins cannot be converted (e.g. the app lacks contact read permission), it is ruled out as well. After an admin change it takes effect again within about 30 seconds; until then the bots are treated as having different owners.
- Whoever can drive the other bot (its guests, people in its oncall groups) may also drive this bot through it. That is inherent to trust between bots, and the same holds for team bots from other deployments; turn the switch off if that is not acceptable.
- When one machine hosts bots for several people, bots with a different owner can still only talk.

Switch: Dashboard "Bot settings → Access & quota → Trust bots on this machine with the same owner", `trustSameOwnerBots: false` in `bots.json`, or `/botconfig set trustSameOwnerBots off`. When off, every bot on this machine can only talk (picking a repository with `/repo` is not affected by this switch).

## Common questions

- **On-call vs bare `/grant`?** Both grant talk only, never operate. On-call is always allowed with no quota and also binds the group to a working directory (new topics skip repo picking); `/grant` only opens talk and binds no directory.
- **How do I give someone exactly 3 messages?** `@bot /grant @someone` produces the card with 3 messages / 1 hour as the defaults; pass a number after the mention or change it on the card.
- **Does every new member need owner approval?** No — whole-group open (bare `/grant`) or on-call means anyone in the group can ask immediately; per-person grants and request cards exist for when you want to keep the gate.

For more Q&A see the [FAQ / Troubleshooting](/en/faq); for when @-mentioning is required, see [@ Policy](/en/mention-mode).
