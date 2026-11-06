# Doubao CLI: installation, configuration, and usage

[中文](doubao.md) · [Back to README](../README.en.md)

Botmux's `cliId: "doubao"` bridges the local **interactive Doubao CLI TUI**. It does not call a model API directly or use `-p` for ordinary sessions. Doubao owns its models, tools, authentication, and native conversations; Botmux handles input, terminal display, final-answer collection, and exact session resume.

> Use a Botmux build that includes this adapter. If setup does not list Doubao or `/cli doubao` reports an unknown CLI, install a build containing this change first. Installing Doubao alone does not add an adapter to an older Botmux. Native acceptance testing used Doubao CLI 2.31.0 on macOS; untested versions are not guaranteed compatible.

## 1. Installation and first login

The standalone Botmux binary needs no host Node runtime. **Installing Doubao through npm and running its npm launcher still requires Node/npm.** Check `node --version` and `npm --version`, then choose one package source. Do not install both packages to compete for the same `doubao` executable.

Public installation:

```bash
npm install -g '@bytedance/doubao-cli' --registry=https://registry.npmjs.org
```

Enterprise installation: set `DOUBAO_NPM_REGISTRY` to the actual internal registry URL according to your organization's installation instructions, then run the following command. This variable is a shell input for this example, **not a Botmux or Doubao runtime setting**. Private deployment hostnames are not hard-coded in the public repository.

```bash
npm install -g '@bytedance-dev/doubao-cli' \
  --registry="${DOUBAO_NPM_REGISTRY:?Set the enterprise npm registry URL first}"
```

On the same machine and OS user that will run Botmux:

```bash
command -v doubao
doubao --version
doubao --help
doubao
```

Complete the native QR/account login until the `Ask Doubao to do anything` composer appears. Send a simple prompt to verify access, then exit with native `/exit`. Keep credentials and session data out of public repositories. Botmux does not complete login on your behalf; an unauthenticated CLI remains on its login screen.

## 2. Configure a Feishu / Lark Bot

### New Bot (recommended)

```bash
botmux setup
# Select Doubao as the CLI, then select the actual project directory
botmux start
```

The scripted setup CLI number is `35`; ordinary interactive use should select by name. Follow the [quickstart](https://deepcoldy.github.io/botmux/en/quickstart) for the app, permissions, and authorized users. Doubao account login is separate from Lark application credentials.

### Existing Bot

Select Doubao in Dashboard Bot Config, or edit the corresponding existing entry in `bots.json`. The default file is `~/.botmux/bots.json`; an explicit `BOTS_CONFIG` takes precedence. This is a **fragment to merge into an existing entry**, not a replacement for the whole registry. Preserve app credentials, permissions, and all other Bot entries.

```json
{
  "cliId": "doubao",
  "workingDir": "/absolute/path/to/your/project",
  "model": "Auto"
}
```

Replace `workingDir` with an existing absolute path to the project the Agent should operate on. Omit `model` to use Doubao's default. When specified, use the **full display name** offered to your account by native `/model`, not a model ID from another CLI. Model availability and quotas belong to the Doubao account.

If the daemon cannot find the executable, set that entry's `cliPathOverride` to the absolute executable path returned by `command -v doubao`. This is a compatibility path override, not an installation command, additional arguments, or another CLI's wrapper.

Save and restart the daemon for new sessions:

```bash
botmux restart
```

Restart affects the Bots in that deployment. Updated configuration need not rewrite the arguments of an already-running CLI; create a new session to verify a new CLI/model. For source checkouts, follow the [repository runtime rules](../AGENTS.md) instead of assuming a global `botmux` command points to that checkout.

## 3. Chat, interrupt, and resume

- DM the Bot or @ it in a configured group/topic. Follow up in the same session to retain context.
- Multiline input is submitted as one paste, not one task per line. Native TUI keys are `Enter` to send and `Ctrl+J` for a newline. A large paste may collapse to `[Pasted text ...]`; submission expands the original text.
- A physical **Esc** in the Web terminal really is Doubao's interrupt key (while the footer shows `esc to interrupt`, it stops the current task and returns to the composer) — not Ctrl+C. Interruption does not undo file writes or external actions already performed. **However, to stop a turn reliably FROM BOTMUX, prefer the card's ⏹ Stop button or send `/stop`** (next bullet): a physical Esc typed into the Web terminal only sends the raw key byte to the TUI and does not go through Botmux's stop channel, so the turn is not retired in Botmux's reply queue and a later fast turn's answer can be misattributed to the interrupted one.
- To explicitly STOP the current turn use the card's **⏹ Stop button** (or send `/stop`, or the card's **^C** quick key): these both send the interrupt key to the TUI and settle the turn as stopped, releasing the queued follow-up — this is the recommended way to stop. The card's **Esc** quick key, like a physical **Esc** in the Web terminal, only sends the Esc byte to the TUI and does not go through Botmux's stop channel: using it to dismiss a menu such as `/model` affects no turn, but pressing it WHILE a turn is running really interrupts Doubao while Botmux does not settle the turn (same shape as the physical-Esc case below) — follow the recovery step to realign.
- **After an interrupt that bypassed the stop channel (a physical Esc in the Web terminal, or the card's Esc quick key pressed while a turn is running), press the card's ⏹ Stop button once (or send `/stop`) BEFORE sending your next message**, so Botmux settles that turn and realigns the queue. Botmux can only stop the turn that is CURRENTLY running: if you have already sent the next message, pressing stop afterwards settles that NEW turn instead and discards its answer — in that case just continue the conversation; do not press stop again.
- Interruption semantics: a turn settled through an explicit stop produces no terminal record in Doubao, and Botmux does not post content that lands on disk afterwards as that turn's reply. If the model writes a terminal answer at almost the same moment the stop takes effect, the late text is not delivered to Lark (review it in the Web terminal / native logs, or ask again). This matches every other structured-bridge CLI: an ownerless terminal after the turn was retired is never delivered.
- Operate native menus such as `/model` through the Web/local terminal. Lark slash commands are routed by Botmux and are not necessarily identical to native commands. Use `/cli doubao` to select the adapter for a session that has not started yet.
- Botmux captures the native decimal Session ID after the first submission and resumes with that exact ID. Missing/malformed IDs, missing local records, or ambiguous submit matches never trigger a guess at the “latest” conversation. Recovery may fall back to a fresh session with a notice.
- For a local continuation, use the native resume command supplied by Botmux (`doubao --resume` followed by the native decimal ID). **The Botmux session UUID is not the Doubao native ID.** Do not interchange them or rotate the managed conversation using native `/new` behind Botmux's session management.

## 4. Final replies, permissions, and Skills

### Final-answer collection

Final text is harvested from local native logs: user sections in `assignment.md` and terminal assistant rows in `trajectory.jsonl`. Tool results and intermediate narration with `tool_calls` are not final answers. **The model need not run `botmux send` to deliver its final result.** HTTP wait mode uses the same bridge and returns `output.content`.

Doubao bots default to `replyDelivery: transcript` (other CLIs still default to `send`): the system prompt does not teach `botmux send`, and the final reply is collected only from the logs above. Doubao runs tool commands in an account-wide resident `doubao --type=service` process shared by every Doubao terminal on the machine, and that process keeps the environment and process tree of whichever terminal **first** started it. A `botmux send` issued from a tool is attributed through that tree, so the reply can land in another session, another chat, or even be sent as another bot. Switching back to `send` is not recommended; if you must, keep a single Doubao session on the machine and restart the resident process after switching.

The first turn's native session id is captured for up to 20 seconds after submit (on a cold resident-process start, `assignment.md` takes 7–8 seconds to appear).

Sandbox combinations: under oncall (`sandbox: true` or `"oncall"`, including legacy readIsolation), Doubao's `~/.local/share/doubao_cli` is directory-bind mounted from the real host path, so the transcript bridge works and the transcript default is unaffected. Under the full-root COW `sandbox: "scratch"`, the whole container root is a merged overlay and authPaths do not apply: the session tree Doubao writes is invisible to the host-side bridge, so both the first-turn id capture and transcript harvest come up empty. In that combination `replyDelivery` falls back to `send` automatically (the Dashboard shows transcript as unsupported and an explicit `transcript` write is rejected) — the legacy model-sends-itself behavior, which still carries the resident-process cross-talk risk described above; running Doubao under scratch is not recommended on a machine shared by multiple bots. `promptInjection: none` (zero injection) is rejected outright under scratch because it forces transcript with no send fallback.

This integration depends on Doubao's on-disk format, not an official stable transcript API. Do not remove or move the logs during execution. Upgrades changing the format may require an adapter update. Interrupted/error terminal coverage is incomplete; not every failure is guaranteed a structured error result.

### Permissions

By default, Botmux passes `--permission-mode always_allow` to avoid remote tasks stalling at per-tool approval dialogs. **The Agent can execute tools in the selected project and its authorized environment.** Limit access to trusted users and projects. Botmux does not additionally pass `--dangerously-bypass-approvals-and-sandbox` or claim to remove Doubao's own safety boundaries.

With `disableCliBypass: true`, this flag is omitted and the CLI's own configuration applies. Resolve native approval prompts through the Web/local terminal. No Doubao-specific native approval/questionnaire integration with Lark choice cards is included.

Botmux sets `DOUBAO_CLI_NO_UPDATE_CHECK=1` to prevent the npm launcher's update question consuming the first prompt. It does not upgrade the CLI. Run the chosen installation command in an ordinary terminal when upgrading, then revalidate.

### Skills and local data

Global native Skills live in `~/Doubao/skills`, with one directory and `SKILL.md` per skill. Do not assume other CLIs' `~/.agents/skills` path is a verified Doubao loader location.

Data roots are `~/Library/Application Support/doubao_cli` on macOS and `${XDG_DATA_HOME:-$HOME/.local/share}/doubao_cli` on Linux. Native session logs live under `agent_mode/<account>/workspace/.sessions/<native-session-id>/agents/<agent-id>/system/`. These can contain full prompts and tool outputs; protect them as sensitive project data. Login state and paths must be accessible to the OS user running Botmux.

## 5. Local HTTP trial without Lark

Complete native login first. In terminal A, start a **separate loopback-only foreground service** using a Botmux build containing the adapter. Replace the project path and use a dedicated state directory. This does not change an existing `bots.json` and is not a public-network deployment recipe.

```bash
botmux serve --api-only --port 17891 --bot local_doubao --cli doubao \
  --backend pty --working-dir "$HOME/work/your-project" \
  --state-dir "$HOME/.botmux-doubao-trial"
```

In terminal B, check health and submit a task:

```bash
curl --fail-with-body http://127.0.0.1:17891/healthz
curl --fail-with-body --max-time 200 \
  http://127.0.0.1:17891/api/trigger \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "source": { "type": "ui", "requestId": "doubao-trial" },
  "target": { "kind": "turn", "botId": "local_doubao" },
  "envelope": {
    "format": "botmux.ui.v1",
    "sourceName": "doubao-trial",
    "trusted": false,
    "payload": {}
  },
  "instruction": "Run pwd and briefly report the working directory.",
  "options": { "waitForFinalOutput": true, "timeoutMs": 180000 }
}
JSON
```

Check `ok: true`, `action: "completed"`, and `output.content`. **A running process or successful health check does not prove task completion.** To follow up, add the first response's `target.sessionId` to the next request's `target`, keeping `kind` and `botId`. This is the Botmux ID, not the Doubao native ID. Preserve the state directory to request resume by the same ID after restarting the service.

The example's `timeoutMs: 180000` is the caller's wait budget, not the whole task runtime limit. If it returns `wait_timeout`, inspect the terminal/logs before resubmitting: the original task may still be running. Stop only the foreground service in terminal A; do not broadly kill other Botmux instances by process name.

## 6. Troubleshooting and current limits

- **Executable missing:** check installation user, daemon PATH, `command -v doubao`, and `cliPathOverride`. Do not put an installation command in the path field.
- **Login screen:** log in through a native terminal as the same user and confirm the account has model access.
- **Model launch error:** check the full display name in native `/model`, or remove `model` to test the default. If automatic discovery fails, static candidates do not prove account entitlement.
- **Terminal answered but HTTP returned nothing:** check for an older Botmux build, readable native logs, captured Session ID, or changed native file format. Do not fabricate completion by editing logs.
- **Resume failure:** check the account, native records, and ID. Moving machines/HOME or deleting records can break recovery. Start a fresh session rather than guessing a sibling conversation's ID.
- **Reasoning effort:** the adapter internally accepts `low/medium/high/xhigh/max`, but Bot configuration loading and `/effort` registration do not currently expose Doubao. Do not rely on `bots.json.reasoningEffort` taking effect. `ultra` has no mapping; native `none/minimal` are not Bot configuration options either.
- **No reply after stopping / a reply lands on the wrong turn:** when stopping with the card ⏹ or `/stop`, a terminal answer written at almost the same moment is not delivered; check the Web terminal or ask again — this is not a lost message. If answers get crossed after interrupting with a **physical Esc in the Web terminal**, or with the **card's Esc quick key pressed while a turn was running** (neither goes through Botmux's stop channel), press the card ⏹ once (or send `/stop`) BEFORE sending your next message to realign the queue. If you have already sent the next message, do not press stop then (it would settle the new turn) — just continue the conversation.
- **Not claimed supported:** a Doubao-specific transcript bridge for existing-terminal `/adopt`, session fork, pure zero-tool model-only APIs, or every native approval/error terminal. Native `-p` runs an Agent; it is not a model-only guarantee.
- **Acceptance scope:** macOS PTY/tmux input, Esc interruption, exact resume, real worker IPC, and core-only HTTP final output/restart follow-up were exercised. Linux path logic has coverage, but native Linux execution and bwrap sandbox are not validated on a real machine. Local HTTP testing does not verify the actual Lark card/click experience.

## 7. Developer regression commands

Use the Bun version pinned in `package.json`, in a checkout whose dependencies are already correctly installed:

```bash
bun run test -- test/doubao-adapter.test.ts test/doubao-transcript.test.ts \
  test/structured-bridge-clis.test.ts test/structured-bridge-spec.test.ts \
  test/cli-id-roster-derivation.test.ts test/local-cli-opener.test.ts
bun run build
BOTMUX_DOUBAO_E2E=1 bun run test:e2e -- \
  test/doubao-input.e2e.ts test/doubao-worker.e2e.ts
```

Native E2E requires installed/logged-in `doubao`, usable model quota, and working PTY/tmux. It executes real model/tool tasks and creates native session records, not a side-effect-free dry run; evaluate before using a production account. Without `BOTMUX_DOUBAO_E2E=1`, native cases are skipped, not passed. Build/unit checks are not all-platform acceptance.
