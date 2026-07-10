/**
 * @file test/research-content-tiers-cli.test.ts
 * @description Criterion #8 (progressive disclosure) proven at the REAL CLI level:
 * `llmwiki context <prompt> --json` reveals a research `sources` record's declared
 * content tiers shallowest-first. The research profile's `sources` entity declares
 * `contentTiers: ["title", "body"]`, so a ranked source primary must carry a
 * `contentTiers` array whose `title` tier precedes its `body` tier, each tier's
 * `content` projecting the seeded frontmatter title / page body respectively.
 *
 * This exercises the shallow-before-deep reveal through the full subprocess
 * serialization (spawn `node dist/cli.js`, parse stdout JSON) rather than the
 * in-process `buildContextPack` path, so the wire shape is what an agent sees. A
 * second case proves default-profile parity: a DEFAULT project's primaries emit
 * NO `contentTiers` key at all, so the feature is additive and opt-in.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { installResearchProfile } from "./fixtures/research-profile.js";

const PROMPT = "Photonic";
const TITLE = "Photonic Interconnect Whitepaper";
const BODY = "Photonic interconnects route signals as light to cut datacenter latency.";

/** Parse the pack JSON emitted by `llmwiki context <PROMPT> --json` in `cwd`. */
async function contextPack(cwd: string): Promise<{ primary: Array<Record<string, unknown>> }> {
  const result = await runCLI(["context", PROMPT, "--json"], cwd);
  expectCLIExit(result, 0);
  return JSON.parse(result.stdout);
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "research-tiers-cli-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("research contentTiers over the real CLI", () => {
  it("reveals a source primary's title tier before its body tier", async () => {
    await installResearchProfile(root);
    await mkdir(path.join(root, "wiki/sources"), { recursive: true });
    const fm = `title: ${TITLE}\nkind: web\nstage: imported`;
    await writeFile(path.join(root, "wiki/sources/photonic-interconnect.md"), `---\n${fm}\n---\n\n${BODY}\n`, "utf8");
    const pack = await contextPack(root);
    const source = pack.primary.find((p) => p.id === "sources/photonic-interconnect");
    expect(source, `source not ranked as a primary; ids: ${pack.primary.map((p) => p.id).join(", ")}`).toBeDefined();
    const tiers = (source?.contentTiers ?? []) as Array<{ tier: string; content: string }>;
    const names = tiers.map((t) => t.tier);
    expect(names.indexOf("title")).toBeLessThan(names.indexOf("body"));
    expect(tiers.find((t) => t.tier === "title")?.content).toBe(TITLE);
    expect(tiers.find((t) => t.tier === "body")?.content).toContain(BODY);
  });

  it("emits NO contentTiers key for a DEFAULT project's primaries", async () => {
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(root, "wiki/concepts/photonic.md"), `# ${TITLE}\n\n${BODY}\n`, "utf8");
    const pack = await contextPack(root);
    expect(pack.primary.length).toBeGreaterThan(0);
    for (const entry of pack.primary) expect(entry.contentTiers).toBeUndefined();
  });
});
