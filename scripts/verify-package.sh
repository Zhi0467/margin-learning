#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
ROOT_DIR="${SCRIPT_DIR:h}"
DIST_DIR="$ROOT_DIR/dist"
EXPECTED_APP_VERSION="$(/usr/bin/plutil -extract version raw -o - "$ROOT_DIR/package.json")"
ARCHIVE="${1:-$DIST_DIR/Margin-${EXPECTED_APP_VERSION}-macos-arm64.zip}"
CHECKSUMS="${2:-$DIST_DIR/SHA256SUMS}"
EXPECTED_NODE_VERSION="v24.18.0"
EXPECTED_BUNDLE_ID="io.github.zhi0467.margin"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/Margin package verification.XXXXXX")"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

[[ -f "$ARCHIVE" ]] || { print -u2 "Archive not found: $ARCHIVE"; exit 1; }
[[ -f "$CHECKSUMS" ]] || { print -u2 "Checksum file not found: $CHECKSUMS"; exit 1; }

archive_name="${ARCHIVE:t}"
expected_checksum="$(/usr/bin/awk -v name="$archive_name" '$2 == name { print $1 }' "$CHECKSUMS")"
[[ -n "$expected_checksum" ]] || { print -u2 "No checksum found for $archive_name"; exit 1; }
actual_checksum="$(/usr/bin/shasum -a 256 "$ARCHIVE" | /usr/bin/awk '{ print $1 }')"
[[ "$actual_checksum" == "$expected_checksum" ]] || { print -u2 "Archive checksum mismatch"; exit 1; }

/usr/bin/ditto -x -k "$ARCHIVE" "$TEMP_DIR"
APP="$TEMP_DIR/Margin.app"
PLIST="$APP/Contents/Info.plist"
NATIVE="$APP/Contents/MacOS/Margin"
NODE="$APP/Contents/Resources/node/bin/node"

for required in \
  "$PLIST" \
  "$NATIVE" \
  "$NODE" \
  "$APP/Contents/Resources/app/server.mjs" \
  "$APP/Contents/Resources/app/lib.mjs" \
  "$APP/Contents/Resources/app/library-lock.mjs" \
  "$APP/Contents/Resources/app/course-transaction.mjs" \
  "$APP/Contents/Resources/app/public/index.html" \
  "$APP/Contents/Resources/teach/SKILL.md" \
  "$APP/Contents/Resources/teach/INTERACTIVE-VISUALS.md" \
  "$APP/Contents/Resources/teach/LEARNER-MODEL-TOOLS.md" \
  "$APP/Contents/Resources/THIRD_PARTY_NOTICES.md" \
  "$APP/Contents/Resources/node/LICENSE"; do
  [[ -e "$required" ]] || { print -u2 "Required bundle resource is missing: $required"; exit 1; }
done

[[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$PLIST")" == "$EXPECTED_BUNDLE_ID" ]]
[[ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$PLIST")" == "$EXPECTED_APP_VERSION" ]]
[[ "$(/usr/bin/plutil -extract LSMinimumSystemVersion raw -o - "$PLIST")" == "13.0" ]]
for development_key in MarginDevelopmentRoot MarginDevelopmentNodeExecutable; do
  if /usr/bin/plutil -extract "$development_key" raw -o - "$PLIST" >/dev/null 2>&1; then
    print -u2 "Release bundle contains development-only metadata: $development_key"
    exit 1
  fi
done

/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"
/usr/bin/lipo "$NATIVE" -verify_arch arm64
/usr/bin/lipo "$NODE" -verify_arch arm64
[[ "$(/usr/bin/lipo -archs "$NATIVE")" == "arm64" ]]
[[ "$(/usr/bin/lipo -archs "$NODE")" == "arm64" ]]
[[ "$($NODE --version)" == "$EXPECTED_NODE_VERSION" ]]

non_system_dependencies="$(
  /usr/bin/otool -L "$NODE" |
    /usr/bin/tail -n +2 |
    /usr/bin/awk '{ print $1 }' |
    while IFS= read -r dependency; do
      case "$dependency" in
        /System/Library/*|/usr/lib/*) ;;
        *) print "$dependency" ;;
      esac
    done
)"
[[ -z "$non_system_dependencies" ]] || {
  print -u2 "Bundled Node has non-system dynamic-library dependencies:"
  print -u2 "$non_system_dependencies"
  exit 1
}

if /usr/bin/grep -R -a -F -q "$ROOT_DIR" "$APP"; then
  print -u2 "The archive contains the source checkout path."
  exit 1
fi

if /usr/bin/find "$APP" \( -name .learn -o -name COURSE.json -o -name MISSION.md \) -print -quit | /usr/bin/grep -q .; then
  print -u2 "The archive contains learner data."
  exit 1
fi

print "Verified $archive_name"
print "SHA-256 $actual_checksum"
