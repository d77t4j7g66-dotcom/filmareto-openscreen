#!/usr/bin/env bash
# Runs the Lua tests for the Resolve parts under DaVinci Resolve's own LuaJIT runner (fuscript).
# fuscript -l lua runs plain Lua without connecting to Resolve, but may not exit by itself, so a
# watchdog kills it after a timeout and each test file ends with os.exit.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FUSCRIPT="${FUSCRIPT:-/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fuscript}"
TIMEOUT="${TEST_TIMEOUT:-60}"

if [ ! -x "$FUSCRIPT" ]; then
  echo "fuscript not found at: $FUSCRIPT (set FUSCRIPT=...)" >&2
  exit 2
fi

export FILMARETO_ROOT="$ROOT"
cd "$ROOT" || exit 2

run_one() {
  local TEST_FILE="$1" OUT PID WATCHDOG STATUS
  OUT="$(mktemp)"
  "$FUSCRIPT" -l lua "$TEST_FILE" >"$OUT" 2>&1 &
  PID=$!
  ( sleep "$TIMEOUT"; kill -9 "$PID" 2>/dev/null ) &
  WATCHDOG=$!
  wait "$PID"
  STATUS=$?
  kill "$WATCHDOG" 2>/dev/null
  wait "$WATCHDOG" 2>/dev/null
  cat "$OUT"
  rm -f "$OUT"
  if [ "$STATUS" -ne 0 ]; then
    echo "resolve lua tests FAILED: $TEST_FILE (exit $STATUS)" >&2
  fi
  return "$STATUS"
}

RESULT=0
for T in core_test.lua import_test.lua; do
  run_one "$ROOT/resolve/tests/$T" || RESULT=1
done
exit "$RESULT"
