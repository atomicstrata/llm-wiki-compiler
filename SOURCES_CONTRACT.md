# `sources/` Input Contract

This document defines the **stable input contract** for the `sources/` directory:
the format a programmatic producer (for example, **a downstream rule importer**) writes to drive
`llmwiki compile` without going through the interactive `llmwiki ingest` command.

Anything that can write a markdown file with the frontmatter described here can feed
the compiler. The compiler treats `sources/` as the single source of truth for what
to compile; it never reaches back to the original URL/file.

> Stability: the **field names, semantics, slug/filename rules, and
> `MAX_SOURCE_CHARS` limit below are stable.** New optional frontmatter fields may be
> added over time; existing fields will not change meaning without a contract revision.

---

## File layout

Each source is one UTF-8 markdown file in `sources/`:

```
sources/
  retrieval-augmented-generation.md
  some-design-doc.md
```

A source file is:

```markdown
---
title: Retrieval-Augmented Generation
source: https://example.com/rag
ingestedAt: 2026-05-31T12:00:00.000Z
sourceType: web
---

<body markdown — the actual content to compile>
```

The body is everything after the closing `---` of the YAML frontmatter block. The
compiler hashes the **entire file** (frontmatter + body) with SHA-256 to detect
changes; see [Change detection](#change-detection-incremental-compile).

Only files ending in `.md` are scanned. Other files in `sources/` are ignored.

---

## Frontmatter fields

The frontmatter is a single YAML block delimited by `---` lines at the very top of
the file.

### Required

| Field        | Type   | Meaning |
|--------------|--------|---------|
| `title`      | string | Human-readable title. Drives the **filename slug** (see below) and the wiki page title. Must contain at least one letter or digit, otherwise the slug is empty and the write is rejected. |
| `source`     | string | Source identity (URL, file path, or any stable producer-chosen URI). Used for re-ingest idempotency and basename-collision disambiguation. For a git-log producer this would be e.g. a commit URL or `repo@sha:path`. |
| `ingestedAt` | string | ISO-8601 timestamp of when the source was captured. |

### Optional

| Field          | Type    | Meaning |
|----------------|---------|---------|
| `sourceType`   | string  | Origin tag. One of `web`, `file`, `image`, `pdf`, `transcript`. Persisted for downstream tooling and human readers. A programmatic producer that does not map cleanly to one of these should pick the closest (`file` is the safe generic default). |
| `truncated`    | boolean | `true` when the body was truncated to fit `MAX_SOURCE_CHARS`. Omit when the body is complete. |
| `originalChars`| number  | Original character count **before** truncation. Set this together with `truncated: true` so consumers can see how much was dropped. Omit when `truncated` is absent. |

Producers may include additional YAML keys; the compiler ignores unrecognized
frontmatter fields rather than failing. Do not rely on unspecified fields surviving
into the compiled output.

---

## Filename and slug rules

The filename a producer chooses should match how `llmwiki ingest` would name it, so
re-ingest stays idempotent:

1. **Slug** is derived from `title` by lowercasing, transliterating to ASCII-ish
   kebab-case, and stripping characters that are not letters/digits/hyphens. A title
   that slugifies to the empty string (e.g. pure punctuation/emoji) is **rejected** —
   choose a title with at least one letter or digit.
2. The default filename is `<slug>.md`.
3. **Basename collisions:** if `<slug>.md` already exists for a *different* `source`,
   the disambiguated name is `<slug>-<8-hex>.md`, where `<8-hex>` is the first 8 hex
   chars of `sha256(source)`. Re-writing the *same* `source` overwrites `<slug>.md`
   in place (the existing file's frontmatter `source` is consulted first), so a
   producer that re-emits an updated version of the same source must keep `source`
   identical to overwrite rather than fork.

A producer that does not want to replicate the slug algorithm may simply write a
stable `<producer-chosen-name>.md` of its own choosing — the compiler keys change
detection off the **filename + file hash**, not the slug. The slug rules above only
matter for staying byte-compatible with `llmwiki ingest` output.

---

## Size limit: `MAX_SOURCE_CHARS`

The compiler-facing size ceiling is **`MAX_SOURCE_CHARS = 100_000` characters** of
body content (see `src/utils/constants.ts`). Producers should:

- Truncate the body to at most `MAX_SOURCE_CHARS` characters.
- When truncating, set `truncated: true` and `originalChars: <pre-truncation length>`
  in the frontmatter.

Very short bodies (under `MIN_SOURCE_CHARS = 50`) compile but are low-signal; the
interactive ingester warns on them. A programmatic producer should avoid emitting
near-empty sources.

---

## Change detection (incremental compile)

`llmwiki compile` is incremental. It records each source file's SHA-256 hash in
`.llmwiki/state.json` under `sources[<filename>] = { hash, concepts, compiledAt }`.
On the next compile, a source whose hash is unchanged is **skipped**.

Consequences for a producer:

- To trigger recompilation of a source, change its file contents (frontmatter or
  body) so the hash changes.
- Writing a byte-identical file is a no-op for that source.
- Deleting a source file marks its owned wiki page(s) orphaned on the next compile.

These same per-source hashes are surfaced in the JSON export as each page's
`sourceHashes`, and the export envelope carries `modelId` / `promptVersion`, so a
downstream consumer can audit which source bytes and which model/prompt produced a
page (the W4 provenance stamp).

---

## Future: a `git`-log adapter

W1 documents the contract only; no new connector ships with it. The natural next
connector for a downstream rule importer is a **git-log adapter** that walks commit history and
emits one `sources/*.md` per commit (or per changed file), with:

- `title` = commit subject (or `path @ short-sha`),
- `source` = a stable commit/blob URI,
- `ingestedAt` = commit timestamp,
- `sourceType: file`,
- body = the commit message and/or diff hunk, truncated to `MAX_SOURCE_CHARS`.

Such an adapter is purely a producer of files in this format; it requires no compiler
changes because it targets this stable contract.
