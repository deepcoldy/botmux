# File Sandbox

A write-isolation mechanism for safely opening an AI coding CLI to **semi-trusted** users — typically paired with [On-Call Mode](/en/oncall).

With the sandbox on, when people in a topic ask the bot to change code or run commands, **every write is isolated**: not a single byte of your real files is modified. Yet the bot still reads the **real** project / config / login state and works natively (it has no idea it's sandboxed). When it's done, the **owner reviews a diff card** and either applies the changeset back to the real repo or discards it.

Ideal for exposing an on-call bot to not-fully-trusted group members or external collaborators: let them use AI to make changes without risking your real repo getting clobbered.

## What it does / doesn't do

| | |
|---|---|
| ✅ **Write isolation** | Every write the bot makes (edit / create / delete files, run a build) lands in an isolated layer — your real files are **never modified** |
| ✅ **Native reads** | The bot reads the **real** filesystem — real project, real CLI config / proxy env — so deps and toolchain all work; the CLI "just works" |
| ✅ **Login persists** | The CLI's auth directory is **bound for real** — logging in or refreshing tokens inside the sandbox sticks (you won't lose your login); project edits stay isolated |
| ✅ **Zero-copy, disk-light** | Built on overlayfs — **no project clone**; only the files actually changed use extra disk |
| ✅ **Review before landing** | The owner reviews the diff + a patch file, then `git apply`s it back to the real repo — or discards it |
| ❌ **Reads are NOT isolated** | By default the bot can read **every local file** (incl. `bots.json`, `~/.ssh`, any credentials). Masking sensitive paths requires explicit per-bot config (see "Privacy masking" below) |
| ❌ **Network is NOT isolated** | The sandbox can reach the network / proxy normally — egress is unrestricted |

> **In one line**: this is "**prevent accidental writes + make every change reviewable**" isolation, not a "block everything" security jail. It guarantees your real repo is never polluted by writes inside the sandbox, and every change needs the owner's sign-off before landing. It does **not** stop the bot from reading local files or hitting the network — mask sensitive content with the mechanism below.

## Enabling it

> **Prerequisite**: **Linux** (relies on bubblewrap + overlayfs). **Both root and non-root work** — root uses the faster kernel overlayfs, non-root automatically falls back to fuse-overlayfs. **Dependencies (bubblewrap / fuse-overlayfs) are auto-installed when you turn the sandbox on** — no need to pre-install; if the environment lacks auto-install permission, it prints a one-line manual command. Mac (sandbox-exec) is on the roadmap, not yet supported.

### Option 1: bots.json

Add to a bot's config:

```jsonc
{
  "name": "oncall-bot",
  "cliId": "claude-code",
  "sandbox": true,                          // enable the file sandbox
  // optional: mask sensitive paths the bot shouldn't read (default empty = all readable)
  "sandboxHidePaths": ["~/.ssh", "~/.botmux/bots.json"]
}
```

See [bots.json reference](/en/bots-json).

### Option 2: Dashboard

Go to the Dashboard **Bot Config** page, toggle **File Sandbox** on, and save.

> **Decided per session**: toggling the sandbox on/off only affects **new topics**. Sessions already running keep their original decision — restarting the daemon will **not** retroactively drag historical sessions into the sandbox.

## Landing changes (`/land`)

After the bot has made its changes in the sandbox, the **owner** sends in the topic:

```
/land
```

You get a **"Sandbox changes → land"** card:

- **Change summary**: N files (+x / −y), plus the target repo path
- **Diff preview**: project-relative paths + real added/removed lines; truncated if long
- **A full `.patch` attachment**: `git apply`-able, good for large changesets / line-by-line offline review
- **"Apply to disk" / "Discard" buttons**: **owner-only**

Click **Apply to disk** → the isolated changeset is `git apply`'d back to the real repo; **Discard** → the change is thrown away. **Until you apply, the real repo is completely untouched.**

> Verified against the hardest case: a sandboxed bot edited botmux's **own running source** and rebuilt it — the live production processes were completely unaffected; all changes stayed in the isolated layer until `/land`.

## Privacy masking (`sandboxHidePaths`)

By default the sandbox does **not** restrict reads — the bot can see every local file. If some paths shouldn't be readable by a semi-trusted on-call bot (private keys, secret configs, other projects), configure per-bot in `bots.json`:

```jsonc
"sandboxHidePaths": ["~/.ssh", "~/.aws/credentials", "/etc/some-secret"]
```

Listed paths are masked with an **empty dir / empty file** inside the sandbox. **There is no default** — without config, everything is readable (including `bots.json`). Decide what to mask based on how much you trust the group members.

## Caveats

1. **Linux only**: needs bwrap + overlayfs (non-root automatically uses fuse-overlayfs, deps auto-installed when you enable the sandbox); Mac (sandbox-exec) not yet supported.
2. **Reads aren't isolated**: everything is readable by default — mask sensitive credentials with `sandboxHidePaths` (above).
3. **Network isn't isolated**: the sandbox can reach the network / local proxy; egress is unrestricted.
4. **Build artifacts join the changeset**: if the bot runs `pnpm build` / compiles inside the sandbox, the artifacts (e.g. `dist/`) also show up in the `/land` changeset. **Read the diff** before landing — don't `apply` build output over your real repo.
5. **The bot is unaware**: it sees the merged overlay view and believes it edited real files; the isolation is fully transparent to it.
6. **`botmux send` still works**: inside the sandbox, `botmux send` relays messages / images / files normally via the daemon (app credentials never enter the sandbox env).

## Pairs with On-Call

The file sandbox + [On-Call Mode](/en/oncall) is the standard combo: on-call opens the bot to a whole group to @ at will, and the sandbox guarantees their changes **never touch the real repo** and **only land after the owner reviews each one**. The default pairing for semi-trusted, many-people, change-anytime on-call scenarios.
