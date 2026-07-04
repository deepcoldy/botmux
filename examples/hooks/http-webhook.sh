#!/usr/bin/env bash
set -euo pipefail

endpoint="${1:?usage: http-webhook.sh <url>}"

curl -fsS \
  -X POST \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "$endpoint" >/dev/null
