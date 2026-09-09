#!/usr/bin/env bash
set -euo pipefail

# Give the standalone macOS CLI the same Developer ID identity on every release.
# TCC stores the binary's designated requirement; an ad-hoc signature reduces
# that requirement to a version-specific cdhash and invalidates permissions on
# every upgrade.

DIST_DIR="${1:-dist-bin}"
IDENTIFIER="${BOTMUX_CODESIGN_IDENTIFIER:-com.botmux.cli}"
ENTITLEMENTS="${BOTMUX_CODESIGN_ENTITLEMENTS:-build/entitlements.mac.plist}"
CERT_LINK="${MAC_CSC_LINK:-}"
CERT_PASSWORD="${MAC_CSC_KEY_PASSWORD:-}"
RUNNER_TMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
KEYCHAIN_PATH="$RUNNER_TMP/botmux-cli-signing.keychain-db"
CERT_PATH="$RUNNER_TMP/botmux-cli-signing.p12"
KEYCHAIN_PASSWORD="$(openssl rand -hex 32)"

fail() {
  echo "botmux macOS CLI signing: $*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "must run on macOS"
[ -n "$CERT_LINK" ] || fail "MAC_CSC_LINK is required"
[ -n "$CERT_PASSWORD" ] || fail "MAC_CSC_KEY_PASSWORD is required"
[ -f "$ENTITLEMENTS" ] || fail "entitlements file not found: $ENTITLEMENTS"

cleanup() {
  security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
  rm -f "$CERT_PATH"
}
trap cleanup EXIT

case "$CERT_LINK" in
  file://*)
    cp "${CERT_LINK#file://}" "$CERT_PATH"
    ;;
  http://*|https://*)
    curl --fail --silent --show-error --location "$CERT_LINK" --output "$CERT_PATH"
    ;;
  *)
    if [ -f "$CERT_LINK" ]; then
      cp "$CERT_LINK" "$CERT_PATH"
    else
      printf '%s' "${CERT_LINK#*base64,}" | /usr/bin/base64 -D > "$CERT_PATH"
    fi
    ;;
esac

[ -s "$CERT_PATH" ] || fail "decoded signing certificate is empty"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security import "$CERT_PATH" \
  -k "$KEYCHAIN_PATH" \
  -P "$CERT_PASSWORD" \
  -T /usr/bin/codesign \
  -T /usr/bin/security
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$KEYCHAIN_PASSWORD" \
  "$KEYCHAIN_PATH" >/dev/null

IDENTITY="$(
  security find-identity -v -p codesigning "$KEYCHAIN_PATH" \
    | awk '/"Developer ID Application:/ { print $2; exit }'
)"
[ -n "$IDENTITY" ] || fail "no Developer ID Application identity found"

EXPECTED_REQUIREMENT=""
for arch in x64 arm64; do
  binary="$DIST_DIR/botmux-darwin-$arch"
  [ -f "$binary" ] || fail "missing binary: $binary"
  chmod +x "$binary"

  codesign \
    --force \
    --sign "$IDENTITY" \
    --keychain "$KEYCHAIN_PATH" \
    --identifier "$IDENTIFIER" \
    --options runtime \
    --timestamp \
    --entitlements "$ENTITLEMENTS" \
    "$binary"
  codesign --verify --strict --verbose=2 "$binary"

  details="$(codesign -dv --verbose=4 "$binary" 2>&1)"
  actual_identifier="$(printf '%s\n' "$details" | awk -F= '/^Identifier=/{print $2; exit}')"
  team_identifier="$(printf '%s\n' "$details" | awk -F= '/^TeamIdentifier=/{print $2; exit}')"
  authority="$(printf '%s\n' "$details" | awk -F= '/^Authority=/{print $2; exit}')"
  requirement="$(codesign -dr - "$binary" 2>&1 | sed -n 's/^designated => //p')"

  [ "$actual_identifier" = "$IDENTIFIER" ] \
    || fail "$binary has identifier '$actual_identifier', expected '$IDENTIFIER'"
  if [ -z "$team_identifier" ] || [ "$team_identifier" = "not set" ]; then
    fail "$binary has no stable TeamIdentifier"
  fi
  case "$authority" in
    "Developer ID Application:"*) ;;
    *) fail "$binary is not signed by a Developer ID Application identity" ;;
  esac
  [ -n "$requirement" ] || fail "$binary has no designated requirement"
  case "$requirement" in
    *cdhash*) fail "$binary still has a version-specific cdhash requirement" ;;
  esac

  if [ -z "$EXPECTED_REQUIREMENT" ]; then
    EXPECTED_REQUIREMENT="$requirement"
  elif [ "$requirement" != "$EXPECTED_REQUIREMENT" ]; then
    fail "darwin x64 and arm64 designated requirements differ"
  fi

  binary_name="$(basename "$binary")"
  (
    cd "$DIST_DIR"
    shasum -a 256 "$binary_name" > "$binary_name.sha256"
  )
  echo "Developer ID signed $binary (identifier=$actual_identifier team=$team_identifier)"
done

echo "Stable designated requirement: $EXPECTED_REQUIREMENT"
