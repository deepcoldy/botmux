#!/bin/sh
# Build a Linux release binary inside the oldest supported glibc runtime.
#
# node-pty has no Linux prebuild, so its install script compiles pty.node against
# the BUILDER's libc. Building on ubuntu-latest silently raised the shipped
# binary's floor to GLIBC_2.34. Node 22 itself supports glibc 2.28, so keep that as
# Botmux's explicit Linux floor and smoke the complete binary inside the same
# manylinux_2_28 environment before it can become a release artifact.
set -eu

target="${1:-}"
out="${2:-}"
version="${3:-}"
[ -n "$target" ] && [ -n "$out" ] && [ -n "$version" ] || {
  echo "usage: $0 bun-linux-{x64|arm64} <output> <version>" >&2
  exit 2
}

case "$target" in
  bun-linux-x64)
    image="quay.io/pypa/manylinux_2_28_x86_64:latest"
    node_arch="x64"
    expected_uname="x86_64"
    ;;
  bun-linux-arm64)
    image="quay.io/pypa/manylinux_2_28_aarch64:latest"
    node_arch="arm64"
    expected_uname="aarch64"
    ;;
  *)
    echo "unsupported target: $target" >&2
    exit 2
    ;;
esac

command -v docker >/dev/null 2>&1 || {
  echo "docker is required for the glibc 2.28 release build" >&2
  exit 1
}

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
case "$out" in
  /*) out_abs="$out" ;;
  *) out_abs="$repo_root/$out" ;;
esac
out_dir="$(dirname -- "$out_abs")"
out_name="$(basename -- "$out_abs")"
mkdir -p "$out_dir"

docker run --rm \
  -v "$repo_root:/src:ro" \
  -v "$out_dir:/out" \
  -e BUILD_TARGET="$target" \
  -e BUILD_VERSION="$version" \
  -e OUTPUT_NAME="$out_name" \
  -e NODE_ARCH="$node_arch" \
  -e EXPECTED_UNAME="$expected_uname" \
  -e HOST_UID="$(id -u)" \
  -e HOST_GID="$(id -g)" \
  "$image" /bin/bash -euo pipefail -c '
    [ "$(uname -m)" = "$EXPECTED_UNAME" ] || {
      echo "runner/image architecture mismatch: expected $EXPECTED_UNAME, got $(uname -m)" >&2
      exit 1
    }
    getconf GNU_LIBC_VERSION | grep -qx "glibc 2.28" || {
      echo "REFUSING: build container is not glibc 2.28" >&2
      getconf GNU_LIBC_VERSION >&2
      exit 1
    }

    work=/tmp/botmux-build
    mkdir -p "$work"
    tar -C /src --exclude=.git --exclude=node_modules --exclude=dist --exclude=dist-bin -cf - . \
      | tar -C "$work" -xf -
    cd "$work"
    rm -rf node_modules dist dist-bin

    node_version=22.22.3
    curl -fsSL "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz
    mkdir -p /opt/node
    tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
    export PATH="/opt/node/bin:$PATH"
    node --version
    npm install -g bun@1.4.0 --loglevel=error
    bun --version

    # Compiles node-pty on glibc 2.28; trustedDependencies makes this lifecycle
    # script run under Bun. Stamp only after the frozen install, mirroring release.
    bun install --frozen-lockfile
    npm version "$BUILD_VERSION" --no-git-tag-version --allow-same-version
    bun run build

    native=node_modules/node-pty/build/Release/pty.node
    test -f "$native" || { echo "node-pty native missing: $native" >&2; exit 1; }
    highest="$(readelf --version-info "$native" | grep -o "GLIBC_[0-9.]*" | sort -Vu | tail -1)"
    [ -n "$highest" ] || { echo "no GLIBC symbol version found in $native" >&2; exit 1; }
    [ "$(printf "%s\n" "$highest" GLIBC_2.28 | sort -V | tail -1)" = GLIBC_2.28 ] || {
      echo "REFUSING: $native requires $highest (maximum supported is GLIBC_2.28)" >&2
      exit 1
    }
    echo "node-pty glibc floor OK: highest required symbol is $highest"

    mkdir -p dist-bin
    bun scripts/build-bun-binary.mjs --target "$BUILD_TARGET" --out "dist-bin/$OUTPUT_NAME"
    node scripts/smoke-bun-binary.mjs "dist-bin/$OUTPUT_NAME"
    cp "dist-bin/$OUTPUT_NAME" "/out/$OUTPUT_NAME"
    chown "$HOST_UID:$HOST_GID" "/out/$OUTPUT_NAME" 2>/dev/null || true
  '

echo "built $out_abs on glibc 2.28"
