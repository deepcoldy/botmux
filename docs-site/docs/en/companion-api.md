# Local Companion API

The Companion API is a small, **local-only** interface. It lets your own tools on the same machine (test scripts, a desktop companion app, and so on) read and change two things on **one** test Bot:

- **Role**: the Bot's default role (persona) and how it is injected;
- **Runtime**: which CLI it uses (Codex or TRAE), which model, and which reasoning level.

It is off by default. When on, it is bound to the single Bot you name at startup. It does not reuse Dashboard login tokens and cannot proxy any other Dashboard route.

## Who it's for

| What you want to do | Good fit? |
|---|---|
| Script persona/model switches on a test Bot for comparison runs | Yes |
| Build a local companion app that tweaks a test Bot | Yes |
| Manage production Bots, several Bots, or call it from a remote service | No. Use the [Dashboard](/en/dashboard) or the [Task Trigger API](/en/api-task-trigger) |

## Step 1: Prepare a dedicated test Bot

In `bots.json`, set up a Bot that is **separate from your production Bots** and meets all three rules:

| Field | Requirement |
|---|---|
| `larkAppId` | Appears only once in `bots.json` |
| `sandbox` | Set to `true` (turns on the [allowlist sandbox](/en/sandbox)). It must be the boolean `true`; the strings `"oncall"` / `"scratch"`, or `readIsolation` alone, are rejected |
| `cliId` | `codex` or `traex` (`codex-app` is not accepted) |

```json
{
  "larkAppId": "cli_xxx_test",
  "larkAppSecret": "…",
  "cliId": "codex",
  "sandbox": true
}
```

## Step 2: Prepare the secret file

The secret is a random string you generate yourself; it is used to sign requests. The file must:

- live at an **absolute path** that does not go through any symlink;
- be a regular file, not a symlink;
- be owned by the current user with mode `0600`;
- be non-empty and at most 1 KiB (leading/trailing whitespace is trimmed);
- sit in a directory that is also owned by the current user and not writable by group or others (so not a shared directory like `/tmp`).

```bash
mkdir -p ~/.secrets && chmod 700 ~/.secrets
openssl rand -base64 32 > ~/.secrets/botmux-companion
chmod 600 ~/.secrets/botmux-companion
```

## Step 3: Start

```bash
botmux restart \
  --companion-secret-file "$HOME/.secrets/botmux-companion" \
  --companion-bot cli_xxx_test
```

- Both `start` and `restart` accept these options, and they **must be given together**.
- You can use environment variables instead: `BOTMUX_COMPANION_SECRET_FILE` and `BOTMUX_COMPANION_BOT_APP_ID`.
- If the fleet is already running, `start` errors out; use `restart` to apply the options.
- If validation fails, startup is refused. Errors are fixed strings and never include the app id, file path, or secret:

| Error | Cause |
|---|---|
| `companion configuration requires both secret-file and bot selection` | Only one of the two options was given |
| `companion_secret_invalid` | The secret file doesn't meet Step 2 |
| `companion bot selection must match exactly one isolated codex/traex Bot` | The Bot is missing, duplicated, or doesn't meet Step 1 |

## Step 4: Send requests

The API lives on the Dashboard's local port (default `7891`; the actual port is written to `~/.botmux/.dashboard-port`). All paths start with `/__companion/v1/`.

### Signing

Every request carries three headers:

| Header | Content |
|---|---|
| `X-Botmux-Companion-Timestamp` | Current time in epoch milliseconds, within 60 seconds of the server clock |
| `X-Botmux-Companion-Nonce` | A fresh random value for every request; each can be used only once |
| `X-Botmux-Companion-Signature` | HMAC-SHA256 of the material below using the secret, base64url-encoded |

The signed material is five lines joined with `\n`:

```text
timestamp
nonce
METHOD (uppercase, e.g. GET / PUT)
path (e.g. /__companion/v1/role, no query string)
sha256 of the request body (hex; with no body, the sha256 of the empty string)
```

A ready-to-use Node.js example:

```js
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const secret = readFileSync(`${process.env.HOME}/.secrets/botmux-companion`, 'utf8').trim();
const port = readFileSync(`${process.env.HOME}/.botmux/.dashboard-port`, 'utf8').trim();

async function call(method, path, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(raw).digest('hex');
  const signature = createHmac('sha256', secret)
    .update([timestamp, nonce, method, path, bodyHash].join('\n'))
    .digest('base64url');
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'X-Botmux-Companion-Timestamp': timestamp,
      'X-Botmux-Companion-Nonce': nonce,
      'X-Botmux-Companion-Signature': signature,
    },
    body: raw || undefined,
  });
  return res.json();
}

console.log(await call('GET', '/__companion/v1/health'));
```

### Routes

| Route | Purpose | Body |
|---|---|---|
| `GET /__companion/v1/health` | Protocol version and capabilities | none |
| `GET /__companion/v1/role` | Read the default role | none |
| `PUT /__companion/v1/role` | Write the default role | `{requestId, role, injectMode}` |
| `GET /__companion/v1/runtime` | Read the runtime config | none |
| `PUT /__companion/v1/runtime` | Change the runtime config | `{requestId, provider, model?, reasoning?}` |

Success responses look like `{"ok": true, ...}`. `health` returns the protocol version `botmux.companion.v1` and a capability list; read routes put the result in `value`; write routes return the `requestId` plus the read-back `value` after the write.

**Reading and writing the role**

- A read returns `{role, injectMode, revision: null}`. This role is the "default role" from [Roles & Teams](/en/roles), the same one written by `/role team set` and the Dashboard's default-role editor.
- `role`: Markdown text, up to 32 KiB (UTF-8 bytes); an empty string `""` clears it.
- `injectMode`: `every` (inject every turn) or `once` (first turn only).

```js
await call('PUT', '/__companion/v1/role', {
  requestId: 'role-20261105-001',
  role: 'You are a strict code reviewer.',
  injectMode: 'every',
});
```

**Reading and writing the runtime**

- A read returns `{provider, model?, reasoning?}`; unset fields are omitted.
- `provider`: `codex` or `traecli`, mapped to Botmux `codex` and `traex`. Sending the other value switches the Bot to the other CLI.
- `model`: optional, at most 200 characters; omitting it clears any configured model and falls back to the CLI default.
- `reasoning`: optional reasoning level; only levels supported by that CLI and model are accepted (e.g. `low` / `medium` / `high` / `xhigh`); omitting it clears any configured level.
- Each write replaces the whole runtime config: to keep the current model or reasoning level, read first and send them back together.

```js
await call('PUT', '/__companion/v1/runtime', {
  requestId: 'runtime-20261105-001',
  provider: 'codex',
  model: '<model-name>',
  reasoning: 'high',
});
```

Bodies accept only the fields listed above; any extra field is rejected.

### Retries and requestId

- You generate `requestId`: 8–128 characters, letters, digits, `_` and `-` only.
- A **successful** write is remembered by `requestId` for 10 minutes; resending it does not run the operation again and returns the earlier result.
- Failed or timed-out results are not remembered, so you can retry with the same `requestId`.
- An operation that takes longer than 10 seconds returns `timeout`. The underlying change may still be in progress, so read the current value first before deciding to retry.

### Error codes

| HTTP status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_body` | Body is not valid JSON, has extra fields, has invalid values, or lacks `requestId` |
| 401 | `unauthorized` | Missing headers, timestamp outside 60 seconds, or bad signature |
| 403 | `forbidden` | The request did not come from loopback |
| 404 | `unknown_endpoint` | Path or method not in the table above (a query string counts too) |
| 404 | `companion_disabled` | The Companion API was not enabled for this run, or the Dashboard's own Bot/secret check failed at startup (look for `[companion] disabled` in the Dashboard log) |
| 409 | `replayed` | The nonce was already used |
| 413 | `body_too_large` | Body exceeds 64 KiB |
| 500 | `timeout` / `operation_failed` | The operation timed out or failed (for example, the bound Bot no longer meets Step 1); transient failures can be retried |

## Security boundaries

- **Local only**: requests must come from a loopback address such as `127.0.0.1`. If you explicitly enable the platform tunnel, requests arriving through it still have to pass signature checks; the signature is the real gate on that path.
- **Separate auth**: signatures are checked before, and independently of, normal Dashboard auth. Passing them grants no Dashboard admin identity.
- **Fixed scope**: no Bot ID, chat ID, arbitrary settings, env vars, URLs, headers, or commands are accepted. Every operation targets only the Bot bound at startup, and each one re-checks that the Bot still meets Step 1.
- **No leaks**: role text is returned only through this signed API and never appears in Dashboard/public data; responses and errors never contain the secret, file paths, or internal IDs.
