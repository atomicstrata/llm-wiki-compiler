/**
 * @file Import-side tests for the bundle-level `x-llmwiki` metadata block (CLP
 * 7.6 Task 3): the untrusted-input parser {@link parseBundleBlock}, the import
 * report's profile-mismatch/relations/workflows sections, and — the core
 * deliverable — INERTNESS (Invariant 7, D-7.6.8): a foreign bundle can never
 * modify `.llmwiki/profile.json` or `.llmwiki/config.json`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { buildOkfBundle } from "../src/export/okf/bundle.js";
import { runOkfImport } from "../src/import/run.js";
import { parseBundleBlock, buildBundleSections, type ParsedBundleBlock } from "../src/import/bundle-block-read.js";
import { DEFAULT_OKF_LIMITS } from "../src/import/okf-limits.js";
import { parseFrontmatter, buildFrontmatter } from "../src/utils/markdown.js";
import { buildResearchProject, seedResearchRelations } from "./fixtures/research-profile.js";
import { startWorkflow } from "../src/workflows/start.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "okf-bb-import-")); });

/** A minimal well-formed profile sub-block for direct parser tests. */
function validProfile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profileId: "research", profileSchemaVersion: 1, profileContentHash: "abc",
    entityTypes: ["papers"], relationTypes: ["cites"], artifactTypes: [],
    producer: { name: "llmwiki", version: "1.0.0" }, ...over,
  };
}

/** Assemble a full x-llmwiki block ({ profile, relations, workflows }). */
function xblock(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { profile: validProfile(), relations: [], workflows: [], ...over };
}

/** Wrap an x-llmwiki value in a frontmatter record, as index.md parses to. */
const fm = (x: unknown): Record<string, unknown> => ({ okf_version: "0.1", "x-llmwiki": x });

/** Write a bundle whose index.md carries a crafted (possibly hostile) x-llmwiki block. */
async function writeBundle(x: unknown): Promise<string> {
  const dir = path.join(root, "kb");
  await mkdir(path.join(dir, "concepts"), { recursive: true });
  await writeFile(path.join(dir, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
  await writeFile(path.join(dir, "index.md"), `${buildFrontmatter({ okf_version: "0.1", "x-llmwiki": x })}\n# B\n`);
  return dir;
}

describe("parseBundleBlock (untrusted-input parser)", () => {
  it("round-trips a real exported research bundle", async () => {
    await buildResearchProject(root);
    await seedResearchRelations(root);
    await startWorkflow(root, "research", {});
    const out = path.join(root, "bundle");
    await buildOkfBundle(root, [], out);
    const { meta } = parseFrontmatter(await readFile(path.join(out, "index.md"), "utf-8"));
    const { block, warnings } = parseBundleBlock(meta, DEFAULT_OKF_LIMITS);
    expect(warnings).toEqual([]);
    expect(block!.profile!.profileId).toBe("research");
    expect(block!.relations.length).toBeGreaterThan(0);
    expect(block!.workflows).toHaveLength(1);
  });

  it("returns no block when x-llmwiki is absent", () => {
    const { block, warnings } = parseBundleBlock({ okf_version: "0.1" }, DEFAULT_OKF_LIMITS);
    expect(block).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("drops a malformed relation entry with a warning", () => {
    const relations = [
      { id: "r1", type: "cites", from: "a", to: "b", contentHash: "h" },
      { id: 42, type: "cites", from: "a", to: "b", contentHash: "h" },
    ];
    const { block, warnings } = parseBundleBlock(fm(xblock({ relations })), DEFAULT_OKF_LIMITS);
    expect(block!.relations).toHaveLength(1);
    expect(block!.relations[0].id).toBe("r1");
    expect(warnings.some((w) => /relation/i.test(w))).toBe(true);
  });

  it("filters non-string schema-id list elements with a warning", () => {
    const x = xblock({ profile: validProfile({ entityTypes: ["papers", 5, "ideas"] }) });
    const { block, warnings } = parseBundleBlock(fm(x), DEFAULT_OKF_LIMITS);
    expect(block!.profile!.entityTypes).toEqual(["papers", "ideas"]);
    expect(warnings.some((w) => /entityTypes/i.test(w))).toBe(true);
  });

  it("drops the profile sub-block when its identity is malformed", () => {
    const x = xblock({ profile: validProfile({ profileId: 123 }) });
    const { block, warnings } = parseBundleBlock(fm(x), DEFAULT_OKF_LIMITS);
    expect(block!.profile).toBeUndefined();
    expect(warnings.some((w) => /profile/i.test(w))).toBe(true);
  });

  it("refuses the whole block when the serialized value exceeds the byte cap", () => {
    const x = xblock({ profile: validProfile({ profileContentHash: "z".repeat(500) }) });
    const limits = { ...DEFAULT_OKF_LIMITS, maxIndexBlockBytes: 50 };
    const { block, warnings } = parseBundleBlock(fm(x), limits);
    expect(block).toBeUndefined();
    expect(warnings.some((w) => /size|cap|byte/i.test(w))).toBe(true);
  });

  it("refuses (not truncates) an over-cap relations list, keeping the profile", () => {
    const relations = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, type: "cites", from: "a", to: "b", contentHash: "h" }));
    const limits = { ...DEFAULT_OKF_LIMITS, maxRelations: 2 };
    const { block, warnings } = parseBundleBlock(fm(xblock({ relations })), limits);
    expect(block!.profile!.profileId).toBe("research");
    expect(block!.relations).toEqual([]);
    expect(warnings.some((w) => /relation/i.test(w))).toBe(true);
  });

  it("refuses an over-cap workflow list, keeping the profile", () => {
    const workflows = Array.from({ length: 3 }, (_, i) => ({
      runId: `w${i}`, workflowId: "research", status: "active", currentStage: null,
      satisfiedGates: [], stages: [], workflowDigest: "d", profileDigest: "p",
    }));
    const limits = { ...DEFAULT_OKF_LIMITS, maxWorkflowRuns: 2 };
    const { block, warnings } = parseBundleBlock(fm(xblock({ workflows })), limits);
    expect(block!.workflows).toEqual([]);
    expect(warnings.some((w) => /workflow/i.test(w))).toBe(true);
  });
});

describe("buildBundleSections (mismatch summary)", () => {
  it("reports differing id/hash and foreign types against the local profile", async () => {
    await buildResearchProject(root);
    const block: ParsedBundleBlock = {
      profile: { profileId: "newsroom", profileSchemaVersion: 1, profileContentHash: "different",
        entityTypes: ["articles"], relationTypes: ["filed-under"], artifactTypes: [],
        producer: { name: "llmwiki", version: "1.0.0" } },
      relations: [], workflows: [],
    };
    const { bundleProfile } = await buildBundleSections(root, block);
    const m = bundleProfile!.mismatch;
    expect(m.differingProfileId).toEqual({ bundle: "newsroom", local: "research" });
    expect(m.differingProfileContentHash!.bundle).toBe("different");
    expect(m.entityTypesNotDeclaredLocally).toContain("articles");
    expect(m.relationTypesNotDeclaredLocally).toContain("filed-under");
    expect(m.note).toMatch(/active local profile|no migration/i);
  });
});

describe("bundle-block import inertness (Invariant 7, D-7.6.8)", () => {
  it("never mutates .llmwiki/profile.json or config.json for a hostile bundle", async () => {
    await buildResearchProject(root);
    const configPath = path.join(root, ".llmwiki/config.json");
    await writeFile(configPath, `${JSON.stringify({ localGrants: {} }, null, 2)}\n`);
    const profilePath = path.join(root, ".llmwiki/profile.json");
    const before = { p: await readFile(profilePath), c: await readFile(configPath) };
    const hostile = {
      profile: { profileId: "../../.llmwiki/config", profileSchemaVersion: 1, profileContentHash: "x",
        entityTypes: ["../../etc/passwd"], relationTypes: [], artifactTypes: [],
        producer: { name: "z".repeat(10), version: "9" } },
      config: { localGrants: { anything: "trusted" } },
      profileJson: { profileId: "pwned" },
      relations: [{ id: "r", type: "cites", from: "a", to: "b", contentHash: "h" }],
    };
    const b = await writeBundle(hostile);
    const report = await runOkfImport(root, b, {});
    expect(report.bundleProfile!.mismatch.differingProfileId!.bundle).toBe("../../.llmwiki/config");
    expect((await readFile(profilePath)).equals(before.p)).toBe(true);
    expect((await readFile(configPath)).equals(before.c)).toBe(true);
    const runs = await readdir(path.join(root, ".llmwiki/workflows/runs")).catch(() => []);
    expect(runs).toEqual([]);
  });

  it("surfaces a no-active-profile mismatch on a default project and still imports pages", async () => {
    const b = await writeBundle(xblock());
    const report = await runOkfImport(root, b, {});
    expect(report.bundleProfile!.mismatch.noActiveProfile).toBe(true);
    expect(report.bundleProfile!.mismatch.note).toMatch(/no active profile/i);
    expect(report.pages).toEqual([{ slug: "a", okfPath: "concepts/a.md", targetDirectory: "concepts" }]);
  });
});
