#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESTINATION="/Applications/Botmux.app"
OPEN_AFTER_INSTALL=1
SKIP_BUILD=0
SKIP_DEPS=0

usage() {
  cat <<'EOF'
Usage:
  bash src/desktop/install-local.sh [options]

Options:
  --app-path <path>   Install destination. Must end with Botmux.app.
  --no-open          Do not open the app after installation.
  --skip-build       Reuse an existing dist/mac*/Botmux.app build.
  --skip-deps        Do not run pnpm install when node_modules is missing.
  -h, --help         Show this help.
EOF
}

log() {
  printf '==> %s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

quit_running_app() {
  local pids
  pids="$(pgrep -x "Botmux" 2>/dev/null || true)"
  [[ -n "$pids" ]] || return 0

  # Use same-user POSIX signals instead of Apple Events so local install never
  # needs macOS Automation permission.
  kill $pids 2>/dev/null || true
  for _ in {1..20}; do
    pids="$(pgrep -x "Botmux" 2>/dev/null || true)"
    [[ -z "$pids" ]] && return 0
    sleep 0.25
  done
  kill -KILL $pids 2>/dev/null || true
}

resolve_app_version() {
  local version="${BOTMUX_DESKTOP_VERSION:-}"
  local package_version
  local tag_version

  if [[ -z "$version" ]]; then
    package_version="$(node -p "require('./package.json').version" 2>/dev/null || true)"
    version="${package_version#v}"
  fi

  if [[ -z "$version" || "$version" == "0.0.0" ]]; then
    tag_version="$(git describe --tags --abbrev=0 2>/dev/null || true)"
    version="${tag_version#v}"
  fi

  # Source archives without .git still need a concrete macOS bundle version.
  # Prefer tags, but fall back to a clearly local semver instead of 0.0.0.
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ || "$version" == "0.0.0" ]]; then
    version="0.0.1-local"
  fi

  printf '%s\n' "$version"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-path)
      [[ $# -ge 2 ]] || fail "--app-path requires a value"
      DESTINATION="$2"
      shift 2
      ;;
    --no-open)
      OPEN_AFTER_INSTALL=0
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-deps)
      SKIP_DEPS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || fail "Botmux Desktop local install currently supports macOS only"
command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required"
command -v pnpm >/dev/null 2>&1 || fail "pnpm is required. Try: corepack enable"
command -v codesign >/dev/null 2>&1 || fail "codesign is required on macOS"
command -v ditto >/dev/null 2>&1 || fail "ditto is required on macOS"

# Match the runtime used by the CLI/dashboard build so source installs do not
# produce a Desktop app that immediately fails against an older local Node.
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
[[ "$NODE_MAJOR" -ge 22 ]] || fail "Node.js 22 or newer is required. Current node: $(node -v)"

case "$(basename "$DESTINATION")" in
  Botmux.app) ;;
  *) fail "--app-path must point to a bundle named Botmux.app" ;;
esac

cd "$ROOT_DIR"

if [[ "$SKIP_DEPS" -eq 0 && ! -x node_modules/.bin/tsc ]]; then
  log "Install dependencies"
  pnpm install
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  APP_VERSION="$(resolve_app_version)"

  log "Build Desktop bundle"
  pnpm desktop:bundle

  log "Package Botmux.app locally (version $APP_VERSION)"
  pnpm exec electron-builder --mac dir --config electron-builder.yml -c.extraMetadata.version="$APP_VERSION"
fi

BUILT_APP=""
for candidate in \
  "$ROOT_DIR/dist/mac-arm64/Botmux.app" \
  "$ROOT_DIR/dist/mac/Botmux.app" \
  "$ROOT_DIR/dist/mac-universal/Botmux.app"; do
  if [[ -d "$candidate" ]]; then
    BUILT_APP="$candidate"
    break
  fi
done

[[ -n "$BUILT_APP" ]] || fail "dist/mac*/Botmux.app not found. Run without --skip-build first."

log "Quit running Botmux app if needed"
quit_running_app

log "Install to $DESTINATION"
rm -rf "$DESTINATION"
ditto "$BUILT_APP" "$DESTINATION"

log "Ad-hoc sign local app"
codesign --force --deep --sign - --options runtime --entitlements "$ROOT_DIR/build/entitlements.mac.plist" "$DESTINATION"

log "Remove quarantine attribute"
xattr -dr com.apple.quarantine "$DESTINATION" >/dev/null 2>&1 || true

log "Verify app signature"
codesign --verify --deep --strict --verbose=2 "$DESTINATION"

if [[ "$OPEN_AFTER_INSTALL" -eq 1 ]]; then
  log "Open Botmux Desktop"
  open "$DESTINATION"
fi

printf '\nBotmux Desktop installed at %s\n' "$DESTINATION"
