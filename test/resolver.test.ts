import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "fs/promises";
import path from "path";
import os from "os";
import { resolveLinks } from "../src/compiler/resolver.js";
import { applyCompilePageWritesLocked } from "../src/compiler/compile-write.js";
import { buildFrontmatter } from "../src/utils/markdown.js";

describe("resolveLinks", () => {
  let tmpDir: string;
  let conceptsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "llmwiki-resolver-"));
    conceptsDir = path.join(tmpDir, "wiki", "concepts");
    await mkdir(conceptsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writePage(slug: string, title: string, body: string): Promise<void> {
    const fm = buildFrontmatter({ title, summary: "test" });
    await writeFile(path.join(conceptsDir, `${slug}.md`), `${fm}\n\n${body}\n`, "utf-8");
  }

  async function readPage(slug: string): Promise<string> {
    return readFile(path.join(conceptsDir, `${slug}.md`), "utf-8");
  }

  // resolveLinks now COMPUTES the rewrites; the caller applies them via the
  // executor batch. Mirror that here so these on-disk assertions exercise the
  // batch model rather than an inline write.
  async function resolveAndApply(changed: string[], newSlugs: string[]): Promise<void> {
    const writes = await resolveLinks(tmpDir, changed, newSlugs);
    await applyCompilePageWritesLocked(tmpDir, writes);
  }

  it("wraps title mentions in wikilinks", async () => {
    await writePage("alpha", "Alpha Concept", "This page mentions Beta Concept here.");
    await writePage("beta", "Beta Concept", "This page is about beta.");

    await resolveAndApply(["alpha"], []);
    const content = await readPage("alpha");
    expect(content).toContain("[[beta|Beta Concept]]");
  });

  it("matches case-insensitively", async () => {
    await writePage("alpha", "Alpha", "We discuss beta concept in depth.");
    await writePage("beta", "Beta Concept", "About beta.");

    await resolveAndApply(["alpha"], []);
    const content = await readPage("alpha");
    expect(content).toContain("[[beta|Beta Concept]]");
  });

  it("does not double-link already linked text", async () => {
    await writePage("alpha", "Alpha", "Already linked: [[Beta Concept]] here.");
    await writePage("beta", "Beta Concept", "About beta.");

    await resolveAndApply(["alpha"], []);
    const content = await readPage("alpha");
    // Should still have exactly one [[Beta Concept]], not nested
    const matches = content.match(/\[\[Beta Concept\]\]/g);
    expect(matches?.length).toBe(1);
  });

  it("respects word boundaries", async () => {
    await writePage("alpha", "Alpha", "The word Betamax should not be linked.");
    await writePage("beta", "Beta", "About beta.");

    await resolveAndApply(["alpha"], []);
    const content = await readPage("alpha");
    expect(content).not.toContain("[[beta|Beta]]max");
    expect(content).toContain("Betamax");
  });

  it.each([
    { label: "single citation", citation: "^[Beta Concept]" },
    { label: "multi-source citation", citation: "^[a.md, Beta Concept]" },
  ])("skips wikilink resolution inside $label markers", async ({ citation }) => {
    await writePage("alpha", "Alpha", `Info here. ${citation}`);
    await writePage("beta", "Beta Concept", "About beta.");

    await resolveAndApply(["alpha"], []);
    const content = await readPage("alpha");
    expect(content).not.toContain("[[Beta Concept]]");
    expect(content).toContain(citation);
  });

  it("adds inbound links for new titles", async () => {
    await writePage("existing", "Existing", "This mentions New Concept here.");
    await writePage("new-concept", "New Concept", "Brand new.");

    await resolveAndApply(["new-concept"], ["new-concept"]);
    const content = await readPage("existing");
    expect(content).toContain("[[new-concept|New Concept]]");
  });
});
