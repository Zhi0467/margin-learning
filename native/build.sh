#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
ROOT_DIR="${SCRIPT_DIR:h}"
APP_VERSION="$(/usr/bin/plutil -extract version raw -o - "$ROOT_DIR/package.json")"
BUILD_KIND="${1:-release}"
case "$BUILD_KIND" in
  release)
    APP_DIR="$ROOT_DIR/Margin.app"
    ;;
  --dev|dev)
    BUILD_KIND="dev"
    APP_DIR="$ROOT_DIR/Margin Dev.app"
    ;;
  *)
    print -u2 "Usage: $0 [--dev]"
    exit 2
    ;;
esac

DEVELOPMENT_NODE_EXECUTABLE=""
if [[ "$BUILD_KIND" == "dev" ]]; then
  DEVELOPMENT_NODE_EXECUTABLE="$(whence -p node || true)"
  if [[ -z "$DEVELOPMENT_NODE_EXECUTABLE" ]]; then
    print -u2 "Margin Dev requires Node.js on PATH."
    exit 1
  fi
  DEVELOPMENT_NODE_EXECUTABLE="${DEVELOPMENT_NODE_EXECUTABLE:a}"
  if [[ ! -x "$DEVELOPMENT_NODE_EXECUTABLE" || -d "$DEVELOPMENT_NODE_EXECUTABLE" ]]; then
    print -u2 "Margin Dev found an invalid Node.js executable: $DEVELOPMENT_NODE_EXECUTABLE"
    exit 1
  fi
fi

CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/margin-native.XXXXXX")"
ICONSET_DIR="$BUILD_DIR/Margin.iconset"
MASTER_ICON="$BUILD_DIR/Margin-1024.png"

cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$ICONSET_DIR"

/usr/bin/clang \
  -arch arm64 \
  -fobjc-arc \
  -O2 \
  -Wall \
  -Wextra \
  -mmacosx-version-min=13.0 \
  -framework Cocoa \
  -framework Security \
  -framework WebKit \
  "$SCRIPT_DIR/MarginApp.m" \
  -o "$MACOS_DIR/Margin"

/usr/bin/ditto "$SCRIPT_DIR/Info.plist" "$CONTENTS_DIR/Info.plist"
/usr/bin/plutil -replace CFBundleShortVersionString -string "$APP_VERSION" "$CONTENTS_DIR/Info.plist"
/usr/bin/plutil -replace CFBundleVersion -string "$APP_VERSION" "$CONTENTS_DIR/Info.plist"
if [[ "$BUILD_KIND" == "dev" ]]; then
  /usr/bin/plutil -replace CFBundleDisplayName -string "Margin Dev" "$CONTENTS_DIR/Info.plist"
  /usr/bin/plutil -replace CFBundleName -string "Margin Dev" "$CONTENTS_DIR/Info.plist"
  /usr/bin/plutil -replace CFBundleIdentifier -string "io.github.zhi0467.margin.dev" "$CONTENTS_DIR/Info.plist"
  /usr/bin/plutil -insert MarginDevelopmentRoot -string "$ROOT_DIR" "$CONTENTS_DIR/Info.plist"
  /usr/bin/plutil -insert MarginDevelopmentNodeExecutable -string "$DEVELOPMENT_NODE_EXECUTABLE" "$CONTENTS_DIR/Info.plist"
fi
/usr/bin/plutil -lint "$CONTENTS_DIR/Info.plist"

if [[ "$BUILD_KIND" == "release" ]]; then
  # Release bundles are self-contained and never point at the source checkout.
  mkdir -p "$RESOURCES_DIR/app"
  /usr/bin/ditto --norsrc --noextattr "$ROOT_DIR/app/server.mjs" "$RESOURCES_DIR/app/server.mjs"
  /usr/bin/ditto --norsrc --noextattr "$ROOT_DIR/app/lib.mjs" "$RESOURCES_DIR/app/lib.mjs"
  /usr/bin/ditto --norsrc --noextattr "$ROOT_DIR/app/library-lock.mjs" "$RESOURCES_DIR/app/library-lock.mjs"
  /usr/bin/ditto --norsrc --noextattr "$ROOT_DIR/app/course-transaction.mjs" "$RESOURCES_DIR/app/course-transaction.mjs"
  /usr/bin/ditto --norsrc --noextattr "$ROOT_DIR/app/public" "$RESOURCES_DIR/app/public"
  /usr/bin/ditto --norsrc --noextattr "$ROOT_DIR/.agents/skills/teach" "$RESOURCES_DIR/teach"
  /usr/bin/ditto --norsrc --noextattr "$ROOT_DIR/THIRD_PARTY_NOTICES.md" "$RESOURCES_DIR/THIRD_PARTY_NOTICES.md"
  "$SCRIPT_DIR/prepare-node-runtime.sh" "$RESOURCES_DIR/node"
  ICON_NODE="$RESOURCES_DIR/node/bin/node"
else
  # The development bundle deliberately loads backend, UI, and skill files from
  # MarginDevelopmentRoot so restarting the app picks up checkout edits. Keep
  # using the exact Node executable recorded in the bundle metadata.
  ICON_NODE="$DEVELOPMENT_NODE_EXECUTABLE"
fi

if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 1024 -h 1024 "$SCRIPT_DIR/AppIcon.svg" -o "$MASTER_ICON"
elif command -v magick >/dev/null 2>&1; then
  magick -background none "$SCRIPT_DIR/AppIcon.svg" -resize 1024x1024 "$MASTER_ICON"
else
  print -u2 "Margin icon build requires rsvg-convert or ImageMagick."
  exit 1
fi

for spec in \
  "16 icon_16x16.png" \
  "32 icon_16x16@2x.png" \
  "32 icon_32x32.png" \
  "64 icon_32x32@2x.png" \
  "128 icon_128x128.png" \
  "256 icon_128x128@2x.png" \
  "256 icon_256x256.png" \
  "512 icon_256x256@2x.png" \
  "512 icon_512x512.png" \
  "1024 icon_512x512@2x.png"; do
  size="${spec%% *}"
  filename="${spec#* }"
  /usr/bin/sips -z "$size" "$size" "$MASTER_ICON" --out "$ICONSET_DIR/$filename" >/dev/null
done

"$ICON_NODE" "$SCRIPT_DIR/make-icns.mjs" "$ICONSET_DIR" "$RESOURCES_DIR/Margin.icns"

if [[ "$BUILD_KIND" == "release" ]]; then
  # Sign the embedded runtime before sealing the release application bundle.
  /usr/bin/codesign --force --sign - "$RESOURCES_DIR/node/bin/node"
fi
/usr/bin/codesign --force --deep --sign - "$APP_DIR"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_DIR"
/usr/bin/lipo "$MACOS_DIR/Margin" -verify_arch arm64
if [[ "$BUILD_KIND" == "release" ]]; then
  /usr/bin/lipo "$RESOURCES_DIR/node/bin/node" -verify_arch arm64
fi

if [[ "$BUILD_KIND" == "release" ]]; then
  if /usr/bin/grep -R -a -F -q "$ROOT_DIR" "$APP_DIR"; then
    print -u2 "The app bundle still contains the source checkout path."
    exit 1
  fi
else
  [[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw "$CONTENTS_DIR/Info.plist")" == "io.github.zhi0467.margin.dev" ]]
  [[ "$(/usr/bin/plutil -extract CFBundleDisplayName raw "$CONTENTS_DIR/Info.plist")" == "Margin Dev" ]]
  [[ "$(/usr/bin/plutil -extract MarginDevelopmentRoot raw "$CONTENTS_DIR/Info.plist")" == "$ROOT_DIR" ]]
  recorded_node="$(/usr/bin/plutil -extract MarginDevelopmentNodeExecutable raw "$CONTENTS_DIR/Info.plist")"
  [[ "$recorded_node" == "$DEVELOPMENT_NODE_EXECUTABLE" ]]
  [[ "$recorded_node" == /* && -x "$recorded_node" && ! -d "$recorded_node" ]]
  for embedded in app teach node; do
    if [[ -e "$RESOURCES_DIR/$embedded" ]]; then
      print -u2 "Margin Dev must not embed $embedded; it should load the live checkout."
      exit 1
    fi
  done
fi

print "Built $APP_DIR"
