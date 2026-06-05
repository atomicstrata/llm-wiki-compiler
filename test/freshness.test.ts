import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { createHash } from "node:crypto";
import { computeFreshness } from "../src/freshness/index.js";
import { buildFreshnessSnapshot } from "../src/freshness/index.js";
import type { FreshnessSnapshot } from "../src/freshness/types.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

function snapshot(sources: FreshnessSnapshot["sources"], stateStatus: FreshnessSnapshot["stateStatus"] = "ok"): FreshnessSnapshot {
  return { stateStatus, sources };
}
const concept = (slug: string, frontmatter: Record<string, unknown> = {}) =>
  ({ slug, pageDirectory: "concepts" as const, frontmatter });

describe("computeFreshness — freshnessStatus", () => {
  it("fresh when the owning source exists and its hash matches", () => {
    const snap = snapshot({ "a.md": { recordedHash: "h", currentHash: "h", exists: true, concepts: ["topic"] } });
    expect(computeFreshness(concept("topic"), snap).freshnessStatus).toBe("fresh");
  });

  it("stale when an owning source's hash drifted", () => {
    const snap = snapshot({ "a.md": { recordedHash: "h1", currentHash: "h2", exists: true, concepts: ["topic"] } });
    expect(computeFreshness(concept("topic"), snap).freshnessStatus).toBe("stale");
  });

  it("orphaned when ALL owning sources are deleted", () => {
    const snap = snapshot({ "a.md": { recordedHash: "h", currentHash: null, exists: false, concepts: ["topic"] } });
    expect(computeFreshness(concept("topic"), snap).freshnessStatus).toBe("orphaned");
  });

  it("STALE (not orphaned) when one owner is deleted but another is live [key regression]", () => {
    const snap = snapshot({
      "a.md": { recordedHash: "h", currentHash: null, exists: false, concepts: ["merged"] },
      "b.md": { recordedHash: "h", currentHash: "h", exists: true, concepts: ["merged"] },
    });
    expect(computeFreshness(concept("merged"), snap).freshnessStatus).toBe("stale");
  });

  it("unverified when the page has no owner in state", () => {
    const snap = snapshot({ "a.md": { recordedHash: "h", currentHash: "h", exists: true, concepts: ["other"] } });
    expect(computeFreshness(concept("handwritten"), snap).freshnessStatus).toBe("unverified");
  });

  it("unverified for any page when state is missing or corrupt", () => {
    expect(computeFreshness(concept("topic"), snapshot({}, "missing")).freshnessStatus).toBe("unverified");
    expect(computeFreshness(concept("topic"), snapshot({}, "corrupt")).freshnessStatus).toBe("unverified");
  });

  it("unverified for query pages, never orphaned or fresh", () => {
    const snap = snapshot({ "a.md": { recordedHash: "h", currentHash: "h", exists: true, concepts: ["q"] } });
    const queryPage = { slug: "q", pageDirectory: "queries" as const, frontmatter: {} };
    expect(computeFreshness(queryPage, snap).freshnessStatus).toBe("unverified");
  });

  it("orphaned via legacy frontmatter flag", () => {
    const snap = snapshot({ "a.md": { recordedHash: "h", currentHash: "h", exists: true, concepts: ["topic"] } });
    expect(computeFreshness(concept("topic", { orphaned: true }), snap).freshnessStatus).toBe("orphaned");
  });
});

describe("computeFreshness — contradicted/archived", () => {
  it("derives contradicted from contradictedBy and archived from frontmatter", () => {
    const snap = snapshot({ "a.md": { recordedHash: "h", currentHash: "h", exists: true, concepts: ["topic"] } });
    const page = concept("topic", { contradictedBy: [{ slug: "other" }], archived: true });
    const result = computeFreshness(page, snap);
    expect(result.contradicted).toBe(true);
    expect(result.archived).toBe(true);
  });

  it("defaults contradicted/archived to false", () => {
    const snap = snapshot({ "a.md": { recordedHash: "h", currentHash: "h", exists: true, concepts: ["topic"] } });
    const result = computeFreshness(concept("topic"), snap);
    expect(result.contradicted).toBe(false);
    expect(result.archived).toBe(false);
  });
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("buildFreshnessSnapshot", () => {
  const env = useLintTempRoot("freshness-snap");

  it("captures stateStatus and per-source recorded/current hash + existence", async () => {
    await mkdir(path.join(env.dir, "sources"), { recursive: true });
    await writeFile(path.join(env.dir, "sources/a.md"), "current body");
    await mkdir(path.join(env.dir, ".llmwiki"), { recursive: true });
    await writeFile(
      path.join(env.dir, ".llmwiki/state.json"),
      JSON.stringify({ version: 1, indexHash: "", sources: {
        "a.md": { hash: "OLD", concepts: ["topic"], compiledAt: "t" },
        "gone.md": { hash: "X", concepts: ["ghost"], compiledAt: "t" },
      } }),
    );
    const snap = await buildFreshnessSnapshot(env.dir);
    expect(snap.stateStatus).toBe("ok");
    expect(snap.sources["a.md"]).toEqual({ recordedHash: "OLD", currentHash: sha("current body"), exists: true, concepts: ["topic"] });
    expect(snap.sources["gone.md"]).toEqual({ recordedHash: "X", currentHash: null, exists: false, concepts: ["ghost"] });
  });

  it("returns empty sources when state is missing", async () => {
    const snap = await buildFreshnessSnapshot(env.dir);
    expect(snap.stateStatus).toBe("missing");
    expect(snap.sources).toEqual({});
  });
});
