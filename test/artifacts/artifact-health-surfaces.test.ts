/**
 * @file test/artifacts/artifact-health-surfaces.test.ts
 * @description Bytes-verified artifact-ref health, wired into every read
 * surface: a page carrying a ref to a tampered artifact, AND a relation
 * attribute carrying the same ref, must both surface an `error`-severity
 * finding from `checkArtifactRefs`, `collectProfileSummary`, and
 * `buildExportProfileBlock` — never a silent "clean" report.
 */
import { describe, it, expect } from "vitest";
import { writeFile } from "fs/promises";
import { makeTempRoot } from "../fixtures/temp-root.js";
import { writeProfileFile, writeMarkdownPage } from "../fixtures/profile-fixtures.js";
import { seedArtifact } from "../fixtures/artifact-root.js";
import { appendRelation } from "../../src/relations/store.js";
import { artifactPaths } from "../../src/artifacts/store.js";
import { formatArtifactRef } from "../../src/artifacts/ref.js";
import { checkArtifactRefs } from "../../src/profile/artifact-lint.js";
import { collectEntityPages } from "../../src/profile/collect.js";
import { collectProfileSummary, loadNonDefaultProfile } from "../../src/profile/block.js";
import { buildExportProfileBlock } from "../../src/export/profile-block.js";
import type { ProfilePack } from "../../src/profile/types.js";
import type { EntityId } from "../../src/relations/types.js";

/** A profile declaring an artifactRef page field AND an artifactRef relation attribute. */
const PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "artifact-health",
  entities: {
    papers: {
      directory: "wiki/papers",
      fields: { title: { type: "string" }, resultRef: { type: "artifactRef", artifactTypes: ["experiment-result"] } },
    },
    experiments: { directory: "wiki/experiments" },
    ideas: { directory: "wiki/ideas" },
  },
  relations: {
    tests: {
      from: ["experiments"], to: ["ideas"], direction: "directed",
      attributes: { evidenceRef: { type: "artifactRef", artifactTypes: ["experiment-result"] } },
    },
  },
  artifacts: {
    "experiment-result": {
      fileName: "result.json", contentKind: "json", maxBytes: 65536,
      metadata: { accuracy: { type: "number", required: true } },
    },
  },
};

/** Seed a project with a tampered artifact pinned by both a page and a relation. */
async function seedTamperedProject() {
  const root = await makeTempRoot("artifact-health-surfaces");
  await writeProfileFile(root, PROFILE);
  const ref = formatArtifactRef(await seedArtifact(root, "experiment-result", "probe", `{"accuracy":0.9}`));
  await writeMarkdownPage(root, "wiki/papers", "p1", `---\ntitle: Paper\nresultRef: ${ref}\n---\n\nBody.\n`);
  await appendRelation(root, PROFILE, {
    type: "tests", from: "experiments/e1" as EntityId, to: "ideas/i1" as EntityId,
    attributes: { evidenceRef: ref },
  });
  const { bytesPath } = artifactPaths(root, "experiment-result", "probe", "result.json");
  await writeFile(bytesPath, `{"accuracy":0.1}`); // bytes-only tamper — manifest left stale
  return { root };
}

describe("tampered artifact ref health reaches every read surface", () => {
  it("checkArtifactRefs reports an error for the page ref AND the relation ref", async () => {
    const { root } = await seedTamperedProject();
    const { pages } = await collectEntityPages(root, PROFILE);
    const findings = await checkArtifactRefs(root, pages, PROFILE);
    const tampered = findings.filter((f) => f.rule === "artifact-bytes-tampered");
    expect(tampered.length).toBe(2); // one from the page field, one from the relation attribute
    expect(tampered.every((f) => f.severity === "error")).toBe(true);
  });

  it("collectProfileSummary surfaces the tamper as a problem", async () => {
    const { root } = await seedTamperedProject();
    const summary = await collectProfileSummary(root);
    expect(summary?.problems?.some((p) => p.message.includes("artifact-bytes-tampered") || p.kind === "artifact-bytes-tampered")).toBe(true);
  });

  it("buildExportProfileBlock surfaces the tamper as a problem", async () => {
    const { root } = await seedTamperedProject();
    const block = await buildExportProfileBlock(root);
    expect(block?.problems?.some((p) => p.message.includes("artifact-bytes-tampered") || p.kind === "artifact-bytes-tampered")).toBe(true);
  });

  it("a healthy project surfaces no artifact problems (parity control)", async () => {
    const root = await makeTempRoot("artifact-health-clean");
    await writeProfileFile(root, PROFILE);
    const loaded = await loadNonDefaultProfile(root);
    expect(loaded).toBeDefined();
    const summary = await collectProfileSummary(root);
    expect(summary?.problems ?? []).toEqual([]);
  });
});
