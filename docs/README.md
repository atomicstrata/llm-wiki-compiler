# llmwiki docs workflow

This directory contains the Mintlify documentation site for llmwiki. The docs are product documentation, not release notes: they should describe the current stable behavior a user can rely on.

## When docs must change

Update docs in the same PR as any user-facing change:

- New or changed CLI command, flag, output field, config key, environment variable, provider, SDK API, MCP tool/resource, viewer behavior, export/import format, or file written under `.llmwiki/`.
- Changed default behavior, failure mode, security boundary, path/confinement rule, review policy, freshness semantics, or compatibility requirement.
- New integration path with another tool or downstream package.

Internal refactors do not need docs unless they change an observable contract.

## Where changes belong

- `introduction.mdx` and `quickstart.mdx` - only for first-run or top-level positioning changes.
- `cli/*.mdx` - command syntax, flags, examples, output semantics, and command-specific safety notes.
- `configuration/*.mdx` - environment variables, providers, project config, schema, review policy, and defaults.
- `concepts/*.mdx` - durable concepts such as the wiki model, page types, citations, freshness, provenance, and review lifecycle.
- `guides/*.mdx` - end-to-end workflows and integrations.
- `troubleshooting/*.mdx` - common failure modes, recovery steps, and diagnostics.
- `docs.json` - navigation only. Add new pages here or they are effectively unpublished.

## Feature PR checklist

For every user-facing feature PR:

1. Update the closest existing page first. Add a new page only when the feature needs its own workflow or reference surface.
2. Include the command or config exactly as the CLI accepts it.
3. Document what is written to disk and what is not written.
4. Document trust boundaries for imports, external content, local servers, credentials, path confinement, and review gates.
5. Document failure behavior: fail-loud, skip-and-warn, dry-run behavior, or partial-success behavior.
6. Add or update examples that users can copy.
7. Update `docs.json` if a new page is added.
8. Run docs preview before merge:

   ```bash
   cd docs
   npx mint dev
   ```

9. Run the normal repo gates before the PR is considered done:

   ```bash
   npx tsc --noEmit
   npm run build
   npm test
   npm run fallow:ci
   ```

## Release checklist

During release prep:

1. Read `CHANGELOG.md` and the merged PR list for the release.
2. Check that each shipped user-facing feature has a Mintlify page or section.
3. Update `README.md` and `CHANGELOG.md` for the release version.
4. Run:

   ```bash
   npm run release:check-docs:current
   ```

5. Preview the docs site and spot-check the changed pages.
