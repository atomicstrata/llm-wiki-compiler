#!/usr/bin/env bash
# The DETERMINISTIC product gate (P5c §6, hardening D87/D101): run the suite
# with NO reachable model credential or provider override. A fresh empty HOME
# removes the Claude settings fallback; the unsets remove every env route the
# provider guard consumes — Anthropic, OpenAI, MiniMax, Copilot — plus the
# provider/settings/invocation overrides. A repository `.env` would let CLI
# subprocesses reload credentials (src/cli.ts imports dotenv/config), so the
# gate REFUSES to run beside one rather than pretend determinism.
set -euo pipefail
if [ -f .env ]; then
  echo "test-keyless: a .env exists in the working directory; the gate cannot guarantee determinism — move it aside" >&2
  exit 2
fi
FRESH_HOME="$(mktemp -d)"
trap 'rm -rf "$FRESH_HOME"' EXIT
env -u ANTHROPIC_API_KEY -u CLAUDE_API_KEY -u ANTHROPIC_AUTH_TOKEN \
    -u OPENAI_API_KEY -u MINIMAX_API_KEY -u GITHUB_TOKEN \
    -u LLMWIKI_PROVIDER -u LLMWIKI_CLAUDE_SETTINGS_PATH \
    -u LLMWIKI_PROVIDER_INVOCATION_MODULE \
    HOME="$FRESH_HOME" npm test "$@"
