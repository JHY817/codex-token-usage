#!/bin/sh
set -eu

REPOSITORY="JHY817/codex-token-usage"
case "$(uname -m)" in
  arm64) RELEASE_ARCH="arm64" ;;
  x86_64) RELEASE_ARCH="x64" ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="Codex-Token-Usage-macOS-${RELEASE_ARCH}.zip"
BASE_URL="https://github.com/${REPOSITORY}/releases/latest/download"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

curl -fL --retry 3 -o "$WORK_DIR/$ASSET" "$BASE_URL/$ASSET"
curl -fL --retry 3 -o "$WORK_DIR/SHA256SUMS" "$BASE_URL/SHA256SUMS"
EXPECTED="$(awk -v file="$ASSET" '$2 == file { print $1 }' "$WORK_DIR/SHA256SUMS")"
ACTUAL="$(shasum -a 256 "$WORK_DIR/$ASSET" | awk '{ print $1 }')"
test -n "$EXPECTED" && test "$EXPECTED" = "$ACTUAL" || {
  echo "Download checksum verification failed" >&2
  exit 1
}

ditto -x -k "$WORK_DIR/$ASSET" "$WORK_DIR/unpacked"
SOURCE_APP="$WORK_DIR/unpacked/Codex Token Usage.app"
test -d "$SOURCE_APP" || { echo "App bundle missing from release" >&2; exit 1; }

DESTINATION_DIR="$HOME/Applications"
DESTINATION_APP="$DESTINATION_DIR/Codex Token Usage.app"
BACKUP_APP="$WORK_DIR/previous-Codex-Token-Usage.app"
mkdir -p "$DESTINATION_DIR"
pkill -TERM -x CodexUsageMenuBar 2>/dev/null || true
if [ -e "$DESTINATION_APP" ]; then
  test -d "$DESTINATION_APP/Contents" || { echo "Existing destination is not an app bundle" >&2; exit 1; }
  mv "$DESTINATION_APP" "$BACKUP_APP"
fi
if ! ditto "$SOURCE_APP" "$DESTINATION_APP"; then
  rm -rf "$DESTINATION_APP"
  [ ! -e "$BACKUP_APP" ] || mv "$BACKUP_APP" "$DESTINATION_APP"
  exit 1
fi
open "$DESTINATION_APP"
echo "Codex Token Usage installed in $DESTINATION_APP"
