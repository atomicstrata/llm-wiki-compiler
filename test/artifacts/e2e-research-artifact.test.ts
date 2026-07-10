/**
 * @file test/artifacts/e2e-research-artifact.test.ts
 * @description End-to-end subprocess proof of the artifact write/verify/lint
 * surface over the REAL research profile fixture (`test/fixtures/research-profile.ts`),
 * driven entirely through `dist/cli.js`. One shared research-profile temp root
 * carries the whole proof, in sequence:
 *
 *   (a) `artifact write` refuses without the `LLMWIKI_TRUSTED_WRITE` grant, and
 *       writes nothing;
 *   (b) it applies live with the grant and prints the compact ref;
 *   (c) an `experiments` page pins that ref in its (optional) `result` field and
 *       `lint` is clean;
 *   (d) after an out-of-band, same-length bytes-only edit (manifest left stale),
 *       `lint` reports `artifact-bytes-tampered` and exits 1;
 *   (e) a page pinning a ref to a NEVER-written artifact makes `lint` report
 *       `artifact-dangling`;
 *   (f) a page pinning a ref to an artifact whose bytes+manifest are
 *       consistently out-of-band authored with a non-numeric `accuracy` makes
 *       `lint` report `artifact-schema-invalid` (the live write path itself
 *       enforces the metadata schema, so this health can only be reached by an
 *       out-of-band author — never through `artifact write`);
 *   (g) `--body-file` pointed at a FIFO fails closed (no hang);
 *   (h) `artifact verify` prints the health verdict WITHOUT ever leaking the body.
 *
 * Cases (d)/(e)/(f) each add ONE additional unhealthy page to the shared root
 * and assert only that ITS health kind appears in that `lint` run's output —
 * they do not assert the ABSENCE of earlier findings, since the root
 * accumulates state deliberately (proving each health kind is independently
 * surfaced, not that they're mutually exclusive).
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { writeFile, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { runCLI, expectCLIExit, expectCLIFailure } from "../fixtures/run-cli.js";
import { makeTempRoot } from "../fixtures/temp-root.js";
import { makeFifo } from "../fixtures/fifo.js";
import { writeMarkdownPage } from "../fixtures/profile-fixtures.js";
import { installResearchProfile } from "../fixtures/research-profile.js";
import { artifactPaths, hashArtifactBody, writeArtifactFiles } from "../../src/artifacts/store.js";
import type { ArtifactManifest } from "../../src/artifacts/store.js";

/** The operator grant, scoped to the fixture's `profileId: "research"`. */
const GRANT = { LLMWIKI_TRUSTED_WRITE: "research" };

/** The valid probe body pinned by the clean-then-tampered page (cases b–d). */
const VALID_BODY = `{"accuracy":0.9}`;
/** Same byte length as {@link VALID_BODY} — an out-of-band bytes-only tamper (case d). */
const TAMPERED_BODY = `{"accuracy":0.1}`;
const PROBE_SLUG = "probe";
const WRITE_ARGS = ["artifact", "write", "--type", "experiment-result", "--slug", PROBE_SLUG];

let root = "";

beforeAll(async () => {
  root = await makeTempRoot("e2e-research-artifact");
  await installResearchProfile(root);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** Author a minimal, contract-satisfying `experiments` page pinning `resultRef` in its `result` field. */
async function writeExperimentPage(slug: string, resultRef: string): Promise<void> {
  const frontmatter = `title: ${slug}\nhypothesis: Proof hypothesis for ${slug}.\nstage: designed\nresult: ${resultRef}`;
  const body = `This experiment page pins an artifact ref for the end-to-end proof (${slug}).`;
  await writeMarkdownPage(root, "wiki/experiments", slug, `---\n${frontmatter}\n---\n\n${body}\n`);
}

/** Directly author a consistent manifest+body pair via `writeArtifactFiles` (bypassing the trust-checked write path, so an out-of-band-only state — schema-invalid, oversize — can be constructed at all) and return its ref. */
async function seedOutOfBandArtifact(slug: string, body: string): Promise<string> {
  const sha256 = hashArtifactBody(body);
  const paths = artifactPaths(root, "experiment-result", slug, "result.json");
  const manifest: ArtifactManifest = {
    artifactType: "experiment-result", slug, sha256,
    bytes: Buffer.byteLength(body, "utf8"), contentKind: "json", writtenAt: new Date().toISOString(),
  };
  await writeArtifactFiles(root, paths, body, manifest);
  return `experiment-result/${slug}@sha256:${sha256}`;
}

describe("artifact write refuses/applies against the research profile (a, b)", () => {
  it("(a) refuses without the grant, advising LLMWIKI_TRUSTED_WRITE, and writes nothing", async () => {
    const result = await runCLI([...WRITE_ARGS, "--body", VALID_BODY], root);
    expectCLIFailure(result);
    expect(result.stderr).toMatch(/LLMWIKI_TRUSTED_WRITE/);

    // The refusal must leave no artifact on disk — neither the bytes nor the manifest.
    const { bytesPath, manifestPath } = artifactPaths(root, "experiment-result", PROBE_SLUG, "result.json");
    await expect(stat(bytesPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("(b) applies live with the grant and prints the compact ref", async () => {
    const result = await runCLI([...WRITE_ARGS, "--body", VALID_BODY], root, GRANT);
    expectCLIExit(result, 0);
    expect(result.stdout.trim()).toBe(`experiment-result/${PROBE_SLUG}@sha256:${hashArtifactBody(VALID_BODY)}`);
  });
});

describe("a pinning page stays clean until tampered (c, d)", () => {
  it("(c) a page pinning the ref keeps lint clean", async () => {
    const ref = `experiment-result/${PROBE_SLUG}@sha256:${hashArtifactBody(VALID_BODY)}`;
    await writeExperimentPage("probe-experiment", ref);
    const result = await runCLI(["lint"], root);
    expectCLIExit(result, 0);
    expect(result.stdout).not.toMatch(/artifact-/);
  });

  it("(d) an out-of-band bytes edit surfaces artifact-bytes-tampered (exit 1)", async () => {
    const { bytesPath } = artifactPaths(root, "experiment-result", PROBE_SLUG, "result.json");
    await writeFile(bytesPath, TAMPERED_BODY, "utf8"); // manifest left stale on purpose
    const result = await runCLI(["lint"], root);
    expectCLIFailure(result);
    expect(result.stdout).toMatch(/artifact-bytes-tampered/);
  });

});

describe("dangling and schema-invalid refs (e, f)", () => {
  it("(e) a ref to a never-written artifact surfaces artifact-dangling", async () => {
    const danglingRef = `experiment-result/missing-probe@sha256:${"0".repeat(64)}`;
    await writeExperimentPage("dangling-experiment", danglingRef);
    const result = await runCLI(["lint"], root);
    expectCLIFailure(result);
    expect(result.stdout).toMatch(/artifact-dangling/);
  });

  it("(f) an out-of-band non-numeric accuracy surfaces artifact-schema-invalid", async () => {
    const ref = await seedOutOfBandArtifact("schema-check", `{"accuracy":"not-a-number"}`);
    await writeExperimentPage("schema-invalid-experiment", ref);
    const result = await runCLI(["lint"], root);
    expectCLIFailure(result);
    expect(result.stdout).toMatch(/artifact-schema-invalid/);
  });
});

describe("an oversize body diverging from its manifest (i)", () => {
  it("(i) growing the on-disk body past maxBytes surfaces artifact-bytes-tampered, distinct from the same-size tamper case (d)", async () => {
    const slug = "oversize-check";
    const ref = await seedOutOfBandArtifact(slug, `{"accuracy":0.5}`);
    const { bytesPath } = artifactPaths(root, "experiment-result", slug, "result.json");
    await writeFile(bytesPath, "x".repeat(70_000), "utf8"); // out-of-band growth past the profile's declared maxBytes (65536)
    await writeExperimentPage("oversize-experiment", ref);
    const result = await runCLI(["lint"], root);
    expectCLIFailure(result);
    expect(result.stdout).toMatch(/artifact-bytes-tampered/);
  });
});

describe("write/verify edge surfaces (g, h)", () => {
  it("(g) --body-file at a FIFO fails closed (no hang)", async () => {
    const fifoPath = path.join(root, "body.fifo");
    await makeFifo(fifoPath);
    try {
      const args = ["artifact", "write", "--type", "experiment-result", "--slug", "fifo-probe", "--body-file", fifoPath];
      const result = await runCLI(args, root, GRANT);
      expectCLIFailure(result);
      // Fails closed specifically because the target isn't a regular file — not
      // some unrelated error (e.g. a bad flag or a validation failure).
      expect(result.stderr).toMatch(/not a regular file, a symlink, or larger than/);
    } finally {
      await unlink(fifoPath); // explicit cleanup — don't rely solely on the afterAll root rm
    }
  });

  it("(h) artifact verify prints the health verdict without ever printing the body", async () => {
    const slug = "verify-probe";
    const body = `{"accuracy":0.42}`;
    const sha256 = hashArtifactBody(body);
    const write = await runCLI(["artifact", "write", "--type", "experiment-result", "--slug", slug, "--body", body], root, GRANT);
    expectCLIExit(write, 0);
    const result = await runCLI(["artifact", "verify", "--type", "experiment-result", "--slug", slug, "--sha256", sha256], root);
    expectCLIExit(result, 0);
    expect(result.stdout).toMatch(/health:\s*ok/);
    expect(result.stdout).not.toContain("accuracy");
    expect(result.stdout).not.toContain(body);
  });
});
