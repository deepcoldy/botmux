# Workflow daemon IPC v1

Status: implemented locally; coordinated fleet deployment required.

## Scope and threat model

This protocol protects the four Workflow v3 daemon HTTP mutations:

- `start`
- `cancel`
- `retry`
- `grant`

They live only under `/__workflow-ipc/v1/runs/:runId/:mutation`. Pre-v1
daemons do not know this namespace, so a stale v1 descriptor followed by a
binary rollback cannot accidentally execute the old unsigned route before the
client notices an unauthenticated response.

It rejects a loopback process that knows a daemon port and run ID but cannot
read the machine's `0600 ~/.botmux/.dashboard-secret`. A process that can read
that secret remains inside the established host trust boundary. Lark user
authorization is still enforced separately by current-turn provenance,
dashboard login, card/operator checks, and the immutable run binding.

IM commands, card callbacks, cold attach, and standalone local runs call the
business services in-process; they do not self-call this HTTP boundary.

## Request protocol

The HMAC key is `.dashboard-secret`. Request canonical material is one JSON
array (UTF-8), avoiding delimiter ambiguity:

```text
[
  "botmux-workflow-daemon-ipc/v1",
  epochMilliseconds,
  nonce,
  upperCaseMethod,
  exactRawRequestUrl,
  sha256ExactBodyBytes,
  targetLarkAppId,
  actualTargetPort,
  targetBootInstanceId
]
```

The daemon descriptor atomically advertises `workflowIpcProtocol: "v1"`, the
random 32-byte base64url `bootInstanceId`, and the actual probed IPC port. A new
client refuses to send when either v1 or the boot audience is absent. The
server reconstructs the port from `req.socket.localPort`, never `Host` or a
caller-controlled target header.

Descriptor writers and all discovery readers resolve `dashboard-daemons/`
through the shared `resolveBotmuxDataDir()` precedence rule, including custom
`SESSION_DATA_DIR` and daemon breadcrumb deployments.

The nonce is 32 random bytes, accepted once per daemon process, and retained
for ten minutes. Timestamps use canonical epoch milliseconds with a symmetric
60-second window. Binding the boot ID makes every old signature invalid after
restart even though the in-memory nonce set starts empty.

The daemon authenticates before run lookup or journal mutation. It reads at
most 16 KiB once, with a 5-second deadline, hashes the exact bytes, and parses
that same authenticated buffer. Invalid UTF-8, empty bodies, non-canonical
JSON, duplicate/unknown keys, and wrong field types fail without mutation.
Every client sends canonical `{}` when no optional field is present.

## Response protocol

Authenticated requests receive a signed response. Its canonical material is:

```text
[
  "botmux-workflow-daemon-ipc/v1/response",
  requestNonce,
  upperCaseMethod,
  exactRawRequestUrl,
  statusCode,
  sha256ExactResponseBodyBytes,
  targetLarkAppId,
  actualTargetPort,
  targetBootInstanceId
]
```

CLI and dashboard proxy verify this before trusting even a 2xx response. This
prevents a stale descriptor or process occupying a shadow port from fabricating
the durable meaning of `202 Accepted`.

Authentication failures intentionally have no signed response: the caller
treats them as transport/auth failures and never claims the mutation succeeded.

## Upgrade contract

There is no unsigned or legacy `ts:nonce` fallback. Old clients are rejected by
new daemons; new clients refuse old descriptors. CLI, dashboard, and every bot
daemon therefore must be upgraded and restarted as one fleet. Disk run formats
and in-process IM/card paths are unchanged.
