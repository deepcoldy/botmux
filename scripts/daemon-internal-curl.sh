#!/usr/bin/env bash
# daemon-internal-curl.sh — sign a Route B request and send it via curl.
#
# Usage:
#   ./scripts/daemon-internal-curl.sh <METHOD> <PATH> [BODY]
#
# Examples:
#   ./scripts/daemon-internal-curl.sh GET /__daemon/sessions-list
#   ./scripts/daemon-internal-curl.sh GET '/__daemon/workflows-runs-snapshot?status=running'
#   ./scripts/daemon-internal-curl.sh PUT /__daemon/settings-write \
#     '{"patch":{"publicReadOnly":true},"ownerUnionId":"on_yours"}'
#
# Env:
#   DAEMON_APP_ID    Identifier echoed in X-Botmux-Daemon-AppId (default cli_dev_local).
#   DASHBOARD_PORT   Default 7891.
#
# The secret is read from ~/.botmux/.dashboard-secret and is NEVER printed.
# `jq` is used to pretty-print JSON if available; otherwise raw text is shown.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <METHOD> <PATH> [BODY]" >&2
  exit 64
fi

METHOD="$1"
URL_PATH="$2"
BODY="${3:-}"

SECRET_FILE="$HOME/.botmux/.dashboard-secret"
APP_ID="${DAEMON_APP_ID:-cli_dev_local}"
PORT="${DASHBOARD_PORT:-7891}"

# Fail closed if secret is missing or empty — never silently bypass HMAC.
if [[ ! -r "$SECRET_FILE" ]]; then
  echo "fatal: cannot read $SECRET_FILE (run \`botmux dashboard\` first)" >&2
  exit 70
fi
if [[ ! -s "$SECRET_FILE" ]]; then
  echo "fatal: $SECRET_FILE is empty" >&2
  exit 70
fi

# Read into a shell variable but DO NOT echo it (set +x guards stays trace-free).
SECRET="$(cat "$SECRET_FILE")"
if [[ -z "$SECRET" ]]; then
  echo "fatal: secret string is empty" >&2
  exit 70
fi

# Uppercase the method for the signing material (matches server normalisation).
METHOD_UPPER="$(printf '%s' "$METHOD" | tr '[:lower:]' '[:upper:]')"

# Mint timestamp + 32-byte base64url nonce via node.
TS="$(node -e 'process.stdout.write(String(Date.now()))')"
NONCE="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')"

# sha256(body) — same hex-digest representation the server reconstructs.
BODY_HASH="$(printf '%s' "$BODY" | node -e '
  const c = require("crypto");
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", d => s += d);
  process.stdin.on("end", () => process.stdout.write(c.createHash("sha256").update(s).digest("hex")));
')"

# Signing material: ts \n nonce \n METHOD \n pathWithQuery \n sha256(body)
MATERIAL="$(printf '%s\n%s\n%s\n%s\n%s' "$TS" "$NONCE" "$METHOD_UPPER" "$URL_PATH" "$BODY_HASH")"

# HMAC-SHA256(secret, material) → base64url. Secret passed as an env var so it
# is never visible in argv (which `ps -ef` exposes).
SIG="$(MATERIAL="$MATERIAL" SECRET_ENV="$SECRET" node -e '
  const c = require("crypto");
  const mat = process.env.MATERIAL;
  const secret = process.env.SECRET_ENV;
  process.stdout.write(c.createHmac("sha256", secret).update(mat).digest("base64url"));
')"

# Send the request. The secret is GONE from the env block — only signed.
URL="http://127.0.0.1:${PORT}${URL_PATH}"
ARGS=(
  -sS -X "$METHOD_UPPER" "$URL"
  -H "X-Botmux-Daemon-Ts: $TS"
  -H "X-Botmux-Daemon-Nonce: $NONCE"
  -H "X-Botmux-Daemon-Sig: $SIG"
  -H "X-Botmux-Daemon-AppId: $APP_ID"
  -H "Content-Type: application/json"
)
if [[ -n "$BODY" ]]; then
  ARGS+=(--data "$BODY")
fi

OUTPUT="$(curl "${ARGS[@]}" || true)"

# Pretty-print if jq is available; otherwise raw.
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$OUTPUT" | jq . 2>/dev/null || printf '%s\n' "$OUTPUT"
else
  printf '%s\n' "$OUTPUT"
fi
