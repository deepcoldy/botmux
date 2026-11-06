#!/usr/bin/env bash
# Lab for the oncall-sandbox CLI matrix. MUST run inside isolate-run (private
# mount + PID namespace; its mounts and processes die with it):
#
#   isolate-run --timeout 60m -- bash scripts/oncall-cli-matrix/lab.sh <upper-dir> [runner args...]
#
# It puts a throwaway overlay over $HOME (upper on <upper-dir>, outside $HOME),
# so the CLIs, their installers and the sandboxed agents read the real
# toolchain layout of this host while EVERY write (installs, configs, caches,
# sessions) lands in the upper and never reaches the host. Then it whites out
# the host's real CLI login state (auth files, sessions, history) inside the
# overlay, so no real credential is visible to anything the matrix starts.
# The runner writes fake credentials pointing at its local mock model.
set -euo pipefail

upper=${1:?upper dir}
shift
grep -q isolate- /proc/self/cgroup || { echo "lab.sh: run me under isolate-run" >&2; exit 2; }
# Own private mount namespace on top of isolate-run's, so none of the mounts
# below can ever propagate back, whatever the caller's namespace looks like.
if [ -z "${OCM_LAB_PRIVATE_NS:-}" ]; then
  exec env OCM_LAB_PRIVATE_NS=1 unshare --mount --propagation private -- bash "$0" "$upper" "$@"
fi
home=${HOME:-/root}
case $upper in "$home"|"$home"/*) echo "lab.sh: upper dir must be outside $home" >&2; exit 2 ;; esac
repo=$(pwd -P)

# isolate-run's bwrap read-only-binds parts of its /proc; a nested user
# namespace (the oncall bwrap) then refuses to mount proc ("not fully
# visible"). A clean procfs on top lets the production sandbox run unchanged.
mount -t proc proc /proc
mkdir -p "$upper/u" "$upper/w"
# The repo lives under $HOME, so from here on it is seen through the overlay:
# anything written there lands in the upper dir, not in the worktree.
mount -t overlay overlay -o "lowerdir=$home,upperdir=$upper/u,workdir=$upper/w" "$home"
cd "$repo"

# Real login state / history of every CLI the matrix touches, plus botmux's own
# config and lark-cli identities, are hidden behind empty tmpfs mounts (never
# deleted: an overlay delete walks the tree). For dirs that also hold the
# CLI's binaries (~/.codex/packages, ~/.grok/bin, ~/.kimi-code/bin …) the kept
# entries are bind-mounted back into the fresh tmpfs. Mounts die with the job.
hide() { # path [keep...]
  local p=$1; shift
  [ -e "$p" ] || [ -L "$p" ] || return 0
  if [ -d "$p" ] && [ ! -L "$p" ]; then
    local stash; stash=$(mktemp -d /tmp/ocm-keep.XXXXXX)
    local k
    for k in "$@"; do
      [ -e "$p/$k" ] || continue
      if [ -d "$p/$k" ]; then mkdir -p "$stash/$k"; else : > "$stash/$k"; fi
      mount --bind "$p/$k" "$stash/$k"
    done
    mount -t tmpfs -o mode=0700 ocm-hide "$p"
    for k in "$@"; do
      [ -e "$stash/$k" ] || continue
      if [ -d "$stash/$k" ]; then mkdir -p "$p/$k"; else : > "$p/$k"; fi
      mount --move "$stash/$k" "$p/$k"
    done
  else
    mount --bind /dev/null "$p" 2>/dev/null || true
  fi
}
for p in .claude .gemini .pi .cursor .config/cursor .config/opencode .local/share/opencode \
  .local/state/opencode .kiro .copilot .config/github-copilot .lark-cli .lark-cli-bots \
  .local/share/lark-cli .botmux .config/gh .ssh .aws .kube .docker .relay .trae .cache/coco \
  .local/share/bytedcli .omp .dsh .dsh-tui .minimax .reasonix .zcode .codem; do
  hide "$home/$p"
done
for f in .claude.json .claude.json.backup .netrc .git-credentials .npmrc; do hide "$home/$f"; done
hide "$home/.codex" packages
hide "$home/.grok" bin bundled
hide "$home/.kimi-code" bin
hide "$home/.hermes" bin hermes-agent
hide "$home/.opencode" bin node_modules package.json bun.lock
# Canary: a host secret the sandboxed agent must not read.
mkdir -p "$home/.sbx-canary" && echo "canary-$(date +%s)" > "$home/.sbx-canary/secret.txt"

if [ -n "${OCM_INSTALL:-}" ]; then bash scripts/oncall-cli-matrix/install.sh $OCM_INSTALL; hash -r; fi

export ISOLATE_LAB_HOME_OVERLAY=1
export OCM_LAB_DIR=$upper/lab
# No egress by default: the runner then talks to its loopback mock model only,
# and a CLI that ignores the mock config (and would call its real provider
# with the probe prompt) fails instead of sending anything out. OCM_EGRESS=1
# keeps the host network, for the network check of CLIs already proven to use
# the mock. Installs above ran before this point.
if [ "${OCM_EGRESS:-}" = 1 ]; then
  exec bun scripts/oncall-cli-matrix/run.ts "$@"
fi
export OCM_NO_EGRESS=1
exec unshare --net -- bash -c 'ip link set lo up && exec bun scripts/oncall-cli-matrix/run.ts "$@"' ocm "$@"
