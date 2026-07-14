/**
 * @file test/superset-proof-e2e-cli.test.ts
 * @description The Slice 7.7 completion-gate CAPSTONE: the six superset-proof
 * bullets (master-design §1340) consolidated into ONE research-profile project
 * driven over the real `dist/cli.js`, so they demonstrably hold TOGETHER, not
 * just in isolation. Each `it` is one bullet:
 *
 *  1. The full research entity + relation VOCABULARY is representable by config
 *     and live-visible — every declared entity/relation type appears in the JSON
 *     export's profile block.
 *  2. The literature → idea → experiment STAGE MODEL runs to completion over the
 *     CLI (the 9-stage `research` pipeline, terminal run status `completed`).
 *  3. ARTIFACTS are hash-pinned and required evidence is a runtime APPROVAL gate:
 *     a healthy pinned artifact APPROVES a `complete` experiment (page live); a
 *     forged integrity-lie manifest is DENIED (non-zero exit, page not on disk).
 *  4. CONNECTOR output is staged as a review candidate (`reviewMode: "connector"`),
 *     never written live.
 *  5. A relation PRECONDITION is a runtime write gate: a manuscript submitting
 *     without its required `cites`→paper relation is REFUSED (non-zero exit, the
 *     page never reaches `submitted`).
 *  6. Agent-facing CONTEXT surfaces live pages, hides unapproved staged content,
 *     and warns that staged work is pending.
 *
 * Reuses the shared research fixture/driver machinery (DRY): it authors NO new
 * production surface. Bullet 4's connector STAGING runs in-process with an
 * offline fetcher (the established `e2e-crossref-offline` pattern) because the
 * CLI `connector run` performs a live network fetch with no offline-injection
 * seam; every other bullet drives the real `dist/cli.js`.
 */

import { vi } from "vitest";
// This suite drives the whole CLI through many subprocess spawns and runs ~25s of
// subprocess work against the 30s default. vitest already caps workers because subprocess
// tests starve each other under load, so on a slower CI runner any test here can breach 30s
// with nothing broken. Raise the timeout for the whole FILE — the fix belongs at file scope,
// not on one victim test at a time. No assertion is weakened.
vi.setConfig({ testTimeout: 90_000 });
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import {
  buildResearchProject,
  installResearchProfile,
  seedResearchRelations,
  RESEARCH_PROFILE,
  RESEARCH_ENTITY_TYPES,
  RESEARCH_RELATION_TYPES,
} from "./fixtures/research-profile.js";
import {
  driveResearchToComplete,
  completeExperimentSubmit,
  driveManuscriptWritingToSubmit,
  expectManuscriptSubmitDenied,
  driveStage,
  expectCompleted,
  RESEARCH_GRANT,
  IDEA_SLUG,
} from "./fixtures/research-workflow.js";
import {
  researchArtifactPreconditionProfile,
  RESEARCH_ARTIFACT_TYPE,
  RESEARCH_ARTIFACT_FILE,
} from "./fixtures/artifact-precondition-profiles.js";
import { stageCompleteExperimentCandidate } from "./fixtures/artifact-seed.js";
import { writeProfileFile } from "./fixtures/profile-fixtures.js";
import { stageEntityPage } from "../src/trust/staging.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { runConnector } from "../src/connectors/run.js";
import { artifactPaths, hashArtifactBody, type ArtifactManifest } from "../src/artifacts/store.js";
import { EXPORT_DIR } from "../src/utils/constants.js";

/** The out-of-band grant the artifact-precondition profile's trusted writes need. */
const ARTIFACT_GRANT = { LLMWIKI_TRUSTED_WRITE: "research-artifact" };
/** The healthy artifact body both artifact writes record (a valid `accuracy` JSON leaf). */
const ARTIFACT_BODY = `{"accuracy":0.9}`;
/** A distinctive token planted ONLY in the unapproved staged candidate's body. */
const STAGED_MARKER = "ZZUNAPPROVEDMARKERZZ";
/** The live paper page the crossref connector would land on once approved. */
const CROSSREF_LIVE_PAGE = "wiki/papers/crossref-10-123-example.md";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "superset-proof-e2e-"));
});

afterEach(async () => {
  delete process.env.LLMWIKI_CONNECTORS;
  if (root) await rm(root, { recursive: true, force: true });
});

/** Run `export --target json` and return the parsed `wiki.json` document. */
async function readExportJson(): Promise<{
  profile: { entityPages: Array<{ entityType: string }>; relations: Array<{ type: string }> };
}> {
  expectCLIExit(await runCLI(["export", "--target", "json"], root), 0);
  return JSON.parse(await readFile(path.join(root, EXPORT_DIR, "wiki.json"), "utf8"));
}

/** Write a healthy artifact via the CLI and return its printed hash-pinned ref. */
async function writeArtifact(slug: string): Promise<string> {
  const w = await runCLI(["artifact", "write", "--type", RESEARCH_ARTIFACT_TYPE, "--slug", slug, "--body", ARTIFACT_BODY], root, ARTIFACT_GRANT);
  expectCLIExit(w, 0);
  return w.stdout.trim().split(/\s+/).pop()!;
}

/** Overwrite an artifact's manifest with an integrity-lie (wrong contentKind). */
async function forgeManifest(slug: string): Promise<void> {
  const { manifestPath } = artifactPaths(root, RESEARCH_ARTIFACT_TYPE, slug, RESEARCH_ARTIFACT_FILE);
  const lying: ArtifactManifest = {
    artifactType: RESEARCH_ARTIFACT_TYPE, slug, sha256: hashArtifactBody(ARTIFACT_BODY),
    bytes: Buffer.byteLength(ARTIFACT_BODY, "utf8"), contentKind: "text", writtenAt: new Date().toISOString(),
  };
  await writeFile(manifestPath, `${JSON.stringify(lying, null, 2)}\n`, "utf8");
}

/** Stage one crossref connector candidate in-process with an offline fetcher. */
async function stageCrossrefOffline(): Promise<void> {
  const dir = path.join(root, ".llmwiki");
  await mkdir(dir, { recursive: true });
  const crossref = { contactEmail: "ops@example.com", allowedHosts: ["api.crossref.org"] };
  await writeFile(path.join(dir, "config.json"), JSON.stringify({ connectors: { crossref } }), "utf8");
  process.env.LLMWIKI_CONNECTORS = "crossref";
  const fixture = await readFile(path.resolve("test/fixtures/crossref-work.json"), "utf8");
  const res = await runConnector(root, "crossref", { doi: "10.123/example" }, {
    fetcher: async () => ({ kind: "ok", finalUrl: "https://api.crossref.org/works/10.123%2Fexample", bytes: Buffer.from(fixture, "utf8"), contentHash: "d".repeat(64) }),
  });
  expect(res.kind).toBe("staged");
}

/**
 * Measured ~14-15s on an idle machine against the 30s default, so this test carries barely
 * 2x headroom. It drives the whole CLI through many subprocess spawns, and vitest already
 * caps workers because subprocess tests starve each other under load — on a slower CI runner
 * that margin disappears and the test times out with nothing actually broken. Give it the
 * headroom its measured cost demands.
 */
const SLOW_CLI_TIMEOUT_MS = 90_000;

describe("superset proof — six bullets over one research project via dist/cli.js", () => {
  it("bullet 1: the full entity + relation vocabulary is representable and live-visible", async () => {
    await buildResearchProject(root);
    await seedResearchRelations(root);
    const doc = await readExportJson();
    const entityTypes = doc.profile.entityPages.map((p) => p.entityType);
    for (const type of RESEARCH_ENTITY_TYPES) {
      expect(entityTypes, `entity type ${type} not represented in export`).toContain(type);
    }
    const relationTypes = doc.profile.relations.map((r) => r.type);
    for (const type of RESEARCH_RELATION_TYPES) {
      expect(relationTypes, `relation type ${type} not represented in export`).toContain(type);
    }
  });

  it("bullet 2: the literature → idea → experiment stage model runs to completion", async () => {
    await installResearchProfile(root);
    const runId = await driveResearchToComplete(root, RESEARCH_GRANT, IDEA_SLUG);
    const done = await driveStage(root, runId, await completeExperimentSubmit(root, runId), RESEARCH_GRANT);
    expectCompleted(done);
    const status = await runCLI(["workflow", "status", runId], root, RESEARCH_GRANT);
    expect(status.stdout).toMatch(/completed/i);
  }, SLOW_CLI_TIMEOUT_MS);

  it("bullet 3: artifacts are hash-pinned and required evidence is a runtime approval gate", async () => {
    await writeProfileFile(root, researchArtifactPreconditionProfile());
    const goodId = await stageCompleteExperimentCandidate(root, "good", await writeArtifact("good"));
    expectCLIExit(await runCLI(["review", "approve", goodId], root, ARTIFACT_GRANT), 0);
    expect(await readFile(path.join(root, "wiki/experiments/good.md"), "utf8")).toMatch(/stage: complete/);

    const badRef = await writeArtifact("bad");
    await forgeManifest("bad");
    const badId = await stageCompleteExperimentCandidate(root, "bad", badRef);
    const denied = await runCLI(["review", "approve", badId], root, ARTIFACT_GRANT);
    expect(denied.code).not.toBe(0);
    await expect(access(path.join(root, "wiki/experiments/bad.md"))).rejects.toThrow();
  });

  it("bullet 4: connector output is staged as a review candidate, never a live page", async () => {
    await buildResearchProject(root);
    await stageCrossrefOffline();
    const connectorCandidate = (await listCandidates(root)).find((c) => c.reviewMode === "connector");
    expect(connectorCandidate, "no connector-staged candidate found").toBeDefined();
    await expect(access(path.join(root, CROSSREF_LIVE_PAGE)), "connector wrote a live page").rejects.toThrow();
  });

  it("bullet 5: a relation precondition is a runtime write gate, not a prompt convention", async () => {
    await buildResearchProject(root);
    const runId = await driveManuscriptWritingToSubmit(root, RESEARCH_GRANT, "no-such-paper");
    await expectManuscriptSubmitDenied(root, runId, RESEARCH_GRANT);
  });

  it("bullet 6: context surfaces live pages, hides unapproved candidates, and warns about staged work", async () => {
    await buildResearchProject(root);
    const body = `---\ntitle: Secret Idea\nrationale: A hidden hypothesis not yet approved.\nstage: proposed\n---\n\n${STAGED_MARKER} unapproved body.\n`;
    await stageEntityPage(root, { entityType: "ideas", slug: "secret-idea", body, profile: RESEARCH_PROFILE, existingStagedCount: 0 });
    const res = await runCLI(["context", "sparse expert routing", "--json"], root);
    expectCLIExit(res, 0);
    const payload = JSON.parse(res.stdout) as { primary: Array<{ id: string }>; warnings: Array<{ code: string }> };
    expect(payload.primary.map((p) => p.id)).toContain("ideas/sparse-routing");
    expect(res.stdout).not.toContain(STAGED_MARKER);
    expect(payload.warnings.map((w) => w.code)).toContain("pending-candidates");
  });
});
