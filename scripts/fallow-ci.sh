#!/usr/bin/env bash
# scripts/fallow-ci.sh
#
# Run fallow with the same flags GitHub Actions uses for the
# `codebase-health` job, so issues that would block PR merge are
# surfaced locally before pushing.
#
# What this mirrors (from fallow-rs/fallow@v2 action.yml + analyze.sh):
#   - bare command (runs dead-code, dupes, and health analyses together)
#   - --root .
#   - --format json and the action's explicit finding-count gate
#   - --changed-since <merge-base with the canonical PR base branch>
#       (CI uses the PR base SHA; merge-base is the closest local equivalent)
#
# Fork-aware base resolution:
#   - Prefer `upstream/main` when an `upstream` remote is configured (the
#     fork-and-PR workflow described in CONTRIBUTING.md, where `origin`
#     points at the contributor's fork and `upstream` at atomicmemory/*).
#   - Fall back to `origin/main` for direct clones.
#   - When neither remote tracks main, fall back to running fallow without
#     `--changed-since` (full-tree analysis).
#
# IMPORTANT — known parity gap:
#   fallow's clone-detection has empirical platform variation. The same
#   command, fallow version, commit, and base SHA can return 0 dupes on
#   macOS arm64 and 1+ dupes on the CI Linux x64 runner. This is a
#   tooling-level limitation, not a config bug. This script catches
#   most issues most of the time, but CI remains the ground truth.
#   When CI flags a clone you can't reproduce locally, just dedupe by
#   intent and re-push.

set -euo pipefail

# Resolve the upstream base branch ref. Forks should configure an
# `upstream` remote pointing at atomicmemory/llm-wiki-compiler so the
# script compares against the canonical main, not the fork's main.
if git remote get-url upstream >/dev/null 2>&1; then
  BASE_REMOTE="upstream"
else
  BASE_REMOTE="origin"
fi
BASE_REF="${BASE_REMOTE}/main"

# Refresh the base ref so the merge-base reflects what CI's PR base SHA
# would point at right now. A fetch failure (offline, auth issue) is
# non-fatal — we'll fall back to whatever's already cached locally.
git fetch --quiet "$BASE_REMOTE" main || \
  echo "warning: could not fetch ${BASE_REF}; using last-known cached state."

# `git merge-base` returns non-zero when the ref is missing or there's no
# common ancestor. Suppress the failure with `|| true` so the empty-result
# fallback below is reachable under `set -e`.
BASE_SHA=$(git merge-base "$BASE_REF" HEAD 2>/dev/null || true)

if [ -z "$BASE_SHA" ]; then
  echo "Could not determine merge-base with ${BASE_REF}; running fallow without --changed-since."
  npx fallow --root . --format json | node scripts/check-fallow-report.mjs
else
  echo "Running fallow scoped to changes since $(git rev-parse --short "$BASE_SHA") (${BASE_REF})..."
  npx fallow --root . --format json --changed-since "$BASE_SHA" | node scripts/check-fallow-report.mjs
fi
