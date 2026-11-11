#!/usr/bin/env bash
# Run CI's test files, narrowed to the affected ones on pull requests. The job
# builds dist/ first; this runs the test runner only.
#
# With a base commit, this runs `bun test --changed=<base>`: only the test files
# whose imports reach a changed file. Bun decides that from the import graph
# alone, so a change it cannot see there would select nothing. Those changes run
# the full suite instead: anything that is not a TypeScript file under src/ or
# test/ (config, the lockfile, packages/, fixtures, viewer assets), and
# test/preload.ts, which bunfig loads rather than any test importing it.
#
# Tests that run dist/ see src/ through the never-called imports in
# test/fixtures/built-dist.ts. Without a base commit (a push to main) the full
# suite runs, which is also the backstop for anything the narrowing misses.
#
# Further arguments go to the runner, e.g. `--shard=2/18`: Bun shards the files
# `--changed` kept, so every shard runs its part of the narrowed set.
#
# Usage: scripts/ci-test.sh [base-commit] [bun test args...]
set -euo pipefail

base="${1:-}"
shift || true
if [[ -z "$base" ]]; then
  exec bun scripts/run-tests.mjs "$@"
fi

changed="$(git diff --name-only "$base" HEAD)"
graph_blind="$(grep -vxE '(src|test)/.+\.ts' <<<"$changed" || true)"
if grep -qx 'test/preload.ts' <<<"$changed"; then
  graph_blind+=$'\ntest/preload.ts'
fi

if [[ -n "${graph_blind//[[:space:]]/}" ]]; then
  echo "ci-test: full suite; the import graph cannot see:"
  echo "$graph_blind" | sed '/^$/d; s/^/  /'
  exec bun scripts/run-tests.mjs "$@"
fi

echo "ci-test: affected tests only (--changed=$base)"
exec bun scripts/run-tests.mjs --changed="$base" "$@"
