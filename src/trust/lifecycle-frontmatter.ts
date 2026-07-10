/**
 * @file src/trust/lifecycle-frontmatter.ts
 * @description PARITY-SAFE raw-frontmatter rewrite for a lifecycle transition.
 *
 * The lifecycle body rebuild must change ONLY the lifecycle field's value (and
 * append the accepted evidence keys) — every OTHER field must keep its ORIGINAL
 * bytes. A parse→`buildFrontmatter` round-trip cannot promise that: the shared
 * `parseFrontmatter` (js-yaml, default schema) coerces an unquoted date-only
 * `created: 2024-01-15` into a JS `Date`, and `buildFrontmatter` re-dumps it as
 * the ISO datetime `2024-01-15T00:00:00.000Z` — silently RETYPING a field the
 * transition never touched. (Changing the shared utils' global behaviour is a
 * parity risk for the frozen goldens, so the fix is LOCAL to this rewrite.)
 *
 * Instead this module SPLICES the existing raw frontmatter text: it replaces the
 * one lifecycle field's value line and upserts each accepted evidence key, leaving
 * every untouched line byte-for-byte. Only the EDITED keys' values are (re)rendered
 * via the SHARED `buildFrontmatter` (so YAML escaping for arbitrary value types
 * stays correct + DRY); the original lines for all other fields are never re-dumped.
 *
 * When an upserted key ALREADY exists as a MULTI-LINE value (a YAML block list,
 * nested block mapping, or block scalar `|`/`>`), the replace also drops that key's
 * CONTINUATION lines (see {@link countContinuationLines}) — otherwise the orphaned
 * old lines would merge with the freshly-rendered value and the page would re-parse
 * to old+new, diverging from the validated `nextMeta`.
 */

import { buildFrontmatter } from "../utils/markdown.js";

/** A single frontmatter line and the bare key it declares (or `null` for non `key:` lines). */
interface FrontmatterLine {
  key: string | null;
  text: string;
}

/** Match a top-level `key: ...` line, capturing the (unindented) key. */
const TOP_LEVEL_KEY = /^([^\s:#][^:]*):/;

/** Split the raw frontmatter block into lines, tagging each with its top-level key (if any). */
function splitLines(rawFrontmatter: string): FrontmatterLine[] {
  return rawFrontmatter.split("\n").map((text) => {
    const match = TOP_LEVEL_KEY.exec(text);
    return { key: match ? match[1].trim() : null, text };
  });
}

/** Render a single `key: value` frontmatter line via the shared dumper (correct YAML escaping). */
function renderLine(key: string, value: unknown): string {
  const dumped = buildFrontmatter({ [key]: value });
  // Strip the `---` fences the shared builder adds; keep only the inner key line(s).
  return dumped.replace(/^---\n/, "").replace(/\n---$/, "");
}

/** Is this line a CONTINUATION of a top-level key's value (an indented child line)? */
function isIndented(text: string): boolean {
  return /^\s/.test(text) && text.trim().length > 0;
}

/**
 * Count the CONTINUATION lines that belong to a top-level key's value at `start`
 * (the key line index) — the block list items, nested mapping children, or block
 * scalar (`|`/`>`) body lines. A continuation is any subsequent INDENTED line, plus
 * a blank line ONLY when it is interior to the block (its next non-blank line is
 * still indented). Stops at the next top-level (unindented, non-blank) line.
 *
 * Without this, replacing only the key line would ORPHAN these lines, and the
 * page would re-parse to the OLD value merged with the freshly-rendered one (a
 * `string[]` becoming old+new, a scalar-over-list becoming a malformed string).
 */
function countContinuationLines(lines: FrontmatterLine[], start: number): number {
  let count = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const { text } = lines[i];
    if (isIndented(text)) {
      count = i - start;
      continue;
    }
    if (text.trim().length === 0) continue; // blank: decided by the NEXT non-blank line
    break; // an unindented, non-blank line: the next top-level key — stop here
  }
  return count;
}

/** Upsert one `key: value` into the line list: replace the existing key (and its continuation lines) in place, else append. */
function upsertLine(lines: FrontmatterLine[], key: string, value: unknown): void {
  const rendered: FrontmatterLine = { key, text: renderLine(key, value) };
  const idx = lines.findIndex((line) => line.key === key);
  if (idx < 0) {
    lines.push(rendered);
    return;
  }
  // Replace the key line AND drop its continuation lines so a re-supplied
  // multi-line value writes EXACTLY the validated value, nothing orphaned.
  lines.splice(idx, 1 + countContinuationLines(lines, idx), rendered);
}

/**
 * Rebuild the frontmatter block for a lifecycle transition by EDITING the raw
 * text: flip the lifecycle field to `toState` and upsert each accepted evidence
 * key, leaving every other field's original bytes untouched.
 *
 * @param rawFrontmatter - The original frontmatter text (between the `---` fences).
 * @param lifecycleField - The frontmatter key the lifecycle FSM is defined over.
 * @param toState - The lifecycle state to set.
 * @param accepted - The allow-listed evidence key/value pairs to upsert.
 * @returns The full frontmatter block (with fences) for the transitioned page.
 */
export function rebuildLifecycleFrontmatter(
  rawFrontmatter: string,
  lifecycleField: string,
  toState: string,
  accepted: Record<string, unknown>,
): string {
  const lines = splitLines(rawFrontmatter);
  upsertLine(lines, lifecycleField, toState);
  for (const [key, value] of Object.entries(accepted)) upsertLine(lines, key, value);
  return `---\n${lines.map((line) => line.text).join("\n")}\n---`;
}
