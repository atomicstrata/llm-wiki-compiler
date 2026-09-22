/**
 * @file test/linter/fix-plan.test.ts
 * @description The §4.6 fix plan: which broken links have a deterministic
 * repair, and which honestly do not.
 *
 * THE AMBIGUITY CASE IS THE ONE THAT MATTERS. A repair is only proposed when
 * EXACTLY ONE page carries the linked title. With two, pointing at either is a
 * guess — and a confident wrong edit to someone's wiki is worse than advice
 * they can act on. With none there is nothing to point at.
 *
 * PLANNING WRITES NOTHING. §4.6 pins that `check` never writes knowledge
 * directly and that fixes are previewed, so the suite asserts the tree is
 * unchanged after planning.
 */

import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planLintFixes } from "../../src/linter/fix-plan.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
afterEach(() => tracker.cleanup());

/** A wiki whose pages are given as `slug -> {title, body}`. */
async function wiki(pages: Record<string, { title?: string; body: string }>): Promise<string> {
  const root = await tracker.create("fixplan-", { real: true });
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  for (const [slug, page] of Object.entries(pages)) {
    const front = page.title === undefined ? "---\n---\n" : `---\ntitle: ${page.title}\n---\n`;
    await writeFile(path.join(root, "wiki", "concepts", `${slug}.md`), `${front}\n${page.body}\n`, "utf8");
  }
  return root;
}

describe("deterministic repairs", () => {
  it("retargets a link written as a page's TITLE, keeping the visible text", async () => {
    const root = await wiki({
      "source-0": { title: "Alpha effects", body: "The paper." },
      index: { title: "Index", body: "See [[Alpha effects]]." },
    });
    const plans = await planLintFixes(root);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      kind: "fix", rule: "broken-wikilink",
      edit: { from: "[[Alpha effects]]", to: "[[source-0|Alpha effects]]" },
    });
  });

  it("RECOMMENDS rather than guessing when two pages carry the same title", async () => {
    const root = await wiki({
      "paper-a": { title: "Shared Title", body: "A." },
      "paper-b": { title: "Shared Title", body: "B." },
      index: { title: "Index", body: "See [[Shared Title]]." },
    });
    const plans = await planLintFixes(root);
    expect(plans[0]).toMatchObject({ kind: "recommendation" });
    expect((plans[0] as { advice: string }).advice).toContain("ambiguous");
  });

  it("RECOMMENDS when no page carries the title at all", async () => {
    const root = await wiki({ index: { title: "Index", body: "See [[Nothing Here]]." } });
    expect(plans0(await planLintFixes(root))).toBe("recommendation");
  });

  it("plans nothing for a link that already resolves", async () => {
    const root = await wiki({
      alpha: { title: "Alpha", body: "A." },
      index: { title: "Index", body: "See [[alpha]]." },
    });
    expect(await planLintFixes(root)).toEqual([]);
  });
});

describe("planning is read-only", () => {
  it("leaves every page byte-identical", async () => {
    const root = await wiki({
      "source-0": { title: "Alpha effects", body: "The paper." },
      index: { title: "Index", body: "See [[Alpha effects]]." },
    });
    const before = await snapshot(root);
    await planLintFixes(root);
    expect(await snapshot(root)).toEqual(before);
  });
});

/** The kind of the first plan, for the terse cases above. */
function plans0(plans: Awaited<ReturnType<typeof planLintFixes>>): string {
  return plans[0]?.kind ?? "none";
}

/** Every page's bytes, so a stray write cannot hide. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const dir = path.join(root, "wiki", "concepts");
  const names = await readdir(dir);
  const rows = await Promise.all(names.map(async (name) =>
    [name, await readFile(path.join(dir, name), "utf8")] as const));
  return Object.fromEntries(rows);
}

describe("the planner and the linter agree", () => {
  it("proposes NOTHING where the linter reports no broken wikilink", async () => {
    // Cross-comparing the two authorities, because they are separate walks over
    // the same wiki. A planner that proposed edits the linter never flagged
    // would be rewriting links nobody said were wrong.
    const root = await wiki({
      alpha: { title: "Alpha", body: "See [[alpha]] and [[Alpha]]." },
    });
    const { lint } = await import("../../src/linter/index.js");
    const broken = (await lint(root)).results.filter((r) => r.rule === "broken-wikilink");
    expect(broken).toEqual([]);
    expect(await planLintFixes(root)).toEqual([]);
  });

  it("proposes exactly one plan per link the linter calls broken", async () => {
    const root = await wiki({
      "source-0": { title: "Alpha effects", body: "The paper." },
      index: { title: "Index", body: "See [[Alpha effects]] and [[Nothing Here]]." },
    });
    const { lint } = await import("../../src/linter/index.js");
    const broken = (await lint(root)).results.filter((r) => r.rule === "broken-wikilink");
    // Two broken links, two plans: one fixable, one recommendation. A count
    // mismatch means the two walks disagree about what is broken.
    expect(broken).toHaveLength(2);
    expect(await planLintFixes(root)).toHaveLength(2);
  });
});

describe("pending targets are the linter's to report, not the planner's", () => {
  it("plans nothing for a link the linter calls pending-target", async () => {
    // Cross-authority: the linter suppresses a link-resolvable pending
    // candidate to info-level pending-target, so the planner advising that the
    // same link "cannot be repaired automatically" would contradict it.
    const root = await wiki({ index: { title: "Index", body: "See [[Pending Page]]." } });
    const { writeCandidate } = await import("../../src/compiler/candidates.js");
    await writeCandidate(root, {
      title: "Pending Page", slug: "pending-page", summary: "Pending.",
      sources: [], body: "pending body", reviewMode: "policy",
      heldReasons: [{ code: "low-confidence" }],
    });
    const { lint } = await import("../../src/linter/index.js");
    const rules = (await lint(root)).results.map((result) => result.rule);
    expect(rules).toContain("pending-target");
    expect(rules).not.toContain("broken-wikilink");
    expect(await planLintFixes(root)).toEqual([]);
  });
});
