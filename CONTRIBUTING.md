# Contributing to llmwiki

Thanks for your interest in contributing! This guide covers the fork-and-PR workflow we use for all contributions.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/llm-wiki-compiler.git
   cd llm-wiki-compiler
   ```
3. **Install dependencies:**
   ```bash
   npm install
   ```
4. **Create a feature branch:**
   ```bash
   git checkout -b feature/<your-feature-name>
   ```

## Branch Naming

- `feature/<name>` — new features
- `fix/<name>` — bug fixes

## Development

### Build and Test

```bash
npm run build    # Compile TypeScript
npm test         # Run all tests
npm run dev      # Watch mode for development
```

**Automatic checks via git hooks:**

After `npm install`, husky wires up hooks that run automatically:

- **pre-commit** — `fallow` (codebase health) and `npx tsc --noEmit` (type check)
- **pre-push** — `npm run build` and `npm test`

If a hook fails, fix the underlying issue rather than bypassing with `--no-verify`. Use `fallow fix --yes` to auto-fix unused exports, then address remaining issues manually.

You can also run the full suite manually:

```bash
npx tsc --noEmit   # Type-check
npm run build       # Build
npm test            # Tests
npx fallow          # Codebase health (dead code, duplication, complexity)
npm run fallow:ci   # Run fallow scoped to changes since origin/main (matches CI args)
```

**A note on `npm run fallow:ci`:** the `codebase-health` job in CI passes `--changed-since <PR-base-sha>` so it scopes analysis to the diff. `npm run fallow:ci` mirrors that locally by computing the merge-base between `HEAD` and the canonical main branch. The script prefers `upstream/main` when an `upstream` remote is configured (the fork workflow), and falls back to `origin/main` for direct clones. To make sure the comparison uses the canonical main from atomicmemory/llm-wiki-compiler:

```bash
# One-time setup on your fork
git remote add upstream https://github.com/atomicstrata/llm-wiki-compiler.git
```

Without an `upstream` remote on a fork checkout, the script compares against your fork's `origin/main`, which can drift from the canonical main and miss findings CI will catch.

There is also one known parity gap that no flag closes: fallow's clone-detection occasionally returns different results across platforms (CI Linux x64 vs macOS arm64). When CI flags a clone you can't reproduce locally, dedupe by intent and re-push — it's not a bug in your branch.

### Code Style

- Follow the conventions in `CLAUDE.md`
- **File size limit:** 400 lines (excluding comments). Refactor if exceeded.
- **Function size limit:** 40 lines (excluding comments and catch/finally blocks).
- Use TypeScript with proper types — avoid `any`.
- Include JSDoc comments on all exported functions and at the top of each file.
- Write meaningful variable and function names that reveal purpose.

### Writing Tests

- Place tests in the `test/` directory
- Use Vitest (already configured)
- Tests should not depend on timing or external services
- Keep test files under 400 lines; split if needed

## Submitting a Pull Request

1. Push your branch to your fork
2. Open a PR against `main` on this repository
3. In your PR description:
   - Describe **what** the change does and **why**
   - Reference the issue number if applicable (e.g., "Closes #3")
   - Include instructions on how to test the change
4. Ensure CI checks pass

## Review Process

- A maintainer will review your PR within a few days
- Address any requested changes by pushing new commits to your branch
- Once approved, the maintainer will squash-merge your PR

## Questions?

Open an issue or start a discussion — we're happy to help.
