#!/bin/zsh
set -euo pipefail

NODE_VERSION="24.18.0"
NODE_ARCHIVE="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
NODE_SHA256="e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1"

if (( $# != 1 )); then
  print -u2 "Usage: $0 DESTINATION"
  exit 2
fi

DESTINATION="$1"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/margin-node.XXXXXX")"

cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

verify_archive() {
  local archive="$1"
  local actual
  actual="$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{print $1}')"
  [[ "$actual" == "$NODE_SHA256" ]]
}

copy_runtime() {
  local source="$1"
  mkdir -p "$DESTINATION"
  /usr/bin/ditto "$source" "$DESTINATION"
}

if [[ -n "${MARGIN_NODE_RUNTIME:-}" ]]; then
  runtime_source="$MARGIN_NODE_RUNTIME"
  if [[ "$runtime_source" == '~/'* ]]; then
    runtime_source="$HOME/${runtime_source#\~/}"
  fi

  if [[ -d "$runtime_source" && -x "$runtime_source/bin/node" && -f "$runtime_source/LICENSE" ]]; then
    copy_runtime "$runtime_source"
  elif [[ -f "$runtime_source" && -x "$runtime_source" ]]; then
    runtime_root="${runtime_source:h:h}"
    if [[ "$runtime_root/bin/node" != "${runtime_source:A}" || ! -f "$runtime_root/LICENSE" ]]; then
      print -u2 "MARGIN_NODE_RUNTIME must point to an official Node distribution or its bin/node executable."
      exit 1
    fi
    copy_runtime "$runtime_root"
  else
    print -u2 "MARGIN_NODE_RUNTIME must be an official Node distribution directory or bin/node executable: $runtime_source"
    exit 1
  fi
else
  CACHE_DIR="${MARGIN_NODE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/Library/Caches}/Margin/node}"
  ARCHIVE_PATH="$CACHE_DIR/$NODE_ARCHIVE"
  mkdir -p "$CACHE_DIR"

  if [[ -f "$ARCHIVE_PATH" ]] && ! verify_archive "$ARCHIVE_PATH"; then
    print -u2 "Discarding cached Node archive with the wrong SHA-256: $ARCHIVE_PATH"
    rm -f "$ARCHIVE_PATH"
  fi

  if [[ ! -f "$ARCHIVE_PATH" ]]; then
    download_path="$BUILD_DIR/$NODE_ARCHIVE"
    print "Downloading official Node.js v${NODE_VERSION} arm64 runtime..."
    /usr/bin/curl --fail --location --retry 3 --output "$download_path" "$NODE_URL"
    if ! verify_archive "$download_path"; then
      print -u2 "Node archive SHA-256 did not match the pinned release."
      exit 1
    fi
    /usr/bin/ditto "$download_path" "$ARCHIVE_PATH"
  fi

  if ! verify_archive "$ARCHIVE_PATH"; then
    print -u2 "Cached Node archive SHA-256 did not match the pinned release."
    exit 1
  fi

  /usr/bin/tar -xzf "$ARCHIVE_PATH" -C "$BUILD_DIR"
  copy_runtime "$BUILD_DIR/node-v${NODE_VERSION}-darwin-arm64"
fi

NODE_EXECUTABLE="$DESTINATION/bin/node"
if [[ ! -x "$NODE_EXECUTABLE" ]]; then
  print -u2 "Portable Node executable is missing: $NODE_EXECUTABLE"
  exit 1
fi

actual_version="$($NODE_EXECUTABLE --version)"
if [[ "$actual_version" != "v${NODE_VERSION}" ]]; then
  print -u2 "Expected Node v${NODE_VERSION}, found ${actual_version}."
  exit 1
fi

/usr/bin/lipo "$NODE_EXECUTABLE" -verify_arch arm64
architectures="$(/usr/bin/lipo -archs "$NODE_EXECUTABLE")"
if [[ "$architectures" != "arm64" ]]; then
  print -u2 "Expected an arm64-only Node runtime, found: $architectures"
  exit 1
fi

non_system_dependencies="$(
  /usr/bin/otool -L "$NODE_EXECUTABLE" |
    /usr/bin/tail -n +2 |
    /usr/bin/awk '{print $1}' |
    while IFS= read -r dependency; do
      case "$dependency" in
        /System/Library/*|/usr/lib/*) ;;
        *) print "$dependency" ;;
      esac
    done
)"
if [[ -n "$non_system_dependencies" ]]; then
  print -u2 "Portable Node runtime has non-system dynamic-library dependencies:"
  print -u2 "$non_system_dependencies"
  exit 1
fi

print "Prepared Node.js ${actual_version} (${architectures}) at $DESTINATION"
