# botmux ↔ daemon bridge

This document describes the **non-mobile** control-plane bridge between Botmux-class Desktop and `botmux` daemon/dashboard (local and multi-SSH).

## Architecture

```
Desktop (Electron)
  botmux-bridge service
    ├─ endpoint: local  → 127.0.0.1:$DASHBOARD_PORT + ~/.botmux/.dashboard-token
    └─ endpoint: ssh×N  → probe remote ~/.botmux + tunnel
         ├─ prefer Botmux SSH port-forward (if host connected)
         ├─ else auto `connectRegisteredSshTarget` then port-forward
         └─ else system `ssh -L`
  → GET /api/sessions, GET write-link, POST /api/trigger
```

Endpoints are **multi-host**: local + any number of SSH remotes. Each keeps its own tunnel and token.

## Persistence

Connected endpoints are saved to:

```text
{Electron userData}/botmux-bridge-endpoints.json
```

After the main window registers SSH handlers, Desktop **reconnects** saved endpoints automatically.

## UI

| Surface | Path |
|---------|------|
| **Left sidebar (primary)** | **Botmux** tree: host (device) → sessions (flat, activity-sorted; optional group-by-agent view in the filter menu). Machines connect via the header **+** menu (Local / Platform / known SSH hosts / New SSH host…); host rows carry reconnect/disconnect/manage menus. Filtering (text query + agent multi-select + show-closed) lives in the header filter menu. Session rows show bot avatar + agent name + `repo:branch` (daemon `/api/sessions` enrichment; older daemons fall back to cwd tail). Click session → remote write-link in main workspace browser tab. |
| Right sidebar | Activity bar → **Botmux** (ops panel) |
| Settings | **Botmux Sessions** (advanced / diagnosis) |

Left tree and right panel poll sessions every ~12s while open.

**No fake project in Projects list.** Session tabs without a matched Botmux worktree open on a **synthetic main-area host** built from the session:

- id: `botmux:session:<sessionId>`
- path: `session.cwd`
- SSH target: from `hostId` (`ssh:<targetId>`) when remote

That shell is stable for Zustand (`useActiveWorktree` must not allocate a new object per read — that caused right-sidebar Maximum update depth). It is **not** the floating panel and **not** a Projects card.

**Never floating:** Botmux session open must not use `global-floating-terminal` / Floating Terminal panel.

**Persisted hosts:** Connected Local/SSH/Platform endpoints are saved under Electron `userData` (`botmux-bridge-endpoints.json`) as the **desired** host list. Auto-reconnect runs after SSH handlers register (and again when the Botmux sidebar refreshes). A failed reconnect must **not** erase the host — only explicit disconnect removes it. Offline desired hosts still appear in status so you do not re-click `+ d2` after every restart.

### Worktree ↔ session matching (also drives open target)

Sessions expose `workingDir` from the dashboard; Desktop maps it to `cwd`. Matching:

- Same host: local worktree ↔ endpoint `local`; SSH worktree `connectionId` ↔ endpoint `ssh:<id>`
- Path: `session.cwd` equals worktree path or is a subdirectory (longest prefix wins for nested worktrees)

That match is the **preferred** tab host. No match → main-area Botmux host (still primary Terminal workbench).

Left **Botmux** tree: sessions matching the active worktree auto-pin to a **This worktree** group on top (only while matches exist; suppressed while a text filter is active). Worktree cards show a small radio badge with session count for that directory.

## Session actions

| Action | Behavior |
|--------|----------|
| Terminal (**default attach**) | **1)** Match `session.cwd` + host → main Terminal on that Botmux worktree. **2)** No match → `botmux:session:<sessionId>` main-area host (SSH: remote PTY when possible, else `ssh -tt`). **Never floating.** Shift+click → Web. |
| Terminal (web) | Fallback / Shift+click: browser tab on write-link HTML terminal |
| Terminal (WS relay) | Optional: `botmux-term-relay.mjs` against worker WS (legacy) |
| Session click | Left tree: **attach** by default; **Shift+click** → Web |
| Write-link auth | Bridge appends `?t=` dashboard token when the link lacks credentials |
| Write-link → WS | `writeLinkHttpToWorkerWsUrl` mirrors worker page: `http://h/s/id?token=` → `ws://h/s/id/?token=` |
| Send | `POST /api/trigger` turn (requires `botId` on the session) |

## Ask-hooks (Feishu deep)

| Piece | Location |
|-------|----------|
| List pending | Daemon `GET /api/asks/pending` (trusted host); dashboard aggregates |
| Answer from Desktop | Daemon `POST /api/asks/answer` via `submitAskFromDesktop` (bypasses Feishu canTalk) |
| Desktop UI | Right sidebar Botmux → **Needs answer** + Settings pane (multi-question / multi-select) |
| OS Notification | Main process `ensureBotmuxAskBackgroundPoll` (~15s) while any endpoint is live — works with sidebar closed |
| Panel poll | Same 12s panel/settings refresh while open |

## Platform tunnel (no SSH)

Transport `kind: 'platform'` uses `~/.botmux/platform.json` → `https://m-<machineId>.<platform-host>` plus local dashboard token. UI: **+ Platform** on the Botmux panel.

## Headless / remote host without Desktop GUI

On a server you still run the normal **botmux CLI daemon + dashboard** (not necessarily Desktop). Desktop on a laptop uses SSH multi-host to reach it.

Optional Botmux-class headless runtime:

```bash
# from desktop/ after build — starts runtime RPC without main window
pnpm exec electron . --serve --port 6768
```

That path is for Botmux-style remote IDE / mobile pairing later; **Feishu sessions** use the botmux daemon dashboard, not serve alone.

## Packaging

```bash
cd desktop
pnpm install
pnpm exec electron-vite build
pnpm pack:local              # dist/mac-arm64/Botmux.app
pnpm smoke:desktop
```

## Coexistence

| Process | Role |
|---------|------|
| Global `botmux` CLI / PM2 | Feishu, workers, dashboard, ask-broker under `~/.botmux` |
| botmux (`desktop/`) | IDE + multi-host session/ask bridge |

Settings → **SSH** and **Botmux Sessions** share the **same host catalog** (`ssh:listTargets` + `~/.ssh/config` import). Botmux does **not** re-ask for host/user/key — pick a known host and Connect; the bridge reuses the Botmux SSH session (port-forward) when already connected, otherwise auto-connects that target, else falls back to `ssh -L`.

Do not confuse the two **payloads**: Settings → SSH owns worktrees/agent remotes; Botmux Sessions owns Feishu daemon/dashboard tunnels over those same hosts.

## Runtime naming

Prefer `BotmuxRuntimeService` from `src/main/runtime/botmux-runtime.ts` (alias of vendor `BotmuxRuntimeService`). Full symbol rename of the class body is intentionally deferred for vendor merge stability.

## Regression matrix

See [capability-regression-matrix.md](./capability-regression-matrix.md).
