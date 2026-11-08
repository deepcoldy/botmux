# Multi-CLI Adapters

botmux is not tied to one AI coding tool. Each bot picks the CLI / agent it runs with `cliId`, and the adapter delivers Lark messages to it and brings the replies back. Switching CLIs means changing one field.

- **Local CLIs**: every session is a real process on this machine. Under the default tmux backend you can `tmux attach` and watch it directly (pty / zellij / herdr backends differ).
- **API / remote agents**: a few adapters (e.g. Mira App, riff, Remote Runner) don't start a local CLI process; they call a remote service. For minimal configs see [API / remote adapters](#remote-agents).

**Use this page when**: you want to switch the underlying CLI, wire up a new tool, or check whether a CLI accepts a model.
**No new adapter needed**: for gateways / launchers (aiden, ttadk, ccr, …) see [Wrapper / gateway integration](#wrapper--gateway-integration); for strictly Codex-compatible distributions see [Codex-compatible distributions](#codex-compatible-distributions).

## Switching a bot's CLI

First install the target CLI **as the same system user that runs the botmux daemon**, run it once in a terminal and finish its own sign-in. botmux will not sign in for you. Then pick one way:

| Way | How | Takes effect |
|-----|-----|--------------|
| `botmux setup` | Pick from the CLI menu when creating or editing a bot (related CLIs are grouped into sub-menus, e.g. Codex / Codex App, TRAE 2.0 / legacy Coco) | after `botmux restart` |
| Dashboard | "Bot Config → Common → Agent Config": choose CLI and model, then "Save Agent Config" | new sessions |
| `bots.json` | Edit `cliId` in the entry, see [bots.json](/en/bots-json) | new sessions after `botmux restart` |

![Dashboard Agent Config: choose CLI and model](/img/adapters-dashboard-cli-picker.png)

Running sessions never switch CLI mid-way: `cliId`, `wrapperCli` and `cliRuntime` are fixed when the session is created, so a change only affects new sessions.

The Dashboard checks whether the selected CLI can be found. It looks the command up through your login shell (Zsh / Bash rc files), so a CLI that is only on the PATH set in `.zshrc` is still detected. When it really is missing you get a warning:

![Warning when the selected CLI is unavailable](/img/adapters-dashboard-cli-missing.png)

On macOS, when Codex / Codex App can't find `codex` on PATH, botmux also looks for the `codex` bundled with ChatGPT.app or Codex.app, in this order:

- `/Applications/ChatGPT.app/Contents/Resources/codex`, `~/Applications/ChatGPT.app/Contents/Resources/codex`
- `/Applications/Codex.app/Contents/Resources/codex`, `~/Applications/Codex.app/Contents/Resources/codex`

So having only the desktop app installed is enough. A `codex` on PATH always wins; to pin a specific one, set `cliPathOverride` to its absolute path. Linux has no such fallback.

## Supported CLIs / agents

The table lists the built-in adapters. "Default command" is the executable botmux looks for on PATH; override it with an absolute path in `cliPathOverride`. The authoritative list is [`src/adapters/cli/registry.ts`](https://github.com/deepcoldy/botmux/blob/master/src/adapters/cli/registry.ts).

| `cliId` | CLI / agent | Default command | Integration | `model` |
|---------|-------------|-----------------|-------------|:--:|
| `claude-code` | Claude Code (default) | `claude` | local process | ✅ |
| `codex` | Codex CLI | `codex` | local process | ✅ |
| `codex-app` | Codex App | `codex` | local process (app-server protocol) | ✅ |
| `cursor` | Cursor (cursor-agent) | `cursor-agent` | local process | ✅ |
| `opencode` | OpenCode | `opencode` | local process | ✅ |
| `opencode2` | OpenCode 2 (beta) | `opencode2` | local process | |
| `mimocode` | MiMoCode | `mimo` | local process | ✅ |
| `antigravity` | Antigravity | `agy` | local process | ✅ |
| `copilot` | GitHub Copilot | `copilot` | local process | ✅ |
| `grok` | Grok Build | `grok` | local process | ✅ |
| `kimi` | Kimi Code | `kimi` | local process | ✅ |
| `kiro-cli` | Kiro | `kiro-cli` | local process | |
| `reasonix` | Reasonix | `reasonix` | local process | ✅ |
| `zcode` | ZCode | `zcode` | local process | ✅ |
| `doubao` | Doubao CLI (see [Doubao guide](https://github.com/deepcoldy/botmux/blob/master/docs/doubao.en.md)) | `doubao` | local process | ✅ |
| `pi` | Pi | `pi` | local process | ✅ |
| `oh-my-pi` | Oh My Pi (Pi fork) | `omp` | local process | ✅ |
| `aiden` | Aiden (native agent) | `aiden` | local process | |
| `traex` | TRAE CLI 2.0 (traex) | `traex` | local process | ✅ |
| `coco` | TRAE CLI 1.0 / CoCo (legacy, no longer maintained; requires ≥ 0.120.32) | `coco` | local process | ✅ |
| `mtr` | MTR | `mtr` | local process | |
| `hermes` | Hermes | `hermes` | local process | |
| `ebsd` | EBSD (requires credential files, see [guide](https://github.com/deepcoldy/botmux/blob/master/docs/ebsd.md)) | `ebsd` | local process | |
| `codem` | CodeM (see [CodeM guide](https://github.com/deepcoldy/botmux/blob/master/docs/codem.md)) | `codem` | local process | ✅ |
| `minimax` | MiniMax Code / mcode (see [MiniMax guide](https://github.com/deepcoldy/botmux/blob/master/docs/minimax-code.md)) | `mcode` | local process | ✅ |
| `genius` | Genius | `genius` | local process | ✅ |
| `seed` | Seed (Claude Code fork) | `seed` | local process | ✅ |
| `relay` | Relay (new release of Seed) | `relay` | local process | ✅ |
| `dsh` | DeepSeek Harness (see [below](#deepseek-harness-dsh)) | `dsh` | local process (SDK JSON-RPC) | ✅ |
| `mir` | Mir CLI (local mircli, see [below](#mir-cli-and-the-mcp-bridge)) | `mircli` | local process | |
| `mira` | Mira App | none | API / remote | |
| `riff` | riff | none | cloud agent (API) | |
| `mojo` | Mojo | `mojo` | API-driven (host execution / cloud sandbox) | ✅ |
| `remote-runner` | Generic Remote Runner (see [protocol](https://github.com/deepcoldy/botmux/blob/master/docs/remote-runner.md)) | `botmux-remote-runner` | remote protocol | ✅ |

### About the `model` column

- ✅ means the model really is passed to the CLI at launch. You can set a default model for the bot in `bots.json` / the Dashboard, or pick one for a single new topic with `/t … /model <model>` in its first message (see [Slash commands](/en/slash-commands)).
- For CLIs without ✅, the model is decided by the CLI's own config or UI. The `model` field is ignored, and `/model` in a topic header is rejected outright rather than silently dropped.
- riff is the exception: its model only comes from the bot's `riff` config block, not from `model`.
- Some CLIs accept a model but ship no built-in candidate list (e.g. Seed, Relay, Pi). Setup won't prompt for a model; type one in if needed, or switch with the CLI's native `/model`.

### Gemini CLI has been removed

Gemini CLI is no longer maintained upstream, so botmux removed the `gemini` adapter, and the Dashboard and `botmux setup` no longer offer it. The replacement is `antigravity` (Antigravity, command `agy`).

- A bot whose `bots.json` entry still says `cliId: "gemini"` **refuses to start**, with a hint to change it to `"antigravity"`. Other bots keep running.
- In scripted setup, the old Gemini number `6` now reports an error instead of selecting another CLI.
- To migrate:
  1. Install `agy` and sign in with a Google account; or skip the sign-in and use a Gemini API key: set `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` and provide `GEMINI_API_KEY`.
  2. Change `cliId` to `"antigravity"` (edit `bots.json`, or change the bot's CLI with `botmux setup`).
  3. Remove or reconfigure Gemini-only settings: `cliPathOverride` / `wrapperCli` (e.g. `ttadk gemini`), Gemini `model` names, `GEMINI_CLI_HOME`.
  4. Run `botmux restart`.

  While the bot is not started, the Dashboard can only show the reason; it cannot save that bot's settings.

## Wrapper / gateway integration

Often you don't run the native CLI directly but through a gateway or launcher (intranet proxy + SSO, model routing, …). **No new adapter is needed**: keep `cliId` set to the real underlying CLI (`claude-code`, `codex`, …) and only change how it is launched. Reply capture, session resume, hooks and the rest keep working.

### Option 1: a `wrapperCli` launch prefix (recommended)

Set `wrapperCli` on the bot, and botmux launches `<wrapperCli> <CLI args>`. No script needed, works on every OS.

```json
{
  "cliId": "claude-code",
  "wrapperCli": "aiden x claude"
}
```

The `botmux setup` and Dashboard CLI menus already include common combinations and fill this in for you:

| Menu item | `cliId` | `wrapperCli` |
|-----------|---------|--------------|
| Aiden × Claude / Aiden × Codex | `claude-code` / `codex` | `aiden x claude` / `aiden x codex` |
| CJADK × Claude / CJADK × Codex | `claude-code` / `codex` | `cjadk claude` / `cjadk codex` |
| TTADK × Claude / Codex / OpenCode / CoCo / Cursor | matching CLI | `ttadk claude`, etc. |

Notes:

- The first word is looked up on PATH and replaces the CLI's default command; with `wrapperCli` set, `cliPathOverride` no longer applies.
- `aiden x claude` rejects the `--settings` botmux injects, so botmux strips it automatically; other launchers get the args unchanged.
- For TTADK combinations, the bot's `model` field is passed as `ttadk -m <model>` (defaults to `glm-5.1` when empty; TTADK × CoCo takes no model).
- Any other launcher such as `ccr` works too.
- `wrapperCli` cannot be combined with `cliRuntime`.

### Option 2: your own wrapper script + `cliPathOverride`

When launching is more involved (changing env vars, stripping args, forcing a PTY, …), write a script:

1. **Sign in to the gateway first** (once), as the same system user that runs the daemon. An expired token pops an interactive login that blocks the terminal, so keep the session alive.
2. **Write the script** in `~/.botmux/bin/` and forward botmux's arguments to the real CLI. Some gateways reject `--settings`; strip it in the script.
3. **`chmod +x`** (the most commonly missed step). Without the executable bit you get `EACCES`, the CLI exits right away and the bot keeps restarting.
4. **Run the script directly to verify**: `~/.botmux/bin/xxx --version`. Don't test with `bash xxx`; that doesn't need the executable bit and hides the problem in step 3.
5. Set `cliPathOverride` in `bots.json` to the script's **absolute path** (not `~`), then `botmux restart`.

Follow each gateway team's published docs for the actual script. MTR is community-contributed; install with `npm i -g @metamove-code/mtr-cli@latest`.

> Debugging a wrapper: find the `Spawning fresh CLI:` line in `botmux logs`, copy the full command and run it by hand in a terminal. That usually shows whether it's permissions, arguments or sign-in.

## Codex-compatible distributions

If you run a separately released distribution that is **strictly compatible with Codex**, use `cliId: "codex"` plus `cliRuntime`: `cliId` selects the Codex protocol adapter and `cliRuntime` names the binary that actually runs. It reuses model args, session resume, idle detection and Codex RPC, without being version-checked as official Codex.

"Strictly compatible" means it accepts the arguments botmux passes to Codex, keeps the same interactive states and rollout / resume semantics, and uses a compatible auth / home layout. If it changes arguments, the UI state machine, session storage or the protocol, contribute a real adapter instead.

In the Dashboard, switch "Codex Runtime" to "Custom Compatible" and fill in the executable and update source:

![Configuring a Codex-compatible distribution in the Dashboard](/img/codex-compatible-runtime-dashboard.png)

For all fields and update sources see [the Codex-compatible distributions section of `bots.json`](/en/bots-json#codex-runtime). The older `cliPathOverride` setup keeps working, but it does not turn on Codex RPC features that require an explicit compatibility declaration.

## API / remote adapters {#remote-agents}

The agents behind these four adapters don't run in a local terminal. `riff`, `mojo` and `remote-runner` are paired with the session backend of the same name automatically, so you don't need to set `backendType`.

| `cliId` | Minimal config | Sign-in |
|---------|----------------|---------|
| `mira` | `cliId` only | reads the local Mira.app login cookie |
| `riff` | `cliId` + `riff.baseUrl` | a JWT, or the local ByteCloud sign-in |
| `mojo` | `cliId` only, with `mojo` on PATH | local `mojo auth login`, or an injected JWT |
| `remote-runner` | `cliId`, plus `cliPathOverride` when the provider isn't called `botmux-remote-runner` | handled by the provider |

### Mira App

In `botmux setup`, choose **Mira → Mira App (Web API)**; this writes `cliId: "mira"`. botmux calls Mira's Web API through a built-in runner, so no CLI is needed.

```json
{ "cliId": "mira" }
```

Sign-in:

1. By default, open Mira.app on macOS and sign in. botmux uses the `sqlite3` command to read `mira_session` from `~/Library/Application Support/mira/Cookies`, so `sqlite3` must be installed.
2. Not on macOS, or the cookies live elsewhere: set `MIRA_COOKIE_HEADER` (a full Cookie header) or `MIRA_SESSION` (just the `mira_session` value) in the daemon environment or the bot's `env`, or point `MIRA_COOKIE_DB` at the cookie database. These are credentials; never post them in chat.

Without a cookie you get "Open Mira.app and sign in". The model ignores the `model` field and follows Mira's own settings. The local Mir CLI is a separate adapter; see [Mir CLI and the MCP Bridge](#mir-cli-and-the-mcp-bridge).

### riff

riff runs the agent in a cloud sandbox, so nothing is installed locally. `riff.baseUrl` is required; use the riff service address for your environment:

```json
{
  "cliId": "riff",
  "riff": { "baseUrl": "https://riff.example.internal" }
}
```

You can also pick Riff as the CLI under "Agent Config" in the Dashboard and fill in the "Riff backend config" panel that appears. Common optional fields:

| Field | Description |
|-------|-------------|
| `model` | Model used in the sandbox; empty means riff's default. The bot's top-level `model` has no effect on riff |
| `reasoningEffort` | `low` / `medium` / `high` / `xhigh`; empty means the default |
| `sandboxCluster` | Sandbox pool for new tasks: `boe` or `cn` |

Sign-in (the JWT is looked up in this order on every riff call):

1. `riff.jwt` holds the token directly. Not recommended: it's stored in plain text and expires quickly.
2. The environment variable named by `riff.jwtEnv`, `RIFF_JWT` by default. Set it in the daemon's environment and renew it yourself.
3. Neither set (recommended): on the daemon machine, sign in once to a ByteCloud CLI as the same system user, and botmux reads the sign-in it stores locally, skipping expired tokens.

On a 401, sign in again on the daemon machine; no restart needed. riff can only be configured per bot; you can't switch a topic to it with `/t`.

### Mojo

With `mojo` on PATH and signed in on this machine, `cliId` alone is enough:

```json
{ "cliId": "mojo" }
```

Sign in one of two ways:

- Run `mojo auth login` as the same system user that runs the daemon.
- Inject a JWT: put the token in `mojo.jwt`, or name the environment variable to read with `mojo.jwtEnv` (default `X_JWT_TOKEN`). An injected JWT takes priority over the local sign-in.

Tools run on this host by default; set `mojo.cloud: true` to run them in the cloud sandbox instead. Put the model in the bot's top-level `model`. Fields such as `bin`, `cwd`, `model` and `wrapperCli` are rejected inside the `mojo` block; use the top-level `cliPathOverride`, `workingDir`, `model` and `wrapperCli`.

### Remote Runner

Remote Runner connects any remote agent platform over a JSONL protocol. botmux starts a provider subprocess, and the provider owns the remote resources and the sign-in:

```json
{
  "cliId": "remote-runner",
  "cliPathOverride": "/opt/example/bin/my-remote-runner"
}
```

- Without `cliPathOverride`, botmux looks for `botmux-remote-runner` on PATH.
- The provider reads its own credentials, injected via a permission-restricted file or the deployment environment, e.g. a token file path in the bot's `env`. The `remoteRunner` block holds no credentials, and unknown fields in it are rejected.
- The `remoteRunner` block is optional and describes protocol expectations:

| Field | Description |
|-------|-------------|
| `expectedProvider` | Provider name checked during the handshake |
| `requiredCapabilities` | Capabilities the provider must declare; it won't start without them |
| `handshakeTimeoutMs` | Limit for the handshake and for start / resume to reach ready; integer, 100–300000 ms |
| `operationTimeoutMs` | Limit for status / cancel / detach; integer, 100–300000 ms |

`envPolicy.mode: "strict"` is not supported for Remote Runner and fails at startup. For protocol details see the [Remote Runner protocol](https://github.com/deepcoldy/botmux/blob/master/docs/remote-runner.md).

## Notes for specific CLIs

### Using the newly added CLIs {#new-clis}

Grok Build, Reasonix, OpenCode 2, DeepSeek Harness (dsh / dsh-tui), MiniMax Code (mcode), MiMoCode, CodeM, ZCode and Doubao are all built-in adapters with no extra switch. Turning one on works like switching to any other CLI (see [Switching a bot's CLI](#switching-a-bots-cli) above): install the command and log in under the daemon's system user, then set the bot's `cliId` to the value below.

| CLI | `cliId` | Default command |
|---|---|---|
| Grok Build | `grok` | `grok` |
| Reasonix | `reasonix` | `reasonix` |
| OpenCode 2 (beta) | `opencode2` | `opencode2` |
| DeepSeek Harness | `dsh` | `dsh` (for the full-screen TUI also set `dshRuntime: "tui"`, which launches `dsh-tui`; see below) |
| MiniMax Code | `minimax` | `mcode` |
| MiMoCode | `mimocode` | `mimo` |
| CodeM | `codem` | `codem` |
| ZCode | `zcode` | `zcode` |
| Doubao | `doubao` | `doubao` |

**Forge × TraeX**: to start TraeX through Forge, pick **Forge x TraeX** in the CLI menu of `botmux setup` or the Dashboard, or write `"cliId": "traex", "cliLaunchMode": "forge-traex"` in `bots.json`. botmux then launches `forge run --agent traex --agent-args ...`, so `forge` must be on PATH. This launch mode only works with `cliId: "traex"` and can't be combined with `wrapperCli`, `cliRuntime`, `cliPathOverride`, the file sandbox or `readIsolation`; such configs are rejected.

### TraeX automatic model switching (experimental) {#traex-auto-model}

A TraeX bot can set `model` to `auto` and provide an ordered model pool. A session starts on the first model and moves on to later models in the pool when it queues or runs out of quota. Switching restarts TraeX and resumes the same session; inputs already sent are not replayed.

In the Dashboard, choose TraeX under "Agent Config", tick "Experimental: automatic model switching" and order the models; each model can have its own reasoning effort and context:

![TraeX automatic model switching in the Dashboard](/img/traex-auto-model-config.png)

The matching `bots.json`:

```json
{
  "cliId": "traex",
  "model": "auto",
  "traexAutoModel": {
    "enabled": true,
    "models": ["model-a", "model-b"],
    "queueTimeoutMs": 30000
  }
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Must be `true` |
| `models` | The pool, in order. The first is preferred, the rest are fallbacks. Only these models are used; no duplicates, and `auto` is not allowed |
| `trigger` | When to switch: `capacity` (model queueing, default) or `quota` (explicit quota exhaustion) |
| `queueTimeoutMs` | How long sustained queueing lasts before switching; 5000–300000 ms, default 30000 |
| `switchCooldownMs` | Minimum time since the last switch before a new queue episode can switch again; 5000–300000 ms, default 60000 |
| `reselectPerTurn` | Default `false`: later inputs in a topic keep the selected model. With `true`, every new input starts again from the preferred model |
| `preflightLoadCheck` | Default `false`. With `true`, load is checked before each independent new turn and an overloaded model is switched out. `capacity` mode only |
| `overloadThresholdPercent` | Overload threshold for the preflight check, default 100; only load above it counts as overloaded |
| `preflightTimeoutMs` | Timeout for the preflight check; 100–30000 ms, default 8000 |
| `modelSettings` | Per-model settings, e.g. `{"model-a": {"reasoningEffort": "xhigh", "modelBackendVariant": "max"}}` |

The two triggers:

- **Capacity queue (`capacity`)**: after queueing for `queueTimeoutMs`, switch to the first later model with load at or below 100% (or unknown load). When all later models are above 100%, pick the lowest-load model in the pool (ties go by pool order) and wait there without further switching; when loads are incomplete, try each model in order and finally pick the one with the best queue position.
- **Quota exhausted (`quota`)**: only structured quota-exhaustion errors count; ordinary 429s, queueing, network or auth failures never trigger it. Models known to be out of quota are skipped; when all are exhausted, automatic retries stop and the next independent input checks again.

Things to know:

- Only applies to `cliId: "traex"`. If `model` is `auto` but `traexAutoModel` is missing or invalid, botmux logs a warning and passes no model to TraeX, so TraeX's own default is used.
- New topics start on the preferred model. In `quota` mode, every new independent input starts on the first model that still has quota, regardless of `reselectPerTurn`.
- Changes apply to newly started or restarted sessions.

### Pi execution progress

Bots with `cliId: "pi"` show Pi's persisted thinking, narration, tool calls and results in the Lark progress bubble. Tool nodes show commands or file paths and finish with the current turn; the final answer is still sent as a reply.

- On by default; respects `cotEnabled` and the chat's `/cot on` / `/cot off`. `/cot show` displays what the current turn has accumulated.
- Updates follow complete messages written by Pi: tool calls appear before they run, results after they finish, not token by token.
- History is not replayed into a new turn's bubble.

### DeepSeek Harness (dsh)

`cliId: "dsh"` drives the local `dsh` CLI ([deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)) through a built-in runner, using the SDK JSON-RPC protocol of `dsh --profile <name>`. Reasoning and tool activity show up in the card's thinking section.

**Prerequisites:**

1. `dsh` is on PATH (or set via `cliPathOverride`). It must be the `dsh` command from the npm package `@deepseek-ai/dsh`; early versions used `dsh-jsonrpc-agent` from a Python package, and having only that old command on PATH gives "command not found".
2. Configure and sign in with native `dsh` first. The data dir is `$DSH_HOME`, or `~/.dsh` when unset.
3. The profile is `botmux` by default (override per bot with `dshProfile`) and lives in `$DSH_HOME/profiles/<name>/`.

**No need to create the profile by hand**: if it's missing, botmux writes a minimal skeleton (`package.json`, empty `cordis.yml`, `cordis.patch.yml`) and runs `dsh plugin add` to install dependencies. The default patch disables the web plugins that would block startup in headless mode and inserts the SDK JSON-RPC server; the default `botmux` profile also gets the `ask_user_question` tool. Everything else comes from `dsh-base`.

To add community plugins or switch model providers, edit that profile's `cordis.patch.yml`; botmux only creates the file when it's missing and never overwrites it. When editing:

- `- insert: [...]` **adds** plugins;
- a bare `- id: X` (no `insert`) overrides the config of an **existing** plugin and is silently skipped if the id doesn't exist.

**How the model is chosen**: botmux takes `agent-default-model` from the composed profile; explicit values in the legacy `$DSH_HOME/settings.yaml` win while that file exists; with neither, it uses `deepseek-official` / `deepseek-v4-flash`. A bot `model` only overrides the model name; the provider still comes from the config above.

**Other points:**

- `DSH_HOME` can only be set in the daemon's environment; a per-bot `env.DSH_HOME` is rejected to avoid split profile paths.
- Session logs go to `$DSH_HOME/sessions/botmux/`. Turns within one runner share context; after a daemon restart a new session starts without the old context.
- For the full-screen TUI instead of the runner: keep `cliId: "dsh"` and set `dshRuntime: "tui"` (also switchable in the Dashboard). It then launches the `dsh-tui` command; the model comes from the TUI's own config and `/model`, and the TUI's state lives in `~/.dsh-tui`.
- When the model calls `ask_user_question`, a Lark question card pops up. In TUI mode Lark is tried first, and questions a card can't represent fall back to the native TUI. To turn the bridge off, set `BOTMUX_DSH_ASK_BRIDGE=0` and restart the session.

### Mir CLI and the MCP Bridge

In `botmux setup`, choosing **Mira → Mir CLI (local mircli)** writes `cliId: "mir"` (the other item, "Mira App (Web API)", is `cliId: "mira"`). It runs `mircli -p --lean` locally, so the system user that runs the daemon must have finished Mir CLI sign-in and initialization. The rules are the same on DevBox, macOS and other Linux machines:

- botmux can find `mircli`, or `cliPathOverride` points to its absolute path.
- `~/.mira/config.json` already has a `device_id` (usually written by `mircli mcp --device-id <id>` or Mir CLI's own setup).
- `miramcp` is in Mir CLI's standard location (e.g. `~/.local/bin/miramcp`), or `MIRAMCP_BIN` points to it.

Before calling `mircli` for a message, botmux tries to start the MCP Bridge:

```bash
miramcp run --device-id <device_id>
```

If it's already running (checked via `~/.mira/miramcp/miramcp.pid` and local port `9801`), it isn't started again. To check its status:

```bash
mircli mcp status
```

To stop the auto-start, either put this in `~/.mira/config.json`:

```json
{"auto_start_bridge": false}
```

or disable it for the botmux process only:

```bash
MIRCLI_AUTO_START_MIRAMCP=0 botmux start
```

### Doubao CLI

`cliId: "doubao"` bridges the interactive UI of the local Doubao CLI. Install it and sign in as the same system user first:

```bash
npm install -g '@bytedance/doubao-cli' --registry=https://registry.npmjs.org
doubao          # sign in, wait for the input box, then /exit
botmux setup    # choose Doubao as the CLI, then the project directory
```

`model` is optional; when set, use the name shown in the native `/model` menu. Press **Esc** in the web terminal to interrupt the current turn. botmux launches it with `--permission-mode always_allow` by default, so keep it to trusted users and projects. See the [Doubao guide](https://github.com/deepcoldy/botmux/blob/master/docs/doubao.en.md) for intranet installs and limitations.

### Codex App native questions

In `codex-app` sessions (and `codex` sessions with app-server RPC enabled), when the model calls native `request_user_input`, botmux turns the question into a Lark question card. Pick on the card, or reply with text in the session, and the answer goes back to **the same native turn**; no new prompt needed. TRAE RPC uses the same bridge.

![Codex native question card preview](/img/codex-native-user-input-preview.png)

(Rendered locally from real card JSON; for illustration only.)

**Answering:**

- All questions in one request share a card, with option descriptions shown per question; a recommended option is never auto-selected, you have to submit it.
- If the batch contains a free-text question, the whole batch is answered with one text reply in the session.
- Choice questions need at least two options; secret-input questions and malformed questions fail outright, with no partial answers. Never type passwords or other secrets in chat.
- Who may answer follows the existing Ask routing and reply permissions.

**Waiting and cancellation:**

- Waits up to one hour. A failed card, timeout, expired card or unrepresentable question interrupts the original turn, so the agent never continues on an empty answer.
- Waiting is cancelled when the turn ends, the process exits or the session closes; late answers are not delivered.
- After a daemon restart these requests are not retried or restored.

**Async questions (`request_user_input_async`, `codex-app` only):**

- The model can keep working after asking; the card can still be answered after the original turn ends normally. Answers keep the original call ID and question indexes.
- With `codexAppCleanInput` on, the original turn still running and steered input supported, the asker's answer joins the original turn directly; otherwise a new turn starts in the same thread. Late answers never join a different task.
- A card showing "Ended" means the answers were collected, not that the model has read them.
- Reply permissions: for human-started turns, the single answerer is locked when the card is registered; scheduled / autonomous turns let members with talk permission (canTalk) answer, while the schedule creator still needs operate permission (canOperate), and silent schedules don't show a card; for doc-comment turns only the original commenter can answer, in a private chat.
- With several pending cards, a text answer must **quote the target card**; unquoted messages are treated as normal input and you get a hint to disambiguate.
- Pending cards are not restored across daemon / runner restarts, and past questions are not resent.

**Not covered by this bridge**: Workflow sub-tasks (use `humanGate` / decision nodes), API-only sessions without a Lark channel, plain terminal-paste mode, and the App history viewer. Whether the native tool is available ultimately depends on the Codex version and mode.

To test: in a normal Codex App session, ask the model to use `request_user_input` for a choice question, check that the card arrives in Lark, then submit and confirm the same turn continues and can repeat your choice.

### Steering a running Codex App turn {#codex-app-steer}

Only for `cliId: "codex-app"` sessions; on by default with nothing to configure on the Lark side. While Codex App is running a turn, a new message you send in the topic is injected into **the current turn** (Codex turn/steer) instead of waiting in the queue. When it lands, the bot replies "Got it — guidance accepted". Handy for "also handle X" or "stop that, do Y instead" mid-task.

- Only messages sent directly by people steer. Messages from other bots queue as usual unless `@steer` is the first semantic line of the body (it may follow the line that @mentions the recipient).
- If it can't be injected (for example, the turn is wrapping up), the message is queued like a normal one; nothing is lost.
- Tasks triggered through the HTTP API must pass `steer: true` in `options` explicitly, starting with the first turn; see [API task trigger](/en/api-task-trigger).

### Claude Code busy/idle detection (OSC 7501) {#claude-osc-7501}

Automatic, nothing to configure. The Claude Code adapter supports the OSC 7501 program status protocol: as soon as the CLI reports its first valid status, "working / idle" follows that report instead of guessing from the terminal screen, so card status and "turn ended" are more accurate. Until a status arrives, the screen is still used. The Pi and Kimi adapters use the same protocol.

## Adding a new adapter (contributors)

1. Create a file under `src/adapters/cli/` implementing the `CliAdapter` interface.
2. Add the new ID to the `CliId` union in `src/adapters/cli/types.ts`.
3. Add the import, switch case and export in `src/adapters/cli/registry.ts`.
4. Add a display name to `CLI_DISPLAY_NAMES` in `src/adapters/cli/display-names.ts` (shared by cards, setup and the Dashboard; missing it fails compilation).
5. Add a number to `CLI_ID_CHOICES` in `src/setup/bot-config-editor.ts`, **always appended at the end**: the numbers are a stable interface for scripted setup, and inserting in the middle makes old scripts silently pick the wrong CLI. The setup menu and Dashboard dropdown follow automatically.
6. Update the CLI list in `README.md` and `README.en.md`.

File-sandbox support also needs the CLI's state directories declared correctly; see [`src/adapters/cli/CLAUDE.md`](https://github.com/deepcoldy/botmux/blob/master/src/adapters/cli/CLAUDE.md) and [CONTRIBUTING.md](https://github.com/deepcoldy/botmux/blob/master/CONTRIBUTING.md).
