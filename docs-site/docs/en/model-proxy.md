# Model Proxy (Experimental)

> ⚠️ Experimental: endpoints, fields and limits may change. It does not affect regular Feishu bots.

`botmux model-proxy serve` starts an **authenticated, OpenAI Chat Completions–compatible endpoint** on `127.0.0.1`. Tools that only speak the OpenAI protocol (scripts built on the OpenAI SDK, code-review tools, and so on) can point their `baseURL` here and call models through a CLI's **own login** (Codex, Claude Code, …) — no separate API key needed.

```text
Your tool (OpenAI SDK)
   │  HTTP + Bearer token, 127.0.0.1 only
   ▼
botmux model-proxy (this page)
   │  local signed IPC
   ▼
Dedicated core-only instance (apiOnly bot with its own native login)
   │
   ▼
Native CLI model call (all tools disabled, inference only)
```

## When to use it

| I want to… | Use this? |
|---|---|
| Let an existing OpenAI-protocol tool reuse a CLI's model login | ✅ That's what it's for |
| My tool manages context and tool calls itself and only needs a "model endpoint" | ✅ Tool calls come back as **proposals**; your tool executes them |
| Have AI work and edit code in Feishu | ❌ Use a regular bot, see [Quick Start](/en/quickstart) |
| Drive a full CLI session over HTTP (read/write files, run commands) | ❌ See [Core-only (apiOnly) API control](/en/api-core-only) |
| Streaming, embeddings, images, audio, direct browser access | ❌ Not supported yet |

Key points up front:

- **Loopback only** (`127.0.0.1`). The config only accepts this address, so it is not reachable from the network.
- **The CLI never touches your files**: native CLI tools are disabled on every call; it only does inference. Returned `tool_calls` are proposals — execution stays with your tool.
- **No borrowed logins**: the proxy only uses the login in the dedicated bot directory you specify. It never picks up chat bots', the global, or other bots' credentials.

## Quick start

### Step 1: Start a dedicated core-only instance

The proxy doesn't call models itself. It forwards requests to a **separate core-only instance** (a botmux that doesn't connect to Feishu and only serves local HTTP, see [Core-only](/en/api-core-only)). That instance must:

- Be its own process with its own data directory and port. **Do not reuse — or restart for this — a running Feishu bot daemon.**
- Have a bot ID of the form `local_<name>`, using only letters, digits, `_` and `-` in the name (the proxy config rejects `.`).
- Use one of the supported CLIs below, with a native login completed in that bot's dedicated directory.

```bash
export STATE_DIR="$HOME/model-proxy-demo"     # pick a fresh directory
export BOTMUX_CORE_CLI=codex                  # or claude-code / pi / opencode
export BOTMUX_API_ONLY_BOT=local_reasoner
export BOTMUX_CORE_CODEX_AUTH_SYNC=isolated   # Codex only
export BOTMUX_CORE_STATE_DIR="$STATE_DIR/data"
export BOTMUX_API_PORT=8930                   # pick a free port
botmux serve --api-only
```

This command runs in the foreground. Use another terminal for the next steps, and `export STATE_DIR=...` again there (same directory as above).

Login files live under `$STATE_DIR/bots/<bot ID>/<subdir>`:

| CLI | Subdir | Login files needed |
|---|---|---|
| `codex` / `codex-app` | `codex` | `auth.json`, plus a `models_cache.json` that contains the target model; `BOTMUX_CORE_CODEX_AUTH_SYNC=isolated` is required |
| `claude-code` | `claude` | `.credentials.json` (a login that only lives in the system keychain won't work) |
| `pi` | `pi` | `auth.json` (API key or OAuth; executable helpers not supported) |
| `opencode` | `opencode` | `auth.json` (API / OAuth records only) |

For Codex, for example, log that directory in with `CODEX_HOME="$STATE_DIR/bots/local_reasoner/codex" codex login`.

> Keep this instance "plain": no sandbox, no `--backend`, no extra env vars, startup commands or wrapper. With any of these, the proxy refuses to start with `inference_profile_unsupported`.

### Step 2: Write the proxy config file

Save the following to a file, e.g. `$STATE_DIR/model-proxy.json`:

```json
{
  "port": 8788,
  "models": {
    "review-model": {
      "bot": "local_reasoner",
      "model": "<native-model-id>",
      "deadlineMs": 120000
    }
  },
  "clients": [
    { "id": "review-client", "tokenEnv": "BOTMUX_MODEL_PROXY_TOKEN", "models": ["review-model"] }
  ]
}
```

Lock it down so only you can read and write it, otherwise the proxy won't start:

```bash
export PROXY_CONFIG="$STATE_DIR/model-proxy.json"
chmod 600 "$PROXY_CONFIG"
```

- It must be a **regular file owned by the current user with mode exactly `0600`**.
- Its directory (and the directories above it) must not be writable by other users.

### Step 3: Create a token and start the proxy

```bash
# At least 32 characters, no whitespace; hand it to the tool over a secure channel
export BOTMUX_MODEL_PROXY_TOKEN="$(openssl rand -hex 32)"
# Point at the data directory of the Step 1 instance so the proxy can find it
export SESSION_DATA_DIR="$STATE_DIR/data"
botmux model-proxy serve --config "$PROXY_CONFIG"
```

On success it prints one line of JSON:

```json
{"listening":"http://127.0.0.1:8788/v1","protocol":"chat-completions-v1"}
```

The proxy runs in the foreground. `Ctrl+C` (SIGINT) or SIGTERM stops it and cancels calls still in flight.

### Step 4: Connect your tool

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8788/v1',
  apiKey: process.env.BOTMUX_MODEL_PROXY_TOKEN,
  maxRetries: 0, // retries are your call; send an Idempotency-Key if you need dedup
});

const result = await client.chat.completions.create({
  model: 'review-model', // the alias from the config, not the native model name
  messages: [{ role: 'user', content: 'Explain binary search in one sentence.' }],
});
console.log(result.choices[0].message.content);
```

To check connectivity first, list the models this token can use:

```bash
curl -s http://127.0.0.1:8788/v1/models \
  -H "Authorization: Bearer $BOTMUX_MODEL_PROXY_TOKEN"
```

## Config file reference

### Top-level fields

| Field | Required | Description |
|---|---|---|
| `host` | No | Must be `127.0.0.1` (the default) |
| `port` | No | Listening port, default `8788`; `0` lets the OS pick one |
| `models` | Yes | Model **alias** table, at least one entry |
| `clients` | Yes | Clients allowed to connect, 1–100 |

Unknown fields in the config are rejected, not ignored.

### `models`: model aliases

Clients only see the alias (e.g. `review-model`), never which bot or native model is behind it.

| Field | Required | Description |
|---|---|---|
| `bot` | Yes | Bot ID of the Step 1 dedicated instance, e.g. `local_reasoner` |
| `model` | Yes | Native model name, as understood by the CLI |
| `reasoningEffort` | No | Reasoning effort: `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra`; ultimately bounded by what the CLI supports |
| `deadlineMs` | No | Per-call time limit, 100–300000 ms, default `120000`; returns 504 on timeout |

### `clients`: clients and tokens

| Field | Description |
|---|---|
| `id` | Client name (letters, digits, `_`, `-`), must be unique |
| `tokenEnv` | **Name of the env var holding the token** (starts with an uppercase letter, e.g. `BOTMUX_MODEL_PROXY_TOKEN`). The token itself never goes in the config file |
| `models` | Aliases this client may use; all must exist in `models` |

- Tokens must be at least 32 characters with no whitespace; different clients can't share a token.
- The token is **unrelated** to the CLI's subscription credentials — it only decides which aliases are allowed.
- Changing a token requires restarting the proxy.

## Supported endpoints and fields

There are only two endpoints, both requiring `Authorization: Bearer <token>`:

- `GET /v1/models`: lists the aliases this token may use.
- `POST /v1/chat/completions`: **non-streaming** chat completion; `Content-Type` must be `application/json`.

| Field | Support |
|---|---|
| `model` | Required; an alias that is in this client's allow list |
| `messages` | Five roles: `system` / `developer` / `user` / `assistant` / `tool`; content is a string or an array of `text` parts only; up to 2000 messages |
| `tools` | `function` type only, up to 128; parameter schema must be an object |
| `tool_choice` | `auto` / `none` / `required` / a specific function |
| `parallel_tool_calls` | When `false`, at most one call proposal is returned |
| `response_format` | `text`, `json_object`, `json_schema` |
| `stream` / `n` | Omit them, or use `stream: false`, `n: 1` |
| `max_completion_tokens` | Omitted or `null` means no limit specified; an integer 1–128000 is **only supported by Claude Code** — other CLIs return 400 `max_completion_tokens_unsupported` |
| Anything else | Always 400 `unsupported_or_invalid_parameter`, including `temperature`, `top_p`, `max_tokens`, `seed`, `stop`, `logprobs`, etc. — **never silently ignored** |

Supported JSON Schema keywords for tool parameters and `json_schema`: `type`, `properties`, `required`, boolean `additionalProperties`, `items`, `enum`, `description`, `title`, numeric bounds, string length, array length. `$ref`, combinators like `anyOf`/`oneOf`, regex patterns and the like are not supported and are rejected.

### Multi-turn tool calls

Same as with OpenAI: the model returns `tool_calls` → your tool executes them → send the results back as `tool` messages (with `tool_call_id`) in the next request. The proxy checks that history is complete:

- `tool_call_id`s must be unique, and every call needs a matching result.
- No other message may be inserted before all results are in.

The model's answer is validated too: calling an unknown function, arguments that don't match the schema, violating `tool_choice`, or invalid JSON when JSON was requested all return 502 instead of handing you a bad result as success.

### What comes back

- On success `finish_reason` is `stop` or `tool_calls`. `length` is never returned.
- Tool call IDs are generated deterministically, so replaying an idempotent request keeps the same IDs.
- The standard `usage` field is always `null`. Real usage is in `botmux.native_invocation_usage`, which totals the **whole CLI invocation** (possibly including internal retries) and can't be treated as a single API bill. Some tools display `null` as 0 — that doesn't mean nothing was consumed.

## Idempotency and timeouts

- With an `Idempotency-Key` header (alphanumerics and `_.:-`, up to 128 chars), the same key + same request from the same client and alias replays the stored result without calling the CLI again; same key with a different request returns 409.
- Two requests without a key are two independent calls.
- A client disconnect cancels the call; within one proxy process, if several connections wait on the same result, one disconnecting doesn't affect the others.
- Run one proxy process per inference bot.

## Common errors

Errors always look like `{"error":{"message":"<code>","type":"...","param":...,"code":"<code>"}}` and never include CLI error output, credentials or local paths.

| Status | Common causes |
|---|---|
| 400 | Unsupported or malformed field (check which field `param` points to), incomplete tool history |
| 401 | Wrong token or missing `Authorization` |
| 403 | Alias not allowed for this token; or the request carries an `Origin` header (direct browser access isn't supported) |
| 404 | Unsupported endpoint |
| 409 | Idempotency key conflict, or the call was cancelled |
| 413 | Request body over 1 MB, or the assembled prompt is too long |
| 415 | `Content-Type` isn't `application/json`, or a content encoding was used |
| 429 | Inference instance is at capacity |
| 502 | Inference failed or the model output failed validation, e.g. `native_auth_missing` (dedicated directory not logged in), `native_model_not_found` (wrong model name) |
| 503 | Dedicated instance not found (`inference_profile_offline`), instance config doesn't qualify (`inference_profile_unsupported`), transport failure |
| 504 | `deadlineMs` exceeded |

## FAQ

**Startup fails with `model_proxy_config_missing` or a permission error?**
Check that the `--config` path exists, the file is `chmod 600`, and its directory isn't writable by other users.

**Startup fails with `model_proxy_token_requires_32_nonwhitespace_characters`?**
The env var named by `tokenEnv` isn't set, or the token is too short or contains whitespace.

**Getting `inference_profile_offline`?**
The proxy can't find the dedicated instance. Make sure it's running and that `SESSION_DATA_DIR` points at its data directory (`$STATE_DIR/data` from Step 1) when you start the proxy.

**Is it exactly the same as calling the model API directly?**
Not exactly. Conversation roles and tool definitions are serialized into text for the CLI, then the response is rebuilt from structured output. Role order and tool associations are preserved, but this isn't native verbatim passthrough, and the CLI's internal prompts and retries also affect results.

**Can the output limit be used as a cost cap?**
No. `max_completion_tokens` only applies to Claude's generation request; the CLI's wrapping and retries also consume tokens.

## Related

- [Core-only (apiOnly) API control](/en/api-core-only): starting the dedicated instance, data directory and security boundaries
- [CLI commands](/en/cli-commands)
- [Supported CLIs](/en/adapters)
