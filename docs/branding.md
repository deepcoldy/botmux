# Botmux branding (canonical)

Final product identity for `desktop/` + `mobile/`. Do **not** reintroduce Orca / orca_botmux as product names.

## Layers

| Layer | Canonical | Examples |
|-------|-----------|----------|
| Display name | **Botmux** | Window title, home screen, About |
| Package / CLI | **botmux-desktop**, **botmux-mobile** | npm `name`, bins |
| Protocol / storage | **botmux** | `botmux://pair`, `~/.botmux`, `com.botmux.*` |

## Rules

1. **Mint** pairing URLs only as `botmux://pair?code=…`.
2. **Do not mint** `orca://` or `orca_botmux://`. Prefer no legacy decode (thorough mode).
3. Dashboard cookie: `botmux_dashboard_token`. Home directory: `~/.botmux`.
4. Environment variables: **`BOTMUX_*` only** (no product `ORCA_*`).
5. Project config file name: **`botmux.yaml`** (not the old `orca_botmux.yaml` name).
6. Runtime class: **`BotmuxRuntimeService`**.
7. Bridge API / IPC: **`botmuxBridge`** / `botmuxBridge:*`.
8. Skills: **`botmux-cli`**, `botmux-linear`, etc. (not `orca-botmux-*`).
9. Packaged launchers: macOS `Contents/MacOS/Botmux` (or `botmux`), Windows `botmux.exe`, Linux `botmux` / `botmux-ide`.
10. **Attribution exception**: `NOTICE` / `LICENSE` may mention upstream Orca / Lovecast (MIT). UI product strings must not.
11. **No private infrastructure hosts in source.** Cloud login, mobile relay, and feedback endpoints are **env-only** (see below). Docs/changelog UI slots stay empty until a public Botmux host exists. Never commit internal domains.

## Cloud / remote services (env-only)

Open-source builds ship with these features **off** until operators set env vars (CI secrets, private packaging, or local `.env` not committed).

| Concern | Env vars | When unset |
|---------|----------|------------|
| **Login** (cloud OAuth / profiles) | `BOTMUX_CLOUD_API_URL` (required), `BOTMUX_CLOUD_CLIENT_ID` (optional, default `botmux-desktop`), optional `BOTMUX_CLOUD_*_URL` endpoint overrides | Cloud sign-in reports not configured |
| **Relay** (phone remote pair) | `BOTMUX_RELAY_URL` (director **origin**, required with login) | Cloud config incomplete |
| **Feedback** | `BOTMUX_FEEDBACK_API_URL` (required), `BOTMUX_FEEDBACK_API_FALLBACK_URL` (optional) | Submit returns not configured |
| **Changelog / docs / privacy** | (empty constants; fill later) | Menu items / fetches no-op |

Example (private deploy only — do **not** commit real hosts):

```bash
export BOTMUX_CLOUD_API_URL=https://login.example.com
export BOTMUX_CLOUD_CLIENT_ID=botmux-desktop
export BOTMUX_RELAY_URL=https://relay.example.com
export BOTMUX_FEEDBACK_API_URL=https://example.com/v1/feedback
# optional:
# export BOTMUX_FEEDBACK_API_FALLBACK_URL=https://api.example.com/v1/feedback
```

## Thorough mode (dogfood)

- No dual-write `ORCA_*`; no dual-read of the old project yaml name.
- No user-data migrate paths; clean reinstall / re-pair accepted.
- Use `node scripts/check-botmux-brand-gate.mjs` before claiming clean.
- Managed Codex profile markers use `# BEGIN BOTMUX AGENT STATUS HOOKS` only.
- SSH/relay wire sentinels use `BOTMUX-RELAY` / `BOTMUX-*-OK` tokens only (no product `ORCA-*`).

## Anti-patterns

- Do not run transitional rebrand scripts under `desktop/scripts/rebrand-*.mjs` (disabled).
- Do not use display name `botmux-desktop` in UI; use **Botmux**.
- Do not leave packaged CLI scripts that resolve `Orca.exe` / `MacOS/Orca` / `orca-ide`.
- Do not hardcode private login/relay/feedback hostnames in source or tests (use `example.test` fixtures).
