# botmux (Botmux-class)

This tree is a **vendor import** of [Botmux](https://github.com/stablyai/botmux)’s Electron desktop, relay, and runtime. Goal: millimeter-level feature parity with botmux, then integrate botmux Feishu/daemon surfaces.

See `NOTICE` for MIT attribution to Lovecast Inc. / Botmux.

## Environment

- **Node.js 24+** recommended (Botmux baseline). Node 22 may work for install but is unsupported upstream.
- **pnpm 10** (this package pins `packageManager`)
- macOS / Windows / Linux (same as Botmux)

The repo root `botmux` CLI package (Node ≥22, pnpm 9) stays independent. Develop Desktop **from this directory**.

## Install & run

```bash
cd desktop
corepack enable
corepack prepare pnpm@10.24.0 --activate
pnpm install
pnpm dev
```

Other useful scripts (inherited from Botmux):

```bash
pnpm build:desktop    # typecheck + relay + cli + electron-vite + web
pnpm build:mac        # package mac app
pnpm typecheck
pnpm test
```

## Layout

| Path | Role |
|------|------|
| `src/main` | Electron main: runtime RPC, PTY daemon, tray, updater |
| `src/preload` | contextBridge IPC |
| `src/renderer` | Full IDE React UI |
| `src/shared` | Shared types / protocol |
| `src/relay` | Remote relay handlers |
| `src/cli` | Runtime CLI |
| `config/` | electron-builder, tsconfigs, scripts |
| `native/` | computer-use / notification helpers |

## Coexistence with botmux CLI

| Surface | Path / process |
|---------|----------------|
| Feishu bridge + web dashboard | Repo root: `pnpm build`, `botmux` CLI, `~/.botmux` |
| Botmux-class IDE Desktop | This package; Electron userData is separate from `~/.botmux` |

Do **not** use the root `src/desktop` thin webview shell for new Desktop work; it is legacy and will be deprecated in favor of this tree.

## Rebrand status

- App id / product name: `com.botmux.desktop` / `Botmux`
- Pairing scheme: **`botmux://pair`** (decode still accepts legacy `botmux://pair`)
- Dev userData: `~/Library/Application Support/botmux-desktop-dev`
- Mechanical pass: `pnpm rebrand` (`scripts/rebrand-from-botmux.mjs`)

Internal class names like `BotmuxRuntimeService` are kept on purpose (vendor stability).

## Botmux Sessions bridge (Feishu daemon)

Settings → **Botmux Sessions**:

| Mode | What it does |
|------|----------------|
| **Local** | Reads `~/.botmux/.dashboard-port` + `.dashboard-token`, lists `/api/sessions` |
| **SSH remote** | Pick a host from **Settings → SSH** (shared store) or type `user@host`; system `ssh` probes remote `~/.botmux` and local-forwards the dashboard |

### Multi-host

Connect **local + any number of SSH remotes at once**. Each host keeps its own tunnel/token; sessions are merged with a **host label**. Actions (terminal / send) carry `hostId` so they hit the right dashboard.

| Where | What |
|-------|------|
| **Right sidebar → Botmux** | Connected hosts list (+ Add Local / + SSH), filter by host, merged sessions |
| **Settings → Botmux Sessions** | Same multi-host model + manual SSH destination + Disconnect all |

**Persistence:** connected endpoints saved under Electron userData (`botmux-bridge-endpoints.json`); auto-reconnect after SSH handlers start.

**Auto-refresh:** panels poll sessions every ~12s while open.

**SSH one-click:** connecting a Desktop SSH target runs Botmux `ssh:connect` when not already connected, then prefers **port-forward**; falls back to system `ssh -L`.

Session actions:

- **Terminal** — if a worktree is active, **in-workspace browser tab**; else **BrowserWindow**; external → system browser. Write-links get `?t=` token when missing.
- **Send** — `POST /api/trigger` on that host (needs `botId`)

Details: [docs/botmux-bridge.md](./docs/botmux-bridge.md).

Requirements for SSH remote:

1. Remote host has `botmux` daemon + dashboard running
2. SSH works with `BatchMode=yes` (config Host / key / agent). Desktop SSH targets reuse `IdentityFile` / `ProxyJump` when set
3. Remote files: `~/.botmux/.dashboard-port` (and ideally `.dashboard-token`)

**Two SSH surfaces (do not confuse):**

| Settings → SSH | Settings → Botmux Sessions |
|----------------|----------------------------|
| Remote **agent worktree / PTY / git** (Botmux-class IDE) | Remote **Feishu botmux sessions** via dashboard tunnel |
| Full relay deploy | Lightweight OpenSSH `-L` only |

Use both on the same host if you want IDE agents *and* Feishu bots on one box.

## Pack & smoke

```bash
pnpm exec electron-vite build
pnpm smoke:desktop
pnpm pack:local              # dist/mac-arm64/Botmux.app (ad-hoc sign)
pnpm pack:local:install      # → /Applications/Botmux.app
```
