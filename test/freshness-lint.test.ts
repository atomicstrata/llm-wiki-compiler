import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { checkStalePages } from "../src/linter/rules.js";
import { lint } from "../src/linter/index.js";
import { buildFreshnessSnapshot } from "../src/freshness/index.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";
import {
  sha256Hex,
  writeCorruptTestStateJson,
  writeSourceFile,
  writeSourceState,
} from "./fixtures/state-json.js";

async function writeConcept(dir: string, slug: string, frontmatter: Record<string, unknown>, body: string) {
  await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  await writeFile(path.join(dir, "wiki/concepts", `${slug}.md`), `---\n${fm}\n---\n\n${body}\n`);
}

/** Write a source file whose current content differs from the recorded hash, making owners stale. */
async function writeStaleSource(dir: string, concepts: string[]) {
  await writeSourceFile(dir, "a.md", "NEW body");
  await writeSourceState(dir, { "a.md": { hash: sha256Hex("OLD body"), concepts } });
}

/** Build the snapshot, run the rule, and assert exactly one finding of the given rule. Returns it. */
async function expectSingleFinding(dir: string, rule: string) {
  const results = await checkStalePages(dir, await buildFreshnessSnapshot(dir));
  expect(results).toHaveLength(1);
  expect(results[0].rule).toBe(rule);
  return results[0];
}

describe("checkStalePages", () => {
  const env = useLintTempRoot("freshness-lint");

  it("reports a page whose source changed since compile", async () => {
    await writeStaleSource(env.dir, ["topic"]);
    await writeConcept(env.dir, "topic", { title: "Topic" }, "Body.");

    const finding = await expectSingleFinding(env.dir, "stale-page");
    expect(finding.severity).toBe("warning");
  });

  it("reports nothing when sources are unchanged", async () => {
    await mkdir(path.join(env.dir, "sources"), { recursive: true });
    await writeFile(path.join(env.dir, "sources/a.md"), "same");
    await writeSourceState(env.dir, { "a.md": { hash: sha256Hex("same"), concepts: ["topic"] } });
    await writeConcept(env.dir, "topic", { title: "Topic" }, "Body.");

    const snap = await buildFreshnessSnapshot(env.dir);
    expect(await checkStalePages(env.dir, snap)).toEqual([]);
  });

  it("never reports a query page as stale", async () => {
    await writeStaleSource(env.dir, ["topic"]);
    await mkdir(path.join(env.dir, "wiki/queries"), { recursive: true });
    await writeFile(path.join(env.dir, "wiki/queries/topic.md"), "---\ntitle: Topic\n---\n\nBody.\n");
    const snap = await buildFreshnessSnapshot(env.dir);
    expect(await checkStalePages(env.dir, snap)).toEqual([]);
  });

  it("reports a computed-orphaned page (all owning sources deleted, no frontmatter flag)", async () => {
    // a.md owns "topic" in state, but the source file does not exist on disk.
    await writeSourceState(env.dir, { "a.md": { hash: sha256Hex("gone"), concepts: ["topic"] } });
    await writeConcept(env.dir, "topic", { title: "Topic" }, "Body.");

    await expectSingleFinding(env.dir, "orphaned-page");
  });

  it("does not double-report a frontmatter-orphaned page (left to checkOrphanedPages)", async () => {
    await writeSourceState(env.dir, { "a.md": { hash: sha256Hex("gone"), concepts: ["topic"] } });
    await writeConcept(env.dir, "topic", { title: "Topic", orphaned: true }, "Body.");

    const snap = await buildFreshnessSnapshot(env.dir);
    expect(await checkStalePages(env.dir, snap)).toEqual([]);
  });
});

describe("lint() orchestrator surfaces freshness findings", () => {
  const env = useLintTempRoot("freshness-lint-orchestrator");

  it("includes the stale-page finding in the full lint summary", async () => {
    await writeStaleSource(env.dir, ["topic"]);
    await writeConcept(env.dir, "topic", { title: "Topic", summary: "s" }, "Body with a [[topic]] link.");

    const summary = await lint(env.dir);
    const staleFindings = summary.results.filter((r) => r.rule === "stale-page");
    expect(staleFindings).toHaveLength(1);
    expect(staleFindings[0].file).toContain("topic.md");
  });
});

describe("checkStalePages — corrupt state is read-only and non-fatal", () => {
  const env = useLintTempRoot("freshness-lint-corrupt");

  it("reports no stale pages and writes no .bak when state.json is corrupt", async () => {
    await writeCorruptTestStateJson(env.dir);
    await mkdir(path.join(env.dir, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(env.dir, "wiki/concepts/topic.md"), "---\ntitle: Topic\n---\n\nBody.\n");

    const snap = await buildFreshnessSnapshot(env.dir);
    const results = await checkStalePages(env.dir, snap);

    expect(results).toEqual([]); // corrupt state => every page unverified, never stale
    expect(existsSync(path.join(env.dir, ".llmwiki/state.json.bak"))).toBe(false);
  });
});
