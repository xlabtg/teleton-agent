#!/bin/sh
set -eu

TEST="${1:?test file required}"
NAME="${2:-}"

echo "===== ENV ====="
node -e 'console.log("node:",process.version); console.log("crypto.getRandomValues:",typeof globalThis.crypto?.getRandomValues)'

echo
echo "===== TEST ====="
echo "$TEST"
[ -n "$NAME" ] && echo "CASE: $NAME"

echo
echo "===== VITEST ====="
./node_modules/.bin/vitest run "$TEST" ${NAME:+-t "$NAME"} --reporter=verbose 2>&1 \
  | tail -100
