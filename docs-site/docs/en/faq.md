# FAQ / Troubleshooting

> Collected from the README and frequent questions in the community group, and updated over time. For more pitfalls, see [Common Pitfalls](/en/pitfalls).

This page is grouped by topic:

| You want to fix | Go to |
|------|------|
| The bot doesn't reply, others can't use it, results never arrive | [The bot doesn't reply](#the-bot-doesnt-reply) |
| Grants, mention policy, adding the bot to groups | [Permissions and mentions](#permissions-and-mentions) |
| Restarts, suspending, interrupting, working directories, terminal won't load on a phone | [Sessions](#sessions) |
| Login errors, upgrades, fonts, wrappers | [Install and environment](#install-and-environment) |

## The bot doesn't reply

Match your **symptom** first — each one has a different cause:

| Symptom | Likely cause | Jump |
|------|-----------|------|
| **No reaction at all** (not even an emoji) | Event subscription, release, or long connection not working | [A. No messages at all](#a-no-messages-at-all) |
| Only **I (the owner)** can trigger it; others get an auth card or no reply | Others have no talk permission | [B. Others can't use it](#b-others-cant-use-it) |
| It **only replies when @-mentioned** and you want it to reply without @ | The group's mention policy | [B. Others can't use it](#b-others-cant-use-it) |
| The card says "working" and the terminal has output, but **nothing reaches Lark** | The model didn't call `botmux send` | [C. Terminal has output but nothing reached Lark](#c-terminal-has-output-but-nothing-reached-lark) |
| The session **won't start**, and the first message errors with `zsh: parse error` | The login shell's startup file switches shells | [Session does not start](#session-does-not-start) |

### A. No messages at all

Check in order (PersonalAgent comes configured; normally you don't need to touch this):

1. **Event subscription**: Open Platform → Events & Callbacks — subscribe to `im.message.receive_v1` and `card.action.trigger`, choose "Long connection (WebSocket)", and make sure the daemon is running.
2. **Bot capability**: Open Platform → App Features → Bot is enabled.
3. **Release**: the app must have a published version ("visible only to me" is approved automatically). After changing permissions or events you **must publish again** for them to take effect.
4. **Long connection taken**: make sure no other program is using the same app's long connection.
5. Once all of that checks out, run `botmux restart` from a clean shell.

> To have an agent investigate, see "General troubleshooting approach" in [Common Pitfalls](/en/pitfalls): use `botmux logs` to find the launch command and reproduce it locally, then check the real error in the web terminal.

### B. Others can't use it

botmux has two permission layers:

- **Talk permission**: who can talk to it.
- **Operate permission**: who can run management commands such as `/cd`, `/restart`, `/close`, and tap card buttons.

By default only people in `allowedUsers` can talk to it. Anyone else who @-mentions it is blocked, and the owner gets a grant request card. **Adding the bot to a group does not grant anyone access.**

| You want to | Do this |
|------|------|
| Let the whole group use it | Send `@bot /grant` in the group, or open the group's manage dialog in Dashboard **Group Management** and click **Whole-chat grant** |
| Let one person try it | `@bot /grant @someone` — 3 messages / 1 hour by default, adjustable on the card |
| Grant several people at once | Multi-select in the Dashboard group member list for a batch grant (up to 50 people) |
| Have it reply without an @ | Change the mention policy with `/mention-mode` — see [Why must I mention the bot in groups?](#why-must-i-mention-the-bot-in-groups) |
| Run duty Q&A with one group per ticket | Use [On-Call Mode](/en/oncall) |
| Block someone | Add them to the blocklist `blockedUsers` in Dashboard **Bot Config**; they're blocked in groups and DMs, with no more request cards |

Full rules: [Permissions & Access](/en/permissions).

### C. Terminal has output but nothing reached Lark

Output printed in the terminal is not the same as a message sent to Lark. For CLIs that send explicitly (Claude Code, Codex CLI, Antigravity, CoCo, and others), the model must run `botmux send` for the group to see anything:

- Every send needs one of `--mention-back`, `--mention`, or `--no-mention`; otherwise it errors and sends nothing.
- If it only uses `echo` / `print`, or forgets `botmux send`, nothing goes out.
- Pass multi-line content with a heredoc; don't write `"line one\nline two"`.

Two cases where the model doesn't need to send by itself:

- **`codex-app`** (the Codex App protocol): botmux forwards the final reply automatically. Don't call `botmux send` for normal replies or they'll be posted twice; use it only for mid-turn progress, attachments, or @-mentioning another bot.
- **Zero prompt injection mode** (`promptInjection: "none"`): botmux picks the final answer from the CLI's transcript and posts it to Lark. See [bots.json](/en/bots-json).

## Permissions and mentions

### How are permissions divided? Who can operate the bot?

| Source | Grants | Notes |
|------|------|------|
| `allowedUsers` | Operate + talk | The owner and admins. Can run management commands, tap buttons, and change `/card` `/cot` `/mention-mode` |
| `allowedChatGroups` (`@bot /grant`) | Talk | Whole group, no quota, no expiry |
| On-call groups | Talk | Whole group, and the group is bound to a working directory |
| `chatGrants` / `globalGrants` (`/grant @someone`) | Talk | Per person, 3 messages / 1 hour by default |
| `blockedUsers` | Deny everything | Takes priority over every rule above |

Quotas, expiry, and request cards are covered in [Permissions & Access](/en/permissions).

### How do I let a whole group use it?

Send `@bot /grant` (same as `/grant all`) in the group:

- The group is added to `allowedChatGroups`, and everyone in it can talk right away — no message limit, no expiry.
- New members get access automatically; people who leave lose it.
- In a topic group it applies to the whole group, covering every topic.
- Revoke with `@bot /revoke`.

The group manage dialog in Dashboard **Group Management** also has a **Whole-chat grant** button. It grants talk only; operate permission stays with `allowedUsers`.

### How do I give someone a few trial messages?

Send `@bot /grant @someone`. The bot replies with a grant card that defaults to **3 messages / 1 hour per person**.

- To set the count directly: `@bot /grant @someone 20`.
- Duration options are 1 hour, 8 hours, 1 day, 7 days, and permanent; leave the quota empty for unlimited.

### What's the difference between on-call and `/grant`?

Both grant talk only, and neither has a quota. The difference is the working directory:

- `/oncall bind <dir>` binds the group to a directory, so new topics skip repo selection and start right away. Good for duty Q&A.
- `/grant` only opens up talking and binds no directory. Good when group members ask questions in topics whose repo is already chosen.

### Why must I mention the bot in groups?

The default policy is `always`: in regular groups the bot replies only when explicitly @-mentioned, so bots don't talk over each other in groups with several bots or people. Send `/mention-mode` in the group to change it:

| Mode | Effect |
|------|------|
| `always` (default) | @ required |
| `topic` | No @ needed for replies inside its own topics |
| `never` | No @ needed anywhere in the group |
| `ambient` | No @ needed, but it stays quiet when someone else is named |

- Changing it requires operate permission and works in regular groups only.
- A "1 person + 1 bot" group needs no @ by default; you can turn that exception off with `soloGroupMentionBypass`.
- A few more exceptions exist (message listeners, no-@ commands, and so on). See [Mention Policy](/en/mention-mode) for the full list.

### How do multiple bots work together?

It works out of the box — add the bots to the same group:

- Just you and one bot: talk to it directly, no @ needed.
- A group with several bots or people: @ the bot you want to hand the work to.
- Bot-to-bot relays (say, one writes and another reviews): the bots @ each other; you only hand the work to the first one.

See [Multi-bot Collaboration](/en/multi-bot).

### Can I stop people from adding the bot to groups?

Not from botmux. "Who can add the bot to a group" is controlled by the Lark platform (app availability, who can add bots to groups). What you can do on the bot side:

- **Don't auto-start when added**: turn off **Auto-start when added to a new chat** (`autoStartOnGroupJoin`) under Dashboard **Bot Config → Proactive Start**. Even when it's on, the group must contain at least one person from `allowedUsers`.
- **Stay restricted**: being added is not a grant. People without access are blocked when they @ it, and the owner gets a request card.
- **Don't pull the owner into new groups**: by default, when the bot is added to a new group it also adds the owner (`autoInviteOwnerOnGroupAdd`). If an alert or on-call platform creates groups in bulk and the owner shouldn't be disturbed, turn off **Add the owner to chats the bot joins** under **Bot Config → Proactive Start**, send `/botconfig set autoInviteOwnerOnGroupAdd off`, or edit `bots.json`.

### Can a bot added to a new group read earlier chat history?

Yes. Tell it "look at the chat history", or quote a specific message. The Lark app needs its full permission set (including reading group messages).

### A regular group is too noisy — can I switch it to a topic group?

Yes, but the group owner or a group admin has to do it: Group Settings → Group Management → Message format → "Topic messages". The bot can't change group settings for you.

## Sessions

### Does restarting the daemon lose context?

Not with the default tmux backend. The CLI keeps running inside tmux, and after `botmux restart` the next message reattaches to the same process.

- Without tmux installed, botmux does **not** quietly fall back to pty; it shows a card asking you to install tmux first.
- pty is used only when you explicitly set `BACKEND_TYPE=pty` (or `backendType: "pty"` for one bot). pty sessions **don't survive a daemon restart** and have to be relaunched.

### What happens to work in progress when the CLI restarts mid-way?

When the CLI exits unexpectedly (a crash, the tmux server going away, and so on), botmux relaunches it with the previous context and reads the transcript the old process left behind to see whether work was cut off:

- **the previous turn hadn't finished**, such as a review half-way through;
- **background tasks died with the old process**, such as Claude Code background commands, Monitors, or background agents.

If so, the resumed CLI first gets a short note (it was just restarted, which background tasks were interrupted, check and continue), and one notice appears in the topic. Nothing is posted when nothing was interrupted.

- The same check runs on a cold resume after a suspend or a daemon restart; the note is placed in front of the next message to the CLI. CLIs that take the first message as a launch argument, such as Pi, only get the topic notice.
- Only the transcript is read, never the screen. This covers Claude Code, plus CLIs with structured transcripts such as Pi and Codex (for those, only whether the turn finished).

**Messages not yet handed to the CLI aren't lost:**

- A first message passed as a launch argument, where the CLI exited before starting on it, is typed in again after the restart.
- Messages still queued when the daemon restarts are delivered by the session's next worker.
- Messages older than 24 hours aren't re-delivered; the topic says they weren't delivered instead. The same happens when another restart interrupts re-delivery and delivery can't be confirmed.
- A message the CLI had already received and started on is not typed in again; the note above reminds it to continue. It is re-sent only when the restart has to open a new session without the old context.

### Does a session use memory forever if I don't close it?

No. Each bot has two automatic limits. A reclaimed session is "suspended": the CLI process exits and frees memory, but the topic stays, and the next message restores the context from disk (usually within a few seconds).

| Rule | Default | Where to change it |
|------|------|------|
| Max resident sessions: beyond this, the least recently used session is suspended | 30 | Dashboard **Bot Config → Resident session limit**, or `maxLiveWorkers` in `bots.json` |
| Idle auto-suspend: suspend after N minutes of continuous idle | Off | **Idle auto-suspend (minutes)** in the same place, or `idleSuspendMinutes` in `bots.json` |

- A session that is producing an answer is never interrupted.
- A session whose main turn has ended while background tasks keep running (the card shows "⏳ Main turn ended · background tasks running") isn't suspended either — suspending would kill those tasks, and they can't be brought back.
- Adopted external terminals and sessions that can't be resumed are exempt.

To clean up by hand:

| You want to | Command |
|------|------|
| Preview, then bulk-suspend sessions idle for 7 days | `botmux maintenance suspend-idle --older-than 7d --dry-run`, then replace `--dry-run` with `--yes` |
| Close one session | Send `/close` in the topic, or `botmux delete <id>` |
| Close all sessions | `botmux delete all`, or batch-close in the Dashboard |
| Clean up sessions whose process already exited | `botmux delete stopped` |

More commands: [CLI Commands](/en/cli-commands).

### Can I follow up or interrupt a running session?

By default it doesn't interrupt. New messages queue up and are entered in order after the current turn ends.

To stop and change course right away:

- Tap **⏹ Stop** on the card, or send `/stop` in the topic. It interrupts only the current turn; the session and its context stay.
- When the card shows the terminal screenshot, you can also tap the `Esc` or `^C` keys; in the web terminal you can press keys directly.

Then send your new request.

### Wrong working directory or repository?

- `workingDir` searches for git repos **downward** from that directory (up to 3 levels), never upward. Point it at a folder with many repos (such as `~/projects`) to list them all; point it at one repo to list only that repo (and its worktrees).
- Switch directories temporarily: `/cd <path>`.
- Skip the repo picker and go straight into one repo: set `defaultWorkingDir` (see side effects in [Common Pitfalls](/en/pitfalls)).
- Don't set `workingDir` to `~` — there are too many folders to scan.
- `/repo` numbers can change; use `/repo <project-name>` to pick a repo.

### Session does not start

Symptom: the session never starts, or the first message errors with `zsh: parse error near '\n'`.

Usually your login shell (`$SHELL`, often bash) has a "switch to another shell" line in its startup file. The classic one is in `~/.bashrc`:

```bash
if [ -t 1 ]; then exec zsh; fi   # common when chsh doesn't take effect
```

botmux starts the session inside tmux with `<$SHELL> -i -c '…start the CLI'`. `-i` loads that startup file, `exec zsh` replaces the shell, and the command that starts the CLI never runs — so the first message lands in an empty shell. botmux detects this and posts a diagnostic card instead of typing the message into the empty shell.

Pick one fix:

- **Set `launchShell` (recommended)**: start this bot directly with the target shell, skipping the startup file that switches shells.
  - In Lark, send `/botconfig set launchShell zsh`;
  - or fill it in under Dashboard **Bot Config → Launch shell**;
  - or add `"launchShell": "zsh"` to `bots.json`.

  PATH, nvm, and the like must live in the chosen shell's own startup file (such as `.zshrc`; for fish, `~/.config/fish/config.fish`).
- **Fix the startup file**: only switch when you open a terminal by hand: `[ -z "$BASH_EXECUTION_STRING" ] && [ -t 1 ] && exec zsh` (put PATH, nvm, etc. before this line).

Then run `botmux restart` and send another message. This only affects backends that start through a shell (`tmux` / `zellij` / `zmx`); the `pty` backend starts the CLI directly and isn't affected.

### The Workbench or terminal won't load on my phone?

If it works on your computer but on your phone the Workbench is blank or the terminal never shows up, open `<your Dashboard address>/workbench-doctor` in the phone's browser.

- This self-check page needs no sign-in. It checks the service version, sign-in state (cookies), the terminal link and the live connections on its own.
- When it finishes, send a screenshot to the bot or a maintainer. It shows whether the cause is the network, the sign-in state or a stale cache.
- The page never shows any token or secret, so the screenshot is safe to share.

For what each check means, see [Agent Workbench · Phone won't load it? Use the self-check page](/en/workbench#phone-wont-load-it-use-the-self-check-page).

## Install and environment

### How do I upgrade?

The safest way is to **re-run the install command**, no matter how you installed originally (npm / pnpm global installs included):

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
```

- It replaces `~/.botmux/bin/botmux` in place. The download is test-run on your machine first; if it can't run, the installer errors out and **keeps your current version**.
- You can run it again safely: it won't add PATH twice, and it doesn't need Node.
- Afterwards, **open a new terminal** and run `botmux restart`. The installer puts `~/.botmux/bin` at the front of PATH, and only a new terminal is guaranteed to pick up the new version.
- The `botmux` command inside sessions always matches the daemon version; no separate upgrade needed.

On v3.18.0 or later you can also use the built-in command:

| You want to | Command |
|------|------|
| Upgrade to the latest stable release | `botmux update` (`botmux upgrade` is the same) |
| Switch to a preview channel | `botmux update canary` (`beta`, `rc`, `next` also work) |
| Install a specific version | `botmux update 3.28.0` |

Install a specific version with curl (same for rollback or pinning; the tag needs the `v`):

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | BOTMUX_VERSION=v3.18.8 sh
```

> ⚠️ `BOTMUX_VERSION` must come right before the `sh` on the **right** of the pipe. If you write `BOTMUX_VERSION=… curl … | sh`, only curl sees the variable, `sh` doesn't, and you silently get the latest version.

#### Why can releases older than v3.18.0 only upgrade via curl?

From v3.18.0 the npm package switched from "Node + source" to **platform binaries**, and `node-pty` left the dependencies. Old releases' `botmux upgrade` handed the job to npm: crossing this version, npm deletes `node-pty` from the old directory, but the old daemon still loads it on restart, fails with `ERR_MODULE_NOT_FOUND`, and none of the bots come back (the output may already say "restarting to apply the update"). curl drops in the new binary without relying on the old directory, so it's the one safe way across this version. If you're not sure how you installed, just use curl.

### How do I fix `Please run /login · API Error: 403`?

First work out which side wants a login:

- **Lark authorization rejected** (calling Lark APIs as the user failed): send `/login` in the topic, open the authorization link, then copy the address the browser lands on (`http://127.0.0.1:9768/callback?...` — it's normal that the page doesn't load) back into the topic.
- **The model gateway returns 403**: unrelated to Lark; usually an environment variable or gateway token problem. A common cause is bash users putting variables in `.bash_profile`, which `bash -i` doesn't read (see [Common Pitfalls](/en/pitfalls)).

**claude keeps asking for `/login` on macOS**

claude stores its login token in two places, and the two drifting apart is the main reason for `Please run /login` on macOS:

| Where | Who uses it |
|------|------|
| Keychain item `Claude Code-credentials` | claude running in the GUI, and botmux's default (non-isolated) setup |
| File `~/.claude/.credentials.json` | Running `/login` over SSH can only write here |

As long as the keychain item exists, claude reads only the keychain, never the file. So "`/login` over SSH succeeded (it only wrote the file), but the GUI and the bot still use the old keychain token". On top of that, claude rotates the token on refresh, so whichever side refreshes first invalidates the other, and everyone gets logged out.

Stick to the file as the only source:

1. Don't use claude code in the GUI; it writes the token to the keychain.
2. Always update the token by running `/login` over SSH.
3. If an old keychain item already exists, delete it.

### `botmux history` returns 400, or the Lark gateway returns 411?

- **400**: usually the Lark app is missing a permission (such as `im:message.group_msg`). Enable the full permission list.
- **411**: older versions sent GET requests with an empty body, which the Lark gateway rejects. Upgrade to a newer version.

### Does it support Lark (international, larksuite.com)?

Yes. Both Feishu (feishu.cn) and Lark (larksuite.com) work:

- When you scan to create an app, China vs. international is **detected automatically**; when you paste the AppID / Secret by hand, you choose once.
- Each bot connects to the domain of its own edition. One machine can run Feishu and Lark bots side by side, with separate login credentials.

### Can I launch the CLI through ccr, a custom gateway, or a wrapper?

Yes. Write a wrapper script that passes its arguments (`"$@"`) straight through, then set `cliPathOverride` to that script's path when editing the bot in `botmux setup`.

### Chinese characters or emoji show up as boxes in screenshots?

Fonts are missing. On Debian / Ubuntu the daemon tries to install `fonts-noto-cjk` and `fonts-noto-color-emoji` automatically (needs root or passwordless sudo). On other Linux distributions, install Noto CJK and Noto Color Emoji by hand, then restart the daemon.

### A bot with `cliId: "gemini"` no longer starts?

Gemini CLI has been retired and the `gemini` adapter removed. That bot refuses to start with a hint to switch to Antigravity; other bots keep running. To migrate:

1. Install `agy` and sign in with a Google account (or set `modelProvider: "gemini"` in `~/.gemini/antigravity-cli/settings.json` and provide `GEMINI_API_KEY`).
2. Change `cliId` to `"antigravity"` (in `bots.json` or with `botmux setup`).
3. Run `botmux restart`.

The old `cliPathOverride` / `wrapperCli` (such as `ttadk gemini`), Gemini `model` names, and `GEMINI_CLI_HOME` don't carry over. See [CLI Adapters](/en/adapters).

### Messages sent while CoCo is busy get lost?

Upgrade to **CoCo 0.120.32 or later**. Messages sent while it's busy go into CoCo's own queue, which relies on that version's behavior.

### Does it work on Windows?

Native Windows isn't supported: the daemon only runs on Unix-like systems, and there's no Windows build (neither curl nor npm can install one). Install inside **WSL2** and follow the Linux steps there.
