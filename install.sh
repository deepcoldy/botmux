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

# ── Install ───────────────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/$asset"
mv "$tmp/$asset" "$INSTALL_DIR/botmux"
printf '%s\n' "✅ installed botmux → $INSTALL_DIR/botmux"

# ── PATH hint ─────────────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$INSTALL_DIR:"*) : ;;  # already on PATH
  *)
    printf '\n%s\n' "Add $INSTALL_DIR to your PATH, e.g.:"
    printf '  %s\n' "echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.profile && . ~/.profile"
    ;;
esac
printf '\n%s\n' "Next: botmux setup"
