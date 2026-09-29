/**
 * A `[[...]]` inside literal Markdown (fenced, indented or inline code) is text,
 * not a link. Link repair and publication already skip it; every other reader
 * must agree, or lint reports broken links llmwiki itself does not treat as
 * links, lint fixes and OKF export rewrite code, and the link graph grows edges
 * that do not exist. Each case drives one reader through its public entry with
 * the same page, where the only live link is the one in prose.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wikilinksToOkf, okfLinksToWikilinks } from "../src/export/okf/mapping.js";
import { lint } from "../src/linter/index.js";
import { planLintFixes } from "../src/linter/fix-plan.js";
import { countWikilinks } from "../src/schema/helpers.js";
import { extractWikilinkSlugs, extractWikilinkTargets } from "../src/wiki/collect.js";
import { findWikilinks } from "../src/wiki/wikilinks.js";
import { recognizedWikilinkTargets } from "../src/wiki/wikilink-tokens.js";
import { slugify } from "../src/utils/markdown.js";
import { tempRootTracker } from "./temp-roots.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";

const tracker = tempRootTracker();
afterEach(() => tracker.cleanup());

/** One prose link and the same kind of link in every literal form. */
const BODY = [
  "Prose links to [[Prose Target|the target]].",
  "",
  "Inline `[[Inline Code]]` is an example.",
  "",
  "```md",
  "[[Fenced Code]]",
  "```",
  "",
  "    [[Indented Code]]",
  "",
].join("\n");

/** A wiki with one page holding {@link BODY}; no link target exists. */
async function wiki(): Promise<string> {
  const root = await tracker.create("wikilinks-literal-", { real: true });
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await writeFile(path.join(root, "wiki", "concepts", "page.md"), `---\ntitle: Page\nsummary: A page\n---\n\n${BODY}`);
  return root;
}

describe("findWikilinks", () => {
  it("returns only the prose link, with its target, label and line", () => {
    expect(findWikilinks(BODY)).toEqual([
      { inner: "Prose Target|the target", target: "Prose Target", label: "the target", index: 15, line: 1 },
    ]);
  });

  it("finds nothing in text without link brackets", () => {
    expect(findWikilinks("plain `code` and prose")).toEqual([]);
  });
});

// The renderer (viewer and answer reporting) is the authority on which links
// exist; the extractor must find exactly the targets it recognizes.
const RENDERER_CASES: Record<string, string> = {
  "unmatched backticks in separate paragraphs": "One ` stray.\n\nSee [[Missing]].\n\nAnother ` stray.",
  "code in a table cell": "| a | b |\n| - | - |\n| `[[In Code]]` | [[In Cell]] |",
  "table pipe after two backslashes": "| a | b |\n| - | - |\n| `[[Code]]\\\\|x` | [[Live]] |",
  "heading and list code": "# Title `[[Heading Code]]` [[Heading Link]]\n\n- item `[[List Code]]` and [[List Link]]",
  "blockquote code": "> quoted `[[Quote Code]]` and [[Quote Link]]",
  "link across lines": "Broken [[Across\nLines]] link.",
  "bracket inside": "Nested [[a [b] c]] text.",
  "inline html is text": "Raw <code>[[Html Text]]</code> here.",
};

describe("agreement with the renderer's recognizer", () => {
  it.each(Object.entries(RENDERER_CASES))("finds exactly the renderer's links: %s", (_label, body) => {
    expect(findWikilinks(body).map(link => slugify(link.target))).toEqual(recognizedWikilinkTargets(body));
  });
});

describe("readers agree with link repair about which links exist", () => {
  it("lint reports only the prose link as broken", async () => {
    const summary = await lint(await wiki());
    const broken = summary.results.filter(r => r.rule === "broken-wikilink").map(r => r.message);
    expect(broken).toEqual([expect.stringContaining("[[Prose Target|the target]]")]);
  });

  it("lint fix plans only the prose link", async () => {
    const plans = await planLintFixes(await wiki());
    expect(plans.map(plan => JSON.stringify(plan))).toEqual([expect.stringContaining("Prose Target")]);
  });

  it("the link graph and schema counts see only the prose link", () => {
    expect(extractWikilinkSlugs(BODY)).toEqual(["prose-target"]);
    expect(extractWikilinkTargets(BODY)).toEqual([{ slug: "prose-target", display: "the target" }]);
    expect(countWikilinks(BODY)).toBe(1);
  });

  it("OKF export and import leave code untouched and round-trip it", () => {
    const resolve = (slug: string) => ({ title: slug, path: `concepts/${slug}.md` });
    const exported = wikilinksToOkf(BODY, resolve);
    expect(exported).toContain("[the target](/concepts/prose-target.md)");
    expect(exported).toContain("`[[Inline Code]]`");
    expect(exported).toContain("\n[[Fenced Code]]\n");
    const codeLink = "Example: `[Doc](/concepts/doc.md)`";
    expect(okfLinksToWikilinks(codeLink, () => ({ slug: "doc", title: "Doc" }))).toBe(codeLink);
  });

  it("lint through the CLI reports one broken link", async () => {
    const run = await runCLI(["lint"], await wiki(), { LLMWIKI_EMBEDDINGS: "off", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" });
    expectCLIExit(run, 1);
    expect(run.stdout.match(/Broken wikilink/g)).toHaveLength(1);
  }, 20_000);
});
