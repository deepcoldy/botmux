#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"
title="botmux ${BOTMUX_HOOK_EVENT:-hook}"
body="$(printf '%s' "$payload" | tr '\n' ' ' | cut -c 1-240)"

/usr/bin/osascript -e 'on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run' "$title" "$body"
