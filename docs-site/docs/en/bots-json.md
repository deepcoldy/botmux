# bots.json Configuration

Configure bots via `~/.botmux/bots.json`. Run `botmux setup` to create it interactively, or edit it by hand. The file is an array; each element is a bot (in production, one bot maps to one dedicated daemon process).

```json
[
  {
    "larkAppId": "cli_xxx_bot1",
    "larkAppSecret": "secret_1",
    "name": "claude-main",
    "cliId": "claude-code",
    "model": "sonnet",
    "lang": "zh",
    "workingDir": "~/projects",
    "allowedUsers": ["alice@company.com"],
    "allowedChatGroups": ["oc_xxx_team"],
    "oncallChats": [{ "chatId": "oc_xxx_oncall", "workingDir": "~/projects/foo" }]
  },
  {
    "larkAppId": "cli_xxx_bot2",
    "larkAppSecret": "secret_2",
    "cliId": "codex",
    "model": "gpt-5-codex",
    "workingDir": "~/work",
    "autoStartOnNewTopic": true
  }
]
```

There are many fields, listed below grouped by purpose. The vast majority are **optional** — just `larkAppId` / `larkAppSecret` is enough to get running, and you add the rest as needed.

## Required

| Field | Description |
|------|------|
| `larkAppId` | Lark app App ID |
| `larkAppSecret` | Lark app App Secret |

## CLI and model

| Field | Description |
|------|------|
| `name` | Process name suffix, e.g. `claude-main` → `botmux-claude-main`; leave empty to default to `botmux-<index>` |
| `cliId` | CLI adapter, defaults to `claude-code`. See [Multi-CLI adapters](/en/adapters) |
| `model` | Model name used to launch the CLI (e.g. `claude --model opus`); leave empty to use the CLI default. Multiple bots with the same `cliId` can run different models. Each adapter's `modelChoices` are the candidates offered in `botmux setup` |
| `cliPathOverride` | Absolute path to the CLI entry point, for wrapping a wrapper / router (ccr, claude-w, aiden-x-claude, etc.) |
| `disableCliBypass` | When `true`, the CLI's auto-approve / sandbox-bypass flags (`--yolo`, `--dangerously-*`) are not appended automatically; omitted / `false` keeps the original behavior |
| `backendType` | Session backend, one of `pty` / `tmux` / `herdr` / `zellij`. Leave empty to **auto-detect**: chooses `tmux` if tmux is available, otherwise `pty` (`herdr` and `zellij` are never auto-selected and must be specified explicitly). `tmux` / `herdr` / `zellij` are all persistent sessions and fall back to `pty` automatically if the corresponding binary probe fails (`zellij` requires ≥ 0.44); `pty` attaches directly to the process and does not persist across restarts. See [tmux backend](/en/tmux) |
| `lang` | The bot's UI language, `zh` / `en`; leave empty to fall back to the `BOTMUX_LANG` / `LANG` environment variable |
| `customPassthroughCommands` | On top of the fixed passthrough allowlist and the current CLI adapter's default-allowed commands, additionally pass through slash commands to the underlying CLI, e.g. `["/export"]` (Claude Code / Codex default-allow `/goal`). Auto-normalized (a missing `/` is added, lowercased, only `[a-z0-9:_-]` kept, deduplicated); entries that would shadow a botmux daemon command (e.g. `/status`) are dropped and have no effect even if configured. Use `/list-slash-command` to view the full allowlist. See [Slash commands](/en/slash-commands) |

## Working directory

| Field | Description |
|------|------|
| `workingDir` | Default working directory, supports a comma-separated list. Recursively searches **downward** for git repositories from this directory (up to 3 levels), never scans upward |
| `workingDirs` | Array form of working directories (`["~/a", "~/b"]`); takes precedence over the comma-separated form of `workingDir` when explicitly configured |
| `defaultWorkingDir` | Default directory for a single repository: with no oncall and no sibling session in the same group, enters it directly and skips the repo selection card. `/cd` can still switch mid-session. Purely a runtime fallback — does not write state and does not change the permission model |

## Permissions and authorization

| Field | Description |
|------|------|
| `allowedUsers` | The operate-permission list (**full email** or `ou_xxx`). When `allowedChatGroups` is configured, at least one is required to serve as owner |
| `allowedChatGroups` | Conversable groups (`oc_xxx`). Any member of the group can converse (only `canTalk`); sensitive operations are still controlled by `allowedUsers` |
| `oncallChats` | Oncall bindings, `[{ "chatId": "oc_xxx", "workingDir": "~/projects/foo" }]`. See [oncall](/en/oncall) |
| `defaultOncall` | The bot's default: the first new topic in a new group chat is automatically bound to oncall. `{ "enabled": true, "workingDir": "~/foo", "since": <epoch ms> }`; older groups that already existed before `since` are unaffected |
| `globalGrants` | Global conversable list (`ou_xxx`, people or bots). Can converse in any group, only `canTalk` |
| `chatGrants` | Per-group, per-user authorization `{ "oc_xxx": ["ou_yyy"] }`, only grants `canTalk`. Usually written by the `/grant` card, but can also be configured by hand |
| `messageQuota` | Message-quota switch `{ "defaultLimit": N }`: once a positive integer is configured, a `/grant` without a number applies an N-message quota; if not configured, authorization is unlimited. Only constrains talk authorization, does not affect `canOperate` |
| `restrictGrantCommands` | When `true`, people granted only via per-user authorization (`chatGrants` / `globalGrants`) are disabled from **all slash commands** and can only have plain conversations; owner / `allowedUsers` / oncall / whole-group members are unaffected. Defaults to `false` |

## Cards and terminal

| Field | Description |
|------|------|
| `brandLabel` | Branding text at the bottom of the card. `undefined` = default `botmux` link; `""` = hidden; any other string = rendered as-is (supports markdown). Purely cosmetic, does not affect routing / permissions |
| `disableStreamingCard` | When `true`, no real-time streaming session card is sent at all (the Web Terminal still runs and the final reply still arrives via `botmux send`, there's just no auto-refreshing status card). For users who find the real-time card noisy |
| `writableTerminalLinkInCard` | When `true`, the card body directly embeds a **writable** terminal link (with token, anyone who can see the card can operate it); by default it's hidden behind a "Get write permission" button and sent privately to whoever clicks. Meaningless when `disableStreamingCard` is enabled |
| `privateCard` | When `true`, `/card` uses an ephemeral private card visible only to `allowedUsers` (talk grantees and the bare triggerer don't receive it), only effective in plain `group` chats, and cannot live-update. Only affects the `/card` command itself |

## Proactive start

| Field | Description |
|------|------|
| `autoStartOnGroupJoin` | When `true`, the bot starts working automatically when added to a new group containing at least one `allowedUsers` member (no @ needed). Requires subscribing the `im.chat.member.bot.added_v1` event for this app in the Lark admin console |
| `autoStartOnGroupJoinPrompt` | Paired with the above: the first-round prompt for proactive start; if empty / blank, opens with an empty message and lets the bot read the group context itself. Meaningless when `autoStartOnGroupJoin` is off |
| `autoStartOnNewTopic` | When `true`, the first message of every new topic in a topic group starts working automatically without an @ (no effect in plain groups). Defaults to passive (only @ triggers) |

## Voice

| Field | Description |
|------|------|
| `voice` | The bot's voice-engine override, merged field-by-field on top of the global `voice` block in `~/.botmux/config.json` (per-bot takes precedence). When valid voice credentials are present, a "🔊 Voice summary" button appears on reply cards. See [Voice summary](/en/voice) |

## Runtime state (auto-maintained, do not edit)

The following fields are written by botmux itself and persisted into `bots.json` alongside authorizations / switches. They are listed only for reference — **do not edit them by hand**:

| Field | Description |
|------|------|
| `defaultOncallAutoboundChats` | The chat_ids that `defaultOncall` has already auto-bound (append-only). Once recorded, it won't auto-bind again even if later unbound |
| `quotaState` | Scope-level message-quota counters `{ "chat:<cid>:<oid>" \| "global:<oid>": { limit, used } }`; when exhausted, automatically revokes the corresponding scope's authorization |
| `noCardChats` | The "don't send streaming cards in this group" list written by `/card off\|on` |

> **Configuration precedence**: the `BOTS_CONFIG` environment variable → `~/.botmux/bots.json`. Run `botmux restart` after editing to take effect.
