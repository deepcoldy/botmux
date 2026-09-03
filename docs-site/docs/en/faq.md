# FAQ / Troubleshooting

> Compiled from the README and high-frequency questions in the community group, and continuously expanded. For more pitfalls, see [Common Pitfalls](/en/pitfalls).

## Troubleshooting "the bot doesn't reply" (the #1 question)

Match your **symptom** first — the root cause differs:

| Symptom | Likely cause | Jump |
|------|-----------|------|
| **No reaction at all** (not even an emoji) | Event subscription / release / long connection not working | [A. No messages received at all](#a-no-messages-received-at-all) |
| Only **I (owner)** can trigger it; others get an auth card / no reply | Only operate permission granted, no talk permission | [B. Others can't use it / auth card](#b-others-cant-use-it--auth-card) |
| Must **@ it** to get a reply / want auto-reply without @ | Group @ policy | [B. Others can't use it / auth card](#b-others-cant-use-it--auth-card) |
| Shows 🟡 "working" but **the result never comes back** (terminal has output) | Terminal CLI session: model didn't call `botmux send` (`codex-app` auto-forwards — it's the exception) | [C. Terminal has output but nothing sent to Lark](#c-terminal-has-output-but-nothing-sent-to-lark) |
| Session **won't start** / first message errors `zsh: parse error` | Login shell startup file jumps shells | [Session won't start](#sessions-never-start--the-first-message-errors-with-zsh-parse-error-near-n) |

### A. No messages received at all

Check these in order (PersonalAgent comes configured correctly by default; normally you don't need to touch it):

1. **Event subscription**: Open Platform → Events & Callbacks → subscribe to `im.message.receive_v1` + `card.action.trigger`, with delivery method "Long connection (WebSocket)", and the daemon must be running.
2. **Bot capability**: Open Platform → App Features → Bot should already be enabled.
3. **Release**: the app must have a version created and published (availability "visible only to myself" passes automatically). After changing permissions / events you **must re-publish** for them to take effect.
4. **Exclusive long connection**: confirm this bot isn't having its long connection grabbed by another app.
5. After confirming, run `botmux restart` (from a clean shell).

> To have an agent triage it, see [Common Pitfalls · General troubleshooting approach](/en/pitfalls#general-troubleshooting-approach) (`botmux logs` to find the spawn command and reproduce locally + the web terminal for the real error).

### B. Others can't use it / auth card

botmux has two permission layers (see [permissions](#how-are-permissions-divided-who-can-operate-it)): **talk permission** (who can ask) and **operate permission** (who can `/cd` `/restart` / tap buttons). By default only the owner has talk permission, so others get refused / see an auth card.

- **Let a whole group use it**: give the bot `allowedChatGroups` (everyone in that group can talk), or authorize a specific group with `/grant`.
- **Group @ policy** (must-@ vs no-@): multi-person groups require @ by default; no-@-in-topic / no-@-whole-group can be configured in the group @ policy. Note a 1-on-1 "you + 1 bot" group is @-free already.
- **On-call scenario** (a new group per ticket, everyone asks @-free): see [On-Call Mode](/en/oncall).

### C. Terminal has output but nothing sent to Lark

**This applies only to terminal CLI sessions that require explicit sending** (Claude Code / Codex CLI / Gemini / CoCo, etc.): terminal stdout ≠ sent to Lark, so the model must explicitly run `botmux send` (with one of `--mention-back` / `--mention` / `--no-mention`) for the group to see it. Just `echo`ing/`print`ing or forgetting `botmux send` means nothing goes out. Use a heredoc for multi-line content; don't write it as `"line one\nline two"`.

> ⚠️ **Exception: `codex-app` (Codex App app-server protocol)** — its final assistant message is **auto-forwarded** back to Lark by botmux, so **don't call `botmux send` for normal replies** (that would double-send); use it only for mid-turn pushes / attachments / cross-bot @mentions.

## `botmux history` reports 400 / Lark gateway 411?

- **400**: Usually a missing Lark bot permission (such as missing `im:message.group_msg`) → enable the full permission JSON.
- **411**: The Lark gateway is stricter about "GET requests with an empty body"; older SDKs attach a `{}` body to GET, which triggers it → upgrading to a newer version fixes it.

## How do I resolve `Please run /login · API Error: 403`?

First figure out which `/login` it is:

- **Lark-side App Token rejected when calling the API**: Send `/login` in the topic → click the authorization link → copy the callback URL the browser redirects to (`http://127.0.0.1:9768/callback?...`; it's normal for the page not to load) back into the topic.
- **Model-gateway-side 403**: This is unrelated to Lark authorization and is usually an environment-variable / gateway-token issue. A common root cause is bash users putting variables in `.bash_profile` where `bash -i` doesn't read them (see [Common Pitfalls](/en/pitfalls)).

**macOS note: claude's login token has two stores — keychain and file — and a split between them is the main reason claude shows `Please run /login` on macOS.**

- **keychain** (the keychain item `Claude Code-credentials`): used by **claude running in the GUI** and by **botmux's default (non-isolated) config**;
- **file** (`~/.claude/.credentials.json`): running `/login` over **SSH can only write here**.

The catch: **as long as the keychain item exists, claude reads the token from the keychain and never reads the file** — even when the file holds the freshly updated token. So you get "SSH `/login` clearly succeeded (it only wrote the file), yet the GUI / non-isolated bot still reads the stale keychain token and says `Please run /login`." On top of that, claude rotates the refresh token on each refresh, so whichever process refreshes first invalidates the other's token, dropping everyone's login.

**Recommended (converge onto the file as the single source):**

1. **Don't use claude code in the GUI** — the GUI writes / refreshes the token into the keychain, creating a second source out of nowhere;
2. **Update the token by running `/login` over SSH**, so both SSH and botmux use the file as the login-token source;
3. If a stale keychain item already exists, delete it to converge onto the single file source.

## Does it support Lark (international, larksuite.com)?

Yes. Both Feishu (feishu.cn) and Lark (international, larksuite.com) work: when you scan to create an app, the tenant type (China / international) is **detected automatically** and remembered; when you paste the AppID/Secret manually, it asks you to choose once. Each bot independently connects to the corresponding domain based on its edition, and the same machine can run Feishu and Lark bots simultaneously, with login credentials isolated per app and not interfering with each other.

## How do multiple bots collaborate with each other?

**It works by default — no extra setup.** Just add the bots you want to collaborate to the same group.

- **Just you and one bot**: talk to it directly; it responds automatically, no @ needed.
- **A group with multiple bots / people**: @ the bot you want to hand the work to.
- When bots need to relay (e.g. one writes, one reviews), the bots @ each other to pass it along — you just hand the work to the first one.

See [Multi-bot Collaboration](/en/multi-bot) for details.

## Does restarting the daemon lose context?

With **tmux** installed, no — tmux is the default backend, the CLI process stays resident in a tmux session, and after `botmux restart` the next message automatically re-attaches, with no need for `--resume`. ⚠️ Without tmux it does **not** silently downgrade to pty; it hard-gates and posts a card asking you to install tmux. Only an explicit `BACKEND_TYPE=pty` (or per-bot `backendType:"pty"`) uses pty, and pty sessions **do not survive daemon restarts** — a restart reloads everything.

## Does a session keep running if I don't close it? Is there automatic reclamation?

It keeps running, and there is **currently no idle-TTL automatic reclamation**. Use `/close`, batch-close via the Dashboard, or `botmux delete stopped`/`all` to clean up.

## Wrong working directory / repository selection?

- `workingDir` searches for git repositories **downward** from that directory (up to 3 levels) and doesn't scan upward. Pointing it at a collection root (such as `~/projects`) lists them all; pointing it at a single repository lists only that repository (including worktrees).
- To switch directories temporarily, use `/cd <path>`; to skip the selection card and connect directly to a repository, use `defaultWorkingDir` (note the side effect described in the pitfalls).
- Don't set `workingDir` to `~`, as it will traverse too many folders. `/repo` numbers drift, so use `/repo <project-name>` to specify.

## How are permissions divided? Who can operate it?

Three layers: `allowedChatGroups` / `globalGrants` grant **conversation rights** (everyone in the group can ask); `allowedUsers` grants **operation rights** (only the owner can `/cd`, `/restart`, `/close`, click buttons). When `allowedChatGroups` is configured, `allowedUsers` must have at least one owner.

## Can I ask a follow-up / interrupt a running session?

By default it doesn't interrupt the current turn; new messages are queued (type-ahead) and entered in order after the current turn ends. To correct course immediately: first click `Esc` in the card / Web Terminal to interrupt, then ask.

## Can I launch the CLI with ccr / a custom gateway / various wrappers?

Yes. For any "native CLI + wrapper / gateway" combination, write a wrapper script that passes `"$@"` through, then set `cliPathOverride` to that script's path when editing the bot in `botmux setup`.

## Sessions never start / the first message errors with `zsh: parse error near '\n'`?

This usually means your login shell (`$SHELL`, often bash) has logic in its startup file that "switches to another shell" — most typically in `~/.bashrc`:

```bash
if [ -t 1 ]; then exec zsh; fi   # a common hack when chsh doesn't take effect
```

botmux launches the session inside tmux via `<$SHELL> -i -c '… start the CLI'`. The `-i` sources that startup file, so `exec zsh` replaces the shell before the command that actually starts the CLI ever runs — the pane is left at a bare shell, and the first message typed into it produces `zsh: parse error`.

Since v2.95.0 botmux detects this "the session never really started" state and posts a diagnostic card instead of typing the message into the bare shell. Two ways to fix it:

- **Set `launchShell` (recommended)**: tell the bot to launch directly under the target shell, bypassing the trampolining startup file. `/config launchShell zsh`, or the dashboard ("Bot defaults → Launch shell"), or add `"launchShell": "zsh"` to `bots.json`. Note: PATH / nvm etc. must then live in the chosen shell's startup files (e.g. `.zshrc`, or `~/.config/fish/config.fish` for fish, which is supported as a first-class launch shell).
- **Fix the startup file**: guard the switch so it only fires for a real interactive terminal: `[ -z "$BASH_EXECUTION_STRING" ] && [ -t 1 ] && exec zsh` (put PATH / nvm exports before it).

Then `botmux restart` and resend a message. This affects shell-wrapped persistent backends (`tmux` / `zellij` / `zmx`); the `pty` backend launches the CLI directly and is immune.

## Can a bot added to a new group see the earlier chat history?

Yes. Just tell it "look at the chat history", or quote a specific message. The prerequisite is that the Lark bot's permissions are fully enabled (including group message reading).

## Are Chinese characters / emoji rendered as boxes in screenshots?

Missing CJK fonts. On Debian/Ubuntu the daemon will try to auto-install `fonts-noto-cjk fonts-noto-color-emoji` (requires passwordless sudo or root); on other Linux distributions, install Noto CJK + Noto Color Emoji manually and restart the daemon.

## A regular group has too many messages — can I switch it to a topic group?

Yes, but it requires action by the group owner / admin: Group Settings → Group Management → Group Message Format → select "Topic messages". A bot cannot change the group's settings on your behalf.

## Does it work on Windows?

It hasn't been verified on native Windows, but WSL2 should be fine.

## How do I upgrade?

`botmux upgrade` — it routes by how you installed: a curl install gets its binary replaced in place, an npm install is handed back to `npm i -g botmux@latest`. curl users can equally just re-run the install command (also an in-place upgrade, and it won't write a second PATH line). The `botmux` wrapper version inside sessions always stays in sync with the daemon, so it doesn't need to be upgraded separately. Run `botmux restart` afterwards to pick up the new version.

## CoCo loses messages while busy?

Upgrade to **CoCo ≥ 0.120.32** — type-ahead (messages received while busy go into CoCo's own queue) depends on that version's behavior.
