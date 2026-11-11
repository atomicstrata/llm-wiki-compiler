#!/usr/bin/env bash
# Run CI's tests: on a pull request, only the files its changes affect. The job
# builds dist/ first, so this calls the test runner directly.
#
# Given the PR's base commit, this adds `--changed=<base>`, which keeps the test
# files whose imports reach a changed file. Bun sees only the import graph, so a
# change outside it would select nothing. Those run the whole suite instead:
# any file that is not TypeScript under src/ or test/ (config, the lockfile,
# packages/, fixtures, assets), and test/preload.ts, which bunfig loads rather
# than any test importing it. Tests that run dist/ reach src/ through the
# never-called imports in test/fixtures/built-dist.ts.
#
# Without a base (a push to main) the whole suite runs; that run is also the
# backstop for anything the narrowing misses. Further arguments go to the
# runner. Bun applies `--shard` after `--changed`, so each shard runs its part
# of the affected files.
#
# Usage: scripts/ci-test.sh [base-commit] [bun test args...]
set -euo pipefail

base="${1:-}"
shift || true

if [[ -n "$base" ]]; then
  outside_graph="$(git diff --name-only "$base" HEAD |
    awk '!/^(src|test)\/.+\.ts$/ || $0 == "test/preload.ts"')"
  if [[ -n "$outside_graph" ]]; then
    echo "ci-test: whole suite; the import graph cannot see:"
    sed 's/^/  /' <<<"$outside_graph"
  else
    echo "ci-test: affected tests only (--changed=$base)"
    set -- --changed="$base" "$@"
  fi
fi

exec bun scripts/run-tests.mjs "$@"
