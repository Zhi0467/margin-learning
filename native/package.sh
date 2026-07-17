#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
ROOT_DIR="${SCRIPT_DIR:h}"
DIST_DIR="$ROOT_DIR/dist"
APP_VERSION="$(/usr/bin/plutil -extract version raw -o - "$ROOT_DIR/package.json")"
ARCHIVE_NAME="Margin-${APP_VERSION}-macos-arm64.zip"
ARCHIVE_PATH="$DIST_DIR/$ARCHIVE_NAME"

"$SCRIPT_DIR/build.sh"

mkdir -p "$DIST_DIR"
rm -f "$ARCHIVE_PATH" "$DIST_DIR/SHA256SUMS"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$ROOT_DIR/Margin.app" "$ARCHIVE_PATH"
(cd "$DIST_DIR" && /usr/bin/shasum -a 256 "$ARCHIVE_NAME" > SHA256SUMS)

print "Packaged $ARCHIVE_PATH"
print "SHA-256: $DIST_DIR/SHA256SUMS"
