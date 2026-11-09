# Mention Policy (`mention-mode`)

In a regular group, the bot by default answers only messages that **explicitly @-mention it**. The mention policy decides when you can skip the @.

It only decides "is this message calling this bot?" — it **does not grant permissions**. Skipping the @ never skips authorization: people without talk access are still blocked (see [Permissions & Authorization](/en/permissions)).

## Pick a mode

| Mode | Name in the Dashboard | What it does | Good for |
|------|------|------|------|
| `always` (default) | Require @ | Answers only when @-mentioned | Large groups; quietest |
| `topic` | No @ inside topics | Top-level messages still need @; replies **inside a topic this bot already handles** don't | Follow-up questions in topics |
| `never` | No @ anywhere | Answers anything from people with talk access, including non-@ top-level messages (which directly create or resume a session) | Dedicated groups, on-call groups |
| `ambient` | No @, yield | No @ needed, like `never` — but if a message **@-mentions another member (person or bot) and not this bot**, the bot stays silent, because someone else was called | The "default responder" in multi-bot / multi-person groups |

Two more notes:

- `@all` does not count as calling someone else; under `ambient` the bot still answers.
- Under `topic`, a reply inside a topic that only @-mentions someone else also makes the bot yield.

## How to set it

There are two levels, and **the per-group setting wins**:

| Level | Scope | Where to change it |
|------|------|------|
| Bot default | Every regular group this bot is in | Dashboard **Bot Config → Sessions → Group reply conditions**, or `regularGroupMentionMode` in [bots.json](/en/bots-json) |
| Single group | Only the current group | Send `/mention-mode` in the group (written to `chatMentionModes` in bots.json) |

![The "Group reply conditions" setting in the Dashboard](/img/mention-mode-dashboard.png)

### Change it with a command in the group

Send in a regular group (in a multi-bot group, @ the specific bot):

```text
@bot /mention-mode status     # show the mode this group uses
@bot /mention-mode always
@bot /mention-mode topic
@bot /mention-mode never
@bot /mention-mode ambient
```

- Viewing (`status` or no argument): talk access is enough.
- Changing: requires **operate rights** (owner / `allowedUsers`).
- Changes apply immediately, affect only this group, and leave the bot default alone.
- Setting a group to the same value as the bot default means "follow the default again": if the bot default changes later, this group changes too. (Exception: bots with `signedChatDefaults` on keep the setting as written; see "Trusted group-creation service" at the end.)

### Which groups support it

Only **regular groups**:

- DMs: never need an @.
- Topic groups: already topic-shaped; the command replies "no need to set it here".
- Session groups created by `/group`: managed by the bot itself; changes are rejected.

## Mode is `always` — why does it still answer without an @?

"Must be @-mentioned" is the default rule, but a set of parallel exceptions exists; matching any one makes the bot answer. When the bot "won't listen", it is almost always one of these:

| # | Case | Notes |
|---|------|------|
| 1 | A reply continuing this bot's topic | The topic is already known to be addressed to this bot (e.g. a thread reply folded back into the group session), so it goes through |
| 2 | Substitute trigger | The bot has substitute mode on and the message @-mentions a person being covered (see "Substitute mode" below) |
| 3 | Message listener match | A [listening rule](/en/bots-json#message-listener) configured under Dashboard **Message Listener** matched. This **ignores the mention policy and the regular talk check**; listeners have their own sender filters |
| 4 | Mode is `never` | The bot default or this group is set to no @ anywhere |
| 5 | Mode is `ambient` and the message doesn't @ anyone else | |
| 6 | Mode is `topic` and the message is inside a topic this bot handles | |
| 7 | No-@ slash commands | Commands listed in Dashboard **Bot Config → Sessions → Slash commands without @** (e.g. `/solve`) fire when sent bare in a regular group. Only the listed commands are opened up, not the whole group |
| 8 | Built-in no-@ commands | `/dash` and `/dashboard link` never need an @, in any group |
| 9 | Group manager | This bot is the group's manager (default responder) and takes **top-level** non-@ messages. Turn on **Group manager (default responder)** under Bot Config → Sessions first. See the "Group manager" section in [Slash Commands](/en/slash-commands) |
| 10 | 1-person-1-bot group | Only you and this bot are in the group; no @ needed by default. You can turn this off — see the next section |

A few details:

- Except for message listeners (case 3), every case requires the sender to **have talk access**.
- Cases 7, 8 and 9 also yield to explicit naming: if the message starts by @-mentioning someone else, the bot doesn't take it. But in `/solve @someone`, the @ after the command is an argument, so the command still fires.
- In multi-bot groups where bots shouldn't talk over each other, prefer `ambient`: whoever is named answers.

> Tip: sent a message and forgot the @? Use Lark's **Edit** to add an @ to this bot — that triggers it too.

## Substitute mode: answer when someone else is @-mentioned

Substitute mode makes the bot a stand-in for certain people: when someone in a group @-mentions one of them (without @-mentioning the bot), the bot answers on their behalf. It suits people who get @-mentioned with questions all the time, such as the on-call engineer or a project owner.

### Turn it on

In Dashboard **Bot Config → Sessions → Substitute mode**, turn on **Enable substitute trigger** and add substitute targets. Changes take effect as soon as you save.

- You can enter an email directly. On save it is resolved to this app's Open ID; entries that fail to resolve are marked red and not saved.
- You can also enter an Open ID, User ID, or Union ID. An Open ID must belong to **this bot's app**; Open IDs from other apps, and people outside the app's contact visibility scope, are rejected.
- Turning it on needs at least one matchable target, otherwise saving fails.

The sender still needs **talk access**; substitute mode does not loosen permissions. To let everyone in a group ask by @-mentioning a target, combine it with [On-Call Mode](/en/oncall).

### Which messages trigger it

- Only text and rich-text messages where the sender typed the @ themselves. @-mentions carried in by a forwarded card or a merged forward don't count.
- If the message @-mentions a target but its body starts with `/` (a slash command), it doesn't trigger; the @ in the command is treated as an argument and the message keeps its normal routing.
- When trigger keywords are configured, the body must also contain one of them, otherwise the bot doesn't answer and the message is dropped outright — it won't fall through to any other path (existing session, no-@ modes, solo groups) (see `keywords` below).
- Regular groups: the substitute turn goes into the group's group-scope session, and the reply is anchored to the trigger message.
- Topic groups: the substitute turn goes into that topic's own session (a new one is started if none exists), and the reply stays in the topic.

### Settings

Each Dashboard field maps to `substituteMode` in this bot's [bots.json](/en/bots-json) entry:

```json
{
  "substituteMode": {
    "enabled": true,
    "targets": [
      { "openId": "ou_example", "name": "On-call engineer" }
    ],
    "keywords": ["incident", "oncall"],
    "disclosure": "prefix",
    "replyMode": "thread",
    "chats": [],
    "excludedChats": ["oc_example"],
    "topicGroups": true,
    "topicActiveSessionTrigger": true,
    "disableControlCard": false
  }
}
```

| Field | Dashboard name | Meaning |
|------|------|------|
| `enabled` | Enable substitute trigger | Master switch. Turning it off keeps the targets and other settings, so you don't re-enter them next time |
| `targets` | Substitute targets | The people or bots being covered. Each entry has one of `openId` / `userId` / `unionId`; a bot can also be given by `appId` alone (see below). `name` is an optional display name shown to the AI |
| `keywords` | Trigger keywords (optional) | Array of strings. Empty or omitted means "trigger on @-mentioning a target alone". When set, a message must both @-mention a target and contain any of these keywords (case-insensitive substring match) in the body the sender typed in this message — mention labels, quoted/forwarded or history content are excluded, and a body that can't be parsed counts as no match. **On a keyword miss the whole message is dropped and the bot stays silent; it never falls through to an existing session, no-@ mode or solo-group fallback** (except when the bot itself is @-mentioned directly, or the body starts with `/` as a slash command). In the Dashboard, separate keywords with newlines, commas or semicolons |
| `disclosure` | Disclosure | `prefix` (default): ask the AI to say who it is answering for; `none`: no extra disclosure requirement |
| `replyMode` | Reply style | Regular groups only. `thread` (default): reply in a thread under the trigger message; `quote`: quote the trigger message without a new thread |
| `chats` | Allowed chats | Allow-list. Empty means every group; when filled, it triggers only in these groups |
| `excludedChats` | Blocked chats | Never triggers in these groups, and `/substitute on` in the group can't turn it back on. A group in both lists is blocked |
| `topicGroups` | Topic groups | On by default. Set to `false` to trigger only in regular groups |
| `topicActiveSessionTrigger` | Trigger in topics with an active session | On by default. Set to `false` and, in a topic where this bot already has a session, @-mentioning a target counts as a hand-off: the bot stays quiet |
| `disableControlCard` | Send owner control card | When a substitute session starts in a regular group, the owner / `allowedUsers` get a DM control card (open terminal, restart, close) by default. Set to `true` to skip it. Topic groups keep their normal streaming card, with no extra DM |

A few notes:

- When editing bots.json by hand, an **email-only target matches no one**: Lark @-mentions don't carry email. The email is only kept as a label; if substitute mode is enabled but no target has an `openId` / `userId` / `unionId` / `appId`, the whole `substituteMode` block is ignored on load. To add people by email, save them in the Dashboard so they are resolved to Open IDs.
- Run `botmux restart` after editing by hand.
- In a blocked group, a message that @-mentions a target is ignored outright and doesn't fall through to other no-@ rules. Direct @-mentions of the bot are still answered.

### Bot substitute targets by App ID

To have the bot answer for another bot, choose **App ID** as the target type and enter `cli_...`; in bots.json write `{ "appId": "cli_example" }`. No Open ID or chat ID is needed, and display names are never used for matching.

- @-mentions in both text and rich-text messages count, whether a person or a bot with talk access sent them.
- The allow list, block list, per-group `/substitute off`, trigger keywords and active-topic rules work exactly as for Open ID targets, and a message they hold back doesn't fall through to other paths either. Messages from bots go through the same rules; when one is held back it also doesn't start a session through new-topic auto-start.
- Lark events only carry the receiver-scoped Open ID, so the bot reads the message again through the Get Message API to learn the App ID. If that read fails, returns a different version of the message, or the identities don't line up, the message isn't treated as an App ID substitute trigger.
- When a substitute message from a bot waits in the session queue, the sender's access and the substitute settings are checked again right before it runs. If the sender is revoked or blocked, or substitute mode is turned off or changed meanwhile, the message is dropped.
- Saving only checks the format (uppercase is converted to lowercase). It doesn't check that the app exists or is in the group, and doesn't request extra scopes to look up names. A malformed `appId` in a hand-edited bots.json is logged as a warning and that target is ignored.

### Per-group toggle

Substitute mode is on by default in every group it applies to. To switch it off for one group, @ the bot in that group:

```text
@bot /substitute status     # check whether it's on in this group
@bot /substitute off        # turn it off in this group
@bot /substitute on         # turn it back on in this group
```

- Anyone can check status; switching needs **operate access** (owner / `allowedUsers`).
- Works in regular and topic groups, not in DMs.
- If the group is blocked, or it is a topic group while `topicGroups` is off, the command tells you it can't be used here instead of pretending it was turned on.

## Turn off "no @ in 1-person-1-bot groups"

A group with one human and one bot needs no @ by default. To make these groups follow the mention policy, configure the bot's [bots.json](/en/bots-json) entry:

```json
{
  "regularGroupMentionMode": "always",
  "soloGroupMentionBypass": false,
  "chatSoloGroupMentionBypass": {
    "oc_example": true
  }
}
```

| Field | Meaning |
|------|------|
| `soloGroupMentionBypass` | Bot-level switch. Omitted or `true`: keep the no-@ exception; `false`: turn it off |
| `chatSoloGroupMentionBypass` | Per-group overrides. Explicit `true` / `false` beats the bot-level switch; remove a group's entry to inherit again |

In the example, only `oc_example` keeps the exception; all other groups have it off. To turn it off for just one group, keep the bot default and set that group to `false` in the map.

Run `botmux restart` after editing by hand.

Once it's off:

- The **effective mention policy** (per-group first) decides: `always` needs @; `topic` still allows non-@ follow-ups in topics the bot handles; `never` / `ambient` behave as usual.
- Under `always` / `topic`, non-@ top-level text or images no longer start a session just because the group is small.
- The switch applies to regular and topic groups, not DMs; permission checks and "yield when someone else is named" still apply.

This switch only removes the implicit "small group" exception. Message listeners, no-@ commands, substitutes, and auto-start on group join / new topic are separate settings. For **strict @-only** behavior: set the switch to `false`, set the group's mention policy to `always`, and check that the group has no other triggers enabled.

Also, "1 person, 1 bot" is judged by group membership. When a message @-mentions another member, the bot re-checks membership, so an old bot won't grab the turn right after a new bot joins. If the mentioned person isn't in the group (Lark allows mentioning non-members) and the re-check still shows one human and one bot, the exception still applies.

## Advanced: trusted group-creation service

If your deployment uses a trusted group-creation service and `signedChatDefaults` is enabled in bots.json, groups created by that service default to `ambient`. The order then is: the group's `/mention-mode` setting → the service-declared `ambient` → the bot default. This only affects whether an @ is needed; it never loosens permissions.

> Related: whether a reply lands in a new topic or the current session is controlled by `/reply-mode`; see [Slash Commands](/en/slash-commands).
