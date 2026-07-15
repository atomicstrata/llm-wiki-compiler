> **First-time setup**: Customize this file for your project. Prompt the user to customize this file for their project.
> For Mintlify product knowledge (components, configuration, writing standards),
> install the Mintlify skill: `npx skills add https://mintlify.com/docs`

# Documentation project instructions

## About this project

- This is a documentation site built on [Mintlify](https://mintlify.com)
- Pages are MDX files with YAML frontmatter
- Configuration lives in `docs.json`
- Use the Mintlify MCP server, `https://mcp.mintlify.com`, to edit content and settings via MCP
- Use the Mintlify docs MCP server, `https://www.mintlify.com/docs/mcp`, to query information about using Mintlify via MCP
- The project-specific docs workflow lives in `README.md` in this directory. Read it before adding or reviewing docs.

## Feature documentation rule

- Any user-facing feature change must update the Mintlify docs in the same PR.
- User-facing means CLI commands and flags, config, environment variables, providers, SDK/MCP surfaces, viewer behavior, export/import formats, files written under `.llmwiki/`, security boundaries, and changed failure behavior.
- Prefer updating the closest existing page. Add a new page only when the feature needs a standalone reference or workflow.
- If a new page is added, update `docs.json` navigation in the same change.
- Document safety and trust boundaries explicitly for imports, external content, credentials, local servers, path confinement, and review gates.
- Docs should describe current stable behavior. Use changelog/release notes for historical narrative.

## Terminology

- Use `llmwiki` for the CLI/product name.
- Use `wiki` for the compiled output under `wiki/`.
- Use `sources/` for raw input files.
- Use `review candidates` for records under `.llmwiki/candidates/`.
- Use `OKF` after first spelling out `Open Knowledge Format` on a page.

## Style preferences

- Use active voice and second person ("you")
- Keep sentences concise - one idea per sentence
- Use sentence case for headings
- Bold for UI elements: Click **Settings**
- Code formatting for file names, commands, paths, and code references
- Prefer copyable commands over prose-only explanations.
- State defaults and exceptions close to the command or config that causes them.

## Content boundaries

- Do not mention internal planning files, localdocs, Claude/Codex review process, or unmerged PR numbers.
- Do not document speculative roadmap items as available behavior.
- Do document known limitations when they affect user decisions.
