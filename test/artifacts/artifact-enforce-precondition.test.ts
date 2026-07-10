/**
 * @file test/artifacts/artifact-enforce-precondition.test.ts
 * @description Unit proof of the write-time artifact precondition enforcer's
 * deny/park classification against the REAL artifact store. A required-artifact
 * state DENIES (ArtifactPreconditionUnmetError) on a missing/dangling/tampered ref
 * or a manifest INTEGRITY-LIE (identity/contentKind/byte-count), and PARKS
 * (ArtifactPreconditionUnverifiableError) only on a GENUINE store fault (malformed
 * manifest). A healthy pinned ref passes. Non-gated / no-requirement states early-out.
 */
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  enforceArtifactPreconditions,
  classifyArtifactHealth,
  ArtifactPreconditionUnmetError,
  ArtifactPreconditionUnverifiableError,
} from "../../src/artifacts/enforce-precondition.js";
import { artifactPaths, hashArtifactBody, writeArtifactFiles, type ArtifactManifest } from "../../src/artifacts/store.js";
import {
  researchArtifactPreconditionProfile, multiTypeArtifactPreconditionProfile,
  RESEARCH_ARTIFACT_TYPE, RESEARCH_ARTIFACT_FILE, OTHER_ARTIFACT_TYPE, OTHER_ARTIFACT_FILE,
} from "../fixtures/artifact-precondition-profiles.js";
import { formatArtifactRef } from "../../src/artifacts/ref.js";
import { resolveArtifactRef } from "../../src/artifacts/resolve.js";

const BODY = `{"accuracy":0.9}`;
const SLUG = "probe";

/** The honest manifest for the seeded probe artifact; tests override ONE field to forge a specific lie. */
function honestManifest(): ArtifactManifest {
  return { artifactType: RESEARCH_ARTIFACT_TYPE, slug: SLUG, sha256: hashArtifactBody(BODY), bytes: Buffer.byteLength(BODY, "utf8"), contentKind: "json", writtenAt: new Date().toISOString() };
}

async function seedArtifact(root: string): Promise<string> {
  await writeArtifactFiles(root, artifactPaths(root, RESEARCH_ARTIFACT_TYPE, SLUG, RESEARCH_ARTIFACT_FILE), BODY, honestManifest());
  return formatArtifactRef({ artifactType: RESEARCH_ARTIFACT_TYPE, slug: SLUG, sha256: hashArtifactBody(BODY) });
}

/** Overwrite the seeded artifact's manifest with the honest manifest plus `overrides` (the forged field). */
async function overwriteManifest(root: string, overrides: Partial<ArtifactManifest>): Promise<void> {
  const { manifestPath } = artifactPaths(root, RESEARCH_ARTIFACT_TYPE, SLUG, RESEARCH_ARTIFACT_FILE);
  await writeFile(manifestPath, `${JSON.stringify({ ...honestManifest(), ...overrides }, null, 2)}\n`, "utf8");
}

function run(root: string, ref: unknown) {
  const profile = researchArtifactPreconditionProfile();
  return enforceArtifactPreconditions({
    root, profile, entityType: "experiments", slug: "exp",
    enteredState: "complete", lifecycle: profile.entities.experiments.lifecycle!,
    meta: { result: ref },
  });
}

describe("enforceArtifactPreconditions deny/park classification", () => {
  let root = "";
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "enforce-artifact-")); });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("passes a healthy pinned ref", async () => {
    const ref = await seedArtifact(root);
    await expect(run(root, ref)).resolves.toBeUndefined();
  });

  it("DENIES a missing ref (required artifact absent)", async () => {
    await expect(run(root, undefined)).rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
  });

  it("DENIES a dangling ref (parses but the artifact was never written)", async () => {
    // Build a STRUCTURALLY VALID ref (type/slug@sha256:<64hex>, per src/artifacts/ref.ts)
    // so parseArtifactRef succeeds and resolveArtifactRef reaches the real
    // artifact-dangling→DENY leg — NOT the unparseable-ref→DENY leg the missing-ref
    // test above already covers. A bare `type:slug@<hex>` would fail to parse and
    // wrongly exercise the same branch.
    const ref = formatArtifactRef({ artifactType: RESEARCH_ARTIFACT_TYPE, slug: "never", sha256: hashArtifactBody("x") });
    await expect(run(root, ref)).rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
  });

  it("DENIES a forged manifest (contentKind integrity-lie) — does NOT park", async () => {
    // Manifest claims `text` where the type declares `json` — a kind lie the
    // manifest-only integrity check (resolve.ts:110) denies before verifyOkBody.
    const ref = await seedArtifact(root);
    await overwriteManifest(root, { contentKind: "text" });
    await expect(run(root, ref)).rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
  });

  it("DENIES a forged manifest (byte-count integrity-lie, resolve.ts:73) — does NOT park", async () => {
    // Same body on disk, but the manifest LIES about its length. verifyOkBody's
    // m.bytes-vs-actual check trips the integrity-lie storeFault (deny), not a park.
    const ref = await seedArtifact(root);
    await overwriteManifest(root, { bytes: 9999 });
    await expect(run(root, ref)).rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
  });

  it("DENIES a forged manifest (identity integrity-lie, resolve.ts:109) — does NOT park", async () => {
    // Manifest at the real path claims a DIFFERENT slug than the ref pins — an
    // identity lie the manifest-only integrity check denies before verifyOkBody.
    const ref = await seedArtifact(root);
    await overwriteManifest(root, { slug: "imposter" });
    await expect(run(root, ref)).rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
  });

  it("PARKS on an unreadable artifact (oversize body, resolve.ts:111) — genuine, not a lie", async () => {
    const ref = await seedArtifact(root);
    const { bytesPath } = artifactPaths(root, RESEARCH_ARTIFACT_TYPE, SLUG, RESEARCH_ARTIFACT_FILE);
    // A CONFIRMED in-root body larger than the type's maxBytes (65536) whose
    // manifest.bytes MATCHES the on-disk size → artifact-unreadable (a benign
    // maxBytes-exceeded park), NOT bytes-tampered. Identity/contentKind stay honest
    // so resolve reaches the oversize branch. Body content is never parsed here.
    const big = "x".repeat(70000);
    await writeFile(bytesPath, big, "utf8");
    await overwriteManifest(root, { bytes: Buffer.byteLength(big, "utf8") });
    await expect(run(root, ref)).rejects.toBeInstanceOf(ArtifactPreconditionUnverifiableError);
  });

  it("PARKS on a malformed manifest (genuine store fault)", async () => {
    const ref = await seedArtifact(root);
    const { manifestPath } = artifactPaths(root, RESEARCH_ARTIFACT_TYPE, SLUG, RESEARCH_ARTIFACT_FILE);
    await writeFile(manifestPath, "{ not json", "utf8");
    await expect(run(root, ref)).rejects.toBeInstanceOf(ArtifactPreconditionUnverifiableError);
  });
});

/** A text `scratch-note` body — trivially schema-valid (text kind runs no metadata check). */
const NOTE_BODY = "just a note";

/** Seed a HEALTHY `scratch-note` (the WRONG type for the `experiment-result` requirement) and return its ref. */
async function seedNote(root: string): Promise<string> {
  const sha256 = hashArtifactBody(NOTE_BODY);
  const manifest: ArtifactManifest = { artifactType: OTHER_ARTIFACT_TYPE, slug: SLUG, sha256, bytes: Buffer.byteLength(NOTE_BODY, "utf8"), contentKind: "text", writtenAt: new Date().toISOString() };
  await writeArtifactFiles(root, artifactPaths(root, OTHER_ARTIFACT_TYPE, SLUG, OTHER_ARTIFACT_FILE), NOTE_BODY, manifest);
  return formatArtifactRef({ artifactType: OTHER_ARTIFACT_TYPE, slug: SLUG, sha256 });
}

function runMultiType(root: string, ref: unknown) {
  const profile = multiTypeArtifactPreconditionProfile();
  return enforceArtifactPreconditions({
    root, profile, entityType: "experiments", slug: "exp",
    enteredState: "complete", lifecycle: profile.entities.experiments.lifecycle!,
    meta: { result: ref },
  });
}

describe("enforceArtifactPreconditions binds the required artifactType to the pinned ref type", () => {
  let root = "";
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "enforce-artifact-type-")); });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("DENIES a HEALTHY wrong-type ref on a multi-type-scoped field (type confusion)", async () => {
    // The `result` field's scope admits both experiment-result and scratch-note, but
    // the `complete` precondition requires experiment-result specifically. A page pins
    // a scratch-note that is SELF-CONSISTENTLY HEALTHY (resolves ok on its own type)…
    const ref = await seedNote(root);
    expect((await resolveArtifactRef(root, multiTypeArtifactPreconditionProfile(), { artifactType: OTHER_ARTIFACT_TYPE, slug: SLUG, sha256: hashArtifactBody(NOTE_BODY) })).health).toBe("ok");
    // …yet the precondition must DENY: a healthy artifact of the WRONG type is not the
    // required experiment-result. Before the type-binding fix this resolved and passed.
    await expect(runMultiType(root, ref)).rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
  });
});

/**
 * Pins the OQ10 deny/park classifier table directly — the security-critical seam:
 * a misclassified verdict either denies an honest retryable run or lets a forged
 * artifact satisfy a precondition. `ok`→pass; `artifact-unreadable`→park; the
 * OVERLOADED `artifact-store-unavailable` splits on `storeFault` (genuine-fault→park,
 * integrity-lie→deny); every other non-ok health→deny.
 */
describe("classifyArtifactHealth OQ10 table", () => {
  it("passes ok, parks unreadable, denies confirmed violations", () => {
    expect(classifyArtifactHealth("ok", undefined)).toBe("pass");
    expect(classifyArtifactHealth("artifact-unreadable", undefined)).toBe("park");
    for (const h of ["artifact-dangling", "artifact-bytes-tampered", "artifact-schema-invalid", "artifact-hash-mismatch"] as const) {
      expect(classifyArtifactHealth(h, undefined)).toBe("deny");
    }
  });

  it("splits store-unavailable on storeFault: genuine-fault parks, integrity-lie denies", () => {
    expect(classifyArtifactHealth("artifact-store-unavailable", "genuine-fault")).toBe("park");
    expect(classifyArtifactHealth("artifact-store-unavailable", "integrity-lie")).toBe("deny");
  });
});
