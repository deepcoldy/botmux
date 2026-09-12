#!/bin/sh
# botmux launcher — the `bin` entry npm/pnpm/bun link onto PATH.
#
# ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────
# The main package ships NO binary (0.1MB, 6 files): the compiled single-file
# executable lives in a platform subpackage (`botmux-linux-x64`, …) pulled in as
# an optional dependency. `bin` can only point INSIDE the main package, so it
# cannot name that binary directly — hence this dispatcher, which resolves the
# subpackage at RUN time and `exec`s it.
#
# Until now the only thing that produced a runnable `botmux` was
# `scripts/postinstall-bin.mjs`, which writes ~/.botmux/bin/botmux. That still
# runs and is still what gives multi-Node-version boxes ONE unambiguous global
# botmux. But postinstall is not guaranteed to run:
#
#   MEASURED on v3.18.13, isolated HOME, each manager's own global install:
#     npm i -g botmux    → postinstall runs   → launcher written → `botmux` works
#     bun add -g botmux  → "Blocked 2 postinstalls" → NO launcher → no command
#     pnpm add -g botmux → script not run at all    → NO launcher → no command
#
#   Both failures exit 0 and print "installed botmux@3.18.13" / "+ botmux 3.18.13",
#   so the user believes it worked and only finds out at `botmux: command not found`.
#   bun can be rescued with `bun pm -g trust botmux`; pnpm could NOT be rescued —
#   `onlyBuiltDependencies: [botmux]` still produced no launcher (measured).
#
# With a `bin` entry the package manager links this script itself, so all three
# get a working command with no lifecycle script at all. postinstall then becomes
# an OPTIMISATION (the single canonical launcher) rather than a prerequisite.
#
# ── WHY sh AND NOT node ────────────────────────────────────────────────────────
# A Node dispatcher would reintroduce a Node dependency for a package whose whole
# point is a self-contained binary, and would add interpreter startup to every
# invocation. `bin` pointing at a shell script works on npm, pnpm and bun alike
# (measured, all three link it and run it). `exec` replaces this process, so the
# binary receives the original argv and signals with no shell left in between.
#
# Windows is not handled here: there are no win32 platform subpackages at all
# (only darwin/linux × x64/arm64 ± musl), so there is nothing for a .cmd shim to
# dispatch to. WSL2 reports as linux and is the supported route.

set -e

# Resolve this script through symlinks, then take the PACKAGE root.
#
# Two things make this fiddly, both MEASURED:
#  · `bin` entries are linked into the manager's bin dir, so $0 is often a
#    symlink — but pnpm instead generates a wrapper that runs `/bin/sh <path>`,
#    where <path> goes through a symlinked package dir. Either way the honest
#    answer comes from resolving the path and then `cd -P`.
#  · This file lives in `<pkg>/scripts/`, so the package root is the PARENT of
#    this script's directory. Using the script's own dir made every sibling
#    lookup miss by one level.
target=$0
# Bounded: a symlink cycle would otherwise spin here forever.
i=0
while [ -L "$target" ] && [ "$i" -lt 40 ]; do
  link=$(readlink "$target")
  case $link in
    /*) target=$link ;;
    *)  target=$(dirname "$target")/$link ;;
  esac
  i=$((i + 1))
done
# `cd -P` resolves any symlinked parent directory (pnpm's store links).
pkg=$(cd "$(dirname "$target")/.." && pwd -P)

# musl (Alpine and most slim images): npm/pnpm/bun select the -musl subpackage via
# each subpackage's `libc` field, so we must look for that same name. Positive
# evidence only — never claim musl on a glibc box.
libc=''
if [ "$(uname -s)" = Linux ]; then
  if ls /lib/ld-musl-* /usr/lib/ld-musl-* >/dev/null 2>&1 || [ -f /etc/alpine-release ]; then
    libc='-musl'
  fi
fi

case $(uname -s) in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *)      os='' ;;
esac
case $(uname -m) in
  x86_64|amd64)  arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *)             arch='' ;;
esac

if [ -z "$os" ] || [ -z "$arch" ]; then
  echo "botmux: unsupported platform $(uname -s)/$(uname -m)." >&2
  echo "Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64. On Windows use WSL2." >&2
  exit 1
fi

sub="botmux-$os-$arch$libc"

# Two layouts, both MEASURED against real global installs of v3.18.13:
#   npm       → <main>/node_modules/botmux-linux-x64/botmux   (nested)
#   pnpm, bun → <main>/../botmux-linux-x64/botmux             (sibling / hoisted)
# Try the exact-libc name first, then the other libc as a fallback: a mirrored or
# repacked registry can drop the `libc` field, leaving the "wrong" one installed.
for name in "$sub" "botmux-$os-$arch"; do
  for candidate in "$pkg/node_modules/$name/botmux" "$pkg/../$name/botmux"; do
    if [ -x "$candidate" ]; then
      exec "$candidate" "$@"
    fi
  done
done

echo "botmux: no platform binary found for $sub." >&2
echo "The optional platform package did not install. Reinstall with:" >&2
echo "  npm i -g botmux --force    (or: pnpm add -g botmux / bun add -g botmux)" >&2
exit 1
