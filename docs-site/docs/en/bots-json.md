# bots.json Configuration

Configure bots via `~/.botmux/bots.json`. Run `botmux setup` to create it interactively, or edit it by hand. The file is an array; each element is a bot (in production, one bot maps to one dedicated daemon process).

> **Most fields are optional** — just `larkAppId` / `larkAppSecret` is enough to run; add the rest as needed. **Applies to**: manually tuning CLI / model / working dir / permissions / sandbox, etc.; for everyday config the dashboard's Bot Config page is preferred (it edits the same `bots.json`). Run `botmux restart` to apply changes.

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
    "p2pOpen": true,
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
| `model` | Model name used to launch the CLI (e.g. `claude --model opus`); leave empty to use the CLI default. Multiple bots with the same `cliId` can run different models. Each adapter's `modelChoices` are the candidates offered in `botmux setup`. **Resolved from the current config on every CLI launch**, resume included: a change (dashboard or this file) also applies to **existing sessions**, from their next launch/resume onward. Unlike `cliId` / `cliRuntime` / `wrapperCli`, which are frozen when the session is created so a live conversation never has its runtime swapped underneath it |
| `reasoningEffort` | Default reasoning effort for new sessions. Only applies to CLIs with structured reasoning controls (`codex` / `codex-app` / `traex` / `grok`); values are validated against the selected CLI/model, and unsupported or undeclared combinations are rejected or ignored |
| `cliRuntime` | Structured runtime descriptor for a Codex-compatible distribution: `{ id, displayName?, executable, update? }`. It reuses the `codex` adapter while retaining its own version, update source, and session identity. See [Codex-compatible distributions](/en/adapters#codex-compatible-distributions) |
| `cliPathOverride` | Legacy CLI entry-point override, retained for wrappers / routers and existing custom binaries. Prefer `cliRuntime` for a new Codex-compatible distribution. To support downgrading BotMux, writers also persist an exact compatibility shadow of `cliRuntime.executable`; do not manually configure mismatched values |
| `disableCliBypass` | When `true`, the CLI's auto-approve / sandbox-bypass flags (`--yolo`, `--dangerously-*`) are not appended automatically; omitted / `false` keeps the original behavior |
| `backendType` | Session backend, one of `pty` / `tmux` / `herdr` / `zellij`. **Leave empty to default to `tmux`** (PTY auto-fallback is retired): when a persistent backend (tmux/herdr/zellij) isn't available on this host it **hard-gates** and posts a card asking you to install it — it does **not** silently downgrade to pty (`zellij` requires ≥ 0.44). `pty` is an explicit fallback only (`backendType:"pty"` or `BACKEND_TYPE=pty`) — attaches directly to the process and **does not survive daemon restarts**. See [tmux backend](/en/tmux) |
| `launchShell` | Shell used to launch the CLI, overriding the daemon's `$SHELL`: a shell name (`zsh` / `bash` / `fish` / `sh`) or an absolute path (e.g. `/usr/bin/zsh`). For when the login `$SHELL` (e.g. bash) has an rcfile that `exec`-trampolines into another shell (`exec zsh`), pre-empting the CLI under botmux's `bash -i` launch so the session never starts (bare-shell `parse error`) — pinning it launches under that shell directly, bypassing the skipped rcfile. **Note**: PATH / nvm / pnpm must then live in the chosen shell's rcfiles (e.g. `.zshrc` / `.zprofile`, or `~/.config/fish/config.fish` for fish). fish is a first-class launch shell: `launchShell: "fish"` and absolute fish paths (e.g. `/usr/bin/fish`) are supported, and the desktop PATH probe reads fish when `$SHELL` is fish, so fish users don't need to mirror PATH / env into `.bashrc` / `.zshrc`. Empty = use `$SHELL`. Takes effect next session for shell-wrapped persistent backends (`tmux` / `zellij` / `zmx`); `pty` execs the CLI directly and is unaffected. Also configurable in the dashboard ("Bot defaults → Launch shell") or via `/config launchShell <value>` |
| `lang` | The bot's UI language, `zh` / `en`; leave empty to fall back to the `BOTMUX_LANG` / `LANG` environment variable |
| `customPassthroughCommands` | On top of the fixed passthrough allowlist and the current CLI adapter's default-allowed commands, additionally pass through slash commands to the underlying CLI, e.g. `["/export"]` (Claude Code / Codex default-allow `/goal`). Auto-normalized (a missing `/` is added, lowercased, only `[a-z0-9:_-]` kept, deduplicated); entries that would shadow a botmux daemon command (e.g. `/status`) are dropped and have no effect even if configured. Use `/list-slash-command` to view the full allowlist. See [Slash commands](/en/slash-commands) |
| `env` | Per-bot process environment variables `{ "KEY": "value" }`, injected into this bot's CLI process. Most common use: run a bot on GLM / a third-party Anthropic·OpenAI-compatible provider (see example below); also handy for `HTTPS_PROXY` or a CLI feature flag. Values accept string / number / boolean; botmux-reserved keys (`BOTMUX_`, `LARK_APP_`, …) are ignored. Injected **per session** (effective from the next session), never written to the shared tmux server env, so it can't leak across bots. Also editable in the dashboard ("Bot defaults → Environment variables") |
| `codexAppCleanInput` | **Experimental**, and only effective for Botmux-managed sessions whose actual CLI is `codex-app`. When `true`, the visible / persisted text `UserMessage` contains only the user's original input while message-level Botmux context primarily moves to `additionalContext`. Defaults to off, takes effect on the next turn dispatch, and does not rewrite existing history. See details below |
| `codexBrowser` | **Experimental and off by default**. Supported only with `cliId: "codex-app"`. Set to `true` to let new sessions control Chrome through the locally installed Codex Chrome plugin. Object form: `{ "enabled": true, "family": "chrome" | "edge", "pluginRoot"?: "/absolute/path" }`. See below |

### Codex-compatible distributions

An independently released CLI that preserves Codex's arguments, interaction, rollout / resume, and authentication semantics does not need a new `cliId`. Keep `cliId: "codex"` as the protocol adapter and describe the concrete runtime separately:

```json
{
  "cliId": "codex",
  "cliPathOverride": "vendor-codex",
  "cliRuntime": {
    "id": "vendor-codex",
    "displayName": "Vendor Codex",
    "executable": "vendor-codex",
    "update": { "provider": "npm", "packageName": "@vendor/codex" }
  }
}
```

- `id` is a stable identity using letters, numbers, `.`, `_`, or `-`, up to 64 characters. Changing it is treated as switching distributions.
- `executable` is one executable name or path, not a shell command; do not append arguments. The Dashboard performs a read-only `--version` probe before saving, and its output must contain a recognizable `X.Y.Z` version.
- `displayName` controls cards, status, and Dashboard labels only; it defaults to `id`.
- `update.provider` is one of `auto`, `self`, `npm`, or `none`. `auto` trusts only a unique npm package proven to own that exact binary. If no source can be established, the runtime is shown as unmanaged and is **never compared with official Codex**. Only `self` uses the CLI's structured doctor data, and its current version must match `--version`; `npm` requires the distribution's own `packageName`; `none` disables update checks for that runtime.
- `cliRuntime` currently applies only to `cliId: "codex"` and cannot be combined with `wrapperCli`. BotMux writers generate a `cliPathOverride` downgrade shadow that exactly matches `executable`: new versions use `cliRuntime` as canonical, while old versions still launch the same binary from the shadow. Manual configs must include the same exact shadow as shown above; a missing or mismatched value fails validation so an accepted config is always safe to roll back. Wrappers and gateways keep using the legacy entry-point mechanism below.
- Existing `cliPathOverride` configs remain launch-compatible and receive the same safe `auto` update behavior. The Dashboard shows them in a read-only compatibility state: model-only saves preserve the old entry point, choosing Official Codex explicitly clears it, and choosing Custom Compatible migrates it to `cliRuntime`. Because a raw path does not assert the full compatibility contract, Codex RPC enhancements remain disabled.

A session freezes its runtime snapshot when created. Model-only changes affect new sessions; switching CLI, runtime, or wrapper immediately closes active sessions that still use the old launch identity so they cannot lazy-resume into the wrong distribution. Existing sessions are never silently switched to another runtime.

### Run a bot on GLM / a third-party provider (per-bot env)

Run one bot on a GLM Coding Plan (or any Anthropic-compatible provider) while another keeps using official Claude — give the former an `env`:

```json
{
  "cliId": "claude-code",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "your GLM Coding Plan key"
  }
}
```

- For GLM in China, use `https://open.bigmodel.cn/api/anthropic` for `ANTHROPIC_BASE_URL`.
- For an OpenAI-protocol CLI like Codex, set `OPENAI_BASE_URL` / `OPENAI_API_KEY` (the provider's OpenAI-compatible endpoint) instead of `ANTHROPIC_*`.
- **Isolation**: env is injected per-session into the CLI process, consistently across backends (tmux / zellij inject it per-pane, never into the shared server env), so one bot's provider config can't leak into another's.
- **Security**: values live in `bots.json` and the process environment in plaintext — not a secret vault; chat surfaces like `/config get` mask the values (the owner-authenticated dashboard editor shows real values).
- Takes effect from the next **session**.

### Clean Codex App input (experimental)

`codexAppCleanInput` keeps user messages shown in Codex App clean while preserving the context Botmux needs when invoking the model. It defaults to `false` / `off`; when disabled, Botmux keeps the original combined-prompt behavior unchanged.

An owner or `allowedUsers` member can hot-update it with `/botconfig`; no daemon restart is required:

```text
/botconfig set codexAppCleanInput on
/botconfig set codexAppCleanInput off
```

You can also add it to the corresponding bot entry directly (manual `bots.json` edits still require the restart described at the end of this page):

```json
{
  "cliId": "codex-app",
  "codexAppCleanInput": true
}
```

- The flag applies only to Botmux-managed sessions whose actual CLI is `codex-app`; other CLIs and externally bridged `/adopt` sessions are unaffected. A session-frozen CLI takes precedence over a later bot-default CLI change.
- When enabled, user-authored turns use the original text as the Codex App text `UserMessage`; Botmux-authored synthetic turns such as external triggers and document prewarm use a short readable label. Message-level sender, mentions, attachment paths, quotes, role, whiteboard, Skills, and synthetic-turn instructions primarily move to hidden `additionalContext`. Readable absolute-path images are also sent as `localImage`; missing, relative, or unreadable images skip the native image item with a diagnostic while their attachment path remains in context.
- A detectable Codex CLI `>= 0.135` enables clean text plus `additionalContext`; `>= 0.136` also attaches a separate `clientUserMessageId`. Older or unknown versions use the legacy combined prompt directly.
- The runner retries the legacy prompt **once** only when app-server explicitly rejects `additionalContext` / `clientUserMessageId` before `turn/started`, then disables clean mode for that runner lifetime. Network, timeout, model, and generic turn errors are never auto-retried, avoiding duplicate work.
- A `/botconfig` change is sampled at the **next dispatch to the Codex worker**. For ordinary live messages this is normally the next message; a first turn waiting on repo selection is sampled when the repo is committed. Already queued or running turns are not rewritten, and existing history is never backfilled.
- `additionalContext` is omitted from the ordinary Codex App user-message bubble, but it may still be retained in raw rollout or diagnostic records. When enabled, Botmux also keeps the legacy prompt and structured sidecar for compatibility fallback and `retry_last_task`. This feature improves App presentation and ordinary history reading; it is **not** a privacy-erasure or security-redaction mechanism.

### Codex App browser bridge (experimental)

This option addresses one narrow gap: Codex running through Botmux's app-server path does not otherwise inherit the Chrome tool built into Codex App. The bridge belongs entirely to Botmux and has no dependency on a project repository, Harness, or local-proxy setup.

```json
{
  "cliId": "codex-app",
  "codexBrowser": true
}
```

- Install and enable the Codex browser extension in Chrome / Edge under the same OS user first. Botmux selects the newest complete official plugin under `CODEX_HOME` (or `~/.codex`) automatically; use an absolute `pluginRoot` only for a maintained custom location.
- The setting registers one `botmux_browser` dynamic tool only on newly created Codex App threads. Existing threads are not rewritten; open a new Lark topic / session to verify it.
- The tool exposes only high-level tab, accessibility-tree interaction, navigation, and screenshot operations. It does not expose arbitrary JavaScript, raw CDP, cookies, local storage, browser history, clipboard, or file transfer.
- Each Botmux runner owns isolated browser-session state. The feature is off by default, so unconfigured bots retain their existing launch arguments and behavior.
- It currently cannot be combined with `existingAppServer`, `sandbox`, or `readIsolation`; conflicting configuration fails at startup instead of running with an incomplete isolation boundary.

## Working directory

| Field | Description |
|------|------|
| `workingDir` | Default working directory, supports a comma-separated list. Recursively searches **downward** for git repositories from this directory (up to 3 levels), never scans upward |
| `workingDirs` | Array form of working directories (`["~/a", "~/b"]`); takes precedence over the comma-separated form of `workingDir` when explicitly configured |
| `defaultWorkingDir` | Default directory for a single repository: with no oncall and no sibling session in the same group, enters it directly and skips the repo selection card. `/cd` can still switch mid-session. Purely a runtime fallback — does not write state and does not change the permission model |

## Permissions and authorization

| Field | Description |
|------|------|
| `allowedUsers` | The operate-permission list. Prefer a **full email**, mobile number, or `on_xxx`; an `ou_xxx` is valid only for the same app that issued it and must never be copied across Bots. When `allowedChatGroups` is configured, at least one is required to serve as owner |
| `allowedChatGroups` | Conversable groups (`oc_xxx`). Any member of the group can converse (only `canTalk`); sensitive operations are still controlled by `allowedUsers` |
| `p2pOpen` | When `true`, any user within the Lark app's availability scope may DM this bot (only `canTalk`). Group behavior is unchanged and sensitive operations still require `allowedUsers`. Always configure at least one `allowedUsers` owner |
| `oncallChats` | Oncall bindings, `[{ "chatId": "oc_xxx", "workingDir": "~/projects/foo" }]`. See [oncall](/en/oncall) |
| `defaultOncall` | The bot's default: the first new topic in a new group chat is automatically bound to oncall. `{ "enabled": true, "workingDir": "~/foo", "since": <epoch ms> }`; older groups that already existed before `since` are unaffected |
| `globalGrants` | Global conversable list (`ou_xxx`, people or bots). Can converse in any group, only `canTalk` |
| `chatGrants` | Per-group, per-user authorization `{ "oc_xxx": ["ou_yyy"] }`, only grants `canTalk`. Usually written by the `/grant` card, but can also be configured by hand |
| `messageQuota` | Message-quota override `{ "defaultLimit": N }`: once a positive integer is configured, new grant cards and Oncall both use an N-message quota. When unset, new grant cards default to 3 messages per person while Oncall remains unlimited. An explicit `/grant @user N` always uses N. Only constrains talk authorization, does not affect `canOperate` |
| `restrictGrantCommands` | When `true`, people granted only via per-user authorization (`chatGrants` / `globalGrants`) are disabled from **all slash commands** and can only have plain conversations; owner / `allowedUsers` / oncall / whole-group members are unaffected. Defaults to `false` |
| `autoGrantRequestCards` | Enabled by default. Set to `false` to stop automatically sending `/grant` request cards to the owner when an unauthorized person or external bot @mentions this bot in a group and the talk gate blocks it; the message is dropped silently instead |

## File sandbox

| Field | Description |
|------|------|
| `sandbox` | When `true`, launch new sessions in the Linux file sandbox. Writes are isolated and must be landed with `/land` |
| `sandboxHidePaths` | Paths masked inside the sandbox with empty dirs/files so the bot cannot read them, e.g. `["~/.ssh", "~/.botmux/bots.json"]` |
| `sandboxReadonlyPaths` | Extra existing paths mounted read-only inside the sandbox, useful for shared source snapshots, reference repos, or generated docs the bot should inspect but not modify |
| `sandboxNetwork` | Network policy for sandboxed sessions. Omitted / `true` keeps current network and proxy access; `false` adds `--unshare-net` and blocks normal network egress |

> ZMX cannot enforce the file sandbox or effective read isolation, so configurations that enable those boundaries fail closed; see [ZMX backend boundaries](/en/zmx#unsupported-combinations).

## Cards and terminal

| Field | Description |
|------|------|
| `brandLabel` | Branding text at the bottom of the card. `undefined` = default `botmux` link; `""` = hidden; any other string = rendered as-is (supports markdown). Purely cosmetic, does not affect routing / permissions |
| `showUsageInCardFooter` | Whether reply-card footers show native Context / Token usage from the Agent CLI. Missing / `true` = show; `false` = hide both metrics. A missing individual metric is still omitted independently. This controls card display only and does not disable the Usage Ledger or other accounting |
| `disableStreamingCard` | When `true`, no real-time streaming session card is sent at all (the Web Terminal still runs and the final reply still arrives via `botmux send`, there's just no auto-refreshing status card). For users who find the real-time card noisy |
| `pinStreamingCard` | When `true`, the bot **pins the current public live-status card**. It is opt-in and default-off: only an explicit `true` enables it. Only the current public live-status real `streamCardId` participates; repo-picker cards, private `/card` snapshots, final reply cards, CoT, closed cards, and every other interactive card stay out of scope. The switch is hot-updated: once dashboard or `/botconfig set pinStreamingCard on/off` successfully writes local config and changes the effective value, Botmux runs a best-effort reconciliation across this bot's **existing active sessions**. The configuration response does **not wait** for Feishu Pin/Unpin calls. Failures never interrupt publication, transfer, resume, close, or configuration itself; during exceptional periods there may temporarily be zero or multiple Pins. This feature adds **no durable retry journal and no full-chat Pin audit**: an explicit on-to-off transition cleans the session's known live-card IDs; if the setting is already off and process-local provenance was lost, later close or transfer does not risk removing a Pin that may have been created manually |
| `noPinStreamingCardChats` | Array of `chatId`s where Botmux must **not pin** streaming cards even when `pinStreamingCard` is enabled for the bot. This is the negative set behind `/card pin off|on`. The live streaming cards themselves still post normally; only the Pin side effect is suppressed for those chats. Empty / absent means no per-chat opt-out |
| `silentTurnReactions` | When `true`, card-off sessions no longer add GoGoGo / DONE reactions to the triggering message. Only affects the lightweight status reactions used when `disableStreamingCard` or `noCardChats` suppresses live cards; defaults to `false` |
| `receivedReactionEmoji` | Feishu emoji_type for the "received" reaction in card-off sessions; `undefined` = default `GoGoGo` (冲!). Free-form string; a bad value just silently fails to attach (best-effort) |
| `doneReactionEmoji` | Feishu emoji_type for the "done" reaction in card-off sessions; `undefined` = default `DONE` (✅). Set it equal to `receivedReactionEmoji` to keep the marker unchanged on turn-end — handy for CLIs whose idle detection can fire early (e.g. Pi), avoiding a premature, misleading ✅ |
| `writableTerminalLinkInCard` | When `true`, the card body directly embeds a **writable** terminal link (with token, anyone who can see the card can operate it); by default it's hidden behind a "Get write permission" button and sent privately to whoever clicks. Meaningless when `disableStreamingCard` is enabled |
| `privateCard` | When `true`, `/card` uses an ephemeral private card visible only to `allowedUsers` (talk grantees and the bare triggerer don't receive it), only effective in plain `group` chats, and cannot live-update. Only affects the `/card` command itself |

## Prompt injection

| Field | Description |
|-------|-------------|
| `senderTag` | Boolean, default `true` (on). Whether each turn forwarded to the CLI carries a `<sender type="user\|bot" open_id="ou_…" name="…" email="…" />` tag naming who spoke. Only an explicit `false` is persisted and disables it; absent or `true` both keep injecting, leaving the prompt byte-for-byte identical to historical behavior |

With it off the model cannot see speaker identity: in a multi-person chat it cannot tell participants apart or address them by name. Useful for a CLI whose model copies the tag into its reply body (e.g. cursor — see the `<sender_note>` anti-echo hint, which disappears together with the tag), or when you do not want per-message identity written into the CLI transcript.

Hot-updatable by the owner / `allowedUsers` via `/botconfig`, no daemon restart:

```text
/botconfig set senderTag off
/botconfig set senderTag on
```

Or write it directly into the bot's config:

```json
{
  "senderTag": false
}
```

- **`botmux send --mention-back` is unaffected**: it reads the daemon-side record of this turn's triggerer (`replyTargets[turnId].senderOpenId`), a separate path from this prompt tag.
- Turning it off costs two **observability** signals: (1) `/adopt` loses one fingerprint for recognizing this bot's own sessions (the remaining structural checks still cover every prompt shape we ship, so self-produced sessions are not listed as external); (2) dashboard session insight can no longer read speaker type or A2A agent name from the tag, falling back to the `[来自 … 的 @mention]` handoff marker — with no such marker, that turn shows no source.
- Applies immediately (from the next turn); it does not rewrite queued or in-flight turns, nor backfill existing history.
- The dashboard "Speaker Tag" toggle saves this field.

## Proactive start

| Field | Description |
|------|------|
| `autoStartOnGroupJoin` | When `true`, the bot starts working automatically when added to a new group containing at least one `allowedUsers` member (no @ needed). Requires subscribing the `im.chat.member.bot.added_v1` event for this app in the Lark admin console |
| `autoStartOnGroupJoinPrompt` | Paired with the above: the first-round prompt for proactive start; if empty / blank, opens with an empty message and lets the bot read the group context itself. Meaningless when `autoStartOnGroupJoin` is off |
| `autoStartOnNewTopic` | When `true`, the first message of every new topic in a topic group starts working automatically without an @ (no effect in plain groups). Defaults to passive (only @ triggers) |

## Group message listener

Have a bot **actively watch a group**: matching group messages start a session automatically, no @ required. The classic use is **alert operations** — your monitoring/alerting system usually already has its own Lark bot posting alerts into a group, so just add this bot to that group and enable the listener; every alert triggers an investigation session, with no need to set up a separate [Webhook integration point](/en/webhook).

Configure it per-group in the **Dashboard "Roles → Message Listener"** tab (with **Preview** of the last 24h of matches and a **dry run** to validate); or write `messageListeners` directly in `bots.json` (keyed by `chat_id`, valued by the config below):

| Field | Description |
|------|------|
| `enabled` | Whether the listener is on for this chat. `prompt` is required when enabled, otherwise the whole entry is ignored |
| `prompt` | Listener prompt: tells the bot which messages to handle and how to reply. A matched message is replied to in a **new topic beneath it** |
| `name` | Listener name (optional), e.g. "Alert listener", shown in the Dashboard |
| `replyCardTitle` | Reply card title (optional); blank uses the default |
| `workingDir` | Working directory for sessions this listener starts (optional); blank uses the bot's default |
| `senderPolicy.mode` | `all_except_excluded` (blacklist, default): handle every matching sender type except the excluded ones; `include_only` (whitelist): handle only the senders in `includeSenderOpenIds` |
| `senderPolicy.includeSenderTypes` | Sender types to listen to: `["user"]` / `["bot"]` / both. **Listening to a third-party alert bot must include `"bot"`** |
| `senderPolicy.includeSenderOpenIds` / `excludeSenderOpenIds` | Exact whitelist / blacklist by `open_id` |
| `senderPolicy.excludeSelf` | Default `true`; always excludes the bot's own messages (prevents self-triggering) |
| `messagePolicy.includeMsgTypes` | Message types to listen to; defaults to text + rich text (`post`) |

```json
{
  "messageListeners": {
    "oc_xxxxxxxxxxxxxxxx": {
      "enabled": true,
      "name": "Alert listener",
      "prompt": "Every alert in this group is a production event. Identify the affected service and give an initial investigation direction; if it's a false alarm, explain why.",
      "senderPolicy": { "mode": "all_except_excluded", "includeSenderTypes": ["bot"] }
    }
  }
}
```

Conventions and limits (V1):

- **Top-level group messages only**: ordinary replies inside an existing topic are not handled; a message that explicitly @s this bot still goes through normal @ routing (no double trigger).
- **One session per matched message**, replied to in a new topic beneath it.
- **Delivery**: the realtime event path covers messages Lark pushes; **messages from other bots, and non-@ messages, are backfilled by a history poll roughly every 30s** (so up to ~30s of latency). That's why listening to a third-party alert bot works most reliably in blacklist mode (`all_except_excluded` + include `"bot"`) — whitelist matches by `open_id`, but the history API reports third-party bots by `app_id`, which may not resolve to an `open_id` and therefore won't match.

## Summary command

| Field | Description |
|------|------|
| `summaryRange` | History range used by the explicit `@bot /summary` command. `limit` is the latest N messages in a regular group, defaulting to 50; `sinceHours` is the latest N hours in a regular group, defaulting to 24. Set either field to `0` to remove that limit. Topic groups always read the current topic/thread history, then apply the summary window |
| `summaryMemory` | Boolean, defaults to `false` (off). When enabled, `@bot /summary` turns the summary into a Chinese "problem-resolution record" appended to the memory file named by `summaryMemoryPath` below, instructs the agent to write only that one file and echo back the exact Markdown written, and injects a `<summary_memory>` reuse hint into later turns so a later question reuses a past conclusion only when key conditions — PSM, environment, task ID, node, error symptom, etc. — match exactly; otherwise the file is treated as reference only |
| `summaryMemoryPath` | Memory file path, defaults to `summary.md`. A relative path is resolved by the agent against the "current project root"; an absolute path is used as-is. Empty / unset falls back to `summary.md`. Only takes effect when `summaryMemory` is `true` |

Example:

```json
{
  "summaryRange": {
    "limit": 50,
    "sinceHours": 24
  },
  "summaryMemory": true,
  "summaryMemoryPath": "docs/summary.md"
}
```

- Only the explicit `@bot /summary` command triggers a summary. Messages that do not mention the bot still follow the existing group/topic routing rules and are not woken up by keywords.
- The dashboard "/summary Range" controls this `summaryRange` field; the "Enable memory" toggle and "Memory file path" input save `summaryMemory` and `summaryMemoryPath` respectively.
- If an earlier `@same bot /summary` exists before the current trigger, the summary window includes only messages after that earlier command and up to the current trigger; otherwise botmux falls back to `limit` / `sinceHours`.
- `limit` and `sinceHours` are safety caps for the default (no explicit boundary) summary window. If both are `0`, that dimension is not limited. **An explicit boundary intentionally takes precedence over these caps**: when `summaryMemory` is on and `/summary` carries boundary text, botmux honors the user's explicit "start from this message" intent and includes everything from the matched boundary onward — in a regular group `limit` still bounds the scan, but a boundary older than `sinceHours`, and any arbitrarily old boundary in a topic group, is accepted and may exceed the default configured range. If you do not want a bot to read in very old content, the reliable approach is to omit the boundary text; in a regular group you can also lower `limit` to bound the scan (but `sinceHours`, and any boundary in a topic group, are not constrained by the configured range).
- **Only when `summaryMemory` is enabled**, text following the `/summary` command is treated as a hard boundary: it locates the **most recent** message before the trigger that contains that text and summarizes only from there up to the current trigger; if the boundary is not found in the scanned history, botmux does not fall back to a wider range but hands the agent a "boundary not found" error together with an empty history (the memory write instruction still runs). When `summaryMemory` is off, text after `/summary` is only a focus hint for the summary and the history window still follows `summaryRange`.
- The memory file is written by the agent within its working directory. If the bot has sandbox enabled and `summaryMemoryPath` points outside the working directory (an absolute path, or a relative path that escapes via `../`), add the file's **existing parent directory** to `sandboxPaths.readWrite`; the worker filters out paths that do not yet exist at spawn time, and a new memory file usually does not exist yet, so adding only the file path itself is dropped (unless the file is pre-created). Otherwise the write may be denied by the sandbox.

## Legacy content trigger config

| Field | Description |
|------|------|
| `contentTriggers` | **Legacy / no longer active.** Older builds used this field for keyword / regex triggers without an @mention, but current message routing no longer wakes a bot from `contentTriggers`. The parser keeps this field only for `bots.json` compatibility: if an old dashboard-managed trigger named `dashboard-default-summary-trigger` exists, botmux may read its `limit` / `sinceHours` as a fallback for `summaryRange`. New configs should use `summaryRange` |

## Voice

| Field | Description |
|------|------|
| `voice` | The bot's voice-engine override, merged field-by-field on top of the global `voice` block in `~/.botmux/config.json` (per-bot takes precedence). When valid voice credentials are present, a "🔊 Voice summary" button appears on reply cards. See [Voice summary](/en/voice) |

## Meeting listener roles and group placement

`vcMeetingAgent.meetingConsumer.consumerProfiles` defines reusable meeting-listener roles. `responseMode` controls whether automatic model output is authorized; `listenerDelivery.placement` independently controls where authorized output appears:

The Dashboard meeting-role editor includes a local built-in template library: Important information sync, Meeting minutes and action items, Meeting facilitator, Solution review and risk challenge, and Interview and requirement insights. “Use template” copies the selected template into a normal, fully editable profile; later template changes never overwrite user configuration. The catalog has stable template IDs, versions, and source metadata so a community source can use the same model later. This release makes no network request and uploads no usage data, so popularity rankings are intentionally unavailable.

- `silent`: automatic model output stays hidden.
- `listener_thread`: automatic output may be sent to the listener group and requires `listener.output.request`.
- placement `auto` (also the default when omitted): preserve legacy session routing.
- placement `chat`: send every update as a top-level group message.
- placement `topic`: use the first useful update as a stable topic root and thread later updates under it. Removing and re-enabling the profile starts a new topic.

Automatic `listener_thread` output uses an internal `skip | publish` control protocol. The agent decides whether the current meeting state warrants publication; botmux sends only the `publish` message body and never renders the control JSON in Lark. There is no semantic-fingerprint deduplication or debounce/interval setting: novelty, observation time, and publication timing remain the agent's responsibility under the profile prompt and full meeting context. Malformed envelopes fail closed. Explicit human IM replies keep their existing quote/thread routing and do not use this protocol.

Example generic “important meeting information sync” profile:

```json
{
  "id": "important-sync",
  "agentAppId": "cli_your_agent_app_id",
  "label": "Important meeting information sync",
  "role": "important-information-sync",
  "instructions": "Continuously listen to the meeting. Publish only new information that materially matters to collaborators: confirmed decisions, status changes, explicit blockers or risks, and items people need to know or act on. When discussion has not formed a clear change, do not publish yet; decide whether to keep observing and when to publish from meeting semantics. Ignore discussion process, repetition, small talk, and unconfirmed speculation. Keep each update concise and include owner, deadline, scope, or impact when known. A correction to a previously stated time, owner, scope, status, or conclusion must be published as new information even when most surrounding details remain unchanged. Re-evaluate transcript revisions without repeating unchanged items.",
  "filter": { "activityTypes": ["transcript_received", "chat_received"] },
  "responseMode": "listener_thread",
  "listenerDelivery": { "placement": "topic" },
  "capabilities": ["listener.output.request", "meeting.read"]
}
```

Set `agentAppId` to the bot that executes the role. Add the profile id to `defaultConsumerIds` with `defaultMode: "agents"` to enable it by default, or select it manually from the in-meeting consumer card.

## Runtime state (auto-maintained, do not edit)

The following fields are written by botmux itself and persisted into `bots.json` alongside authorizations / switches. They are listed only for reference — **do not edit them by hand**:

| Field | Description |
|------|------|
| `defaultOncallAutoboundChats` | The chat_ids that `defaultOncall` has already auto-bound (append-only). Once recorded, it won't auto-bind again even if later unbound |
| `quotaState` | Scope-level message-quota counters `{ "chat:<cid>:<oid>" \| "global:<oid>": { limit, used } }`; when exhausted, automatically revokes the corresponding scope's authorization |
| `noCardChats` | The "don't send streaming cards in this group" list written by `/card off\|on` |

> **Configuration precedence**: the `BOTS_CONFIG` environment variable → `~/.botmux/bots.json`. Run `botmux restart` after editing to take effect.
