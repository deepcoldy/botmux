# Local Companion API

Botmux can expose a closed local management protocol for one explicitly bound isolated test Bot. It neither reuses Dashboard tokens or Dashboard/daemon HMAC keys nor proxies arbitrary Dashboard routes.

## Startup

```bash
botmux start \
  --companion-secret-file /run/secrets/botmux/companion \
  --companion-bot local_test_bot
```

`restart` accepts the same options. Both options are required together. `--companion-bot` selects one specific existing Bot; unrelated fleet entries are ignored, but that selected app id must match exactly one entry with `sandbox` enabled and `cliId` set to `codex` or `traex`. Duplicate entries, a missing entry, or any nonqualifying entry fail closed with a deterministic generic diagnostic and no app id disclosure.

Preprovision a dedicated test Bot before invoking the command: add one unique `larkAppId` entry with `sandbox: true` and `cliId: "codex"` or `"traex"`, and keep it separate from production Bots. Then pass that app id to `--companion-bot` and a separate canonical `0600` secret file to `--companion-secret-file`. `readIsolation` alone and `codex-app` are not accepted by this protocol. The secret must be a nonempty, non-symlink `0600` regular file owned by the current user at a canonical absolute path. Invalid configuration fails closed without including the path or contents in the error.

## Authentication

The surface uses the Dashboard's local listening port but authenticates independently before ordinary Dashboard auth/routing; it grants no Dashboard administrator identity. Requests must originate from loopback and carry the headers below. If an operator explicitly enables the platform tunnel, the tunnel is a trusted transport into the local Dashboard port; HMAC remains mandatory and is the effective boundary for that opt-in path.

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

Successful writes are idempotent by `requestId` for a bounded process-local window. Failed or timed-out writes are not cached and may be retried; the underlying operation must still be treated as asynchronous when a timeout is reported. The API accepts no Bot ID, chat ID, arbitrary settings/env/URL/header/command and exposes no trigger/result surface; every operation targets the startup-bound Bot. Role text is returned only on this companion-HMAC route and is not added to Dashboard/public DTOs. Responses and errors contain no secret, file path, or native identifier.
