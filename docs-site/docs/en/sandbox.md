# File & Network Sandbox

Botmux provides multi-layered runtime isolation to safeguard your host development machine from accidental file modification and sensitive credential leakage.

The file sandbox provides **two orthogonal modes (a three-state switch)**, fully supporting both **Linux** and **macOS**:

| Mode | Core Objective | Readable Scope | Write Behavior | Best Suited For | Supported Platforms |
|---|---|---|---|---|---|
| `off` | Sandbox disabled | All host files | Directly writes to real host files | Fully trusted personal local environment | All platforms |
| `oncall` (default sandbox) | **Confidentiality & leak prevention** | `fs-policy` strict whitelist (non-whitelisted paths are hidden) | Directly writes within whitelisted paths; supports `/land` diff review | Exposing bots to group members / external collaborators in On-Call mode | Linux + macOS |
| `scratch` (draft sandbox) | **Write-pollution prevention (fully disposable)** | Entire real host filesystem is natively readable | Full-root Copy-on-Write (COW), **zero writes to host** | High-risk experiments, building untrusted code, disposable refactoring | Linux + macOS |

> 💡 **Which mode should you choose?**
> - **Exposing your bot to semi-trusted group members** → choose **`oncall`**. It masks SSH keys, AWS credentials, `bots.json`, and other projects by default, preventing reconnaissance and data leakage.
> - **Using the bot yourself for complex builds, scripts, or risky commands** → choose **`scratch`**. No whitelist configuration needed; all dependencies and global tools just work, while any modification can be discarded cleanly without touching your real host disk.

---

## 1. On-Call Mode (Confidential Whitelist Sandbox)

Confines the CLI to a **per-session file whitelist**, typically paired with [On-Call Mode](/en/oncall). Group members interacting with the bot cannot reach private keys, other repositories, or Lark app secrets on your host machine.

### How It Works

- **Fresh filesystem root**: The sandbox root is an independent `tmpfs`, with `/tmp`, `/run`, `/dev`, and `/proc` isolated. `$HOME` is **never mounted wholesale**.
- **Deny-by-default whitelist**: Only explicitly declared paths are bound into the sandbox:
  - Working directory (`workingDir`), essential system binaries, and shared libraries;
  - `~/.ssh`, `~/.aws`, `bots.json`, and shared `~/.lark-cli` are strictly masked by default.
- **Underlying implementation**:
  - **Linux**: Powered by bubblewrap (bwrap) user namespaces with granular read-only / read-write binds;
  - **macOS**: Powered by Seatbelt (`sandbox-exec`) enforcing the compiled whitelist rules.

### Privacy Masking & Extra Inputs

Customize paths per bot in `bots.json`:

```jsonc
{
  "sandbox": "oncall", // or true (backward compatible)
  // Mask sensitive paths with empty nodes inside the sandbox
  "sandboxHidePaths": ["~/.kube", "/opt/confidential"],
  // Expose existing paths read-only (shared source snapshots, runbooks, docs)
  "sandboxReadonlyPaths": ["/srv/shared-libs", "~/docs/runbooks"]
}
```

### Multi-Account & Credential Isolation

- **Codex Isolated Login (`codexAuthSync`)**:
  When set to `"isolated"`, the bot directs `CODEX_HOME` to a private `<BOTMUX_HOME>/bots/<appId>/codex` directory, never reading or contaminating the global `~/.codex`.
- **Claude Per-Bot Accounts (`credentialsSourceDir`)**:
  Supplies an isolated directory containing OAuth credentials, populated into the bot's private directory on cold restart.

### Reviewing and Landing Changes (`/land`)

When human sign-off is desired, the **owner** sends `/land` in the topic once the bot finishes its work:

```text
/land
```

The bot replies with a **Sandbox Changes Review** card:
- Displays affected files and unified diff statistics;
- Attaches a downloadable `.patch` file for offline inspection;
- Only the owner can click **"Apply to disk"** (runs `git apply`) or **"Discard"**. The host workspace remains completely untouched until explicitly applied.

---

## 2. Scratch Mode (Disposable Draft Sandbox)

**Introduced in September 2026**. Provides a completely isolated, disposable execution environment for the machine owner.

### Key Highlights

1. **Native Reads, Zero Setup**: The bot sees the **full real filesystem**. Compilers, global npm/pip packages, `~/.gitconfig`, and project configs are natively accessible.
2. **Full-Root Copy-on-Write (COW)**:
   - Any write operation inside the container (editing `/etc`, installing global packages, writing to `$HOME` or the project) is redirected to an isolated upper layer;
   - **Zero writes hit the host disk**, eliminating accidental clobbering or environment pollution.
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

- **`scratchStorage: "tmpfs"`**: In-memory storage destroyed instantly upon session teardown or host reboot.
- **`scratchStorage: "disk"`**: Upper layer stored in disk cache. Survives daemon restarts and resumes via cold restore; cleaned up automatically on clean session close.

---

## 3. Configuration

### Option 1: Dashboard

Under Dashboard → **Bot Config** → Select Bot → **File Sandbox**, select from the 3-state segmented control:
- **Off**
- **Oncall (Whitelist Confidentiality)**
- **Scratch (Disposable Full-Root COW)** (with options for tmpfs or disk storage)

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
    "sandboxHidePaths": ["~/.ssh"]
  }
]
```

Environment variable overrides (useful for testing): `BOTMUX_SANDBOX=1` (enables oncall) or `BOTMUX_SANDBOX=scratch`.

---

## 4. Network Sandbox

In addition to filesystem isolation, Botmux provides egress network filtering.

### Full Egress Block (`sandboxNetwork`)

```jsonc
"sandboxNetwork": false
```

Adds `--unshare-net` so the CLI runs in an unrouted network namespace. Ideal for local offline tasks.

### Destination IP Policy (`sandboxNetworkPolicy`)

For selective access to internal APIs or proxy endpoints (Linux + PTY):

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
- **Trusted Proxy Egress (`proxyMode: "trusted-egress"`))**: Limits client egress strictly to authorized proxy endpoints.

---

## 5. Security Architecture & Boundaries

1. **Zero-Credential Outbox Relay for `botmux send`**:
   CLIs running inside the sandbox never hold Lark App Secrets. When invoking `botmux send`, payloads are written to a session-private `outbox` directory. The host daemon watches this directory and dispatches messages with host-managed credentials.
2. **Zero Prompt Injection Compatibility**:
   - `oncall` mode is fully compatible with Zero Prompt Injection (`promptInjection: "none"`), with transcript directories mounted directly;
   - `scratch` mode currently excludes Cursor and Antigravity under zero-injection due to transcript bridge limitations in full-root merged views (other CLIs are supported).
3. **Backend Boundaries**:
   - Supports local PTY and persistent tmux backends;
   - ZMX and remote runners reject sandbox configurations fail-closed due to lack of host isolation parity.
