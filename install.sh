#!/bin/sh
# botmux single-binary installer.
#
#   curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
#
# Downloads the self-contained Bun executable for your OS/arch from the latest
# GitHub Release, verifies its SHA-256 checksum, and installs it to
# ~/.botmux/bin/botmux (added to PATH via your shell profile). NO Node required —
# the binary bundles its own runtime, so it does not collide with, or depend on,
# any Node install on the machine. (This is the alternative to `npm i -g botmux`,
# which requires Node and is prone to the "two Node versions each carry their own
# global botmux" breakage this binary avoids.)
#
# Env overrides:
#   BOTMUX_INSTALL_DIR   install location (default: $HOME/.botmux/bin)
#   BOTMUX_VERSION       release tag to install (default: latest)
#   BOTMUX_REPO          owner/repo (default: deepcoldy/botmux)
set -eu

REPO="${BOTMUX_REPO:-deepcoldy/botmux}"
INSTALL_DIR="${BOTMUX_INSTALL_DIR:-$HOME/.botmux/bin}"

err() { printf '%s\n' "botmux install: $*" >&2; exit 1; }

# ── Detect OS/arch and map to the release asset name (botmux-<os>-<arch>) ──────
os="$(uname -s)"
case "$os" in
  Linux)  os_tag=linux ;;
  Darwin) os_tag=darwin ;;
  *) err "unsupported OS '$os' (the daemon is Unix-only: Linux/macOS). Use \`npm i -g botmux\` on Windows." ;;
esac
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch_tag=x64 ;;
  arm64|aarch64) arch_tag=arm64 ;;
  *) err "unsupported arch '$arch' (need x64 or arm64)" ;;
esac
asset="botmux-${os_tag}-${arch_tag}"

# On Linux, pick the musl build when the C library is musl (Alpine and most slim
# Docker images). A glibc-linked binary does not run there at all — it dies in the
# loader with a message that names no cause — so guessing wrong is worse than not
# installing. `uname` cannot tell us this, so probe the libc.
#
# `ldd` IS AUTHORITATIVE IN BOTH DIRECTIONS when present: glibc and musl both ship
# one, so if it answers "musl" we are on musl, and if it answers anything else we are
# NOT — do not let a later probe overturn it. That matters because a glibc distro can
# legitimately have musl INSTALLED (Debian/Ubuntu `musl` / `musl-tools`, common for
# Rust/Go musl cross-compiling) which drops /lib/ld-musl-x86_64.so.1 at top level.
# Measured: debian:bookworm-slim + musl-tools was selecting the musl asset — an
# install that "succeeds" and then fails in the loader on first run.
#
# The filesystem probes are therefore the fallback for images with NO ldd at all
# (distroless-style). Deliberately conservative: only claim musl when positively
# observed, so a glibc box is never pushed onto the musl asset.
if [ "$os_tag" = linux ]; then
  is_musl=0
  if command -v ldd >/dev/null 2>&1; then
    # musl's ldd exits non-zero for --version, so read the output, not the status.
    if (ldd --version 2>&1 || true) | grep -qi musl; then
      is_musl=1
    fi
  elif ls /lib/ld-musl-* >/dev/null 2>&1 || ls /usr/lib/ld-musl-* >/dev/null 2>&1; then
    is_musl=1
  elif [ -f /etc/alpine-release ]; then
    is_musl=1
  fi
  [ "$is_musl" -eq 1 ] && asset="${asset}-musl"
fi

# ── Resolve the download URLs (binary + checksum) ─────────────────────────────
if [ "${BOTMUX_VERSION:-latest}" = "latest" ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${BOTMUX_VERSION}"
fi

command -v curl >/dev/null 2>&1 || err "curl is required"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf '%s\n' "↓ downloading $asset from $base ..."
curl -fSL "$base/$asset" -o "$tmp/$asset" || err "download failed: $base/$asset (no build for ${os_tag}-${arch_tag}?)"
# Checksum is best-effort: if the release omits it, warn but continue.
if curl -fsSL "$base/$asset.sha256" -o "$tmp/$asset.sha256" 2>/dev/null; then
  expected="$(cut -d' ' -f1 < "$tmp/$asset.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"
  else
    actual=""
  fi
  if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
    err "checksum mismatch for $asset (expected $expected, got $actual)"
  fi
  [ -n "$actual" ] && printf '%s\n' "✓ checksum verified"
else
  printf '%s\n' "⚠ no checksum published for $asset; skipping verification"
fi

# ── Probe + atomically install ────────────────────────────────────────────────
# os/arch/libc selection cannot express the minimum glibc symbol version. Run the
# exact candidate before replacing a working installation: `--version` loads the
# embedded node-pty native, so a GLIBC_x.y mismatch surfaces here without starting
# a daemon or touching bot data. Stage on the destination filesystem so the final
# rename is atomic even when /tmp and $INSTALL_DIR are different mounts.
mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/$asset"
candidate="$INSTALL_DIR/.botmux-install-$$"
cp "$tmp/$asset" "$candidate"
chmod +x "$candidate"
trap 'rm -rf "$tmp"; rm -f "$candidate"' EXIT
if ! probe_output="$("$candidate" --version 2>&1)"; then
  err "downloaded $asset cannot run on this host; existing botmux was preserved: $probe_output"
fi
mv "$candidate" "$INSTALL_DIR/botmux"
printf '%s\n' "✅ installed botmux → $INSTALL_DIR/botmux"

# ── PATH: write it, don't just suggest it ─────────────────────────────────────
# This used to only print `echo 'export PATH=…' >> ~/.profile`, which is WRONG for
# zsh users: zsh never reads ~/.profile (measured), so following the hint verbatim
# left `botmux` still not found. Mirrors scripts/install-path-entry.mjs — keep the
# two in step. Startup files per shell, all measured:
#   zsh  → ${ZDOTDIR:-$HOME}/.zshenv   (only file read by -c, -i and -li alike;
#                                       zsh reads dotfiles from $ZDOTDIR when set)
#   bash → .bashrc AND its login file  (interactive vs login are disjoint; the
#                                       login file is the FIRST of .bash_profile →
#                                       .bash_login → .profile that EXISTS)
#   fish → ${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/botmux.fish
#                                      (and fish is NOT POSIX: `set -gx`)
#   else → .profile                    (sh/ksh/dash read it at login)
MARKER='# added by botmux installer'

# Quote INSTALL_DIR for LITERAL use inside the rc file we write.
# ⚠️ SECURITY: INSTALL_DIR is caller-controlled (BOTMUX_INSTALL_DIR) and the line
# we write is executed by the user's shell on every startup. Inside double quotes
# a `$(…)`/backtick/`$VAR` in the path would RUN — measured: an install dir with
# `$(touch /tmp/PWNED)` created that file on every new shell. Single quotes make
# every byte literal; only `'` needs care, closed and reopened as '\''. Same form
# works in POSIX shells and fish.
sq=$(printf '%s' "$INSTALL_DIR" | sed "s/'/'\\\\''/g")
QUOTED_DIR="'$sq'"

path_line_present() {  # $1=file — already handled, by us or by the user's own line?
  [ -f "$1" ] || return 1
  # TWO SEPARATE CHECKS, mirroring fileAlreadyHasEntry() in
  # scripts/install-path-entry.mjs. Do not try to fold them into one.
  #
  # (a) OUR OWN line, recognised by its known syntax: the marker plus the exact
  #     quoted directory we would generate. Needed because the line written for a
  #     dir containing a quote is  export PATH='/x/q'\''bin'":$PATH"  and ANY
  #     tokenizer that treats `'` as a separator shreds it into /x/q, \, bin — so
  #     the quoted spelling can never match a token (measured: a second line was
  #     appended on every re-install).
  #
  # (b) A HAND-WRITTEN line: strip quote syntax, then compare whole PATH elements.
  #     Substring matching produced three measured false positives that each left
  #     the real dir unwritten: <INSTALL_DIR>-old (sibling), /backup<INSTALL_DIR>
  #     (prefix) and <INSTALL_DIR>/other (child). Commented-out lines never count.
  # NOTE the comment filter: without it, commenting OUT our own generated line
  # (marker included) still counted as configured, so no working line was ever
  # added back — measured, install.sh reported configured while the mjs half
  # correctly said false.
  if grep -F "$MARKER" "$1" 2>/dev/null \
    | grep -Ev '^[[:space:]]*#' \
    | grep -Fq "$QUOTED_DIR"; then
    return 0
  fi
  BOTMUX_RAW_DIR="$INSTALL_DIR" awk '
    BEGIN { raw = ENVIRON["BOTMUX_RAW_DIR"]; sub(/\/+$/, "", raw) }
    /^[[:space:]]*#/ { next }
    !/export[[:space:]]+PATH[[:space:]]*=|^[[:space:]]*PATH[[:space:]]*=|set[[:space:]]+(-[[:alnum:]]+[[:space:]]+)*PATH|fish_add_path|path\+=|path=\(/ { next }
    {
      line = $0
      gsub(/["'"'"']/, "", line)     # quotes are syntax around a plain path here
      gsub(/[()=]/, " ", line)       # zsh path=(...) and assignments
      n = split(line, tok, /[:[:space:]]+/)
      for (i = 1; i <= n; i++) {
        t = tok[i]
        sub(/\/+$/, "", t)           # a trailing slash is the same directory
        if (t != "" && t == raw) { found = 1; exit }
      }
    }
    END { exit(found ? 0 : 1) }
  ' "$1" 2>/dev/null
}

# bash's LOGIN file is the FIRST of .bash_profile → .bash_login → .profile that
# EXISTS. Creating .bash_profile when the user's login config lives in .profile
# (or .bash_login) silently stops that file from being read ever again — measured
# with a sentinel: visible before, MISSING after. So append to whichever already
# exists, and only create .bash_profile when none does (nothing to shadow then).
bash_login_file() {
  for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    [ -f "$f" ] && { printf '%s\n' "$f"; return 0; }
  done
  printf '%s\n' "$HOME/.bash_profile"
}

append_path_line() {  # $1=file  $2=line
  mkdir -p "$(dirname "$1")" 2>/dev/null || return 1
  # Leading newline only when the file exists and lacks a trailing one, so we
  # never glue onto an unterminated last line.
  if [ -f "$1" ] && [ -n "$(tail -c 1 "$1" 2>/dev/null)" ]; then
    printf '\n%s\n' "$2" >> "$1" || return 1
  else
    printf '%s\n' "$2" >> "$1" || return 1
  fi
  printf '%s\n' "✓ added $INSTALL_DIR to PATH in $1"
}

# ⚠️ DO NOT WRAP THIS IN A `$PATH` CHECK. It used to be inside
#   case ":$PATH:" in *":$INSTALL_DIR:"*) : ;;  # already on PATH
# which asks "is INSTALL_DIR on the PATH of the process running the installer?" —
# the wrong question. What decides whether `botmux` works is whether the user's
# FUTURE shells get it, i.e. whether a startup file says so. The two come apart
# whenever the installing shell has INSTALL_DIR on PATH transiently, and botmux
# itself creates exactly that situation: the daemon prepends ~/.botmux/bin to the
# PATH of every CLI session it spawns (5 × prependBotmuxBin). So running this
# installer from inside a botmux session wrote NO startup file and printed NO
# hint — exit 0, and `botmux` still missing from every new terminal. MEASURED
# with an isolated HOME: with INSTALL_DIR pre-seeded onto PATH, not one startup
# file was written; the same run without it correctly wrote two.
#
# This is the same defect #1117 fixed on the npm side; the guard rationale is
# kept verbatim in scripts/postinstall-bin.mjs. Keep the two in step.
#
# Skipping the check costs nothing, because BOTH layers below are already
# idempotent and neither depends on the current PATH:
#   · path_line_present() — don't append a line the file already has
#   · the emitted line itself — a `case` guard so re-sourcing cannot grow PATH
# $PATH stays outside the quotes so it still expands; the dir cannot.
# The STATEMENT must be idempotent too, not just the file write: an
# unconditional prepend re-runs on every shell startup, so nested or
# re-sourced shells keep growing PATH (measured: the dir appeared twice at
# nesting depth 2). `case` is POSIX, needs no subshell, and the `:` padding
# makes it an exact ELEMENT test so `<dir>-old` never satisfies it.
posix_line="case \":\$PATH:\" in *:$QUOTED_DIR:*) ;; *) export PATH=$QUOTED_DIR\":\$PATH\" ;; esac  $MARKER"
wrote=0
case "$(basename "${SHELL:-}")" in
  *zsh*)
    # zsh reads its dotfiles from $ZDOTDIR when set, else $HOME. Writing
    # $HOME/.zshenv on a ZDOTDIR machine produces a file zsh never reads.
    f="${ZDOTDIR:-$HOME}/.zshenv"
    if path_line_present "$f"; then wrote=1; else append_path_line "$f" "$posix_line" && wrote=1; fi
    ;;
  *fish*)
    # fish's config dir is $XDG_CONFIG_HOME/fish, default ~/.config/fish.
    f="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/botmux.fish"
    if path_line_present "$f"; then wrote=1
    # fish: `contains` is its own exact list-element test.
    else append_path_line "$f" "contains $QUOTED_DIR \$PATH; or set -gx PATH $QUOTED_DIR \$PATH  $MARKER" && wrote=1; fi
    ;;
  *bash*)
    # .bashrc (interactive) and the login file are disjoint; write both, but
    # never CREATE a login file that would shadow an existing one.
    for f in "$HOME/.bashrc" "$(bash_login_file)"; do
      if path_line_present "$f"; then wrote=1; else append_path_line "$f" "$posix_line" && wrote=1; fi
    done
    ;;
  *)
    f="$HOME/.profile"
    if path_line_present "$f"; then wrote=1; else append_path_line "$f" "$posix_line" && wrote=1; fi
    ;;
esac
if [ "$wrote" = 1 ]; then
  printf '%s\n' "  open a new terminal (or re-source that file) and \`botmux\` will be on PATH"
else
  printf '\n%s\n' "Add $INSTALL_DIR to your PATH, e.g.:"
  printf '  %s\n' "echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.profile && . ~/.profile"
fi

printf '\n%s\n' "Next: botmux setup"
