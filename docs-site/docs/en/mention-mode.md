# Mention Policy (`mention-mode`)

In a regular group, by default the bot responds only to messages that explicitly **@-mention it**. The mention policy controls when @ is *not* required; it is a routing rule for **human messages in regular groups** and has nothing to do with authorization — skipping @ never skips the talk gate, so someone without talk access is still blocked (see [Permissions & Authorization](/en/permissions)).

## The four modes

| Mode | Semantics |
|------|-----------|
| `always` (default) | In a multi-person group the bot responds **only when explicitly @-mentioned** |
| `topic` | Top-level messages still need @; replies **inside a topic the bot already owns** need no @ (both shared topics in regular groups and its topics inside a topic group count) |
| `never` | **@ never required**: anyone with talk access is answered in the group, including non-@ top-level messages (which directly create or resume a session). Suits dedicated-person groups and duty groups |
| `ambient` | @ is not required, just like `never`, **but when a message @-mentions another specific member (person or bot) and does not @ this bot, the bot yields and stays silent** — someone else was explicitly called. `@all` does not count as naming someone, so the bot still responds. Suits the role of "default responder" in multi-bot / multi-person groups |

- Two levels: the bot-level default `regularGroupMentionMode` (Dashboard **Bot Config → Group mention policy**) and the per-group override `chatMentionModes` (set by the in-group command); the per-group value wins.
- **Regular groups only**: DMs never need @; topic groups are already topic-shaped, so the command replies "no need to set it there"; a session group created via `/group` is managed by the bot itself and rejects changes.

## Commands

Send in a regular group (in a multi-bot group @ the specific bot):

```text
@bot /mention-mode always
@bot /mention-mode topic
@bot /mention-mode never
@bot /mention-mode ambient
@bot /mention-mode status
```

- Querying (`status`, or no argument) only requires talk access; **changing the mode requires operate rights** (owner / `allowedUsers`).
- A per-group change takes effect immediately, affects only that group, and never touches the bot-level default.

## Mode is `always`, so why does it still answer without an @? — the 8 no-@ exceptions

"Must be @-mentioned" is the main default rule, but the code also has a set of parallel no-@ clauses; matching any one of them makes the bot respond. When the bot "won't listen", it is almost always one of these:

1. **A reply continuing a thread already addressed to this bot**: upstream routing has already decided the reply is directed at this bot (internal marker `replyRootId`; the typical case is a thread reply folded back into the group session), so it goes through without re-running the @ gate.
2. **Substitute trigger**: the group has substitute mode on (`/substitute`); when a message @-mentions the configured substitute target, the configuring bot answers on its behalf.
3. **Message-listener match**: once a [message-listening rule](/en/bots-json#group-message-listener) configured under Dashboard **Roles** matches, it fires per the rule — this clause is **independent of both the mention policy and the regular talk gate** (the listener has its own sender filters).
4. **The mode is `never`**: the bot-level default or this group was switched to no-@-required.
5. **The mode is `ambient` and the message does not @-mention anyone else**.
6. **The mode is `topic` and the message is inside a topic the bot owns**.
7. **No-@ slash commands**: commands configured in `commandTriggers` (e.g. `/solve` in some groups) also fire when sent bare in a regular group (top-level or inside an in-group thread); it only opens up allowlisted commands, not the whole group.
8. **1-person-1-bot group**: when a group contains exactly 1 human and 1 bot, @ was never needed (decided live from group membership; the moment another member is @-mentioned the exception stops applying, preventing the old bot from grabbing the turn in the cache window right after a new bot is pulled in).

Except for the message listener (clause 3), every clause still requires the sender to **have talk access**. In multi-bot groups where you want the bots not to talk over each other, prefer `ambient`: whoever is named answers.

> Related: whether a reply lands in a new topic or the current session is controlled by `/reply-mode`; see [Slash Commands](/en/slash-commands).
