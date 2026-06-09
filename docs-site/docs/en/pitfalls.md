# Common Pitfalls and How to Avoid Them

> High-frequency, battle-tested pitfalls from the community group, sorted by how often they occur and their impact.

## Environment / Installation

- **Node too old**: v18 and similar lack a built-in global `fetch`, so `botmux setup` throws `fetch is not defined` / `fetch failed` and won't write `bots.json`. → Upgrade to **Node ≥ 22**.
- **Newer tmux causing the CLI to exit mid-session**: Homebrew / source-compiled 3.6a and the like. The symptom is that after creating a new session, the CLI exits when input reaches a newline, and `tmux send-keys ... Enter` errors out. → Uninstall the Homebrew tmux and switch to the stable version that ships with your system (e.g., 3.3a).
- **First launch stuck on a manual confirmation**: On first run, a CLI (such as Claude Code) pops up a "trust this directory / bypass permissions" confirmation. If nobody has clicked through it, it hangs and reports a `tmux send-keys` error. → Confirm it manually once, and it won't appear again.

## Lost environment variables (high frequency)

- **bash users who put variables in `.bash_profile` don't get them**: A new worker starts with `bash -i`, and `bash -i` only reads `.bashrc`. → In `.bashrc`, run `source ~/.bash_profile`, or just put the variables directly in `.bashrc` (zsh users use `.zshrc`). This is a common root cause of `API Error 403` / gateway token errors.
- **Claude refuses `--dangerously-skip-permissions` under root**: It reports "cannot be used with root/sudo privileges". → `export IS_SANDBOX=1` (zsh in `.zshrc`, bash in `.bashrc`; for PM2 / systemd / Docker scenarios, configure it in the corresponding startup environment). Newer versions already inject this automatically for the root scenario.

## Custom wrapper / gateway integration

- **The wrapper doesn't pass arguments through**: When wrapping CLI startup with a gateway script, if `"$@"` isn't passed through correctly, the CLI won't receive arguments like `--session-id`. → Run `botmux logs`, find the `Spawning fresh CLI:` line, copy the full command, and reproduce it locally to pin down the issue.
- **The wrapper blacklists botmux's arguments**: For example, blocking `--settings` or reporting `unknown option '--images'` will cause startup to fail and drop into a shell. → Run that spawn command manually in your local shell to locate the problem, then allow the relevant arguments through.

## Input / Submission

- **A multi-line message gets split into multiple submissions**: Some TUIs (Codex / CoCo) treat the `\n` and `\t` inside a multi-line prompt as Enter / autocomplete keys and submit line by line. → Newer versions have switched Codex input to bracketed paste to work around this (consistent with CoCo). When you write multi-line `botmux send` yourself, always use a heredoc too.
- **"Forgetting" to send messages to Lark after context compaction**: CLIs without a persistent system prompt (CoCo / Codex / Gemini / OpenCode) only inject the routing instructions in the first message of a topic. Once the context is compacted, the routing block is lost and the model answers directly in the terminal instead of sending to Lark. → Newer versions re-inject the full routing block on every follow-up for these CLIs; using a stronger model also helps.
- **Weak models / wrapped models don't call `botmux send`**: They easily forget to call it, or keep calling it repeatedly without stopping. → Use a SOTA model, or add stronger prompt constraints.
- **`botmux send --images` with ≥ 6 images may silently fail**: → Send ≤ 4 at a time, in batches.

## Processes / Connections

- **One Lark bot wired to two apps both competing for the long connection**: Whichever grabs the websocket first owns it, which makes botmux work intermittently. → One bot should connect to only one long-connection app.
- **After `tmux kill-session`, the session gets brought back up**: The daemon still considers it active. → Use `botmux delete`.
- **Once `defaultWorkingDir` is configured, every single message spins up a new session**: This is a side effect of "skipping repository selection". → If you don't want it, remove that config.
- **Codex 0.131+ headless reports a desktop attach socket error**: `features.apps` is enabled by default and tries to connect to the desktop. → botmux already adds `--disable apps` to the Codex it launches to work around this.
- **Running `botmux restart` inside botmux's own tmux pane**: Runtime variables (`TMUX` / `LARK_*` / `BOTMUX_*`) get inherited and pollute the daemon, causing sporadic token / gateway errors. → Restart the daemon from a **clean, non-tmux shell**.
- **`/repo` repository numbers drift**: Adding a new repository to the list shifts the numbering. → Don't hard-code numbers in automation; use `/repo <project-name>` or specify a unique path.

## Disk / Logs

- **`tmux-server-*.log` filling up the disk**: These are only produced when tmux is started with `tmux -v`/`-vv`, have no automatic rotation, and can grow to hundreds of GB over a long run. botmux itself never uses `-v`, so these files can be safely deleted without affecting botmux logs.

## Collaboration

- **Two bots @-mentioning each other in an infinite loop**: Each message ending with "send to @the other bot" loops forever. → Usually one side stopping on its own resolves it; fundamentally this is chatty model behavior, so add constraints.

## Dashboard / Security

- **Don't post a token-bearing dashboard URL into a group** (it's equivalent to publicly exposing a temporary access credential). For security-sensitive scenarios, bind the host to the local machine: `BOTMUX_DASHBOARD_HOST=127.0.0.1`. The token is single-use; each run of `botmux dashboard` regenerates it and the old link becomes invalid immediately.
- **Dashboard won't open**: First run `curl http://<host>:<port>/__health`; a `{"ok":true}` response means the service is healthy. The problem is usually a browser proxy / wrong host (a Mac's intranet IP can change) / opening a link with an old token.

## General troubleshooting approach

For any "won't start locally / behaving abnormally" issue, follow these three steps first:

1. Run `botmux logs`, find the `Spawning fresh CLI:` line, copy the full command, and run it manually in your local shell to reproduce it (the fastest way to pin down permission / argument / login-state issues).
2. Open the Web Terminal to see the model's / gateway's real error at a glance.
3. Hand the symptom to the local agent and let it self-diagnose; the community welcomes PRs.
