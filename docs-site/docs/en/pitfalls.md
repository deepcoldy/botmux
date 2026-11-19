# Common Pitfalls and How to Avoid Them

> Problems that keep coming up in the community, roughly ordered by how common they are. **If something misbehaves after installing or upgrading, scan this page first** — it is most likely a known issue. Not sure where to start? Jump to [General troubleshooting approach](#general-troubleshooting-approach) at the end.

## Find it by symptom

| What you see | Which section to read |
|------|------|
| The group gets no messages, the CLI seems to quit mid-session, `botmux history` returns 400 | Bot permissions / app creation |
| `botmux: command not found`, install fails, start is refused | Environment / installation |
| The topic says the CLI is "stuck on folder trust / sign-in / update confirmation" | Environment / installation → first launch stuck on a dialog |
| `API Error 403`, gateway token errors | Lost environment variables |
| Startup fails right away, drops into a shell, `unknown option` | Custom wrapper / gateway integration |
| The model answered in the terminal but nothing reached Lark | Input / submission |
| The bot works on and off, a killed session comes back | Processes / connections |
| The Dashboard won't open | Dashboard / security |

## Bot permissions / app creation (most common)

**Symptoms** vary: the CLI seems to "quit mid-session", the group gets no messages, `botmux history` returns 400… The root cause is usually incomplete bot permissions. It typically comes from one of three things: reusing a bot from an old app, not creating the app with the latest `botmux setup` QR flow, or missing permissions when creating the app by hand.

**Fix**: use the latest `botmux setup` to **recreate** the app by QR code. It configures every permission and publishes a version for you. Don't reuse a bot from an old app, and don't skip permissions when creating one by hand.

## Environment / installation

- **`botmux: command not found` right after installing**: `~/.botmux/bin` isn't on PATH yet. Both the curl and npm installs write it into your current shell's startup file (such as `.zshrc` / `.bashrc`), but **it only takes effect in a new terminal (or after you `source` the file)**. If it still fails, add `export PATH="$HOME/.botmux/bin:$PATH"` to the startup file by hand.
- **npm install fails with `no prebuilt binary package`**: the npm package also installs a self-contained binary now, picked from a per-platform subpackage. If that subpackage didn't land, you get this error. → Try `npm i -g botmux --force` first; if that doesn't help, use the curl install (no Node needed). npm itself requires **Node ≥ 22**.
- **Running from source, `botmux start` / `restart` refuses with "cannot load an SQLite engine"**: the session store needs Node ≥ 22.13 (≥ 23.4 on 23.x) or bun. The check runs **before** the old processes are stopped, so your live bots keep running when it refuses. → Re-run with a suitable interpreter as the message suggests (for example `bun dist/cli.js restart`). Don't use a bare `node`: it follows PATH and may land on an old version again.
- **A `cliId: "gemini"` bot doesn't start**: Gemini CLI is no longer maintained and its adapter has been removed; other bots are unaffected. → Change `cliId` to `"antigravity"` (command `agy`: install it and sign in with a Google account, or configure a Gemini API key), and drop the `cliPathOverride` / `wrapperCli` / `model` you set for Gemini. See [Gemini CLI has been removed](/en/adapters#gemini-cli-has-been-removed).
- **First launch stuck on a dialog**: some CLIs ask on first start "Trust this folder?", "Sign in / update?", "Use the API key found in your environment?" and so on. botmux can't answer these from Lark, so it posts a notice in the topic, such as "⚠️ Claude Code is stuck on a folder trust confirmation". Your message is held back and never typed into the dialog. → Open the Web Terminal (or the local machine) and make the choice; processing continues automatically. Usually you only need to do this once.

## Lost environment variables (high frequency)

- **bash users put variables in `.bash_profile` and sessions don't see them**: botmux starts sessions with `bash -i`, which only reads `.bashrc`. → Add `source ~/.bash_profile` to `.bashrc`, or put the variables straight into `.bashrc`. zsh users use `.zshrc`; fish users use `~/.config/fish/config.fish`. This is the most common cause of `API Error 403` and gateway token errors.
- **Under root, Claude reports "cannot be used with root/sudo privileges"**: Claude Code refuses `--dangerously-skip-permissions` as root. When botmux detects root, it injects `IS_SANDBOX=1` for Claude-family CLIs automatically, so usually there's nothing to do. If your wrapper wipes the environment and the error persists, `export IS_SANDBOX=1` yourself (for PM2 / systemd / Docker, set it in that startup environment).

## Custom wrapper / gateway integration

When you wrap the CLI in your own script (for example to go through an internal gateway), two problems are common:

- **Arguments aren't passed through**: if the script doesn't forward `"$@"` correctly, the CLI never receives arguments like `--session-id`.
- **The script blocks arguments botmux needs**: for example it filters out `--settings`, or reports `unknown option '--images'`. Startup fails and drops into a shell.

**How to pin it down**: get the exact launch command botmux ran and run it yourself. Two ways to get it: click "Copy reproduce command" in the Dashboard session list (it contains credentials such as tokens, so keep it private), or find the `Spawning fresh CLI:` line in `botmux logs`.

## Input / submission

- **A multi-line message gets submitted as several messages**: some TUIs treat newlines and tabs in the prompt as Enter or autocomplete. botmux now types into Codex and CoCo as one bracketed paste. When you send multi-line content with `botmux send` yourself, use a heredoc too.
- **The model answered in the terminal, but nothing reached Lark**: by default, the final reply relies on the model calling `botmux send` itself. Weak or wrapped models tend to forget it, or keep calling it without stopping. → Two options:
  - Use a stronger model, or add firmer prompt constraints;
  - For supported CLIs (Claude Code, Codex, CoCo and others), turn on `replyDelivery: "transcript"`: botmux takes the last answer of the turn straight from the CLI's transcript and posts it to Lark, so it no longer depends on the model calling `botmux send`. See `replyDelivery` in [bots.json Configuration](/en/bots-json).
- **`botmux send --images` with 6 or more images may fail silently**: → Send at most 4 at a time, in batches.

### A message got no response: read the diagnosis card {#submit-failure-diagnosis}

Automatic, nothing to configure. When a message handed to the CLI can't be confirmed for a while, botmux first looks at what the terminal is showing, then posts a card that names the cause (the error code is still `submit_unconfirmed`) instead of a generic "submit could not be confirmed":

| What the card says | What to do |
|---|---|
| The CLI is stuck on a login / auth screen | Open the web terminal, finish the CLI's own login, then resend. CLI login and Lark authorization are separate |
| The CLI is waiting on a keyboard choice (update, data migration, hooks review, a confirm box, …) | Open the web terminal and pick an option, or press Esc to dismiss it, then resend. botmux never chooses for you |
| The text was pasted but is sitting in the input box, not submitted | Open the web terminal and press Enter; resend from Lark only if it really shouldn't run |
| No clear cause | The card reminds you that a failed confirmation doesn't mean it didn't run; check the web terminal first and resend only if it really didn't |

## Processes / connections

- **One Lark bot connected by two programs at once**: whichever grabs the long connection first wins, so botmux works on and off. → Give each bot to one program only.
- **`tmux ls` doesn't show the bot's sessions**: botmux sessions run on their own tmux server, so add `-L botmux`, e.g. `tmux -L botmux ls`. See [Tmux Session Persistence](/en/tmux).
- **After a manual `tmux kill-session`, the session comes back**: the daemon still thinks the session is alive, and the next message brings it back. → To really end it, send `/close` in the topic, or run `botmux delete <session ID>` on the command line.
- **With `defaultWorkingDir` set, every new topic starts a session right away**: that's the expected effect of "skip repo selection" — no repo picker card first. Remove the setting if you don't want it. If the configured directory doesn't exist, botmux won't quietly run somewhere else; it posts a "Working directory not found" card. Pick a directory there and the message starts right away, no need to resend:

  ![The card shown when the working directory is missing](/img/pitfalls-missing-workdir-card-en.png)

- **Running `botmux restart` inside a bot's own terminal, then seeing sporadic token / gateway errors**: the session carries runtime variables (`TMUX`, `LARK_*`, `BOTMUX_*` and so on). botmux scrubs these at its process boundaries, but if you still hit such errors, restart once from a **clean shell that is not inside tmux**.
- **`/repo` numbers shift**: when a new repo joins the list, the numbers after it move. → Don't hard-code numbers in automation; use `/repo <project-name>` or `/repo <path>`.

## Disk / logs

- **`tmux-server-*.log` fills up the disk**: these files only appear when tmux is started with `tmux -v` / `-vv`. They never rotate and can grow to hundreds of GB on a long run. botmux itself never passes `-v`, so you can safely delete them without touching botmux's logs.

## Collaboration

- **Two bots keep @-mentioning each other**: if every message ends with "send to @the other bot", it loops forever. → Usually one side stopping ends it. The real cause is a chatty model, so add constraints.

## Dashboard / security

- **Don't post a Dashboard link with a token into a group**: the token is your login credential; posting it hands the key to everyone in the group. It stays valid until you run `botmux dashboard rotate`, which issues a new token and invalidates old links immediately; `botmux dashboard` and `botmux dashboard current` don't rotate it. For stricter setups, bind the Dashboard to the local machine only: `BOTMUX_DASHBOARD_HOST=127.0.0.1`. More in [Dashboard · What the token in the link is](/en/dashboard#what-the-token-in-the-link-is).
- **The Dashboard won't open**: first run `curl http://<host>:<port>/__health`. If it returns `{"ok":true}`, the service is fine, and the problem is most likely on the browser side: a proxy that isn't bypassed, the wrong host (a Mac's intranet IP may have changed), or an old link whose token has been rotated.

## General troubleshooting approach

When something "won't start" or "behaves oddly", go through these three steps first:

1. **Reproduce the launch command**: use "Copy reproduce command" in the Dashboard, or find the `Spawning fresh CLI:` line in `botmux logs`, and run it by hand. Permission, argument and sign-in problems usually show up right away.
2. **Check the Web Terminal**: open the session's Web Terminal and read the real error from the model or gateway.
3. **Let the agent diagnose**: hand the symptom to your local agent and let it investigate. If you fix something, PRs to the community are welcome.
