# Personal Assistant Mode (assistantMode)

A bot that anyone can DM shares, by default, one working directory, one set of CLI memories and one writable sandbox surface across all users — what A said in a DM is reachable from B's session. **Personal assistant mode** turns the bot into "everyone's own assistant": every session has exactly one owner, and the working directory, CLI data directory (memory / project history), sandbox grants and host-side read commands are all narrowed to that owner.

## Enabling

Add to the bot in `bots.json`:

```json
{
  "assistantMode": true,
  "sandbox": true,
  "assistantTemplateDir": "~/assistant-template",
  "assistantLarkBotIdentity": false
}
```

- `assistantMode`: the switch. **Requires `sandbox: true` (the oncall allow-list sandbox)** — without it every session refuses to start, because falling back to the shared directory is exactly the hole this mode closes. `/botconfig assistantMode on` toggles it live.
- `assistantTemplateDir`: optional template directory (defaults to the bot's default working directory). Before each session starts, template files are **overwrite-synced** into the owner's work directory (files absent from the template are kept; symlinks are not followed). Put admin-maintained shared knowledge / CLAUDE.md here.
- `assistantLarkBotIdentity`: whether `lark-cli` inside a session may call Lark with the **bot identity**. Default `false` — the bot identity can read every chat the bot is in, which bypasses the isolation; only `--as user` (the owner's own grant) remains.

Before enabling, archive the old shared memories under `~/.botmux/bots/<appId>/claude/projects/` (invisible to assistant sessions, but still plaintext on the host).

## Who owns a session

| Where | Owner |
|------|------|
| DM | the sender |
| `/group` session group | the creator (fixed) |
| Regular group | **whoever added the bot** (recorded from the member-added event) |
| Groups the bot joined before the mode was enabled / lost record | unowned: the bot stays silent and asks for `/assistant claim` |

- `/assistant`: show the group's owner.
- `/assistant claim`: when the group has no owner (or the owner left), the sender becomes owner. An owned group cannot be taken over.
- `/assistant owner @someone`: a bot admin (`allowedUsers`) assigns or replaces the owner. The previous owner's sessions stop immediately; the new owner sends a message to start.
- Owner leaves the group: all sessions in that group are suspended and the group becomes unowned.

One person's sessions across groups and DMs share a single memory and directory (partitioned by person, not by chat).

## What an owner gets

One `USER_HOME = ~/.botmux/bots/<appId>/users/<open_id>/` per owner:

- `work/`: working directory for all their sessions (`/cd` and `/repo` are disabled in this mode).
- `claude/`: that person's own CLI data directory (memory, project history, settings). **The refreshToken in the credential copy is replaced with an invalid string** — sessions run on the access token only and can never rotate the shared account's credentials; the central refresher just has to fan out to `bots/*/users/*/claude/.credentials.json` (see `docs/file-sandbox.md`).

Inside the sandbox the real `BOT_HOME`, other owners' directories, the role library and the bot-wide attachment bucket do not exist; attachments land in `attachments/<appId>/u/<open_id>/`. Host-side `botmux history --session-id` / `botmux quoted` / `botmux list` only reach sessions of the same owner and messages of the session's own chat.

## Not supported

- The role system (`/role`, role switching, role-directory schedules) is off in this mode.
- `botmux send` routing still needs read-only access to `sessions.db`, so the sandbox can **see** other sessions' metadata (titles, chat ids), not their content.
- One owner per group; do not put an assistant-mode bot into a group meant for several people.
