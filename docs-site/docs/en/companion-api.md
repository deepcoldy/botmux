# Local Companion API

Botmux can expose a closed local management protocol for one explicitly bound isolated test Bot. It neither reuses Dashboard tokens or Dashboard/daemon HMAC keys nor proxies arbitrary Dashboard routes.

## Startup

```bash
botmux start \
  --companion-secret-file /run/secrets/botmux/companion \
  --companion-bot local_test_bot
```

`restart` accepts the same options. Both options are required together. The target must match exactly one `bots.json` entry with `sandbox` enabled and `cliId` set to `codex` or `traex`. The secret must be a nonempty, non-symlink `0600` regular file owned by the current user at a canonical absolute path. Invalid configuration fails closed without including the path or contents in the error.

## Authentication

The surface uses the Dashboard's local listening port but authenticates independently before ordinary Dashboard auth/routing; it grants no Dashboard administrator identity. Requests must originate from loopback and carry:

- `X-Botmux-Companion-Timestamp`: epoch milliseconds, within 60 seconds;
- `X-Botmux-Companion-Nonce`: a one-time random value;
- `X-Botmux-Companion-Signature`: base64url HMAC-SHA256.

Signing material:

```text
timestamp\nnonce\nMETHOD\nexact-pathname\nsha256(raw-body)
```

Bodies are capped at 64 KiB. Replay, stale timestamps, and signature/method/path/body mismatches are rejected before the operation runs.

## Fixed routes

- `GET /__companion/v1/health`: protocol version and capabilities only;
- `GET /__companion/v1/role`: `{role, injectMode, revision:null}`, with role text capped at 32 KiB;
- `PUT /__companion/v1/role`: only `{requestId, role, injectMode}`; `injectMode` is `every|once`, and `role:""` clears it; returns the sanitized readback;
- `GET /__companion/v1/runtime`: `{provider, model?, reasoning?}`;
- `PUT /__companion/v1/runtime`: only `{requestId, provider, model?, reasoning?}`. `provider` is `codex|traecli` (mapped to Botmux `codex|traex`), model is at most 200 characters, and reasoning uses the existing provider/model-specific closed allowlist.

Writes are idempotent by `requestId` for the process lifetime. The API accepts no Bot ID, chat ID, arbitrary settings/env/URL/header/command and exposes no trigger/result surface; every operation targets the startup-bound Bot. Role text is returned only on this companion-HMAC route and is not added to Dashboard/public DTOs. Responses and errors contain no secret, file path, or native identifier.
