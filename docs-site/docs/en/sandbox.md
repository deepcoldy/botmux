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
| ✅ **Extra read-only inputs** | Optional `sandboxReadonlyPaths` can expose sibling repos, generated docs, or shared source snapshots read-only |
| ❌ **Reads are NOT isolated** | By default the bot can read **every local file** (incl. `bots.json`, `~/.ssh`, any credentials). Masking sensitive paths requires explicit per-bot config (see "Privacy masking" below) |
| ⚠️ **Network defaults open** | The sandbox can reach the network / proxy normally by default; set `sandboxNetwork: false` to run it in a separate network namespace |

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
  "sandboxHidePaths": ["~/.ssh", "~/.botmux/bots.json"],
  // optional: expose extra existing paths read-only
  "sandboxReadonlyPaths": ["/srv/source-snapshots/service-a"],
  // optional: disable network egress inside the sandbox
  "sandboxNetwork": false
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

## Extra read-only paths (`sandboxReadonlyPaths`)

Use `sandboxReadonlyPaths` when the bot needs to inspect extra local inputs without editing them:

```jsonc
"sandboxReadonlyPaths": ["/srv/source-snapshots/service-a", "~/docs/runbooks"]
```

Each existing path is mounted read-only at the same path inside the sandbox (`~` expands to the home dir). Missing entries are ignored. This is useful for shared source snapshots, reference repos, generated docs, or other context that should not be part of the `/land` changeset.

Two guardrails: `sandboxHidePaths` masks always take precedence — a read-only path overlapping a masked path can never re-expose the hidden content. And entries equal to or containing the home dir or the session working dir are ignored with a warning (they would replace the entire write-isolated overlay); paths *under* the working dir are fine.

## Network policy (`sandboxNetwork`)

By default, the sandbox keeps network access for package installs, API calls, and normal CLI behavior. Set:

```jsonc
"sandboxNetwork": false
```

to add `--unshare-net` and run the CLI without host network access. This is a blunt switch: model/API access, package managers, git remotes, and proxies inside the sandbox may stop working unless the CLI can run entirely from already-mounted local inputs.

## Caveats

1. **Linux only**: needs bwrap + overlayfs (non-root automatically uses fuse-overlayfs, deps auto-installed when you enable the sandbox); Mac (sandbox-exec) not yet supported.
2. **Reads aren't isolated**: everything is readable by default — mask sensitive credentials with `sandboxHidePaths` (above).
3. **Network is open by default**: set `sandboxNetwork: false` only for bots that can tolerate losing network / proxy access.
4. **Build artifacts join the changeset**: if the bot runs `pnpm build` / compiles inside the sandbox, the artifacts (e.g. `dist/`) also show up in the `/land` changeset. **Read the diff** before landing — don't `apply` build output over your real repo.
5. **The bot is unaware**: it sees the merged overlay view and believes it edited real files; the isolation is fully transparent to it.
6. **`botmux send` still works**: inside the sandbox, `botmux send` relays messages / images / files / custom card JSON normally via the daemon (app credentials never enter the sandbox env).

## Pairs with On-Call

The file sandbox + [On-Call Mode](/en/oncall) is the standard combo: on-call opens the bot to a whole group to @ at will, and the sandbox guarantees their changes **never touch the real repo** and **only land after the owner reviews each one**. The default pairing for semi-trusted, many-people, change-anytime on-call scenarios.

## Destination IP policy (explicit opt-in)

`sandboxNetworkPolicy` independently configures public and private address space. Without it, existing `sandboxNetwork` values and historical sessions keep their behavior. An explicit policy takes precedence over the boolean. Supported only for **Linux x64/arm64, local PTY, oncall file sandbox**. Docker must permit user/network/PID namespaces and namespace-local nftables. macOS, scratch, persistent terminals, remote backends, adopt and external App Servers are rejected.

```json
{
  "sandbox": true,
  "backendType": "pty",
  "sandboxNetworkPolicy": {
    "version": 1,
    "public": { "mode": "allow" },
    "private": { "mode": "allowlist", "rules": [{ "cidr": "10.20.0.0/16", "protocol": "tcp", "ports": [443] }] },
    "dnsServers": ["1.1.1.1"]
  }
}
```

Each zone supports `allow` (all destinations), `block` (none), `allowlist` (any matching rule; empty blocks all), or `denylist` (deny any matching rule; empty permits all). Classify the actual address first, then evaluate that zone. Rules have union semantics, with no longest-prefix or last-rule overrides. A cross-zone CIDR only matches within its containing zone.

Rules accept IP/CIDR only; host bits normalize. IPv4-mapped IPv6 addresses share IPv4 rules. Omitted protocol/ports matches all protocols/ports; optional protocol accepts TCP/UDP, and optional ports requires protocol and an integer list 1–65535. Domains, URLs, wildcards, port ranges and other protocol selectors are rejected.

Private means conservative non-public space: RFC1918, IPv4 loopback, link-local, CGNAT, unspecified, reserved, documentation/test and multicast ranges (full list: `PRIVATE_V4` in `src/core/sandbox-network-policy.ts`); IPv6 outside `2000::/3`, plus `2001::/23`, `2001:db8::/32`, `2002::/16` and `3fff::/20`. This includes ULA, loopback, link-local, multicast and translation/transition space. Classification is static, independent of DNS suffix or current routing.

The boundary filters **actual destination IP packets** using nftables in a fresh namespace before connecting a generic slirp4netns link. Direct sockets, changed/deleted proxy variables, IPv4 mappings, changed DNS answers and redirected connections receive the same kernel filtering. Model endpoints and DNS must be explicitly permitted. It does not modify the host firewall, Docker or any proxy product configuration.

Restricted policies do not support upstream proxy destination re-resolution; inherited HTTP/HTTPS/ALL proxy configuration is rejected rather than rewritten. This is address enforcement, not inspection of encrypted application traffic. An allowed server or tunnel endpoint is an authorized exit: do not allow arbitrary forwarding services when requiring final application destination restrictions. Domain/HTTP rules or final destinations hidden behind a proxy cannot be enforced by this policy.

Namespace-local loopback remains available for local IPC, distinct from host loopback. Host loopback aliases and slirp DNS forwarding are always disabled. Only required IPv6 neighbor discovery control packets are exempted. Task socket creation is restricted to Internet families; host Unix sockets, setns/unshare, compat syscall ABI and io_uring are blocked, while process-local socketpair IPC remains. Host MCP Gateway/Unix IPC combinations fail closed; the file outbox relay remains available.

Optional `dnsServers` grants explicit TCP/UDP port 53 access before zone evaluation (max 8 IPs, excluding loopback and slirp aliases). Default is empty, without host DNS delegation. DNS queries are themselves an authorized capability; resulting application connections still receive destination filtering. Omit DNS capability to block all external communication.

Provide iproute2 `ip`, nft, slirp4netns supporting `--disable-host-loopback`/`--disable-dns`, and bwrap supporting `--disable-userns`/`--add-seccomp-fd`. No network dependency auto-install occurs. Initialization failures abort launch; a link failure terminates the task lifetime. There is no unfiltered fallback.

Dashboard Security saves JSON and shows configured-for-new-sessions status. Host CLI supports `botmux sandbox-network-policy check <file>`, `set <appId> <file>` and `clear <appId>`. Mutations require an online authenticated owning daemon; isolated/session CLIs cannot modify host policy. IM `/config sandboxNetworkPolicy <JSON>` shares validation and atomic persistence. Session/workflow snapshots are deep copies; fork/restart/restore retains the frozen policy. Clearing affects new sessions and restores the legacy boolean behavior.

See the Chinese page's isolated Linux test command. `test/sandbox-network-linux.test.ts` is opt-in (`BOTMUX_NETWORK_POLICY_INTEGRATION=1`); explicit runs fail if dependencies or kernel capabilities are unavailable. A skipped run is not boundary validation. Set `BOTMUX_NETWORK_TEST_BINARY` to the absolute compiled binary path to include the self-reexec case. The Sandbox network boundary CI runs the complete matrix and binary test for relevant PRs. Model requests use an isolated HTTP fixture rather than a live provider.
