# File & Network Sandbox

The sandbox limits what the CLI behind a bot can touch on your host: it keeps secrets out of reach and stops the CLI from wrecking your environment. It is configured per bot and **works on both Linux and macOS**.

## Pick a mode

The file sandbox is one switch with three positions:

| Mode (config value) | In one line | What it can read | Where writes go | Who it suits |
|---|---|---|---|---|
| Off (`off`, the default) | No isolation | Every host file | Straight to the host | Only you, in a fully trusted environment |
| Allowlist isolation (`oncall`) | **Keep secrets in** | Only allowlisted paths; everything else does not exist inside the sandbox | Writable allowlisted paths, written straight to the host | Sharing the bot with group members or outside collaborators |
| scratch (`scratch`) | **Keep the machine clean** | The whole real filesystem (only botmux's own credentials are hidden) | A throwaway copy, discarded when the session ends; the host is untouched | Your own risky commands, experimental refactors, building untrusted code |

How to choose:

- **Other people will use this bot** (group members, Oncall, several authorized users) → choose **Allowlist isolation**. Private keys, tokens, other repositories and other bots' data are invisible by default.
- **Only you use it, but you worry a command will mess up the machine** → choose **scratch**. No allowlist to configure, every tool just works, and anything that breaks is simply thrown away.
- ⚠️ **scratch isolates writes, not credentials**: the agent can still read the secrets on this machine, including other people's tokens and login state (such as `user-token-*` and `lark-cli-home/` under `~/.botmux/data/`). Do not use scratch for a bot several people share.

> The sandbox governs which files the CLI can access, not who can talk to the bot. Who can talk is decided by [On-Call Mode](/en/oncall) and [Permissions](/en/permissions).

## Turning it on

### In the Dashboard (recommended)

1. Open the Dashboard → **Bot Config** → select the bot.
2. Under **File sandbox**, pick **Off / Allowlist isolation / scratch (throwaway)**.
3. When switching to Allowlist isolation or scratch, a confirmation dialog explains what the mode does; click **Switch**. Switching back to Off has no dialog.
4. For scratch you can also pick the storage: in-memory or disk.

The Dashboard also checks a few things for you:

- When the bot is used by more than its owner (Oncall, whole-group access, several `allowedUsers`, or per-sender auth) but allowlist isolation is off, it suggests turning it on and says whether the current CLI is verified to work.
- When you pick scratch, it warns up front if this machine cannot run scratch or can only use disk storage, and lists the missing dependencies and how to install them.

### In `bots.json`

```json
[
  {
    "name": "public-oncall",
    "cliId": "codex",
    "sandbox": "oncall",
    "sandboxPaths": { "deny": ["~/.kube"] }
  },
  {
    "name": "my-scratch",
    "cliId": "claude-code",
    "sandbox": "scratch",
    "scratchStorage": "tmpfs"
  }
]
```

- Leaving out `sandbox`, or setting it to `false`, means off; `true` is the same as `"oncall"`.
- The legacy field `readIsolation: true` is treated as allowlist isolation and migrated automatically at daemon startup.

### When changes take effect

**New sessions only.** A session records its sandbox mode the first time it starts and keeps using that record. Running sessions keep the mode they started with, even across `/restart` or a daemon restart. To use the new mode right away, start a new topic.

To check whether a session is sandboxed:

- The session card in Lark shows a small line "🛡️ Sandbox: Allowlist isolation" or "🛡️ Sandbox: scratch (throwaway)". No line means no sandbox.
- In the Dashboard session list and kanban, a session whose recorded sandbox mode differs from the bot's current config is tagged "Sandbox ≠ config". Hover to see both values (for example "session uses Off, config is now Allowlist isolation").

"Sandbox ≠ config" is not an error. It means you changed this bot's sandbox mode after the session started, and the session still runs with the old mode.

| You want | Do this |
|---|---|
| This session to use the new mode | Start a new topic. `/restart` does not switch the mode, and the tag stays |
| To keep the old mode | Nothing. The session keeps working as before |

Sessions that have not started yet (for example, still picking a repo) don't show this tag.

### Forcing it on machine-wide

`BOTMUX_SANDBOX` is handy for testing or blanket hardening and applies to every bot on the machine:

| Value | Effect |
|---|---|
| `1` or `oncall` | Every bot is forced into allowlist isolation |
| `scratch` | Every bot is forced into scratch |
| Unset, empty, `0`, `false` | No force; each bot follows its own `sandbox` setting |
| Anything else | Rejected at startup |

The variable **can only force the sandbox on, never off**: setting it to `0` does not turn off a sandbox the bot enables itself.

---

## Allowlist isolation (`oncall`)

The CLI is confined to a per-session file allowlist that governs both reads and writes. However group members try to steer the model, it cannot reach your private keys, other repositories, or Lark app secrets. It is often paired with [On-Call Mode](/en/oncall).

### What the sandbox can see

| Path | Inside the sandbox |
|---|---|
| Working directory (`workingDir`) | Read-write; changes land on the host directly |
| System tools, shared libraries, the CLI itself | Read-only |
| `/tmp`, `/run`, `/var/tmp`, `/dev/shm` | Session-private empty directories, separate from the host |
| `~/.ssh`, `~/.aws`, shared `~/.lark-cli` | Hidden |
| `~/.botmux` (botmux data directory) | Only what this session needs (the bot's own `bots/<appId>/`, the `botmux` command and plugins, this session's records); `bots.json`, the Dashboard secret and other bots' directories can be neither read nor written |
| botmux install directory | Read-only, so the `botmux` command runs; if it is a git checkout, files git does not track (`.env`, login state, `data/`, …) and `.git` are hidden |
| Rest of your home directory | **Not mounted as a whole**, unless it is inside the working directory |
| Network | **Not restricted** by default, same as the host; see [Network sandbox](#network-sandbox) |

Things to watch:

- **Point the working directory at a specific project** (e.g. `~/proj`). `workingDir` defaults to `~`, which puts every unhidden file in your home directory on the allowlist, writable.
- The working directory cannot be inside the botmux data directory (except the bot's own `bots/<appId>/`); such a session refuses to start.
- On Linux, the private `/run` also holds a few read-only mounts the session needs: the command relay directory `/run/sbxbin`, the MCP plugin gateway socket directory (when the gateway is on), `/etc/resolv.conf` when it links into `/run`, and CLI / interpreter directories living under `/run` (such as fnm or nvm multishell directories).

### Adding paths or masks (`sandboxPaths`)

To let the sandbox see more directories, or hide more sensitive paths:

```jsonc
{
  "sandbox": "oncall",
  "sandboxPaths": {
    // Extra read-write directories
    "readWrite": ["~/shared-output"],
    // Extra read-only directories (shared sources, docs, …)
    "readOnly": ["/srv/shared-libs", "~/docs/runbooks"],
    // Extra sensitive paths to hide
    "deny": ["~/.kube", "/opt/confidential"]
  }
}
```

Rules:

- **Use absolute paths** (starting with `/` or `~/`). A relative path is resolved against the session working directory, where `..` may already be your home directory, so none of the three lists accepts one.
- **`readWrite` cannot contain `/`, your home directory, the botmux data directory, or any parent of them**: that would hand the whole disk or every credential to the sandbox. A specific directory such as `~/projects/foo` is fine.
- **On Linux, `readOnly` cannot contain `/` or `/run`**: the mount points the sandbox needs could not be created and the session would exit at launch. Use specific directories such as `/usr`, `/opt/<tool dir>`, `/run/lock`.
- The Dashboard rejects these on save and explains why. Older entries hand-written into `bots.json` are downgraded at spawn: home / data directory move from read-write to read-only, `/` and relative paths in `readWrite` are dropped, and on Linux `/` and `/run` in `readOnly` are dropped too.
- `readWrite` / `readOnly` paths that do not exist yet are skipped at spawn; to allow a file that has not been created, allow its existing parent directory.
- The legacy fields `sandboxHidePaths` and `sandboxReadonlyPaths` are still read and are migrated to `deny` / `readOnly` at daemon startup.

### Where each CLI keeps its data

- **Claude Code (including Seed, built on it) and Codex**: config, transcripts and memory live in the bot's own directory `<BOTMUX_HOME>/bots/<appId>/` (`.../claude`, `.../codex`) instead of your global `~/.claude` / `~/.codex`. The Dashboard shows "Enhanced CLI data isolation".
- **Other CLIs** (Cursor, Antigravity, Grok, Kimi, …): keep using their global data directory on the host, mounted into the sandbox as each adapter declares (some writable as a whole directory, some only their credential files).
- With `wrapperCli` configured, this redirect is skipped and the CLI uses its usual data directory.

### Which CLIs are verified

These CLIs were tested under allowlist isolation on Linux (start, first turn, shell tool, working directory read/write, network, `botmux send` and credential isolation, on both tmux and pty backends):

Claude Code, Codex, Antigravity, OpenCode, Pi, oh-my-pi, Grok, Kimi.

- **Codex App** does not support allowlist isolation on Linux and refuses to start; use Codex instead.
- Other CLIs have not been verified one by one; try one in a test session first.

### Using it with `wrapperCli`

A bot with a launch prefix (`wrapperCli`) can also be sandboxed (pty / tmux backends). The wrapper itself runs inside the sandbox, under the same allowlist:

- botmux only lets in the wrapper's own executable file and the CLI it calls.
- Anything else the wrapper needs (its install tree, interpreter, config) must be added to `sandboxPaths`: `readOnly` for reading, `readWrite` if it writes.
- When a path is missing, the session names it before starting; if the wrapper exits right after launch, the topic also suggests adding the paths to `sandboxPaths`. Under scratch it suggests checking `scratchDenyPaths` instead.

### Multiple accounts & credentials

- **Codex isolated login (`codexAuthSync: "isolated"`)**: points `CODEX_HOME` at `<BOTMUX_HOME>/bots/<appId>/codex` and never reads or touches the global `~/.codex`. Works with the sandbox off or in allowlist isolation; it **cannot be combined with `scratch` or `wrapperCli`** (the session refuses to start). When a session is bound to a non-legacy Codex instance, the instance's own auth mode applies.
- **Codex `config.toml`**: when Codex uses the bot's own directory (allowlist isolation, or `codexAuthSync: "isolated"`; not under scratch or with `wrapperCli`), the `config.toml` in it is copied once from the host's `~/.codex/config.toml` when the first new session starts; later host edits are not synced. The Dashboard (next to "Codex login credentials") shows the path and offers **Re-sync from host** (the current file is backed up as `config.toml.bak-<time>` first), effective for the next new session.
- **Claude per-bot accounts (`credentialsSourceDir`)**: a sandboxed bot takes its OAuth credentials from this directory on every cold start, so sandboxed bots never share an account by accident. No effect on bots without a sandbox; cannot be combined with `codexAuthSync: "isolated"`.
- **lark-cli**: the sandbox hides the shared `~/.lark-cli`. To use lark-cli inside the sandbox, the machine must first split lark-cli config per bot; see [lark-cli per-bot config](https://github.com/deepcoldy/botmux/blob/master/docs/lark-cli-per-bot.md) (Chinese).

#### Several accounts on one machine: a separate account for a Claude bot {#credentials-source-dir}

By default every sandboxed bot on a machine takes its credentials from the shared login (`~/.claude/.credentials.json` or the keychain), so they all run as one Claude account. To give one bot a different account:

1. Prepare an account directory with one sub-directory per CLI, for example:

   ```text
   ~/accounts/acct-b/
   └── claude/
       └── .credentials.json
   ```

2. Set `credentialsSourceDir` for the bot: `"credentialsSourceDir": "~/accounts/acct-b"` in `bots.json`, or send `/botconfig set credentialsSourceDir ~/accounts/acct-b` in Lark.
3. It takes effect for new sessions (`/restart` an existing one). From then on, every cold start copies the credentials from that directory into the bot's own data directory.

Limits:

- **Only `claude-code` is supported for now**, and the bot must have the file sandbox on. On a bot with no sandbox at all it has no effect (the global login is still used and a warning is logged); with the sandbox on but the data directory not redirectable (for example with `wrapperCli`), the session refuses to start.
- If the source directory is missing, unreadable or holds invalid credentials, the session **refuses to start** instead of quietly falling back to the shared login.
- Cannot be combined with `codexAuthSync: "isolated"`. For separate Codex accounts use `codexAuthSync: "isolated"`, see the item above.
- botmux only copies on cold start and **does not refresh** the tokens in the source directory; keeping them valid is up to you (or an external script).
- `/botconfig unset credentialsSourceDir` goes back to the shared login.

---

## scratch (throwaway sandbox)

A disposable environment for your own use.

### How it works

- **Reads: zero setup**. The bot sees the full real filesystem; compilers, global npm / pip packages, `~/.gitconfig` and project configs just work.
- **Writes: all go to a copy**. Editing `/etc`, installing global packages, changing your home directory or project files: every write lands in a separate copy-on-write layer that is discarded when the session ends.
- **Linux**: based on overlayfs, with **zero writes to the host disk**. A root daemon uses kernel overlayfs; a non-root daemon falls back to `fuse-overlayfs` automatically. Separately mounted data disks (such as `/data00`): under root each gets its own copy layer; under non-root they are read-only inside the sandbox, so **keep the working directory on the root filesystem**, otherwise the session refuses to start.
- **macOS**: uses APFS clones of your home directory and project (only changed blocks take space), with system paths read-only. But `~/Library/{Caches,Application Support,Logs}` and system temp dirs such as `/private/tmp` and `/private/var/folders` **still write to the real disk** and are outside the throwaway guarantee.

### Storage and options

```jsonc
{
  "sandbox": "scratch",
  // tmpfs (default, in memory) or disk
  "scratchStorage": "tmpfs",
  // tmpfs size limit in MB; 0 = kernel default, roughly half of RAM
  "scratchTmpfsSizeMb": 4096,
  // Extra paths to hide (botmux's own credentials are hidden by default)
  "scratchDenyPaths": ["~/.ssh"]
}
```

| Storage | Behavior | Requirement |
|---|---|---|
| `tmpfs` in-memory (default) | Kept in RAM, wiped when the session closes or the machine reboots | On Linux, **the daemon must run as root**; use `disk` otherwise |
| `disk` | Kept on disk, survives daemon restarts; cleaned up when the session closes normally | None |

macOS always uses APFS clones; there is no memory / disk choice.

---

## Network sandbox

The file sandbox **does not restrict networking by default**: network and proxy access inside the sandbox are the same as on the host. To restrict it, add one of the following.

### Block all network (`sandboxNetwork: false`)

```jsonc
"sandboxNetwork": false
```

The CLI runs in a network namespace with no outside access. Good for purely local, offline tasks.

### Allow by destination IP (`sandboxNetworkPolicy`)

Use this when the sandbox should reach only certain internal APIs or a proxy. **Linux + pty backend + allowlist isolation only.**

```json
{
  "sandbox": "oncall",
  "backendType": "pty",
  "sandboxNetworkPolicy": {
    "version": 1,
    "public": { "mode": "allow" },
    "private": {
      "mode": "allowlist",
      "rules": [{ "cidr": "10.20.0.0/16", "protocol": "tcp", "ports": [443] }]
    },
    "dnsServers": ["1.1.1.1"]
  }
}
```

- Public (`public`) and private (`private`) ranges are set separately; each can be `allow` (everything), `block` (nothing), `allowlist` (only matching rules) or `denylist` (everything except matching rules).
- Rules use IP / CIDR only and can be limited to TCP / UDP ports; domain names are not supported.
- Filtering happens in the kernel (nftables + slirp4netns) on the real destination IP of each packet.
- In the Dashboard: **Bot Config** → **Destination IP network policy**; edit and click **Save policy**, or **Clear network policy** to remove it.

**Check two things first**, otherwise sessions either start without network access or do not start at all:

1. **Set `dnsServers`**. With a policy the sandbox no longer uses the host's DNS; without it no name resolves (`getaddrinfo EAI_AGAIN`), even with an allow-all policy. Use the addresses from the host's `/etc/resolv.conf`; if it says `127.0.0.53` (systemd-resolved), the sandbox cannot reach it, so use the upstream servers in `/run/systemd/resolve/resolv.conf`. Only port 53 is opened to them. The Dashboard's starting template fills in the host's current DNS servers.
2. **Add `proxyMode` when proxy variables are set**. If the daemon or the bot's `env` has `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` (any case), the proxy forwards traffic for the CLI and the kernel rules only see the proxy, so a policy that is not allow-all refuses to start. Once you trust the proxy exit, add `"proxyMode": "trusted-egress"` (only the proxy's own IP is allowed), or remove the proxy variables.

Other limits:

- The host `PATH` needs `slirp4netns` (with `--disable-host-loopback` and `--disable-dns`), `nft`, `ip` and `unshare` (with `--kill-child` and `--mount-proc`), and bwrap must support `--add-seccomp-fd` and `--disable-userns`. Nothing is installed automatically; if any piece is missing, the session refuses to start.
- A bot without its own backend setting uses the daemon default (tmux); switch it to pty under "Session backend" in the Dashboard.
- With a policy configured, changing the sandbox mode or backend is rejected until you clear the policy.
- The policy is fixed when a topic is created. After clearing or changing it, existing topics (including ones restored after a daemon restart) keep the old policy; start a new topic.

---

## What works inside the sandbox, and what does not

### `botmux send` still works, credentials stay outside

When the CLI inside the sandbox calls `botmux send` to post text, cards, images or files, it never gets Lark credentials. The request is written to a session-private relay directory and the daemon outside the sandbox sends it. **The Lark App Secret never enters the sandbox.**

Sending somewhere other than the current topic (`--top-level` for the group's top level, `--chat-id` for another group, `--into` for another message's thread) also works, but the daemon re-checks the destination:

- The session's own chat is always allowed;
- Any other chat must be a regular group (not a DM, not an external chat) that the bot is in, and the person who sent this turn's message (or the session owner when there is none) must be a member there and allowed to talk to the bot;
- If any of this cannot be confirmed, the send is refused.

### Fleet commands belong on the host

The sandbox cannot see the supervisor / daemon processes on the host. Running `botmux status / logs / start / stop / restart / start-bot / stop-bot` inside it prints a notice that you are inside a botmux sandbox and asks you to run the command in a host terminal. **The fleet is most likely fine; do not restart it because of this.**

### Common limits (both sandbox modes)

- **No adopt**: a sandbox can only wrap a CLI started from scratch, so `/adopt` is refused. Start a new session instead.
- **No Codex RPC input**: under a sandbox, Codex uses normal terminal input instead of `codexRpcInput`.
- **No dynamic single card**: sandboxed sessions always use the default card mode; see [Cards](/en/cards).
- **Skills are a snapshot taken at spawn**: the enabled managed skills are copied for the session when it starts; after updating a skill, use `/restart` or start a new session. Skills installed as links (`local-link`) or living in a CLI's native skill directory are unavailable under allowlist isolation; `botmux skill show` suggests a copy install instead.
- **Installs inside the sandbox do not reach the host**: if the CLI installs a global skill or package or edits global config, under allowlist isolation it either cannot write or writes to the bot's own directory; under scratch it lands in the throwaway copy. Do installs that should apply globally on the host (Dashboard or a host shell).
- **Sub-agents are sandboxed too**: sub-agents and child processes the CLI spawns inherit the same file and network limits.
- **Zero prompt injection (`promptInjection: "none"`)**: fully supported under allowlist isolation; under scratch, Cursor and Antigravity are not supported (their transcript lands in the throwaway copy and cannot be captured); other CLIs work.

### Supported session backends

| Backend | With a sandbox |
|---|---|
| pty, tmux | Supported |
| zellij, herdr, zmx and other local persistent backends | Cannot set up the same file boundary, so the session **refuses to start**; switch to pty or tmux |
| Riff, remote-runner and other remote backends | The CLI runs remotely, so the local sandbox **has no effect** (the session starts normally and isolation is up to the remote side); combined with `sandboxNetworkPolicy`, though, the session refuses to start |
| mojo | Same as remote backends when it provably runs entirely remote; same as local backends (refuses to start) when it runs on this machine |

---

## Prerequisites in containers / restricted hosts {#linux-namespace}

The Linux sandbox relies on kernel namespaces, which Docker-style containers and hardened hosts often block by default. Check per mode:

| Required capability | Allowlist isolation | scratch | Network policy |
|---|---|---|---|
| bwrap + unprivileged user namespaces + mount / PID namespaces | ✅ | ✅ | ✅ |
| root: kernel overlayfs; non-root: `fuse-overlayfs` + `/dev/fuse` | | ✅ | |
| root (for `scratchStorage: "tmpfs"`; use `"disk"` when non-root) | | ✅ | |
| bwrap with `--add-seccomp-fd` and `--disable-userns`, plus the network tools above | | | ✅ |

Notes:

- **Which bwrap**: the distro binary at `/usr/bin/bwrap` or `/bin/bwrap` is preferred; only when neither exists is a bwrap from `PATH` used, with a one-time warning in the log. Codex installs its own build at `~/.local/bin/bwrap`; when that comes first, sandboxed sessions exit right after launch. Install the distro `bubblewrap` package to fix it.
- **Symlinked system directories**: when a directory such as `/opt` is itself a symlink, the sandbox recreates the same symlink inside and mounts the real path read-only.
- **No downgrade by dropping PID isolation**: other bots' processes on the same host hold plaintext credentials in their environment, which a sandbox without PID isolation could read through `/proc`. So a normal deployment refuses to start when procfs cannot be mounted (only the core-only deployment `BOTMUX_CORE_ONLY=1` allows it).

botmux **never** falls back to running the CLI unsandboxed; it refuses to start the session instead. Common messages:

| Message | Meaning |
|---|---|
| `sandbox requested but could not be established (bwrap missing or setup failed)` | Allowlist isolation could not start |
| `scratch 沙箱没能建立：<reason>。<fix>` (scratch sandbox could not be established) | scratch could not start; the topic names the reason and the fix (missing dependencies, in-memory storage on a non-root daemon, `/dev/fuse` unavailable, a storage setting that no longer matches the session, …). Only in-memory storage lost in a machine reboot needs a new session |
| `[scratch-sandbox] tmpfs upper slot mount failed (non-root host? use scratchStorage "disk")` | In-memory storage on a non-root host |
| `[scratch-sandbox] missing deps (...)` | bubblewrap or fuse-overlayfs is missing and could not be installed automatically (only attempted as root or with passwordless sudo) |
| `bubblewrap cannot establish the required user/mount/PID namespaces` | The host probe failed, typically inside a container |
| `[device-credential-isolation] ... credential-only bubblewrap could not be established` | Machines enrolled with a managed platform and holding a device credential hide credentials with bwrap whether or not the bot has a sandbox; this means bwrap is not usable on that machine |

### Troubleshooting

1. Try bwrap directly:

   ```bash
   bwrap --unshare-user --unshare-pid --bind / / --proc /proc true && echo ok
   ```

   If it fails, namespaces are blocked; fix that first, nothing on the botmux side needs to change.
2. Check whether unprivileged user namespaces are disabled:
   - `cat /proc/sys/user/max_user_namespaces`; `0` means disabled;
   - some distributions also have `/proc/sys/kernel/unprivileged_userns_clone`; `0` means disabled;
   - newer Ubuntu releases may restrict them through AppArmor (`kernel.apparmor_restrict_unprivileged_userns`).
3. Inside a container: the default seccomp profile may block `clone` / `unshare`, and AppArmor / SELinux may block `mount`. Relax this through your container runtime, e.g. `--security-opt seccomp=...`.
4. scratch as non-root: make sure `ls -l /dev/fuse` shows the device and `fuse-overlayfs` is installed; containers need the device passed through (e.g. `--device /dev/fuse`). scratch as root also needs mount capability in a container (e.g. `--cap-add SYS_ADMIN`).
5. Network policy: `bwrap --help` must list `--add-seccomp-fd` and `--disable-userns`; upgrade bubblewrap if it is too old.

Relaxing container isolation weakens the container's own security boundary, so weigh it for your environment.

---

## Three things that are easy to mix up

- **An Oncall directory is not a sandbox**: `/oncall bind <dir>` anchors the bot to a working directory in this group and lets members talk to it directly; it **does not restrict** which files the CLI can read or write. Enable allowlist isolation for that.
- **CLI auto-approval is not "sandbox off"**: the auto-approval flags botmux adds by default (`--dangerously-*`, `--yolo`, etc.; turn them off with `disableCliBypass`) only disable the CLI's **own** approvals / sandbox. The botmux file sandbox wraps the CLI from outside and still applies.
- **`/grant` only grants talk access**: it lets members talk to the bot, but gives no operate rights such as `/cd` or `/restart`, and does not change the sandbox or credentials. See [Permissions](/en/permissions).

---

## Several people on one bot: isolation is stacked

No single layer covers everything; combine them as needed:

| Layer | Isolates | Does not isolate | Where to configure |
|---|---|---|---|
| Session | One CLI process per topic, with its own context and transcript | Files: all sessions see the same host files, and sessions in the same directory see each other's changes; accounts: they share the bot's model account and credentials | Automatic (one session per new topic) |
| Worktree | Each topic edits code in its own git worktree / branch, so topics do not overwrite each other | File access is unchanged; host files outside the worktree are still readable and writable | `/tw`, `/repo wt <repo> [branch]`; see [Slash Commands](/en/slash-commands) |
| File sandbox: off | Nothing | Everything | `sandbox` unset / `false` |
| File sandbox: allowlist isolation | Reads and writes outside the allowlist; credentials, other repositories, other bots' data; the Claude family's and Codex's data directories are split per bot | Writes to allowlisted paths (including the working directory) reach the host directly, and with `workingDir` at its default `~` the whole home directory is allowlisted; other CLIs keep their global host data directory; network is not restricted by default; sessions of the same bot share its model account and CLI data directory | `sandbox: "oncall"` + `sandboxPaths` |
| File sandbox: scratch | Writes (kept in a throwaway copy); botmux's own credentials | Reads: most host files are readable, including other people's tokens; on macOS, cache / preference and system temp dirs still write to the real disk; network is not restricted by default | `sandbox: "scratch"` + `scratchStorage` |
| Per-person tool credentials | lark-cli and other managed tools run with the **current message sender's** own authorization and are refused when that person has not authorized, never borrowing the owner's or anyone else's login | Model account, file access and other unmanaged tools still use the machine / bot identity | `triggerUserAuth`; personal Lark authorization via `/login`, other managed tools reply with an authorization link when needed |
| Model account | Different bots use different model accounts (Claude: `credentialsSourceDir`, sandbox required; Codex: `codexAuthSync: "isolated"`) | Split per bot, not per person: everyone using the same bot shares one model account | The corresponding `bots.json` fields |
| OS user | System-level file permissions, processes and home directories are fully separate | botmux does not provide this layer: every bot and session under one daemon runs as the same system user | Deploy a separate botmux per system user (each with its own `~/.botmux`) |
