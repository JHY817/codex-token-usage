#!/bin/sh
set -eu

REPOSITORY="JHY817/codex-token-usage"
case "$(uname -m)" in
  arm64) RELEASE_ARCH="arm64" ;;
  x86_64) RELEASE_ARCH="x64" ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="Codex-Token-Usage-macOS-${RELEASE_ARCH}.zip"
BASE_URL="${CODEX_USAGE_RELEASE_BASE_URL:-https://github.com/${REPOSITORY}/releases/latest/download}"
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

DESTINATION_DIR="${CODEX_USAGE_DESTINATION_DIR:-$HOME/Applications}"
mkdir -p "$DESTINATION_DIR"
DESTINATION_DIR="$(cd "$DESTINATION_DIR" && pwd -P)"
DESTINATION_APP="$DESTINATION_DIR/Codex Token Usage.app"
BACKUP_APP="$WORK_DIR/previous-Codex-Token-Usage.app"
READY_FILE="$WORK_DIR/install-ready"

destination_app_pids() {
  ps -axo pid=,command= | awk -v executable="$DESTINATION_APP/Contents/MacOS/CodexUsageMenuBar" '
    {
      pid = $1
      $1 = ""
      sub(/^ /, "", $0)
      if ($0 == executable || index($0, executable " ") == 1) print pid
    }
  '
}

stop_destination_app() {
  PIDS="$(destination_app_pids)"
  [ -z "$PIDS" ] || kill -TERM $PIDS 2>/dev/null || true
}

server_process_pids() {
  ps -axo pid=,command= | awk -v script="$DESTINATION_APP/Contents/Resources/server/http.mjs" '
    {
      pid = $1
      $1 = ""
      sub(/^ /, "", $0)
      if (index($0, script) > 0) print pid
    }
  '
}

discover_server_url() {
  for PID in $(server_process_pids); do
    URL="$(lsof -Pan -p "$PID" -iTCP -sTCP:LISTEN -n 2>/dev/null | awk '/127\.0\.0\.1:[0-9]+ \(LISTEN\)/ { match($0, /127\.0\.0\.1:[0-9]+/); print "http://" substr($0, RSTART, RLENGTH); exit }')"
    [ -n "$URL" ] && { printf '%s\n' "$URL"; return 0; }
  done
}

rollback_install() {
  stop_destination_app
  rm -rf "$DESTINATION_APP"
  if [ -e "$BACKUP_APP" ]; then
    mv "$BACKUP_APP" "$DESTINATION_APP"
    open -n "$DESTINATION_APP" >/dev/null 2>&1 || true
  fi
}

stop_destination_app
WAIT_COUNT=0
while [ -n "$(destination_app_pids)" ] && [ "$WAIT_COUNT" -lt 40 ]; do
  sleep 0.25
  WAIT_COUNT=$((WAIT_COUNT + 1))
done
if [ -n "$(destination_app_pids)" ]; then
  echo "Existing Codex Token Usage process did not stop" >&2
  exit 1
fi
if [ -e "$DESTINATION_APP" ]; then
  test -d "$DESTINATION_APP/Contents" || { echo "Existing destination is not an app bundle" >&2; exit 1; }
  mv "$DESTINATION_APP" "$BACKUP_APP"
fi
if ! ditto "$SOURCE_APP" "$DESTINATION_APP"; then
  rollback_install
  exit 1
fi
if ! open -n "$DESTINATION_APP" --args --install-ready-file "$READY_FILE"; then
  echo "Unable to launch the installed app" >&2
  rollback_install
  exit 1
fi

SERVER_URL=""
WAIT_COUNT=0
while [ -z "$SERVER_URL" ] && [ "$WAIT_COUNT" -lt 80 ]; do
  if [ -s "$READY_FILE" ]; then
    SERVER_URL="$(sed -n '1p' "$READY_FILE")"
  fi
  if [ -z "$SERVER_URL" ]; then
    SERVER_URL="$(discover_server_url)"
  fi
  [ -n "$SERVER_URL" ] || sleep 0.25
  WAIT_COUNT=$((WAIT_COUNT + 1))
done
if [ -z "$SERVER_URL" ]; then
  echo "Installed app did not start its local data service" >&2
  rollback_install
  exit 1
fi
case "$SERVER_URL" in
  http://127.0.0.1:*) ;;
  *)
    echo "Installed app returned an invalid local service address" >&2
    rollback_install
    exit 1
    ;;
esac
if ! curl -fsS --retry 2 --max-time 60 "$SERVER_URL/api/status?refresh=1" >/dev/null; then
  echo "Installed app could not read local Codex data; previous version restored" >&2
  rollback_install
  exit 1
fi
echo "Codex Token Usage installed in $DESTINATION_APP"
