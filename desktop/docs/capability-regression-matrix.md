# Desktop capability regression matrix (non-mobile)

Manual + smoke checklist for orca_botmux (OrcaBotmux-class). Run after significant `desktop/` or bridge changes.

## Automated

```bash
cd desktop
pnpm exec electron-vite build
pnpm smoke:desktop
# CI:
ORCA_BOTMUX_SMOKE_SKIP_ELECTRON=1 pnpm smoke:desktop
```

| Check | Gate |
|-------|------|
| electron-vite main/preload/renderer build | CI `desktop` job |
| Package identity / pairing / bridge IPC symbols | `smoke-desktop.mjs` |
| Endpoint persistence source present | smoke |
| Write-link token helper present | smoke |

## Manual (local)

| Area | Steps | Pass? |
|------|-------|-------|
| **Cold boot** | `pnpm dev` or pack app; window paints | |
| **Worktree** | Add local repo → create worktree → agent tab | |
| **Terminal** | Type in worktree terminal; resize; scrollback | |
| **Git SC** | Dirty file appears; stage/commit/push smoke | |
| **Browser** | Open browser tab; navigate | |
| **Mobile QR** | Settings → Mobile; QR shows `orca_botmux://pair` | |
| **OrcaBotmux Local** | Start `orca_botmux` daemon; sidebar OrcaBotmux → Local → sessions | |
| **OrcaBotmux multi SSH** | Connect 2 SSH hosts; both listed; filter by host | |
| **OrcaBotmux persist** | Connect hosts; restart app; auto-reconnect | |
| **Ask-hooks single** | CLI ask one question; Desktop Needs answer; submit; CLI continues | |
| **Ask-hooks multi** | Multi-select / multi-question card; submit all; CLI continues | |
| **Native terminal** | Open worktree → session **PTY** → tab runs `ELECTRON_RUN_AS_NODE` + relay; type input echoes; resize ok |
| **Ask background notify** | With panel closed, new ask still shows OS Notification | |
| **Web terminal** | Session **Terminal/Web** → browser tab write-link works | |
| **Platform** | With `platform.json` + public tunnel; **+ Platform** connects | |
| **Local readiness hint** | Stop dashboard; panel shows start instructions | |
| **SSH one-click** | Disconnect OrcaBotmux SSH; Add orca_botmux SSH host; auto-connect works | |

## Out of scope (this matrix)

- Mobile Expo app / App Store
- Apple notarization
- Full e2e Playwright suite for every OrcaBotmux IDE path

Mark date/reviewer when executed for a release branch.
