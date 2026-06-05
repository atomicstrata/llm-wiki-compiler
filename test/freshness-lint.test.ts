import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { createHash } from "node:crypto";
import { checkStalePages } from "../src/linter/rules.js";
import { buildFreshnessSnapshot } from "../src/freshness/index.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function writeConcept(dir: string, slug: string, frontmatter: Record<string, unknown>, body: string) {
  await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  await writeFile(path.join(dir, "wiki/concepts", `${slug}.md`), `---\n${fm}\n---\n\n${body}\n`);
}

async function writeState(dir: string, sources: Record<string, { hash: string; concepts: string[] }>) {
  await mkdir(path.join(dir, ".llmwiki"), { recursive: true });
  const entries = Object.fromEntries(Object.entries(sources).map(([f, s]) => [f, { ...s, compiledAt: "t" }]));
  await writeFile(path.join(dir, ".llmwiki/state.json"), JSON.stringify({ version: 1, indexHash: "", sources: entries }));
}

describe("checkStalePages", () => {
  const env = useLintTempRoot("freshness-lint");

  it("reports a page whose source changed since compile", async () => {
    await mkdir(path.join(env.dir, "sources"), { recursive: true });
    await writeFile(path.join(env.dir, "sources/a.md"), "NEW body");
    await writeState(env.dir, { "a.md": { hash: sha("OLD body"), concepts: ["topic"] } });
    await writeConcept(env.dir, "topic", { title: "Topic" }, "Body.");

    const snap = await buildFreshnessSnapshot(env.dir);
    const results = await checkStalePages(env.dir, snap);
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("stale-page");
    expect(results[0].severity).toBe("warning");
  });

  it("reports nothing when sources are unchanged", async () => {
    await mkdir(path.join(env.dir, "sources"), { recursive: true });
    await writeFile(path.join(env.dir, "sources/a.md"), "same");
    await writeState(env.dir, { "a.md": { hash: sha("same"), concepts: ["topic"] } });
    await writeConcept(env.dir, "topic", { title: "Topic" }, "Body.");

    const snap = await buildFreshnessSnapshot(env.dir);
    expect(await checkStalePages(env.dir, snap)).toEqual([]);
  });
});
