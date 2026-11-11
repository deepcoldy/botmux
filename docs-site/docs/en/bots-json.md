# bots.json Configuration

`~/.botmux/bots.json` is the bot configuration file. It is an array, and each entry is one bot. Each bot runs in its own daemon process.

`larkAppId` and `larkAppSecret` are all you need to get started. Every other field is optional; add them as you need them.

## How to change the config

All three ways edit the same `bots.json`. Use whichever is handy:

| Way | Good for | Takes effect |
|------|------|------|
| Dashboard "Bot Config" page | Day-to-day changes (recommended) | Most settings apply on save; a few (CLI, environment variables) apply to new sessions |
| Send `/botconfig set <field> <value>` in Feishu | Changing one thing from a chat | Same as above; `/botconfig help` lists the fields you can change, `/botconfig get` shows current values |
| Edit the file by hand | Bulk edits, advanced fields | Run `botmux restart` afterwards |

To create your first bot, run `botmux setup`. It walks you through it and writes this file for you.

> File location: the path in the `BOTS_CONFIG` environment variable if set, otherwise `~/.botmux/bots.json`.

This page covers per-bot settings only. Machine-wide switches such as auto-update, idle cleanup and the global layer of session environment variables live in `~/.botmux/config.json`; see [Global settings](/en/global-settings).

![Dashboard "Bot Config" page with five tabs: Common / Sessions / Permissions & Security / Message Cards / Advanced](/img/codex-compatible-runtime-dashboard.png)

## Examples

Minimal config:

```json
[
  { "larkAppId": "cli_xxx", "larkAppSecret": "xxx" }
]
```

Two bots, one on Claude Code and one on Codex:

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

## Want to do X → which field

| What you want | Field |
|------|------|
| Switch CLI / model | `cliId`, `model`, `reasoningEffort` |
| Run a bot on GLM or a third-party model provider | `env` (see [GLM / third-party providers](#glm-provider)) |
| Open new topics straight in one directory, no repo picker card | `defaultWorkingDir` |
| Choose who the admins are | `allowedUsers` |
| Let everyone in a group talk to the bot | `allowedChatGroups` or `oncallChats` |
| Let anyone DM the bot | `p2pOpen` |
| Block someone | `blockedUsers` |
| Limit which files the agent can read and write | `sandbox` (see [File sandbox](/en/sandbox)) |
| The live card is too noisy | `disableStreamingCard`, `hiddenStreamingCardButtons` |
| Keep host paths and local addresses out of replies for a bot others use | `hideLocalAddresses` (see [Hide development host addresses](#hide-local-addresses)) |
| One card per turn for both progress and answer | `replyCardMode: "unified"` |
| Start working without being @-mentioned | `autoStartOnNewTopic`, `autoStartOnGroupJoin` |
| DM the owner a welcome message when the bot first comes online | `welcomeMessage` (see [Welcome message](#welcome-message)) |
| Watch an alert group and handle every alert | Group message listener (see [Group message listener](#message-listener)) |
| Hand off to another bot when quota runs out | `quotaFallbackBot` |
| Stop botmux from adding anything to the prompt | `promptInjection: "none"` |
| Control how much memory sessions use | `maxLiveWorkers`, `idleSuspendMinutes` |
| Track spend and get budget alerts | `pricing`, `budget` (see [Spend and budget](#budget)) |
| Remind the owner when a session keeps waiting on a person | `sessionOwnerReminder` (see [Waiting and no-progress reminders](#reminders)) |
| Use international Lark | `brand: "lark"` |

## Required

| Field | Description |
|------|------|
| `larkAppId` | Feishu app App ID |
| `larkAppSecret` | Feishu app App Secret |

The optional `brand` says which platform the app belongs to: `feishu` (default, Feishu in China) or `lark` (international Lark). API hosts and authorization links follow it. `botmux setup` detects it and writes it for you. A bot is bound to one tenant; to switch platforms, set up another bot.

## CLI and model

| Field | Description |
|------|------|
| `name` | Process name suffix: `claude-main` gives the process `botmux-claude-main`. Defaults to `botmux-<index>` |
| `displayName` | Nickname shown in the Dashboard. Display only; it does not rename the app in Feishu |
| `cliId` | Which CLI to run. Defaults to `claude-code`. See [Multi-CLI adapters](/en/adapters) for the options. `gemini` has been removed: a bot still set to `"gemini"` refuses to start and tells you to switch to `"antigravity"` |
| `model` | Model passed to the CLI at launch (e.g. `claude --model opus`); empty means the CLI's own default. Several bots on the same CLI can run different models. It is read every time a session starts or resumes, so after a change, existing sessions without a per-group model pick up the new model on their next resume |
| `reasoningEffort` | Default reasoning effort for new sessions: `low` / `medium` / `high` / `xhigh` / `max` / `ultra`. Supported CLIs: Claude Code, Codex, Codex App, TraeX, Grok, Kimi, ZCode, `remote-runner`. Checked against the CLI and model; unsupported combinations are ignored. For example, Kimi only applies with model `kimi-code/k3` or `kimi-code/k3-256k`, and only has `low` / `high` / `max`; Claude's Haiku models take no reasoning effort |
| `groupDefaultModels` | Per-group default model for new topics; Codex and Claude Code for now. See [Per-group default model](#group-default-models) below |
| `serviceTier` | Codex only: speed tier for new sessions, `default` / `priority` / `ultrafast`. Empty keeps Codex's own setting |
| `codexProfile` | Codex only: Codex config profile name; the Dashboard can scan and list them |
| `modelBackendVariant` | TraeX only: backend variant `standard` / `max`. Empty keeps the TraeX global setting |
| `nativeSubagentRuntime` | TraeX only: model and reasoning effort for TraeX's native subagents. See below |
| `wrapperCli` | Launch prefix, e.g. `"aiden x claude"`. botmux builds the launch command as `<wrapperCli> <CLI args>`, which suits enterprise gateways, ccr and similar launchers. See [Multi-CLI adapters](/en/adapters) |
| `cliRuntime` | Describes a Codex-compatible distribution. See [Codex-compatible distributions](#codex-runtime) below |
| `cliPathOverride` | Legacy CLI executable override, still supported. Use `cliRuntime` for new Codex-compatible distributions |
| `cliConfigDir` | Claude Code only: launch with `CLAUDE_CONFIG_DIR=<dir>`, so settings, login and transcripts all come from that directory. New sessions only |
| `disableCliBypass` | `true` stops botmux from adding approval-bypass flags such as `--yolo` and `--dangerously-*` |
| `promptCache` | Claude Code only: prompt-cache lifetime and idle keep-alive, e.g. `{"ttl":"1h","keepalive":{"enabled":true}}`. Fields you leave out follow the global setting; off by default |
| `skillInjection` | How botmux's built-in skills reach the CLI: `prompt` (per session), `global` (installed into the CLI's global skills dir), or `off`. If unset, it follows the global setting, which defaults to `prompt`. See [Skills](/en/skill-cli) |
| `customPassthroughCommands` | Extra slash commands passed through to the CLI, e.g. `["/export"]`. Entries that would clash with botmux's own commands are dropped. `/list-slash-command` shows the full list. See [Slash commands](/en/slash-commands) |
| `startupCommands` | Commands sent to the CLI after it starts and before the first message, e.g. `["/effort ultracode"]`. Re-sent on every fresh start and resume |
| `quotaFallbackBot` | Hand the session to another bot when CLI quota runs out. Off by default. See [Quota handoff](#quota-fallback) below |
| `codexCapacityRecovery` | Codex / Codex App only: automatically continue after an explicit model-capacity error. Off by default; at most two recovery inputs per task. Ordinary rate limits and exhausted quota don't count |
| `suppressDeliveredFinalFailureNotice` | Experimental, off by default. Once a turn's final answer has been delivered, a later model-service error no longer posts a "model connection failed" notice |
| `turnTimeoutMs` | dsh / MiniMax only: per-turn time limit (ms, positive integer). Unset by default, meaning no limit. dsh: an idle watchdog that ends the turn after this long with no new events, plus a hard cap of 4x this value; MiniMax: total execution time for the turn, not reset by model output or tool progress, and time spent waiting for a human doesn't count. Other CLIs ignore it |
| `codexRpcInput` | Experimental, Codex / TraeX only: send input over app-server JSON-RPC instead of typing into the terminal. `true` on, `false` off; if unset it follows the Dashboard global switch. `/stop` (use `/close` instead) and `/fast` are not supported in this mode. Can't be combined with `existingAppServer` |
| `codexAppCleanInput` | Experimental, Codex App only: the user message shown in Codex App contains only what the user wrote. See below |
| `codexBrowser` | Experimental, Codex App only: lets sessions drive Chrome / Edge through the locally installed Codex browser plugin. See below |

### Per-group default model for new topics {#group-default-models}

`groupDefaultModels` lets one bot default to different models in different groups:

```json
{
  "groupDefaultModels": {
    "oc_team": { "codex": { "model": "your-codex-model", "reasoningEffort": "high" } }
  }
}
```

The easier route is Dashboard "Group Management → New topic default model", per bot. No restart needed after saving.

- A new topic records the group model at creation time. Later changes to the group setting only affect new topics; existing topics keep their model across restarts and resumes.
- Each CLI is recorded separately, so a topic that switches CLI won't pass a Claude model name to Codex.
- Priority: model given explicitly at trigger time > the group model recorded by the topic > the bot model for the same CLI > the CLI's own default.
- DMs, group-wide shared sessions in regular groups, and adopted external sessions don't use this setting.

### TraeX native subagents (`nativeSubagentRuntime`)

This only affects new subagents created by TraeX's native `spawn_agent`, not the parent agent. `model` and `reasoningEffort` are each optional:

- Leave one out: the value from the subagent request is passed through.
- Set it to `{ "mode": "custom", "value": "..." }`: always use that value.
- Leaving both out: delete the whole field. `inherit` is not a valid mode.

Switching to another CLI removes this field automatically.

### Quota handoff {#quota-fallback}

With `quotaFallbackBot`, when the current CLI is confirmed to be out of quota, the daemon really `@`-mentions a backup bot in the original session so it can take over. It doesn't call the exhausted model again and leaves the existing quota notice card alone.

![Quota handoff settings under Dashboard "Bot Config → Advanced"](/img/quota-fallback-dashboard.png)

```json
{
  "quotaFallbackBot": {
    "enabled": true,
    "targetAppId": "cli_xxx_backup",
    "kinds": ["usage", "rate"],
    "message": "The primary bot is out of quota. Please take over this session and continue from the context."
  }
}
```

| Field | Description |
|------|------|
| `enabled` | Only `true` turns it on |
| `targetAppId` | The backup bot's Feishu App ID (starts with `cli_`). Don't use `ou_xxx`: an open_id is only valid for the app that issued it |
| `kinds` | `usage` (usage cap) and/or `rate` (rate limit); both if omitted |
| `message` | What to say when handing off; a default is used if omitted. Up to 1000 characters, no `<at>` tags |

Good to know:

- The backup bot must be configured on this machine and actually be in the group right now. Bots on other machines, the bot itself, and bots not in the group are skipped.
- Group sessions hand off in the original group, topic sessions in the original topic. The backup bot reads the history itself.
- One handoff per source bot and quota type every 5 minutes. A daemon restart doesn't replay old handoffs.
- Saving checks the handoff chain and rejects handing off to itself or loops like `A → B → C → A`. If a hand edit introduces a loop, `botmux start/restart` skips the bots in the loop and starts the rest; the Dashboard flags them and lets you fix them under "Advanced → Quota-limit handoff".

![The Dashboard flags bots skipped because of a handoff loop and opens the fix directly](/img/quota-fallback-cycle-recovery-dashboard.png)

### Codex-compatible distributions {#codex-runtime}

Some CLIs are independent distributions of Codex: same flags, interaction, session resume and login, but a different binary and release line. They don't need a new `cliId`. Keep `cliId: "codex"` and describe the distribution with `cliRuntime`:

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

The easier way: in Dashboard "Bot Config → Common → Agent config", pick "Custom Compatible", fill it in and save (that's the screenshot at the top of this page).

| Field | Description |
|------|------|
| `id` | Stable identity: letters, digits, `.`, `_`, `-`, up to 64 characters. Renaming it counts as switching distributions |
| `executable` | An executable name or path, not a shell command; don't put arguments in it. The Dashboard runs `--version` on save, and the output must contain an `X.Y.Z` version |
| `displayName` | Name shown on cards, status and the Dashboard; defaults to `id` |
| `update.provider` | `auto`: only trusts an npm package that maps exactly to this binary, otherwise marks it "unmanaged" and never compares against official Codex versions; `self`: uses the version info the CLI reports; `npm`: requires `packageName`; `none`: no update checks |

Notes:

- `cliRuntime` only supports `cliId: "codex"` for now and can't be combined with `wrapperCli`.
- When writing it by hand, also set a `cliPathOverride` identical to `executable` (as above). It lets an older botmux downgrade safely; missing or different values fail validation. The Dashboard writes it for you.
- Old configs with only `cliPathOverride` keep working. The Dashboard shows them as read-only compatibility mode and can migrate them to "Custom Compatible".
- Each session remembers the distribution it started with. Changing only the model affects new sessions; switching CLI, distribution or wrapper closes active sessions still on the old launch identity, so they never resume on the wrong binary.

### GLM / third-party providers {#glm-provider}

To run one bot on GLM Coding Plan (or another Anthropic-compatible provider) while another stays on official Claude, give the first one an `env`:

```json
{
  "cliId": "claude-code",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "your GLM Coding Plan key"
  }
}
```

- For the GLM China site use `https://open.bigmodel.cn/api/anthropic`.
- For OpenAI-protocol CLIs such as Codex, set `OPENAI_BASE_URL` / `OPENAI_API_KEY` instead.
- Each bot's `env` only goes into its own sessions and never leaks to other bots.
- Values are stored in plain text in `bots.json` and the process environment; this is not a secret vault. Config queries in Feishu are masked, the Dashboard masks by default, and only the local owner can reveal the raw value.
- Changes apply to new sessions.

For more (global layer, removing a variable, strict inheritance) see [Session environment](#session-env) below.

### Clean Codex App input (experimental)

By default botmux combines context such as the sender and attachment paths with the user's text before sending it to Codex App, so the user message in the App looks cluttered. With `codexAppCleanInput` on, the App shows only what the user wrote, and the context goes through the hidden `additionalContext` instead.

```text
/botconfig set codexAppCleanInput on
/botconfig set codexAppCleanInput off
```

Or in the config:

```json
{ "cliId": "codex-app", "codexAppCleanInput": true }
```

- Only applies to botmux-managed sessions actually running `codex-app`; external sessions taken over with `/adopt` are unaffected.
- Needs Codex CLI `>= 0.135`; older or unrecognized versions fall back to the combined prompt.
- If Codex App explicitly rejects the experimental fields, botmux retries once the old way and turns clean mode off for that run. Network errors, timeouts and the like are not retried, to avoid running a task twice.
- Takes effect from the next message dispatched to Codex. Queued or running messages and existing history are not rewritten.
- This only tidies up what the App shows. It is not privacy scrubbing: the context may still be in the raw session records.

### Codex App browser bridge (experimental)

When botmux runs Codex over the app-server protocol, it doesn't get Codex App's built-in Chrome tool. `codexBrowser` fills that gap: new sessions can drive Chrome / Edge through the locally installed Codex browser plugin. Toggle it in Dashboard "Bot Config → Advanced → Codex App".

```json
{ "cliId": "codex-app", "codexBrowser": true }
```

Full form:

```json
{ "codexBrowser": { "enabled": true, "family": "chrome", "autoApproveOrigins": true } }
```

| Field | Description |
|------|------|
| `family` | `chrome` or `edge` |
| `pluginRoot` | Custom plugin directory (absolute path); when set, only this one is used. Usually not needed; by default the newest complete version is picked from the official plugin cache under `CODEX_HOME` (or `~/.codex`) and the plugin bundled with the Codex / ChatGPT desktop app |
| `autoApproveOrigins` | Stop asking for approval site by site when visiting HTTP/HTTPS sites. Off by default; login credentials, uploads/downloads, browsing history and full devtools access are not covered, and nothing is saved as "always allow" |

Requirements and limits:

- The Codex browser extension must be installed and enabled in Chrome / Edge for the same OS user, and the browser runtime that ships with the Codex desktop app must be installed. If the runtime is in a non-default location, point to it with the `BOTMUX_CODEX_NODE_REPL_PATH` environment variable.
- Actions that need confirmation (site access, upload, download) become Feishu approval cards. Only people who can talk to the bot can choose "Allow for this session / Always allow / Deny". Denial, timeout or an unreachable daemon all count as deny.
- The tool doesn't expose arbitrary JavaScript, raw CDP, cookies, local storage, browsing history or the clipboard. Secure sign-in flows that need a password are never downgraded to an ordinary Feishu card.
- Sessions that are already running must be restarted or resumed to load the new tool.
- Can't be combined with `existingAppServer`, `sandbox` or `readIsolation`; conflicts fail at startup.

## Working directory

| Field | Description |
|------|------|
| `workingDir` | Default working directory; comma-separate several. botmux looks downward from here for git repos (up to 3 levels), never upward |
| `workingDirs` | Array form, e.g. `["~/a", "~/b"]`; takes priority over `workingDir` when set |
| `defaultWorkingDir` | New topics open straight in this directory and skip the repo picker card (unless there's an oncall binding or another bot in the same chat is already working in a directory). You can still switch with `/cd` |
| `defaultWorkingDirAutoWorktree` | Together with `defaultWorkingDir` (must be a git repo): each new session first gets its own worktree based on the remote default branch. Falls back to `defaultWorkingDir` if that fails |
| `botToBotSameDir` | On by default: when the bot is @-mentioned into a topic where another bot is already working, it reuses that directory instead of showing the repo picker. Set `false` to turn off |

## Sessions and runtime

| Field | Description |
|------|------|
| `backendType` | Session backend: `tmux` (default), `zellij` (≥ 0.44), `herdr`, `zmx`, `pty`. If a persistent backend like tmux isn't available on the machine, you get a card asking you to install it; botmux never silently falls back to pty. `pty` is used only when set explicitly, and its sessions don't survive a daemon restart. See [tmux backend](/en/tmux), [ZMX backend](/en/zmx) |
| `launchShell` | Shell used to launch the CLI, overriding the daemon's `$SHELL`. Use `zsh` / `bash` / `fish` / `sh` or an absolute path. For when the login shell's rc file does something like `exec zsh` and the session never starts (you see `parse error` in the terminal). Once set, put PATH, nvm and so on in that shell's rc file (`~/.config/fish/config.fish` for fish). Applies to new tmux / zellij / zmx sessions |
| `lang` | UI language `zh` / `en`; falls back to the `BOTMUX_LANG` / `LANG` environment variables |
| `p2pMode` | DM mode: `chat` (default, one continuous session), `thread` (each DM message starts its own session), `group` (each DM message gets its own session group). See [Group modes](/en/group) |
| `regularGroupReplyMode` | Default reply shape after @bot in regular groups: `chat-topic` (default: top-level @-mentions share one continuous session, and each native topic opened in the group gets its own session), `chat` (the whole group shares one session, native topics fold into it too), `new-topic` (each @ opens a topic), `shared` (replies go in a topic but share one session). Override per group with `/reply-mode`. See [Slash commands](/en/slash-commands) |
| `regularGroupMentionMode` | When an @ is required: `always` (default), `topic`, `never`, `ambient`. Override per group with `/mention-mode`. See [Mention mode](/en/mention-mode) |
| `maxLiveWorkers` | Max sessions kept live at once, default 30. Beyond that, the least recently used sessions are suspended (background processes exit to free memory; the next message resumes them) |
| `idleSuspendMinutes` | Suspend a session after it has been idle this many minutes. Unset by default, meaning idle sessions never time out |
| `env` | Environment variables for this bot's sessions, `{ "KEY": "value" }`. See [GLM / third-party providers](#glm-provider) above and [Session environment](#session-env) below |
| `envUnset` | Inherited variable names to remove from this bot's sessions, e.g. `["HTTPS_PROXY"]`. `PATH` / `HOME` and botmux-reserved variables can't be removed |
| `envPolicy` | Process environment inheritance. Inherits the host environment by default; `strict` keeps only a baseline plus the names you list. See [Strict process environment](#strict-env) below |
| `sessionOwnerReminder` | When a topic session stays in a "waiting on a person" state, periodically @-mention the session owner in the topic. Off by default. See below |
| `noProgressNotify` | Post a reminder in Feishu when a turn shows no confirmed progress for a long time. On by default for Codex App (90 seconds); Codex CLI must opt in. See below |

### Waiting and no-progress reminders {#reminders}

**`longTaskReminder`** sends an independent status card to the original chat or topic while an executing task remains unfinished. Configure it in **Bot Defaults → Message cards → Long-running task cards**; saves apply immediately.

```json
{"longTaskReminder": {"enabled": true, "thresholdMinutes": 10, "intervalMinutes": 10}}
```

Disabled by default. Both windows default to 10 minutes and accept integers from 1 to 10080. Timing starts at the observed native execution write, excluding queued and idle time. Progress and follow-up messages do not reset the running turn. Scans run every 30 seconds; repeats start at the previous successful delivery and missed cycles are not replayed. Failed sends retry after one minute using the same delivery ID. Completion, cancellation, worker exit or session closure stops reminders. Chat, DM and topic sessions are supported; document comments and headless sessions are excluded. Silent, meeting-driven and suppressed replay turns keep their auxiliary-UI restrictions; reminder cards do not invoke `outbound.send` hooks. Preferences persist, but execution timing requires a current worker observation and is never inferred across daemon restarts.

**`sessionOwnerReminder`**: when a session sits in a state that needs a person and nothing changes, it @-mentions the session owner in the original topic at a fixed interval.

```json
{
  "sessionOwnerReminder": {
    "enabled": true,
    "intervalMinutes": 30,
    "text": "This session is waiting for you. Please follow up.",
    "states": ["idle", "dormant", "pending_repo", "tui_prompt", "agent_attention", "limited"]
  }
}
```

| Field | Description |
|------|------|
| `enabled` | Turn it on; off by default |
| `intervalMinutes` | Reminder interval in minutes, default 30, range 1–10080 |
| `text` | Reminder text, up to 500 characters, no `<at>` tags |
| `states` | Which states trigger reminders: `idle` (CLI idle), `dormant` (session suspended), `pending_repo` (waiting for a repo choice), `tui_prompt` (waiting for a terminal choice), `agent_attention` (the agent asked for a person), `limited` (quota limited). Pick at least one when enabled |

- Only sessions split by topic are reminded (topic groups, topics inside regular groups, and DMs with `p2pMode: "thread"`). A session shared by a whole group or a whole DM is not reminded. The session needs an owner.
- While the state stays the same, it reminds once every `intervalMinutes`; a state change or a new message in the session restarts the timer.
- When writing it by hand, include all four fields. A missing or invalid field makes the whole block count as unset (that is, off).

**`noProgressNotify`**: posts a reminder card when a turn shows no confirmed progress for a long time. It's only a reminder: it never restarts, interrupts or retries the task.

| Field | Description |
|------|------|
| `enabled` | Default `true`. `false` only mutes the Feishu reminder; the stalled state in the Dashboard and the `session.requires_attention` [hook](/en/hooks) still work |
| `cliEnabled` | Codex CLI only: `true` turns reminders on; off by default. Once on, it reminds at `timeoutMs` (default 5 minutes) and again at 15 minutes (or 3x `timeoutMs`, whichever is larger) |
| `timeoutMs` | Threshold for the first reminder (ms), integer, range 10000–3600000. Codex App defaults to 90000 (90 seconds) |

- Codex App has it on without any config; Codex CLI needs `{"cliEnabled": true}`. Other CLIs are unaffected.
- `timeoutMs` applies from the next worker process. While the session waits on a person (ask card, terminal choice, agent attention request), the Codex CLI timer pauses.

## Permissions and authorization

For the full permission model see [Permissions](/en/permissions).

| Field | Description |
|------|------|
| `allowedUsers` | Admin list: can run admin commands and press card buttons. Prefer full email, phone number or `on_xxx`. An `ou_xxx` is only valid for the app that issued it, so don't copy it from another bot. If `allowedChatGroups` is set, you need at least one admin |
| `ownerOpenId` | Explicit primary admin `ou_xxx`. Only counts while it is still in `allowedUsers`; defaults to the first person in `allowedUsers` |
| `allowedChatGroups` | Groups (`oc_xxx`) where anyone can talk to the bot. Admin actions still require `allowedUsers` |
| `p2pOpen` | `true` lets anyone within the Feishu app's availability scope DM the bot (talk only). Groups are unaffected |
| `oncallChats` | Oncall bindings: `[{ "chatId": "oc_xxx", "workingDir": "~/projects/foo" }]`. See [Oncall](/en/oncall) |
| `defaultOncall` | Auto-bind oncall on the first new topic in a new group: `{ "enabled": true, "workingDir": "~/foo", "since": <epoch ms> }`. Groups that existed before `since` are unaffected |
| `blockedUsers` | Blocklist (same formats as `allowedUsers`). Applies in groups and DMs and beats every allow rule; blocked people don't trigger access request cards. Admins can't be blocked |
| `globalGrants` / `chatGrants` | Per-person talk grants (global / per group). Usually written by `/grant` cards and kept in the grant store, see [Grant store](#grant-store) below |
| `messageQuota` | `{ "defaultLimit": N }`: how many messages a guest let in by a grant card can send; 3 if not set. Oncall groups have no quota; `/grant @user N` always uses N |
| `grantDefaultDurationMs` | Default validity of new grant cards (ms); 1 hour if not set |
| `restrictGrantCommands` | `true`: people allowed in only by a per-person grant can't use any slash command, just chat |
| `canTalkDaemonCommands` | Open the listed botmux commands (e.g. `/status`) to anyone who can talk to the bot; by default they're admin-only. See [Slash commands](/en/slash-commands) |
| `autoGrantRequestCards` | On by default: when someone without access @-mentions the bot, send an access request card to the admins. `false` ignores them silently |
| `grantRequestToOwnerDm` | Off by default. With `true`, if nobody in the conversation can act on the request card (e.g. no admin in the group, or a blocked DM), the card goes to the primary admin's DM instead |
| `trustSameOwnerBots` | On by default: other bots on this machine with the same admins can run admin commands, and people they name when @-mentioning this bot get talk access in that group. With `false`, same-machine bots can only talk |
| `grantDelegateBots` | Extra external bots to trust (`ou_` or `cli_`). When a listed bot @-mentions this bot, people named in the same message get talk access in that group (talk only). Empty by default |
| `acceptSlashFromBots` | On by default: accept slash commands sent by other bots via `botmux send --slash`. With `false` those messages are treated as plain text. Humans are unaffected |
| `allowArbitraryMention` | Off by default. When on, the model can `botmux send --mention` anyone in the group (membership is checked), not just the person who sent this turn |
| `autoInviteOwnerOnGroupAdd` | On by default: when the bot is added to a new group, it pulls the primary admin in too. Set `false` for cases like alert platforms creating many incident groups |

## File sandbox and credentials

Details in [File sandbox](/en/sandbox).

| Field | Description |
|------|------|
| `sandbox` | `"oncall"` (or `true`): allowlist isolation, the agent can only read and write the project and its own home; `"scratch"`: throwaway draft, the agent can read the whole machine but every write goes to a temporary layer; `false` / `"off"`: no isolation |
| `sandboxPaths` | Extra paths under allowlist isolation: `{ "readWrite": [...], "readOnly": [...], "deny": [...] }`. Legacy `sandboxHidePaths` and `sandboxReadonlyPaths` are still read and migrated automatically at startup |
| `scratchStorage` | `scratch` only: `"tmpfs"` (default, in memory, gone on restart) or `"disk"` (on disk, can resume after a daemon restart) |
| `scratchTmpfsSizeMb` | `scratch` + tmpfs only: size cap in MB; default `0` uses the kernel default (about half of RAM) |
| `scratchDenyPaths` | `scratch` only: extra paths to hide. botmux's own credentials are always hidden |
| `sandboxNetwork` | Default `true` keeps network access; `false` cuts ordinary outbound network |
| `sandboxNetworkPolicy` | Advanced network policy that filters target IPs separately for public and private ranges |
| `credentialsSourceDir` | A sandboxed bot copies its CLI login from this directory on every start, instead of the machine's shared login. Useful for several accounts on one machine |
| `codexAuthSync` | Codex login policy: `shared` (default) uses the global login; `isolated` always uses this bot's own `CODEX_HOME` and never reads or copies global credentials |
| `triggerUserAuth` | Off by default. When on, tools such as `lark-cli` in the session run with the authorization of the person who sent the message; people who haven't authorized get an authorization link |
| `larkToolBinding` | On by default: `lark-cli` in the session uses the current bot's app identity, and `--as user` / `--profile` can switch. `false` injects no bot credentials at all |

> The ZMX backend can't enforce the file sandbox; sandboxed combinations are refused at startup. See [ZMX backend](/en/zmx).

### Protected local MCP capabilities

A local stdio MCP server can request one optional protected capability in its plugin-private `mcp/index.json`. The capability ID is opaque to Botmux; use a non-business-specific fixture such as:

```json
{
  "transport": "stdio",
  "command": ["node", "./mcp/server.js"],
  "protectedCapability": "fixture.secret.v1"
}
```

`protectedCapability` is not supported for streamable HTTP MCP servers; a plugin descriptor that combines them is rejected. The descriptor does not supply the secret source, principal policy, or containment rules; those bindings come only from machine-level configuration.

Within `bots.json`, the `plugins` array only enables installed plugins for that bot:

```json
{
  "plugins": ["fixture-plugin"]
}
```

Do not put protected capability bindings, secret sources, secret values, or rollout state in `bots.json`. Operators bind the opaque capability ID in the machine-level `~/.botmux/config.json`:

```json
{
  "protectedMcpCapabilities": {
    "fixture.secret.v1": {
      "enabled": false,
      "allowedPluginIds": ["fixture-plugin"],
      "secret": {
        "source": "file",
        "path": ".botmux/secrets/fixture-protected-secret"
      },
      "principal": "verified-human-email",
      "containmentProfile": "local-stdio-secret-v1",
      "isolation": {
        "protectedHomePaths": [".fixture-credential"],
        "redactEnv": ["FIXTURE_AUTH_TOKEN"]
      }
    }
  }
}
```

Missing `enabled` defaults to disabled; only JSON boolean `true` enables the binding. Non-boolean values such as `"true"` or `1` reject the entire record. Secrets support only `{ "source": "file", "path": "<Home-relative path>" }`, rooted at the daemon account's trusted Home. Absolute paths, `.`/`..` components, and symlinks are rejected. Operators must preprovision a nonempty regular file owned by the current user with exact mode `0600`, at most 64 KiB. Botmux never repairs unsafe files and never captures or caches secrets at daemon startup. It reads the file before each new worker fork, pinning directory fds and opening each component without following symlinks so an intermediate replacement cannot redirect the read.

The secret reaches an authorized MCP only through the one-shot fd channel, never argv, generic environments, or logs. Rotation takes effect on the next worker fork; an existing MCP retains its startup secret until that session is recreated. Every valid configured secret file is automatically denied in all relevant session sandboxes, including bots without the matching plugin and disabled capabilities. Additional `protectedHomePaths` remain scoped to matching plugins. Current configuration supplies the `redactEnv` names and recognizable valid names from rejected legacy `source: "env"` records for worker, model, and generic plugin environment redaction; legacy environment sources grant no write capability. Machine configuration changes follow the global configuration's short cache refresh rules.

At MCP process startup, Botmux uses the ordinary stdio transport without a protected secret file descriptor if the capability is disabled or not provisioned, the plugin is outside `allowedPluginIds`, the configured containment prerequisites are not satisfied, or the daemon cannot provide the one-shot channel. The server can still start and expose read-only tools. A `tools/call` on that connection receives neither `botmuxTrustedPrincipal` nor `botmuxGrantedCapabilities`; the plugin must fail closed for protected writes.

`principal` is evaluated for each `tools/call`, not when the MCP process starts. If the global binding, plugin allowlist, containment prerequisites, and daemon channel all succeeded at startup, the long-lived process may already hold the one-shot secret even when a later call lacks its required verified human principal or other call-time grant condition. Botmux omits `botmuxTrustedPrincipal` and `botmuxGrantedCapabilities` from that call, and the plugin must reject the protected write. For **every** protected write, the plugin must freshly validate `botmuxTrustedPrincipal` and confirm that `botmuxGrantedCapabilities` contains the exact capability ID. It must never cache or reuse a principal, capability, or authorization result from an earlier call; any missing, mismatched, or stale field must fail closed. Isolation paths and environment redaction remain active for a matching enabled plugin even while the capability itself is disabled.

To migrate legacy environment secrets, provision the safe file and change the configuration to `source: "file"`, then remove the old variable from the daemon launch source and restart the daemon. Deleting `process.env` cannot erase an old process's `/proc/<pid>/environ`. Before adding or changing secret paths, terminate and recreate old CLI sessions so their file denies cover the new paths; a hot update cannot revoke access already granted to old processes. Prefer rotation via atomic replacement at a fixed protected path. Protected files or other isolation requirements disable bare-host one-shot title generation and retain placeholder titles; ordinary session reads are unaffected.

A restarted stdio MCP process currently cannot receive the one-shot secret again and falls back to read-only; recreate the session to restore protected capabilities. User-visible errors from the different policy collection entry points remain a follow-up.

### Run CLI calls as the message sender (`triggerUserAuth`) {#trigger-user-auth}

**Off by default.** When on, `lark-cli` / `bytedcli` in this bot's sessions run with the authorization of whoever sent the current message, not whatever is logged in on the machine. Useful when several people share one bot: each message reads docs, checks calendars or calls internal platforms as its own sender.

Pick one way to turn it on. It **takes effect for new sessions** (`/restart` an existing one):

- **Dashboard**: **Bot Config → Security → Trigger-user auth**, switch on **Run CLI calls as the message sender** and tick the tools it should cover.
- **In Lark** (admins): `/botconfig set triggerUserAuth {"enabled":true,"tools":["lark-cli","bytedcli"]}`; turn it off with `/botconfig unset triggerUserAuth`.
- **bots.json**:

```json
"triggerUserAuth": { "enabled": true, "tools": ["lark-cli", "bytedcli"] }
```

Rules:

- Only `"enabled": true` turns it on. Leaving out `tools` covers every tool; an unknown tool name is an error rather than a silent downgrade.
- When someone who hasn't authorized makes a call, the command is refused and the refusal carries an authorization link. The AI can also send that person a link itself with `botmux auth request` (see [Agent-initiated authorization](/en/cli-commands#agent-auth-request)), or ask them to send `/login` in the topic. Retry after authorizing.
- It never falls back to running as the bot or as anyone else. `bytedcli` has no bot identity, so an unauthorized call simply fails.
- Optional fields: `credentialSource` (`auto` by default / `platform` [central platform](/en/platform) only / `local` local QR login only), `delegateOnMention` (default `true`, see [Carry the sender over on @ handoffs](/en/permissions#delegate-on-mention)), `gitHost` (git pushes to that code host also authenticate as the current turn's sender).

#### Upgrade note: old-format authorizations need a fresh `/login` {#legacy-user-token}

Since v3.20, the Lark user authorizations botmux stores itself are kept per app and per authorizing person (`~/.botmux/data/user-token-<appId>-<openId>.json`). The older files (`user-token-<appId>.json`, `user-token.json`) don't say who authorized them, so nothing that has to act as a specific person uses them any more.

A bot that only has an old-format authorization loses those user-identity features. **Have the person send `/login` once in a topic** to restore them. `/login` only refreshes the stored authorization; running CLI calls as the sender still has to be turned on separately as described above.

## Cards and terminal

What the cards look like and what each switch does: see [Live streaming cards](/en/cards).

| Field | Description |
|------|------|
| `replyCardMode` | `legacy` (default): progress and answer are sent separately; `unified`: a turn's progress, tool calls and final answer all update one card. Works for non-sandboxed Claude Code / Codex / Grok / TraeX / Pi / Kimi sessions, from the next turn |
| `replyCardShowTools` | `unified` only: `false` hides tool calls on the card; thinking summaries and progress still show |
| `disableStreamingCard` | `true` stops sending the live terminal status card. The web terminal still runs and final answers are still sent |
| `hiddenStreamingCardButtons` | Hide buttons on the live card: `output`, `terminal`, `writeLink`, `compact`, `stop`, `close`. E.g. `["terminal", "writeLink", "close"]`. Also `/botconfig set hiddenStreamingCardButtons terminal,close` |
| `pinStreamingCard` | `true` pins the current live status card; off by default. A failed pin doesn't affect anything else. Turn it off for one group with `/card pin off` |
| `cotEnabled` | On by default: show the model's thinking and tool calls live as a native Feishu "thinking" message. Turn off for one group with `/cot off` |
| `usageDisplay` | Where Context / Token usage shows: `streaming` (default, live card body), `footer` (answer card footer), `off`. Display only; usage accounting is unaffected. Legacy `showUsageInCardFooter: false` means `off` |
| `cardFooterExtension` | Append a few custom text segments after the usage, produced by a command you configure: `{"command": "<command>", "refreshSeconds": 60}`. The command runs via `/bin/sh -c`, one copy per bot; `refreshSeconds` defaults to 60, range 10–3600. Output is read line by line (or as `{"segments": [...]}`), up to 4 segments of up to 40 characters each. A command that takes over 3 seconds counts as failed; failures keep the last result, and after 10 minutes without a success the text is hidden. See [Live streaming cards](/en/cards) |
| `brandLabel` | Card signature. Empty shows the default `botmux` link; `""` hides it; any other text is shown as-is (markdown allowed). If the master switch in Dashboard "Global Settings → Feishu cards" is off, no bot shows a signature |
| `replyCardActions` | Show a compact action menu (open terminal / switch model / close session) on ordinary answer cards. Off by default |
| `askOptionLayout` | Layout of `botmux ask` option buttons: `compact` (default, wraps) or `vertical` (one per row, easier for long options) |
| `writableTerminalLinkInCard` | `true` puts a writable terminal link directly in the card (anyone who can see the card can drive the terminal). By default it's behind a "get write link" button and sent privately to whoever clicks |
| `privateCard` | `true` makes `/card` send a private card visible only to admins; regular groups only, and it doesn't refresh live |
| `silentTurnReactions` | `true` stops adding the GoGoGo / ✅ reactions in sessions with the live card turned off |
| `receivedReactionEmoji` / `doneReactionEmoji` | Replace the "received" / "done" reactions (Feishu emoji_type); defaults `GoGoGo` / `DONE`. Setting both to the same value avoids an early ✅ when a CLI is judged idle too soon |
| `feedback` | Collect "usable / progress / wrong" feedback on final answer cards; off by default. See [Final answer feedback](#feedback) below |

In Dashboard "Bot Config → Message Cards → Live card buttons" you can tick which buttons to show:

![Live card button settings](/img/streaming-card-button-settings.png)

### Answer card footer

The footer is the small line at the bottom of an answer card: signature, model, usage, recipients, voice button and so on. Each part can be toggled on its own, in Dashboard "Bot Config → Message Cards" or with `/botconfig set <field> on|off`.

![Reply card footer settings in the Dashboard](/img/reply-footer-settings.png)

| Field | Default | Controls |
| --- | --- | --- |
| `replyFooterEnabled` | on | Master switch for the whole footer (including the divider and voice button) |
| `replyFooterBrand` | on | Brand signature, still subject to `brandLabel` and the global signature switch |
| `replyFooterModel` | on | Model name, reasoning effort and backend tier |
| `replyFooterUsage` | on | Usage in the footer; only shows with `usageDisplay: "footer"` |
| `replyFooterRecipients` | on | "Sent to" and its @ notification; @-mentions in the body are unaffected |
| `replyFooterVoice` | on | The "voice summary" button when a voice service is configured |
| `showReplyTiming` | off | Wait and run time; omitted when no reliable timing is available |

- Turning the master switch off doesn't clear the individual settings; turning it back on restores them. If every part is off or empty, the footer and divider are left out entirely.
- Changes apply to new answers; cards already sent stay as they are. After editing `bots.json` by hand, restart the daemon.

### Final answer feedback {#feedback}

With `feedback.enabled: true`, final answer cards get three buttons (default "Conclusion usable / Effective progress / Conclusion wrong") with three fixed meanings, `positive / progress / negative`. Button labels, styles, order, the follow-up reasons after "wrong" and the comment box are all configurable.

```json
{
  "feedback": {
    "enabled": true,
    "visibleSemantics": ["positive", "progress", "negative"],
    "buttons": [
      { "key": "conclusive_usable", "label": "Conclusion usable", "semantic": "positive", "style": "primary" },
      { "key": "effective_progress", "label": "Effective progress", "semantic": "progress", "style": "default" },
      { "key": "incorrect", "label": "Conclusion wrong", "semantic": "negative", "style": "danger" }
    ],
    "negativeFollowup": {
      "reasons": [{ "key": "wrong_result", "label": "Wrong conclusion or result" }],
      "comment": { "enabled": true, "required": false, "maxLength": 1000 }
    }
  }
}
```

Edit it visually in Dashboard "Bot Config → Message Cards → Final answer feedback", or with `/botconfig set feedback '<json>'`. By default feedback is stored locally in `botmux-feedback.sqlite` and can be reviewed on the Dashboard "Feedback" page. To switch to PostgreSQL or migrate the data, see [Feedback storage & migration](/en/feedback-storage). Implementation notes: [`docs/feedback-capability-current-implementation.md`](https://github.com/deepcoldy/botmux/blob/master/docs/feedback-capability-current-implementation.md).

## Reply delivery and prompt injection

| Field | Description |
|------|------|
| `replyDelivery` | How the final answer reaches Feishu. `send` (default for every CLI except Doubao): the model runs `botmux send` itself; `transcript`: botmux takes the turn's last answer from the CLI's session record and sends it. See below |
| `senderTag` | On by default: every message forwarded to the CLI carries a `<sender ... />` tag saying who spoke. Only `false` turns it off |
| `senderTagHideEmail` | Off by default. When on, the `<sender>` tag leaves out the email; name and ID stay |
| `hideLocalAddresses` | Off by default: model replies reach Feishu as written. When on, host paths and local service addresses are kept out of replies. See [Hide development host addresses](#hide-local-addresses) below |
| `promptInjection` | `"default"` (default) or `"none"`. `none` is zero-injection mode: botmux adds no system prompt or reminders, passes only the task and attachments, and forwards the final answer automatically. See below |
| `envelopeInjection` | Claude Code only: `auto` moves the per-turn reminder into a hook, so the terminal input box shows only the message itself. Default `off` keeps it as is |
| `topicUnavailablePolicy` | What to do when the original topic is deleted or unavailable. See [Topic unavailable policy](/en/topic-unavailable-policy) |
| `turnResults` | Structured per-turn results for external systems to read. See [Turn results](/en/turn-results) |

### Transcript replies (`replyDelivery: "transcript"`)

Doubao defaults to `transcript` (its tool commands run in an account-wide resident process, so a model-run `botmux send` can land in the wrong topic; see [CLI Adapters](/en/adapters)). Every other CLI defaults to `send`, where the model has to run `botmux send` to post its answer to Feishu. With `transcript`, botmux takes the turn's last answer from the CLI's session record and sends it; the model just answers.

Three things change:

1. The system prompt no longer teaches `botmux send`. When the model really needs it (attachments, mentioning another bot), it can find out how through the built-in `botmux-send` skill.
2. No more `<botmux_reminder>` each turn.
3. In DMs, or 1:1 groups with only the admin and this bot, messages are no longer wrapped in `<user_message>` and `<sender/>`; the model sees the raw text.

Supported CLIs: Claude Code, Codex, TraeX, CoCo, Hermes, MTR, Pi, Oh My Pi, ebsd, Grok, Cursor, Doubao. Antigravity only captures answers in zero-injection mode, so setting it explicitly is rejected; if you later switch to an unsupported CLI, runtime falls back to `send` and no answer is lost. Cursor and Doubao don't support transcript under `sandbox: "scratch"` (setting it is rejected and the default falls back to `send` at runtime); the oncall sandbox is unaffected.

```text
/botconfig set replyDelivery transcript   # turn on
/botconfig set replyDelivery send         # explicitly use botmux send (not recommended for Doubao)
/botconfig unset replyDelivery            # back to default
```

- Per-turn reminders and wrappers change from the next turn. The system prompt is set when a session starts, so running sessions need `/restart`.
- Trade-off: 1:1 sessions lose the `<user_message>` / `<sender>` structure, so `/adopt` no longer recognizes them as botmux's own sessions.
- The Dashboard "Transcript reply mode" switch writes this field; it's greyed out when the current CLI doesn't support it.

### Turning off the sender tag (`senderTag: false`)

Without it the model can't tell who is speaking: in multi-person sessions it can't tell speakers apart or address people by name. Useful for CLIs that copy the tag into their replies, or when you don't want each message's identity in the CLI's records.

```text
/botconfig set senderTag off
/botconfig set senderTag on
```

- Applies from the next turn; queued messages and history are not changed.
- `botmux send --mention-back` (mention the person who sent this turn) is unaffected; it uses the daemon's own record of who triggered the turn.
- Trade-off: Dashboard session insights can no longer tell the sender type from the tag, and `/adopt` loses one clue for recognizing botmux sessions.
- The Dashboard "Speaker Tag" switch writes this field.

### Hide development host addresses (`hideLocalAddresses`) {#hide-local-addresses}

Feishu users read replies in their own client and cannot open files or services on the development host. Turn this on for a bot other people use; keep the default (off) for a bot only you use whose replies should show troubleshooting paths.

```text
/botconfig set hideLocalAddresses on
/botconfig set hideLocalAddresses off
```

When off (the default), replies and cards are sent as written and no related rule is added to prompts. When on:

- Before model output reaches Feishu (`botmux send`, the automatically forwarded final answer, unified reply cards, native thinking messages and document comment replies), absolute host paths, local schemes such as `file://` and local service addresses are replaced: source files under the working directory become repository-relative paths, everything else becomes an internal-file label, and skill links keep only their name. System paths that name no user file, such as `/dev/null` and `/proc`, stay.
- The system prompt gets the full rule once per session and every turn's reminder gets one sentence, asking the model to leave such addresses out and deliver files as attachments or reachable links.
- A card whose button or link points at this host is refused and the model gets `LOCAL_ADDRESS_OUTBOUND_REJECTED`; botmux's own Web terminal and Dashboard links are sent as usual.
- Reply processing and the per-turn reminder apply immediately; the full rule in the system prompt applies from the next new session.
- The Dashboard switch "Bot Config → Message Cards → Development host addresses" writes this field.

### Zero prompt injection (`promptInjection: "none"`)

For multi-agent pipelines where a lead bot hands out work and sub-bots just execute, or whenever you don't want botmux adding anything to the prompt.

To turn it on:

1. Dashboard: enable "Zero injection" in "Bot Config → Advanced".
2. `bots.json`: set `"promptInjection": "none"` on the bot; set `"default"` or remove the field to go back.

What happens:

- **Only the task and attachments are passed**: no botmux system prompt, per-turn reminders, identity info, role, whiteboard, memory or skill catalog. The CLI's own system prompt and the project's `AGENTS.md` are still handled by the CLI.
- **Answers are forwarded automatically**: the final answer is taken from the CLI's session record and sent back to Feishu, mentioning the person who sent the task by default. Names of other bots in the group (like `@Reviewer`) become real Feishu mentions.
- **Supported CLIs**: Claude Code, Codex, TraeX, CoCo, Hermes, MTR, Pi, Oh My Pi, ebsd, Grok, Cursor, Doubao, Antigravity. Local backends only: tmux / pty / zellij / herdr / zmx (Antigravity doesn't support zmx). Cursor and Antigravity don't support the `scratch` sandbox. Remote backends and v3 workflows are not supported yet.

Technical details: [`docs/zero-prompt-injection.md`](https://github.com/deepcoldy/botmux/blob/master/docs/zero-prompt-injection.md).

## Proactive start

By default a bot only starts working when @-mentioned. These fields make it more proactive; all of them can be set under "Proactive Start" in Dashboard "Bot Config → Common → Default Working Directory".

| Field | Description |
|------|------|
| `autoStartOnNewTopic` | `true`: in topic groups, the first message of every new topic starts a session without an @ (no effect in regular groups) |
| `autoStartOnGroupJoin` | `true`: when the bot is added to a new group that contains an admin, it starts working right away. Subscribe the app to the `im.chat.member.bot.added_v1` event in the Feishu developer console |
| `autoStartOnGroupJoinPrompt` | First task when auto-starting on group join. If empty, the bot looks at the group's context first and reports that it's ready if nobody has assigned anything |
| `autoStartOnGroupJoinSeed` | Text of the opening message posted on join; a built-in text is used if empty |
| `autoStartOnGroupJoinGateRequired` | `true`: auto-start on join also needs a matching `chat.bot_added` sync [hook](/en/hooks) to explicitly allow it, otherwise nothing happens. Useful when only specific groups should auto-start |
| `autoStartOnGroupJoinAnchor` | Where the join session lives in a regular group. Default `"reply-mode"` follows the group's reply mode; `"latest-message"` skips the opening message and starts the session in the thread of the newest existing message (system events, recalled messages and this bot's own messages are skipped). Useful when another platform posts a context message and then adds the bot. Falls back to the default when there is no usable message or the read fails. Topic groups and `new-topic` mode are unaffected. Anchoring on a message sent by another bot (e.g. a platform card) also requires the `im:message.group_msg.include_bot:read` scope; without it only user messages are listed |
| `autoStartExcludedChats` | Groups where auto-start (join and new topic) never happens; @-mentions still work |
| `groupJoinCommandEnabled` / `groupJoinCommand` | When the bot is added to any group, run a command on this machine directly: no session, no model. Independent of `autoStartOnGroupJoin`, and no admin needs to be in the group. Also needs the `im.chat.member.bot.added_v1` subscription |

`groupJoinCommand` runs the same way as [Hooks](/en/hooks):

- No shell; for pipes or redirects write `bash -c '…'`. Only a minimal set of environment variables is passed (no app secrets).
- stdin receives JSON `{event:"chat.bot_added", larkAppId, chatId, operatorOpenId, emittedAt}`; the environment variables `BOTMUX_JOIN_CHAT_ID` / `BOTMUX_JOIN_LARK_APP_ID` / `BOTMUX_JOIN_OPERATOR_OPEN_ID` are also set.
- It's killed if it hasn't finished after 10 minutes.

### Welcome message (`welcomeMessage`) {#welcome-message}

Set it to some text and the bot DMs its primary admin (see `ownerOpenId`) once after it first comes online. Set it with `--welcome-message "…"` or `--welcome-message-file <file>` on `botmux setup add` / `botmux setup edit`; `--welcome-message -` on edit clears it. It can't be edited in the Dashboard yet. The value of `--welcome-message` is always sent as written, so text starting with `@` is never treated as a file path.

- Delivery is recorded in `welcome-sent/<AppID>.json` under the daemon data dir. Once sent, restarts don't resend it, and neither does changing the text. Deleting that file makes it send again, but Feishu dedupes a resend less than 1 hour after the previous one.
- A failed send, or an admin who can't be resolved yet, doesn't block startup; the next start retries.
- Core-only (`apiOnly`) bots and multi-replica deployments (`BOTMUX_COORDINATION_MODE=primary`, where replicas don't share the delivery record) don't send it; the daemon log says why.

## Group message listener {#message-listener}

Have the bot watch a group: matching messages start a session without an @. The typical use is **alert handling**: your monitoring system already posts alerts to a group through its own bot. Add this bot to that group, turn on the listener, and every alert gets investigated automatically, with no [Webhook](/en/webhook) needed.

The recommended place is the Dashboard "Message Listener" page:

- **Global listener settings**: one set of rules applied to every group this bot is in, including groups it joins later.
- **Group listener settings**: each group can "Use global settings", "Turn off listening" or use "Custom settings".
- You can **preview** which messages from the last 24 hours would match, and do a **trial run** (the bot really replies in the group).

In `bots.json` this maps to two fields:

| Field | Description |
|------|------|
| `globalMessageListener` | The global rule, a listener config as described below |
| `groupMessageListenerOverrides` | Per-group exceptions keyed by `chat_id`. Either `{ "mode": "disabled" }` (don't listen in this group) or `{ "mode": "custom", "listener": { ...listener config } }` (use this group's own rule) |

The legacy `messageListeners` field (keyed by `chat_id`) is still read and treated as per-group custom rules.

A listener config contains:

| Field | Description |
|------|------|
| `enabled` | Whether it's on. `prompt` is required when enabled |
| `prompt` | Tells the bot which messages to handle and how to reply |
| `name` | Optional name shown in the Dashboard |
| `replyCardTitle` | Optional reply card title |
| `workingDir` | Optional working directory for the sessions it starts; defaults to the bot's |
| `replyPolicy.mode` | `thread` (default): reply in a new topic under the matched message; `chat`: reply directly in the group |
| `autoCloseAfterCompletion` | `true` closes the session once the task completes successfully |
| `senderPolicy.mode` | `all_except_excluded` (default): handle every sender except the excluded ones; `include_only`: only handle senders in `includeSenderOpenIds` |
| `senderPolicy.includeSenderTypes` | Which senders: `["user"]`, `["bot"]` or both. **To listen to an alert bot you must include `"bot"`** |
| `senderPolicy.includeSenderOpenIds` / `excludeSenderOpenIds` | Exact senders to include / exclude by `open_id` |
| `senderPolicy.excludeSelf` | Default `true`: always ignore the bot's own messages, so it never triggers itself |
| `messagePolicy.includeMsgTypes` | Message types to watch; text and rich text (`post`) by default |
| `contentPolicy.includeKeywords` | Keyword filter, case-insensitive substring match |
| `contentPolicy.includeMentionedOpenIds` | Match on who the message really @-mentions (`ou_xxx`, open_ids as seen by this app) |
| `contentPolicy.matchMode` | `any` (default): any condition matches; `all`: every condition must match |
| `contentPolicy.resolveDocumentTitles` | Default `false`. When keywords don't match, look up the **title** of Feishu doc links in the message with the bot's identity and match against that (the body isn't read) |

```json
{
  "globalMessageListener": {
    "enabled": true,
    "name": "Alert listener",
    "prompt": "Every alert in this group is a production incident. Identify the affected service and suggest a first direction; if it's a false alarm, explain why.",
    "senderPolicy": { "mode": "all_except_excluded", "includeSenderTypes": ["bot"] }
  },
  "groupMessageListenerOverrides": {
    "oc_xxx_chat": { "mode": "disabled" }
  }
}
```

Good to know:

- **Only top-level group messages**: replies inside existing topics are ignored; messages that @ the bot go through the normal @ flow and don't trigger twice.
- **Each matched message starts its own session.**
- **Up to about 30 seconds of delay**: Feishu pushes some messages in real time; messages from other bots and messages that don't @ the bot are picked up by a history poll every 30 seconds. So for third-party alert bots, the default `all_except_excluded` plus `"bot"` is the safest choice: the history API may not return an `open_id` for third-party bots, so exact `open_id` matching can miss them.
- **Matching doc titles**: only HTTPS `docx` / `wiki` links. The app needs the published scopes `drive:drive.metadata:readonly` (read doc titles) and `wiki:node:read` (or `wiki:wiki:readonly`). Without permission, or if the bot can't see the doc, it falls back to the message text.

## Summary command

| Field | Description |
|------|------|
| `summaryRange` | How much history `@bot /summary` reads. `limit`: last N messages in regular groups, default 50; `sinceHours`: last N hours in regular groups, default 24. `0` means no limit on that dimension. Topic groups always read the current topic |
| `summaryMemory` | Off by default. When on, `/summary` writes the summary as a "problem solved" record appended to a memory file; later sessions can reuse the earlier conclusion when the key conditions match exactly |
| `summaryMemoryPath` | Memory file path, default `summary.md`. Relative paths are resolved from the current project root |

```json
{
  "summaryRange": { "limit": 50, "sinceHours": 24 },
  "summaryMemory": true,
  "summaryMemoryPath": "docs/summary.md"
}
```

- Only an explicit `@bot /summary` triggers a summary; keywords never do. The Dashboard "/summary range" settings write these fields.
- If there was an earlier `@same bot /summary`, this one only covers messages after it.
- With `summaryMemory` on, text after `/summary` marks the starting point: the summary starts at the most recent message containing that text. If it isn't found you get an error rather than a wider range. Such an explicit starting point can be older than `sinceHours`, so leave it out if you don't want old content read. With `summaryMemory` off, the text only tells the model what to focus on.
- If the sandbox is on and the memory file is outside the working directory, add its **existing parent directory** to `sandboxPaths.readWrite`, or the sandbox will block the write.

> `contentTriggers` (old keyword / regex triggers without @) no longer has any effect and is only parsed for compatibility with old files. Use `summaryRange` instead.

## Spend and budget {#budget}

botmux can estimate each bot's spend (in CNY) from token usage and send a DM when monthly spend crosses a budget line.

```json
{
  "pricing": {
    "usdCny": 7.2,
    "models": {
      "my-gateway-model": { "input": 3, "output": 15, "cacheRead": 0.3 }
    }
  },
  "budget": {
    "monthlyCny": 500,
    "alertThresholdPercent": [50, 80, 100]
  }
}
```

**`pricing`: how cost is calculated**

| Field | Description |
|------|------|
| `usdCny` | USD to CNY exchange rate, default 7.2 |
| `models` | Your own model prices, added to or overriding the built-in table. Keys are model names or model family prefixes (e.g. `claude-sonnet-4`). Prices are in **USD per 1M tokens**: `input` and `output` are required, `cacheRead` and `cacheWrite` are optional and fall back to the `input` price |

- Cost is only calculated when `pricing` is set. `{ "usdCny": 7.2 }` is enough to use the built-in table (common Claude, GPT and Gemini models).
- Models found in neither the built-in table nor `models` are not priced; botmux never guesses a price.
- Spend accumulates from when you turn it on; earlier usage is not counted.

**`budget`: monthly budget**

| Field | Description |
|------|------|
| `monthlyCny` | Monthly budget (CNY), must be positive. Missing or invalid turns the whole budget feature off |
| `alertThresholdPercent` | Alert lines (percent), default `[80]`. Each line alerts at most once a month; crossing several at once sends one alert, for the highest line |
| `hardStop` | Default `false`. `true` currently only adds a 100% alert line. It **does not block new tasks**; pause sessions yourself once over budget |

- Alerts are sent by DM to the primary admin set in `ownerOpenId`. Without `ownerOpenId` they only go to the log.
- Spend is counted per calendar month (UTC) and resets on the 1st.
- The budget relies on the amounts `pricing` produces: without `pricing`, spend stays at 0 and no alert ever fires.

## Voice

| Field | Description |
|------|------|
| `voice` | This bot's voice engine config, merged field by field over the global `voice` in `~/.botmux/config.json`. With usable voice credentials, answer cards get a "🔊 Voice summary" button. See [Voice summary](/en/voice) |

## Lark meeting agent {#vc-meeting-agent}

A Lark-connected bot **can be invited into video meetings by default** (core-only `apiOnly` bots excepted). It listens in, syncs the transcript, and, depending on its meeting role, posts text or speaks in the meeting.

**Prerequisites**: the app needs `vc:meeting.bot.join:write` (join / leave), `vc:meeting.meetingevent:read` (read meeting events) and `vc:meeting.message:write` (in-meeting text), plus `vc:meeting.bot.realtime:write` for realtime voice; the event subscription must include `vc.bot.meeting_invited_v1`, `vc.bot.meeting_activity_v1`, `vc.bot.meeting_ended_v1` and `vc.meeting.participant_meeting_joined_v1`. Missing scopes are logged as an error at startup and DMed to the admin; event subscriptions can't be queried through any Lark API, so the daemon only reminds you to check them, and a missing event just means no meeting pushes arrive, with no error.

**How to use it**:

1. Invite the bot from a Lark video meeting.
2. The bot DMs the owner (or `vcMeetingAgent.attentionTargetOpenId`, if set) a confirmation card, valid for 30 minutes by default (`inviteTtlMs`).
3. After confirmation the bot joins and creates a meeting listener group that syncs the transcript; set `vcMeetingAgent.listenerChatId` to use an existing group instead.
4. What it does in the meeting is decided by meeting roles, see the next section. To let someone give the bot instructions while it listens to the meeting, use `/vc-auth @member` (`/vc-auth revoke @member` to undo, `/vc-auth list` to view).
5. To prepare ahead: send `/vc prepare <meeting link or number>` in a regular group to make it the meeting prep group, add background and pre-read docs there, and the same Agent session is reused once the meeting starts (see [Slash commands](/en/slash-commands)).

**Speaking in the meeting**:

- Text and voice are **sent directly by default, without per-message approval**. For per-message approval, set `textOutputPolicy` / `voiceOutputPolicy` to `approval` under `vcMeetingAgent.meetingConsumer`; `deny` turns that channel off.
- Realtime voice is on by default but only connects when the bot actually needs to speak; turn it off with `vcMeetingAgent.realtimeVoice.enabled: false`. Speaking also needs the realtime scope above and in-meeting AI speaking permission; without them it fails with a clear warning and never sends audio.
- Speech is synthesized with the engine configured for [voice summaries](/en/voice) (MiniMax, Volcengine / Doubao, and others).

**Turning it off**:

- One bot: `"vcMeetingAgent": { "enabled": false }` in `bots.json`, or turn off **Receive meeting events** for that bot under **Global Settings → Meeting Agent → Meeting Listener → Meeting role presets → Per-bot meeting switches**.
- The whole machine: Dashboard **Global Settings → Meeting Agent → Meeting Listener**, turn off **Allow meeting listener features on this machine** (`vcMeetingAgent.enabled: false` in `config.json`). Meetings already running usually finish naturally.

## Meeting roles

When the bot is invited into a Feishu video meeting, it can act in a "meeting role", such as syncing key information, taking minutes or facilitating. Manage roles in Dashboard "Global Settings → Meeting role presets":

- Presets are shared by all bots: whichever bot is invited runs the selected role, so presets don't name an executing bot.
- Built-in templates: Important information sync, Meeting minutes and action items, Meeting facilitator, Solution review and risk challenge, Interview and requirement insights. "Use this template" makes an editable copy; later template updates don't touch your copy.
- "Per-bot meeting switches" let you turn off meeting events for a bot or pick its default role.

A role has two independent output settings:

| Setting | Values |
|------|------|
| `responseMode` | `silent`: automatic output is never posted to the group; `listener_thread`: may post to the meeting listener group (needs the `listener.output.request` capability) |
| `listenerDelivery.placement` | `auto` (default): follow the current session's group / topic; `chat`: post each update as a top-level group message; `topic`: the first update becomes a fixed topic and later ones reply in it |

In `listener_thread` mode the agent decides whether there's anything new worth posting; botmux only posts the text it chooses to publish, and nothing on malformed output.

You can also write roles by hand in one bot's `vcMeetingAgent.meetingConsumer.consumerProfiles`; that bot then stops using the shared presets. Hand-written roles need `agentAppId` to say which bot executes them:

```json
{
  "id": "important-sync",
  "agentAppId": "cli_your_agent_app_id",
  "label": "Important information sync",
  "role": "important-information-sync",
  "instructions": "Keep listening and only publish new information that matters to collaborators in the group: confirmed conclusions or decisions, status changes, clear blockers or risks, and items people need to know or act on. Ignore discussion, repetition and unconfirmed guesses. Each time, publish only what is new since last time.",
  "filter": { "activityTypes": ["transcript_received", "chat_received"] },
  "responseMode": "listener_thread",
  "listenerDelivery": { "placement": "topic" },
  "capabilities": ["listener.output.request", "meeting.read"]
}
```

Add the role id to `defaultConsumerIds` and set `defaultMode` to `agents` to enable it by default when a meeting starts; otherwise enable it from the selection card shown during the meeting.

## Session environment (global and per-bot layers) {#session-env}

![Dashboard session environment view](/img/session-env-dashboard.png)

A session's environment is built up layer by layer in this order; later layers override earlier ones:

| Order | Layer | Stored in | Notes |
| --- | --- | --- | --- |
| 1 | Inherited baseline | — | The daemon's own environment, with sensitive entries removed (Feishu app credentials, `GITHUB_TOKEN`, etc.) and filtered by `envPolicy` |
| 2 | Global layer | `sessionEnv: { "set": {…}, "unset": […] }` in `~/.botmux/config.json` | Applies to every bot |
| 3 | Bot layer | This bot's `env` (set) and `envUnset` (remove) | Overrides the global layer |
| 4 | botmux reserved | Fixed list | `BOTMUX*`, `LARK_APP_*`, `SESSION_DATA_DIR`, `TMPDIR` / `TMP` / `TEMP`, etc. Injected last; no layer can change them |

**Managing it in the Dashboard**: the global layer is in "Global Settings → Session environment", the bot layer in "Bot Config → Advanced → Launch environment → Session environment". The table lists each variable's name, effective value and source (host / global / this bot). You can set, override, remove, or restore inheritance, and paste many at once. By default only variables changed in this layer are listed; inherited ones collapse into a "N inherited, expand" row. Credential-like values are masked; only the local owner can reveal them.

**When it applies**: new sessions, no daemon restart needed. Running sessions keep the environment they started with; the page lists sessions "still on the old environment", and restarting them picks up the change. To see what a running session's CLI actually got, use "More → View session environment" in the session drawer (read-only, masked, Linux only).

Rules:

- Within a layer, a variable is either "set" or "removed". "Restore inheritance" deletes this layer's entry, so the value falls back to the layer below.
- `PATH` and `HOME` can be overridden but not removed.
- A layer's sets and removes together are capped at 4 KB (tmux limits single command length). Saving more is rejected; an old config that's already over can always be made smaller.
- For tmux / zellij / zmx sessions, removal is the last step of session startup, so same-named variables from the tmux server's global environment or shell startup files are removed too.
- With lark-cli app binding on, botmux takes over `ZDOTDIR` / `BASH_ENV`; with trigger-user auth on, also `GIT_ASKPASS` / `GIT_CONFIG_*`. These can't be set or removed on that bot.
- No migration needed: `env` is the bot layer's "set". Without `envUnset` / `sessionEnv`, everything works as before.
- riff / mojo sessions don't run on this machine; only this bot's `env` goes with them, and the global layer and removals don't apply.
- Env set in a CLI's own config file (e.g. Claude's `~/.claude/settings.json`) is injected by the CLI after it starts and isn't affected by removal.

**tmux server global environment**: a tmux server freezes a global environment when it starts, and every new pane inherits it. Below "Global Settings → Session environment" you'll see the default server and the `tmux -L botmux` server used for managed sessions. The local owner can remove a variable from a server's global environment (with confirmation); it only affects panes created afterwards. To remove something for good, use "remove" above.

### Strict process environment (opt in) {#strict-env}

By default (no `envPolicy`, or `{ "mode": "inherit" }`) the host environment is inherited, minus known sensitive entries. Strict mode only lets through an exact allowlist of names:

```json
{
  "envPolicy": {
    "mode": "strict",
    "inherit": ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "TOOLCHAIN_ROOT"]
  },
  "env": { "OPENAI_API_KEY": "<this bot's model credential>" }
}
```

| Layer | Rule |
| --- | --- |
| System baseline | `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, temp dirs, locale, terminal and XDG paths, etc.; full list in `src/core/env-policy.ts` |
| Extra inheritance | `inherit` takes exact names only, no wildcards. Proxies, CAs, toolchains and model auth must be listed here or set in this bot's `env` |
| This bot's injection | `env` overrides inherited values of the same name and only goes into this bot's sessions |
| Internal identity | botmux injects session, owner and other internal variables last; `BOTMUX*`, `__OWNER_OPEN_ID`, `CODEX_HOME` and the like can't be forged through `env` or `inherit` |

Adapter variables such as `TRAE_HOME` and `CLI_EXTRA_ARGS` aren't inherited automatically in strict mode either; list them in `inherit` or set them in `env` if you need them.

How to set it:

- Dashboard: "Inherit host environment" above "Bot Config → Advanced → Launch environment → Session environment".
- CLI: `botmux env-policy set '{"mode":"strict","inherit":["HTTPS_PROXY"]}'` (pick the bot with `--bot`); `unset` restores the default.
- Feishu: `/botconfig set envPolicy {"mode":"strict"}`.

Bad formats, unknown fields and reserved names are rejected outright, never silently downgraded.

**When it applies**: on the next cold start of a session. Offline CLI edits only change the file; the daemon reads it on its next start. When the daemon restarts and restores sessions whose policy no longer matches, it closes the old session first and starts fresh; if it can't confirm the old one is gone, it refuses to start. Environment a CLI has already read can't be revoked.

**Coverage**: strict mode covers PTY, tmux, zellij and zmx sessions started by botmux, plus local Codex / TraeX App Servers and helper processes such as title generation. tmux / zellij no longer load the `launchShell` startup files and launch the CLI with a clean environment, so PATH, nvm, mise and the like must come from the baseline or your explicit config. `TERM` defaults to `xterm-256color` when missing.

**Not supported**: Herdr, Riff, Mojo, Forge launch mode, adopted external processes and external App Servers can't provide the same isolation yet; strict mode refuses them. Config and credential files the CLI reads itself, file permissions and cloud accounts are outside this policy.

**With a network policy**: if `sandboxNetworkPolicy` is also set, proxy variables (`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` and lowercase forms) must also satisfy the table below. Strict inheritance only decides whether a variable reaches the CLI; it doesn't grant network access.

| Network config | Proxy variables |
| --- | --- |
| No network policy; or `proxyMode` unset and both public and private are `allow` | Not rejected by the network policy; in strict mode they still need to be listed in `inherit` or set in `env` |
| `proxyMode` unset and either zone is `block` / `allowlist` / `denylist` | Any non-empty proxy value refuses to start |
| `proxyMode: "reject"` | Any non-empty proxy value refuses to start |
| `proxyMode: "trusted-egress"` | Explicitly allowed proxies may stay; network rules must allow the proxy's IP and port, and the final targets are governed by the proxy's own ACL |

General proxy delegation in this table applies only to ordinary sessions. A frozen protected HTTP egress policy explicitly rejects `trusted-egress` and task proxy variables; adding that mode repeatedly cannot resolve the error. Model connections must use the protected model bridge, currently supported only by Codex. See [network sandbox documentation](sandbox.md).

`trusted-egress` neither creates a proxy, grants environment variables nor guarantees the CLI uses it. Authorizing an exit does not restrict destinations behind it. If a model requires a proxy, do not simply remove its `inherit` grant to pass validation: explicitly trust the exit and configure endpoint rules plus deployment-layer ACLs, or first establish direct model authentication, permitted destination CIDRs/ports and DNS. Persistent backends such as tmux, adopt and external App Servers remain rejected regardless of `trusted-egress` or `envPolicy`.

The network policy itself requires Linux, the local PTY backend and `sandbox: "oncall"`. See [File and network sandbox](/en/sandbox).

## Auto-maintained fields (don't edit)

botmux writes these itself. They're listed here so you can read the file:

| Field | Description |
|------|------|
| `defaultOncallAutoboundChats` | Groups already auto-bound by `defaultOncall`. Once recorded, a group is never auto-bound again, even after unbinding |
| `noCardChats` | Groups where `/card off` turned off the live card |
| `noPinStreamingCardChats` | Groups where `/card pin off` turned off live card pinning |
| `noCotChats` | Groups where `/cot off` turned off the thinking message |
| `chatReplyModes` / `chatMentionModes` | Per-group settings written by `/reply-mode` and `/mention-mode` |

### Grant store (`grants.sqlite`) {#grant-store}

Per-person talk grants are not kept in `bots.json` but in `<data dir>/grants.sqlite` (default `~/.botmux/data/grants.sqlite`): `chatGrants`, `globalGrants`, and their message quotas and expiry. This keeps `bots.json` from growing every time several bots create a group together.

- At daemon startup, if `bots.json` still has these fields (left from before an upgrade, or written by hand), they're merged into the grant store and removed from `bots.json`; for the same entry the store wins. Before the first removal, the whole `bots.json` is backed up as `bots.json.bak-grants-v1`.
- Grants are only reclaimed automatically when they **expire**: at daemon startup and every hour after. To revoke early use `/revoke` or the grant card.
- In multi-replica mode (`BOTMUX_COORDINATION_MODE=primary`) grants stay in `bots.json`. Don't switch back and forth between modes: after switching to primary, grants in the grant store are not read.
