#!/usr/bin/env bash
# Installs CLIs that are not on this host INTO the lab's $HOME overlay (lab.sh),
# so nothing lands on the host. Each install is best-effort: a failure is
# printed and the matrix reports that CLI as "not installed".
set -uo pipefail
for cli in "$@"; do
  echo "[install] $cli"
  case $cli in
    hermes) uv tool install --quiet hermes-agent >/dev/null 2>&1 || echo "[install] hermes failed" ;;
    opencode2) npm install -g --silent @opencode-ai/cli@next >/dev/null 2>&1 || echo "[install] opencode2 failed" ;;
    reasonix) npm install -g --silent reasonix >/dev/null 2>&1 || echo "[install] reasonix failed" ;;
    minimax) npm install -g --silent @minimax-ai/code >/dev/null 2>&1 || echo "[install] minimax failed" ;;
    dsh|dsh-tui) npm install -g --silent @deepseek-ai/dsh >/dev/null 2>&1 || echo "[install] dsh failed" ;;
    copilot) npm install -g --silent @github/copilot >/dev/null 2>&1 || echo "[install] copilot failed" ;;
    *) echo "[install] no recipe for $cli" ;;
  esac
  command -v "$cli" >/dev/null 2>&1 && echo "[install] $cli -> $(command -v "$cli")"
done
