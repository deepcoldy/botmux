#!/usr/bin/env bash
set -euo pipefail
log="${BOTMUX_HOOK_LOG:-/tmp/botmux-hook.log}"
printf '\n--- %s %s ---\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "${BOTMUX_HOOK_EVENT:-unknown}" >> "$log"
cat >> "$log"
