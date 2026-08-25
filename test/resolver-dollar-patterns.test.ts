/**
 * @file test/resolver-dollar-patterns.test.ts
 * @description Interlink resolution must insert a rewritten body verbatim,
 * including `$` sequences that `String.replace` would otherwise treat as
 * substitution patterns.
 *
 * `rewritePage` splices the linked body back into the page with
 * `content.replace(body, ...)`. A STRING replacement there is interpreted:
 * `$&` re-inserts the match, `` $` `` inserts everything before it — which is
 * this page's own frontmatter — `$'` inserts everything after, and `$$` becomes
 * a single `$`. None of that is hypothetical for a wiki: shell, sed, awk and
 * Makefile pages carry those sequences as ordinary prose, and `$$` for a process
 * id is common.
 *
 * The bug was silent. The link resolved correctly and the page was rewritten,
 * so nothing failed; the prose around the link was simply wrong afterwards.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAndApplyLinks } from "../src/compiler/resolver.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** A project with a link TARGET page, plus one page whose prose contains `body`. */
const FRONTMATTER = "---\ntitle: PID Tricks\nsummary: s\nsources: []\n---\n\n";

function projectWithBody(body: string): { root: string; pagePath: string } {
  const root = mkdtempSync(path.join(tmpdir(), "resolver-dollar-"));
  roots.push(root);
  mkdirSync(path.join(root, "wiki/concepts"), { recursive: true });
  writeFileSync(
    path.join(root, "wiki/concepts/shell-quoting-rules.md"),
    "---\ntitle: Shell Quoting Rules\nsummary: s\nsources: []\n---\n\nTarget page.\n",
  );
  const pagePath = path.join(root, "wiki/concepts/pid-tricks.md");
  writeFileSync(pagePath, FRONTMATTER + body);
  return { root, pagePath };
}

describe("interlink resolution preserves $ sequences in prose", () => {
  // A bare title mention is what triggers a rewrite; an existing [[link]] is
  // skipped by isInsideWikilink, so it would never reach the splice at all.
  it.each([
    ["$$ (process id)", "The PID is $$ here.\n\nSee Shell Quoting Rules for more.\n"],
    ["$& (whole match)", "Use $& in sed.\n\nSee Shell Quoting Rules for more.\n"],
    ["$` (prefix)", "Use $` in sed.\n\nSee Shell Quoting Rules for more.\n"],
    ["$' (suffix)", "Use $' in sed.\n\nSee Shell Quoting Rules for more.\n"],
  ])("keeps %s exactly as written", async (_label, body) => {
    const { root, pagePath } = projectWithBody(body);
    await resolveAndApplyLinks(root, ["pid-tricks"], []);
    const after = readFileSync(pagePath, "utf-8");

    // EXACT equality, not containment. `$&` re-inserts the match, which
    // duplicates the body rather than mangling it — every `toContain` on the
    // original prose still passes against a page that now says everything
    // twice. Only comparing the whole file catches that.
    const expected = FRONTMATTER + body.replace(
      "Shell Quoting Rules",
      "[[shell-quoting-rules|Shell Quoting Rules]]",
    );
    expect(after).toBe(expected);
  }, 30_000);
});
