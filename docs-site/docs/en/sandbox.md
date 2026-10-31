# File & Network Sandbox

Botmux provides multi-layered runtime isolation to safeguard your host development machine from accidental file modification and sensitive credential leakage.

The file sandbox is **one switch with three positions**, configured per bot, fully supporting both **Linux** and **macOS**:

| Mode (config value) | Core Objective | Readable Scope | Write Behavior | Best Suited For | Supported Platforms |
|---|---|---|---|---|---|
| Off (`off`, the default) | No isolation | All host files | Directly writes to real host files | Fully trusted personal local environment | All platforms |
| Allowlist isolation (`oncall`, formerly "oncall (shared)"; `sandbox: true` means this mode) | **Confidentiality & leak prevention** | Only allowlisted paths are visible; nothing else exists (apart from a few read-only runtime mounts, see below) | Only writable allowlisted paths can be written, and writes go straight to the host | Exposing bots to group members / external collaborators | Linux + macOS |
| Scratch (`scratch`) | **Write-pollution prevention (fully disposable)** | Entire real host filesystem is natively readable (except botmux credentials) | Linux: full-root Copy-on-Write (COW), **zero writes to host**; macOS: COW over cloned trees with read-only system paths, but cache / preference dirs such as `~/Library/Caches` and the system temp dirs still write to the real disk | High-risk experiments, building untrusted code, disposable refactoring | Linux + macOS |

Leaving `sandbox` out of `bots.json` (or setting `false`) means off; `true` is the same as `"oncall"`. The legacy field `readIsolation: true` is now treated as allowlist isolation and is migrated automatically at daemon startup.

> 💡 **Which mode should you choose?**
> - **Exposing your bot to semi-trusted group members** → choose **allowlist isolation**. SSH keys, tokens, credentials, and other projects are invisible by default, preventing reconnaissance and data leakage.
> - **Using the bot yourself for complex builds, scripts, or risky commands** → choose **`scratch`**. No allowlist configuration needed; all dependencies and global tools just work, while any modification can be discarded cleanly without touching your real host disk. Scratch can read most files on the host, so it is **not suitable** for untrusted users.

---

## 1. Allowlist Isolation (config value `oncall`)

Confines the CLI to a **per-session file allowlist** that governs both reads and writes, typically paired with [On-Call Mode](/en/oncall). Group members interacting with the bot cannot reach private keys, other repositories, or Lark app secrets on your host machine.

### How It Works

- **Fresh filesystem root**: The sandbox root is an empty `tmpfs`; `/proc` and `/dev` are mounted fresh, and `/tmp`, `/run`, `/var/tmp`, `/dev/shm` are session-private `tmpfs` mounts. On Linux, the private `/run` holds a few read-only runtime mounts: the command relay directory `/run/sbxbin`, the MCP plugin gateway socket directory when the gateway is enabled, the host's resolver file when `/etc/resolv.conf` links into `/run` (skipped if the policy denies it), and CLI / interpreter executable directories that live under `/run` (such as fnm or nvm multishell directories). `$HOME` is **never mounted wholesale**.
- **Deny-by-default allowlist**: Only explicitly declared paths are mounted into the sandbox, each with its own access level (writable bind / read-only bind / empty mask):
  - The working directory (`workingDir`) is writable; essential system binaries and shared libraries are read-only;
  - `~/.ssh`, `~/.aws`, and shared `~/.lark-cli` are strictly masked by default;
  - `~/.botmux` (and a custom botmux data directory) always stays on the allowlist model: even when `workingDir` is `~` (the default) or a parent of it, the sandbox only reaches what the session needs (the bot's own `bots/<appId>/`, the `botmux` command and plugin directories, the session's own records); `bots.json`, the Dashboard secret and other bots' directories can be neither read nor written. A working directory inside the botmux data directory (other than the bot's own `bots/<appId>/`) is refused at session start;
  - The botmux install directory is mounted read-only so the `botmux` command runs. When it is a git checkout, files git does not track (such as `.env`, bot configs, login state, `data/`) and `.git` are masked, while build outputs `dist/` and `node_modules/` stay readable. When the working directory itself is inside the install directory, nothing under the working directory is masked; granting the install directory or a parent of it in `sandboxPaths` does not lift the masks.
  - `workingDir` defaults to `~`, which leaves the rest of the unmasked home directory writable; pointing the working directory at a specific project (e.g. `~/proj`) is recommended.
- **CLI data directory redirected per bot (Claude family and Codex)**: Claude Code (and Seed, built on it) and Codex keep their config, transcripts, and memory in the bot's own directory `<BOTMUX_HOME>/bots/<appId>/` (`.../claude`, `.../codex`) instead of your global `~/.claude` or `~/.codex`; this is what the legacy `readIsolation` field means in practice. Other CLIs (Cursor, Gemini, Grok, Kimi, …) are not redirected: they keep using their global data directory on the host, mounted into the sandbox as each adapter declares (some writable as a whole directory, some only their credential files).
- **Network is not isolated by default**: The allowlist covers files only. Without `sandboxNetwork: false` or `sandboxNetworkPolicy`, the network inside the sandbox is the same as on the host. See [Network Sandbox](#4-network-sandbox).
- **Underlying implementation**:
  - **Linux**: Powered by bubblewrap (bwrap) user namespaces with granular read-only / read-write binds;
  - **macOS**: Powered by Seatbelt (`sandbox-exec`) enforcing the compiled allowlist rules.

### Custom Paths (`sandboxPaths`)

Extend the allowlist or add masks per bot in `bots.json`:

```jsonc
{
  "sandbox": "oncall", // or true
  "sandboxPaths": {
    // Existing paths mounted writable
    "readWrite": ["~/shared-output"],
    // Existing paths mounted read-only (shared source snapshots, runbooks, docs)
    "readOnly": ["/srv/shared-libs", "~/docs/runbooks"],
    // Sensitive paths masked with empty nodes inside the sandbox
    "deny": ["~/.kube", "/opt/confidential"]
  }
}
```

`readWrite` / `readOnly` paths that do not exist yet are filtered out at spawn; to allow a file that has not been created, allow its existing parent directory. The legacy fields `sandboxHidePaths` and `sandboxReadonlyPaths` are still read and are migrated to `sandboxPaths.deny` / `sandboxPaths.readOnly` at daemon startup.

### Multi-Account & Credential Isolation

- **Codex Isolated Login (`codexAuthSync`)**:
  When set to `"isolated"`, the bot directs `CODEX_HOME` to a private `<BOTMUX_HOME>/bots/<appId>/codex` directory, never reading or contaminating the global `~/.codex`. This applies with the sandbox off or in allowlist isolation; it cannot be combined with `scratch` or `wrapperCli` (both combinations refuse to start the session). When a session is bound to a non-legacy Codex instance (`cliInstanceBinding`), the `bots.json` value is ignored and the binding's own auth mode applies; the session starts normally.
- **Claude Per-Bot Accounts (`credentialsSourceDir`)**:
  Points a sandboxed bot at its own OAuth credential directory, copied into the bot's private directory on every cold spawn so sandboxed bots never share an account by accident. It has no effect on bots without a sandbox and cannot be combined with `codexAuthSync: "isolated"`.
- **Per-bot lark-cli config**: The sandbox denies the shared `~/.lark-cli`. To use lark-cli inside the sandbox, the machine must first split lark-cli config per bot; see [lark-cli per-bot config](https://github.com/deepcoldy/botmux/blob/master/docs/lark-cli-per-bot.md) (Chinese).

---

## 2. Scratch Mode (Disposable Draft Sandbox)

**Introduced in September 2026**. Provides a completely isolated, disposable execution environment for the machine owner.

### Key Highlights

1. **Native Reads, Zero Setup**: The bot sees the **full real filesystem**. Compilers, global npm/pip packages, `~/.gitconfig`, and project configs are natively accessible.
2. **Full-Root Copy-on-Write (COW)**:
   - Any write operation inside the container (editing `/etc`, installing global packages, writing to `$HOME` or the project) is redirected to an isolated upper layer;
   - On Linux, **zero writes hit the host disk**, eliminating accidental clobbering or environment pollution; on macOS, `~/Library/{Caches,Application Support,Logs}` and system temp dirs such as `/private/tmp` and `/private/var/folders` still write to the real disk and are outside the throwaway guarantee.
3. **Platform Implementations**:
   - **Linux**: Based on overlayfs (`lowerdir=/`). Uses kernel overlayfs when running as root, and automatically falls back to `fuse-overlayfs` for non-root users. Nested mount points (such as secondary data disks) receive recursive overlays.
   - **macOS**: Based on APFS clonefile symlink farms + Seatbelt. Core CLI state directories and the working directory are instantly cloned via native APFS COW; heavy dependency trees and system directories are protected via symlinks + write-seals.

### Storage Modes & Configuration

```jsonc
{
  "sandbox": "scratch",
  // Storage backend: "tmpfs" (default, ephemeral in-memory) or "disk" (persists across daemon restarts)
  "scratchStorage": "tmpfs",
  // tmpfs size limit in MB (0 = kernel default, roughly half of RAM)
  "scratchTmpfsSizeMb": 4096,
  // Additional masked paths (botmux credentials are fixed-masked by default)
  "scratchDenyPaths": ["~/.ssh"]
}
```

- **`scratchStorage: "tmpfs"`**: In-memory storage destroyed instantly upon session teardown or host reboot. On Linux, mounting the tmpfs **requires the daemon to run as root**; use `disk` on non-root hosts.
- **`scratchStorage: "disk"`**: Upper layer stored in disk cache. Survives daemon restarts and resumes via cold restore; cleaned up automatically on clean session close.

---

## 3. Configuration

### Option 1: Dashboard

Under Dashboard → **Bot Config** → Select Bot → **File Sandbox**, select from the 3-state segmented control:
- **Off**
- **Allowlist isolation** (config value `oncall`; shown as "oncall (shared)" before the rename)
- **Scratch (throwaway)** (with options for tmpfs or disk storage)

> 💡 **Session-Frozen**: Sandbox configuration changes apply to **new sessions**. Existing sessions retain their frozen execution mode; restarting the daemon will not alter existing sandboxes.

### Option 2: `bots.json`

Configure in `~/.botmux/bots.json`:

```json
[
  {
    "name": "worker-bot",
    "cliId": "claude-code",
    "sandbox": "scratch",
    "scratchStorage": "tmpfs"
  },
  {
    "name": "public-oncall",
    "cliId": "codex",
    "sandbox": "oncall",
    "sandboxPaths": { "deny": ["~/.kube"] }
  }
]
```

Environment variable overrides (useful for testing; applies to every bot on the machine): `BOTMUX_SANDBOX=1` (allowlist isolation) or `BOTMUX_SANDBOX=scratch`.

Precedence: when `BOTMUX_SANDBOX` is `1` / `oncall` / `scratch`, every bot is forced into that mode. Unset, empty, `0` or `false` means no force: each bot follows its own `sandbox` setting (the legacy `readIsolation: true` counts as allowlist isolation), and **a sandbox the bot enables itself is never turned off**. Any other value is rejected at startup. The variable can only force the sandbox on, never turn it off globally.

---

## 4. Network Sandbox

The file sandbox **does not restrict networking by default**: the CLI inside the sandbox has the same network and proxy access as the host. To restrict it, add one of the following.

### Full Egress Block (`sandboxNetwork`)

```jsonc
"sandboxNetwork": false
```

Adds `--unshare-net` so the CLI runs in an unrouted network namespace. Ideal for local offline tasks.

### Destination IP Policy (`sandboxNetworkPolicy`)

For selective access to internal APIs or proxy endpoints (allowlist isolation + Linux + PTY backend only):

```json
{
  "sandbox": true,
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

- **Zone-Based Control**: Independently configure `public` and `private` address ranges with `allow`, `block`, `allowlist`, or `denylist`.
- **Kernel-Level Filtering**: Enforced via nftables + slirp4netns within the network namespace.
- **Trusted Proxy Egress (`proxyMode: "trusted-egress"`)**: Limits client egress strictly to authorized proxy endpoints.
- **Host requirements**: `slirp4netns` (with `--disable-host-loopback` and `--disable-dns`), `nft`, `ip`, and `unshare` (with `--kill-child` and `--mount-proc`) must be on `PATH`, and bwrap must support `--add-seccomp-fd` and `--disable-userns`. Nothing is installed automatically; if any piece is missing, the session refuses to start.

Check two prerequisites first, otherwise sessions either start without working network access or do not start at all:

1. **Set `dnsServers` explicitly.** With a policy, the sandbox's `/etc/resolv.conf` contains only the `dnsServers` addresses and slirp4netns' built-in DNS forwarder is disabled. Without them there is no DNS and every lookup fails (`getaddrinfo EAI_AGAIN`) — an allow-all policy included. Use the nameservers from the host's `/etc/resolv.conf` (with systemd-resolved that file says `127.0.0.53`, which the sandbox cannot reach; use the upstream servers in `/run/systemd/resolve/resolv.conf`). Only port 53 is opened to them, even inside a blocked `private` zone. The Dashboard's starting template fills in the host's current nameservers.
2. **Set `proxyMode` when the host or bot env has proxy variables.** If the daemon or the bot's `env` sets `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` (any case), a policy that is not allow-all refuses to start sessions: the proxy resolves and forwards destinations, so the kernel rules only see the proxy. Once the proxy exit is trusted, add `"proxyMode": "trusted-egress"` (kernel rules still only allow the proxy's own IP), or remove the proxy variables.

Other limits:

- Linux, the **pty backend** and the oncall sandbox only. A bot without its own backend setting uses the daemon default (tmux) for new sessions; set it to pty under "Session backend" in the Dashboard. With a policy configured, changing the sandbox mode or backend is rejected until you "Clear network policy".
- The policy is frozen into each topic when it is created. After clearing or changing it, existing topics (including ones restored after a daemon restart) still start with their original policy; start a new topic.

---

## 5. Security Architecture & Boundaries

1. **Zero-Credential Outbox Relay for `botmux send`**:
   CLIs running inside the sandbox never hold Lark App Secrets. When invoking `botmux send`, payloads are written to a session-private `outbox` directory. The host daemon watches this directory and dispatches messages with host-managed credentials.
2. **Zero Prompt Injection Compatibility**:
   - Allowlist isolation is fully compatible with Zero Prompt Injection (`promptInjection: "none"`), with transcript directories mounted directly;
   - `scratch` mode currently excludes Cursor and Antigravity under zero-injection due to transcript bridge limitations in full-root merged views (other CLIs are supported).
3. **Backend Boundaries**:
   - Supports the local PTY and tmux backends;
   - Other local persistent backends (zellij, herdr, zmx, …) cannot establish the same file boundary, so a sandbox **refuses to start** the session;
   - Remote backends (Riff, remote-runner) execute on the remote machine, so the local sandbox switch **has no effect** (the session starts normally and isolation is up to the remote environment); such a backend combined with `sandboxNetworkPolicy` refuses to start, though.
   - mojo depends on its configuration: when it provably runs entirely remote it behaves like the above and the local sandbox has no effect; when it executes locally it is treated as a local backend and a sandbox refuses to start.

---

## 6. Common Limits Under Any Sandbox

These apply to both allowlist isolation and scratch:

- **No adopt**: A sandbox can only wrap a CLI started from scratch, not a process that is already running, so `/adopt` is refused for sandboxed bots. Start a new session instead.
- **No Codex RPC input**: Under any sandbox, Codex uses normal terminal input rather than the RPC input channel (`codexRpcInput`).
- **No dynamic single card**: Sandboxed sessions keep the default card mode; a dynamic reply card is never created even if the bot is configured for it. See [Cards](/en/cards).
- **Skills are a snapshot taken at spawn**: When a session starts, botmux copies the enabled managed skills (from the skill store and plugins) for that session. Skill updates made later are not visible to running sessions; use `/restart` or start a new session. Skills installed as links (`local-link`) or living in a CLI's native skill directory are not copied and are unavailable under allowlist isolation; `botmux skill show` suggests a copy install instead.
- **Installs inside the sandbox do not reach the host**: If the CLI installs a global skill, a global package, or edits global config from inside a session, those directories are either not writable or redirected to the bot's own directory under allowlist isolation, and land in the throwaway upper layer under scratch. Do installs that should apply globally on the host (Dashboard or a host shell).
- **Sub-agents are sandboxed too**: Sub-agents and child processes spawned by the CLI are descendants of the same sandboxed process and inherit the same file and network limits.

---

## 7. Prerequisites in Containers / Restricted Hosts {#linux-namespace}

The Linux sandbox relies on kernel namespaces, which Docker-style containers and hardened hosts often block by default. Check per mode:

- **Which bwrap**: the distro binary at `/usr/bin/bwrap` or `/bin/bwrap` is always preferred. Only when neither exists is a bwrap from PATH used, with a one-time warning in the daemon log. Codex installs its own build at `~/.local/bin/bwrap`; when that comes first on PATH, sandboxed sessions exit right after launch, and the warning names it. Install the distro `bubblewrap` package to fix it.
- **Symlinked system directories**: when a baseline directory such as `/opt` is itself a symlink, the sandbox recreates the same symlink inside and binds the real path read-only.
- **No PID-namespace downgrade in normal deployments**: even when procfs cannot be mounted in a new PID namespace, a normal deployment refuses to start (only the core-only deployment `BOTMUX_CORE_ONLY=1` may drop `--unshare-pid`) — sibling bot workers on the same host hold plaintext credentials in their environment, which a sandbox without PID isolation could read through /proc.

| Required capability | Allowlist isolation | Scratch | Network policy |
|---|---|---|---|
| bwrap + unprivileged user namespaces + mount / PID namespaces | ✅ | ✅ | ✅ |
| root: kernel overlayfs; non-root: `fuse-overlayfs` + `/dev/fuse` | | ✅ | |
| root (for `scratchStorage: "tmpfs"`; use `"disk"` when non-root) | | ✅ | |
| bwrap with `--add-seccomp-fd` and `--disable-userns`, plus the network tools above | | | ✅ |

botmux **never** falls back to running the CLI unsandboxed; it refuses to start the session instead. Common log messages:

- `sandbox requested but could not be established (bwrap missing or setup failed)`: allowlist isolation could not start.
- `scratch sandbox requested but could not be established (overlay/bwrap setup failed, or the tmpfs upper was lost in a reboot)`: scratch could not start; if the tmpfs layer was lost in a reboot, only a new session will work.
- `scratch sandbox (macOS) could not be established (clonefile/Seatbelt setup failed ...)`: macOS scratch could not start; check same-volume placement and free space.
- `[scratch-sandbox] tmpfs upper slot mount failed (non-root host? use scratchStorage "disk")`: tmpfs storage on a non-root host.
- `[scratch-sandbox] missing deps (...)`: bubblewrap or fuse-overlayfs is missing and could not be auto-installed (only attempted as root or with passwordless sudo).
- `bubblewrap cannot establish the required user/mount/PID namespaces`: the host probe failed, typically inside a container.
- `[device-credential-isolation] ... credential-only bubblewrap could not be established`: machines enrolled with a managed platform and holding a device credential mask credentials with bwrap whether or not the bot has a sandbox; this means bwrap is not usable on that machine.

### Troubleshooting

1. Try bwrap directly:

   ```bash
   bwrap --unshare-user --unshare-pid --bind / / --proc /proc true && echo ok
   ```

   If this fails, namespaces are blocked; fix that first, nothing on the botmux side needs to change.
2. Check whether unprivileged user namespaces are disabled:
   - `cat /proc/sys/user/max_user_namespaces`; `0` means disabled;
   - some distributions also have `/proc/sys/kernel/unprivileged_userns_clone`; `0` means disabled;
   - newer Ubuntu releases may restrict unprivileged user namespaces through AppArmor (`kernel.apparmor_restrict_unprivileged_userns`).
3. Inside a container, the default seccomp profile may block `clone` / `unshare` from creating user namespaces, and AppArmor / SELinux may block `mount`. Relax this through your container runtime, e.g. a seccomp profile that allows these syscalls (`--security-opt seccomp=...`) and, if needed, a looser AppArmor profile.
4. Scratch as non-root: make sure `ls -l /dev/fuse` shows the device and `fuse-overlayfs` is installed; containers need `/dev/fuse` passed through (e.g. `--device /dev/fuse`). Scratch as root uses kernel overlayfs / tmpfs, so the container also needs mount capability (e.g. `--cap-add SYS_ADMIN`).
5. Network policy: `bwrap --help` must list `--add-seccomp-fd` and `--disable-userns`; upgrade bubblewrap if it is too old.

Relaxing container isolation weakens the container's own security boundary, so weigh it for your environment.

---

## 8. Three Things That Are Easy to Mix Up

- **An Oncall directory is not a sandbox**: `/oncall bind <dir>` anchors the bot to a working directory in this group and lets members talk to it directly; it **does not restrict** which files the CLI can read or write. Enable allowlist isolation for that.
- **CLI auto-approval is not "sandbox off"**: The auto-approval flags botmux adds to the CLI by default (`--dangerously-*`, `--yolo`, etc.; turn them off with `disableCliBypass`) only disable the CLI's **own** approvals / sandbox. The botmux file sandbox wraps the CLI from outside and still applies.
- **`/grant` only grants talk access**: `/grant` lets members talk to the bot; it does not give operate rights such as `/cd` or `/restart`, and it does not change the bot's sandbox or credentials. See [Permissions](/en/permissions).

---

## 9. Isolation Layers When Several People Share a Bot

When several people use one bot, isolation is stacked; no single layer covers everything.

| Layer | Isolates | Does not isolate | Where to configure |
|---|---|---|---|
| Session | One CLI process per topic, with its own context and transcript | Files: all sessions see the same host files, and sessions pointed at the same directory see each other's changes; accounts: they share the bot's model account and credentials | Automatic (one session per new topic) |
| Worktree | Each topic edits code in its own git worktree / branch, so topics do not overwrite each other | File access is unchanged; host files outside the worktree are still readable and writable | `/tw`, `/repo wt <repo> [branch]`; see [Slash Commands](/en/slash-commands) |
| File sandbox: off | Nothing | Everything | `sandbox` unset / `false` |
| File sandbox: allowlist isolation | Reads and writes outside the allowlist; credentials, other repositories, other bots' data; CLI data directory split per bot for the Claude family and Codex | Writes to allowlisted paths (including the working directory) reach the host directly, and with `workingDir` at its default `~` the whole home directory is allowlisted; other CLIs keep their global host data directory; network is not isolated by default; sessions of the same bot share its model account and CLI data directory (one session can see the same bot's other session records) | `sandbox: "oncall"` + `sandboxPaths` |
| File sandbox: scratch | Writes (kept in a throwaway COW layer); botmux credentials | Reads: most host files are readable; on macOS, cache / preference and system temp dirs still write to the real disk; network is not isolated by default | `sandbox: "scratch"` + `scratchStorage` |
| Per-person tool credentials | lark-cli and other managed tools run with the **current message sender's** own authorization and are refused when that person has not authorized, never borrowing the owner's or anyone else's login | Model account, file access, and other unmanaged tools still use the machine / bot identity | `triggerUserAuth`; personal Lark authorization via `/login`, other managed tools reply with an authorization link when needed |
| Model account | Different bots use different model accounts (Claude: `credentialsSourceDir`, sandbox required; Codex: `codexAuthSync: "isolated"`) | Split per bot, not per person: everyone using the same bot shares one model account | The corresponding `bots.json` fields |
| OS user | System-level file permissions, processes, and home directories are fully separate | botmux does not provide this layer: every bot and session under one daemon runs as the same system user | Deploy a separate botmux per system user (each with its own `~/.botmux`) |
