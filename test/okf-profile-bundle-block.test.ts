/**
 * @file Integration tests for the bundle-level `x-llmwiki` metadata block on the
 * OKF `index.md` (CLP 7.6 Task 2).
 *
 * A NON-DEFAULT profile project exports `index.md` frontmatter carrying
 * `x-llmwiki: { profile, relations, workflows }`: the profile identity/digest/
 * producer (D-7.6.2), one entry per live valid relation, and a BOUNDED per-run
 * workflow summary (D-7.6.7 — no events/inputs/outputs/integrity). Two dissimilar
 * profiles (research, newsroom) drive the SAME code (genericity), a default-profile
 * project stays byte-identical to `okf_version: "0.1"` only (D-7.6.10), and two
 * exports of one project are byte-identical (determinism).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { buildOkfBundle } from "../src/export/okf/bundle.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { loadNonDefaultProfile } from "../src/profile/block.js";
import { startWorkflow } from "../src/workflows/start.js";
import { buildResearchProject, seedResearchRelations } from "./fixtures/research-profile.js";
import { buildNewsroomProject, seedNewsroomRelations } from "./fixtures/newsroom-profile.js";
import { exportDefaultBundleIndex } from "./fixtures/default-export-page.js";
import pkg from "../package.json";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "okf-bundle-block-")); });

/** Export the project (no native concept/query pages) and return the x-llmwiki block. */
async function exportBlock(from: string): Promise<Record<string, unknown>> {
  const out = path.join(from, "bundle");
  await buildOkfBundle(from, [], out);
  const { meta } = parseFrontmatter(await readFile(path.join(out, "index.md"), "utf-8"));
  return meta["x-llmwiki"] as Record<string, unknown>;
}

describe("OKF bundle-level x-llmwiki block", () => {
  it("carries profile identity, digest, producer, relations, and workflows for research", async () => {
    await buildResearchProject(root);
    await seedResearchRelations(root);
    await startWorkflow(root, "research", {});
    const loaded = await loadNonDefaultProfile(root);
    const profile = (await exportBlock(root)).profile as Record<string, unknown>;
    expect(profile.profileId).toBe("research");
    expect(profile.profileVersion).toBe("0.1.0");
    expect(profile.profileSchemaVersion).toBe(1);
    expect(profile.profileContentHash).toBe(loaded!.digest);
    expect(profile.producer).toEqual({ name: "llmwiki", version: pkg.version });
  });

  it("sorts the profile schema-id lists (entity/relation/artifact types)", async () => {
    await buildResearchProject(root);
    const profile = (await exportBlock(root)).profile as Record<string, string[]>;
    for (const key of ["entityTypes", "relationTypes", "artifactTypes"] as const) {
      expect(profile[key]).toEqual([...profile[key]].sort());
    }
    expect(profile.entityTypes).toContain("papers");
    expect(profile.relationTypes).toContain("cites");
    expect(profile.artifactTypes).toContain("experiment-result");
  });

  it("emits one sorted relation entry per live valid relation", async () => {
    await buildResearchProject(root);
    await seedResearchRelations(root);
    const relations = (await exportBlock(root)).relations as Array<Record<string, unknown>>;
    expect(relations.length).toBeGreaterThan(0);
    expect(relations.map((r) => r.id)).toEqual([...relations.map((r) => r.id)].sort());
    for (const rel of relations) {
      expect(typeof rel.id).toBe("string");
      expect(Object.keys(rel).sort()).toEqual(["contentHash", "from", "id", "to", "type"]);
    }
  });

  it("emits a bounded workflow summary with no events/inputs/outputs/integrity", async () => {
    await buildResearchProject(root);
    const run = await startWorkflow(root, "research", { seed: "x" });
    const workflows = (await exportBlock(root)).workflows as Array<Record<string, unknown>>;
    expect(workflows).toHaveLength(1);
    const entry = workflows[0];
    expect(entry.runId).toBe(run.runId);
    expect(entry.workflowId).toBe("research");
    expect(Object.keys(entry).sort()).toEqual(
      ["currentStage", "profileDigest", "runId", "satisfiedGates", "stages", "status", "workflowDigest", "workflowId"],
    );
    expect(entry.stages).toEqual(run.stageLog.map((s) => ({ id: s.stageId, status: s.status })));
    for (const forbidden of ["events", "inputs", "outputs", "integrity"]) {
      expect(entry[forbidden]).toBeUndefined();
    }
  });

  it("produces its own block for the dissimilar newsroom profile (genericity)", async () => {
    await buildNewsroomProject(root);
    await seedNewsroomRelations(root);
    await startWorkflow(root, "story-pipeline", {});
    const block = await exportBlock(root);
    const profile = block.profile as Record<string, unknown>;
    expect(profile.profileId).toBe("newsroom");
    expect(profile.relationTypes).toEqual(["filed-under"]);
    expect(profile.entityTypes).toEqual(["articles", "bylines", "desks"]);
    const workflows = block.workflows as Array<Record<string, unknown>>;
    expect(workflows[0].workflowId).toBe("story-pipeline");
  });

  it("keeps a default-profile index.md frontmatter byte-identical to okf_version only", async () => {
    const { index } = await exportDefaultBundleIndex(root);
    expect(index).toMatch(/^---\nokf_version: "0\.1"\n---\n/);
    expect(index).not.toContain("x-llmwiki");
  });

  it("produces byte-identical index.md across two exports of one project (determinism)", async () => {
    await buildResearchProject(root);
    await seedResearchRelations(root);
    await startWorkflow(root, "research", {});
    await buildOkfBundle(root, [], path.join(root, "a"));
    await buildOkfBundle(root, [], path.join(root, "b"));
    const [a, b] = await Promise.all([
      readFile(path.join(root, "a", "index.md"), "utf-8"),
      readFile(path.join(root, "b", "index.md"), "utf-8"),
    ]);
    expect(a).toBe(b);
    expect(a).toContain("x-llmwiki");
  });
});
