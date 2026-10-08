#!/usr/bin/env bash
# Run selected regression tests against the prepared, unmodified baseline.
set -eu
repo_root=$(git rev-parse --show-toplevel)
task_baseline=$(mktemp -d)
export task_baseline
cleanup() { python -c 'import os, shutil; shutil.rmtree(os.environ["task_baseline"])'; }
trap cleanup EXIT
git archive 37609581 | tar -x -C "$task_baseline"
ln -s "$repo_root/node_modules" "$task_baseline/node_modules"
ln -s "$repo_root/packages/sdk/dist" "$task_baseline/packages/sdk/dist"
files=(
  src/ton/__tests__/units.test.ts
  src/ton/__tests__/confirm-window.test.ts
  src/telegram/__tests__/flood-retry.test.ts
  src/providers/__tests__/nvidia-model.test.ts
  src/backup/__tests__/backup.test.ts
  src/session/__tests__/store.test.ts
  src/services/__tests__/audit-trail.test.ts
  src/telegram/__tests__/command-access.test.ts
  src/webui/__tests__/setup-server-launch.test.ts
  src/agent/tools/web/__tests__/download-binary.test.ts
)
for file in "${files[@]}"; do
  mkdir -p "$task_baseline/$(dirname "$file")"
  cp "$repo_root/$file" "$task_baseline/$file"
done
cd "$task_baseline"
# Finite test cases and two workers, with a 10-second per-test limit.
./node_modules/.bin/vitest run --maxWorkers=2 "${files[@]}"
