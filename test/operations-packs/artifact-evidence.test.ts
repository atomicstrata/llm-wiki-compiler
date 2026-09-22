/**
 * @file test/operations-packs/artifact-evidence.test.ts
 * @description W2 unit witnesses for the D41a mechanical builder and its
 * capture: SYNTHETIC consumer only (the member-bearing `bundle` fixture type —
 * no product vocabulary, the §4.6 genericity gate). The builder re-verifies
 * everything sealed: a tampered member refuses (unhealthy); a post-capture
 * REWRITE breaks the SEALED REF itself (a Merkle root — hash-mismatch);
 * FORGED sealed columns beside a healthy ref refuse as MANIFEST DRIFT (the
 * reachable forgery channel — the mutant that removes the check would hand
 * the provider fewer members than the operator approved, killed by the
 * extra-row case); the happy path materializes the exact member bytes
 * (binary included) with the inputId→name table. The capture verifies the ref
 * END TO END before filling host-owned columns, refuses an unhealthy or
 * unpinned ref BEFORE staging, and OVERWRITES any caller-supplied columns.
 */

import { describe, expect, it, afterEach } from "vitest";
import path from "path";
import { writeFile } from "fs/promises";
import { buildArtifactEvidenceSpecs } from "../../src/operations-packs/runtime/artifact-evidence.js";
import { captureArtifactEvidenceInput } from "../../src/products/artifact-evidence-capture.js";
import type { WorkspaceOperationsPackV2 } from "../../src/operations-packs/types.js";
import {
  EVIDENCE_DESCRIPTOR, forgeSecondDigest, sealedBundleValue,
} from "../fixtures/artifact-evidence-fixture.js";
import {
  makeMembersRoot, writeBundle, bundlePaths, twoMembers, shaOf, BINARY_BYTES, SLUG,
} from "../fixtures/member-artifact-root.js";

afterEach(() => { delete process.env.LLMWIKI_TRUSTED_WRITE; });


describe("the artifact-evidence builder re-verifies everything sealed", () => {
  it("materializes the exact member bytes (binary included) with the inputId→name table", async () => {
    const root = await makeMembersRoot("aev-happy");
    const ref = await writeBundle(root, twoMembers());
    const built = await buildArtifactEvidenceSpecs(root, EVIDENCE_DESCRIPTOR, sealedBundleValue(ref));
    if (built.status !== "ok") throw new Error(built.reason);
    expect(built.built.specs.map((spec) => spec.inputId)).toEqual(["member-0", "member-1"]);
    expect(built.built.pathTable).toEqual({ "member-0": "figure.bin", "member-1": "main.tex" });
    expect(Buffer.from(built.built.specs[0]!.bytes).equals(BINARY_BYTES)).toBe(true);
    expect(built.built.specs[1]!.provenanceLabel).toBe("bundle-member");
  });

  it("REFUSES a tampered member (unhealthy) and a post-capture REWRITE (the sealed ref IS a Merkle root)", async () => {
    const root = await makeMembersRoot("aev-drift");
    const ref = await writeBundle(root, twoMembers());
    const sealed = sealedBundleValue(ref);
    await writeFile(path.join(bundlePaths(root).expectedDir, "figure.bin"), Buffer.from([0x00]));
    const tampered = await buildArtifactEvidenceSpecs(root, EVIDENCE_DESCRIPTOR, sealed);
    expect(tampered).toMatchObject({ status: "unavailable", reason: expect.stringContaining("unhealthy") });
    // A REWRITE lands a perfectly healthy NEW bundle — and thereby breaks the
    // SEALED ref itself: the pinned sha is the manifest's, a Merkle root over
    // every member, so the old ref can never resolve over the new store.
    await writeBundle(root, [{ fileName: "main.tex", bytes: Buffer.from("rewritten", "utf8") }]);
    const rewritten = await buildArtifactEvidenceSpecs(root, EVIDENCE_DESCRIPTOR, sealed);
    expect(rewritten).toMatchObject({ status: "unavailable", reason: "artifact-evidence-unhealthy-artifact-hash-mismatch" });
  });

  it("REFUSES FORGED sealed columns beside a healthy ref — manifest drift (the reachable forgery channel)", async () => {
    // The product capture overwrites columns, but a raw compile (SDK/pack
    // runner) can seal caller-supplied ones. The builder must compare the
    // CURRENT verified manifest against the SEALED table, not trust either.
    const root = await makeMembersRoot("aev-forged");
    const ref = await writeBundle(root, twoMembers());
    const sealed = sealedBundleValue(ref);
    const forged = forgeSecondDigest(sealed);
    const drift = await buildArtifactEvidenceSpecs(root, EVIDENCE_DESCRIPTOR, forged);
    expect(drift).toMatchObject({ status: "unavailable", reason: "artifact-evidence-manifest-drift" });
    const dropped = { ...sealed, "member-names": [(sealed["member-names"] as string[])[0]!], "member-digests": [(sealed["member-digests"] as string[])[0]!], "member-byte-counts": [(sealed["member-byte-counts"] as string[])[0]!] };
    expect(await buildArtifactEvidenceSpecs(root, EVIDENCE_DESCRIPTOR, dropped))
      .toMatchObject({ status: "unavailable", reason: "artifact-evidence-manifest-drift" }); // a member cannot be hidden from the provider
    // EXTRA forged rows are the drift check's UNIQUE catch (the mutant that
    // removes it would verify the two real members and silently hand the
    // provider fewer members than the operator "approved"):
    const extra = {
      ...sealed,
      "member-names": [...(sealed["member-names"] as string[]), "ghost.tex"],
      "member-digests": [...(sealed["member-digests"] as string[]), `sha256:${"e".repeat(64)}`],
      "member-byte-counts": [...(sealed["member-byte-counts"] as string[]), "5"],
    };
    expect(await buildArtifactEvidenceSpecs(root, EVIDENCE_DESCRIPTOR, extra))
      .toMatchObject({ status: "unavailable", reason: "artifact-evidence-manifest-drift" });
  });

  it("REFUSES an invalid ref, a non-member-bearing type, and missing columns — each by name", async () => {
    const root = await makeMembersRoot("aev-shape");
    const ref = await writeBundle(root, twoMembers());
    const sealed = sealedBundleValue(ref);
    expect(await buildArtifactEvidenceSpecs(root, EVIDENCE_DESCRIPTOR, { ...sealed, "bundle-ref": "not-a-ref" }))
      .toMatchObject({ status: "unavailable", reason: "artifact-evidence-ref-invalid" });
    expect(await buildArtifactEvidenceSpecs(root, EVIDENCE_DESCRIPTOR, { ...sealed, "member-digests": undefined }))
      .toMatchObject({ status: "unavailable", reason: "artifact-evidence-columns-invalid" });
    const foreign = { ...sealed, "bundle-ref": `no-such-type/${SLUG}@sha256:${"a".repeat(64)}` };
    expect(await buildArtifactEvidenceSpecs(root, EVIDENCE_DESCRIPTOR, foreign))
      .toMatchObject({ status: "unavailable", reason: "artifact-evidence-not-member-bearing" });
  });
});

/** A minimal pack whose one action's recipe carries the descriptor. */
function packWith(descriptor: object | undefined): WorkspaceOperationsPackV2 {
  return {
    actions: { "demo.run": { execution: { recipeRef: "demo.recipe" } } },
    recipes: {
      "demo.recipe": {
        phases: [{ phaseId: "extract", kind: "provider", body: descriptor === undefined ? {} : { artifactEvidenceDescriptor: descriptor } }],
      },
    },
  } as unknown as WorkspaceOperationsPackV2;
}

describe("the artifact-evidence capture verifies before staging and owns the columns", () => {
  it("fills host-owned columns from the VERIFIED manifest, overwriting caller-supplied ones", async () => {
    const root = await makeMembersRoot("aev-capture");
    const ref = await writeBundle(root, twoMembers());
    const captured = await captureArtifactEvidenceInput(root, packWith(EVIDENCE_DESCRIPTOR), "demo.run", {
      "bundle-ref": `${ref.artifactType}/${ref.slug}@sha256:${ref.sha256}`,
      "member-names": ["forged.tex"], "member-digests": [`sha256:${"f".repeat(64)}`], "member-byte-counts": ["1"],
    } as never);
    if ("refused" in captured) throw new Error(captured.refused);
    expect(captured.input["member-names"]).toEqual(["figure.bin", "main.tex"]); // forged columns OVERWRITTEN
    expect(captured.input["member-digests"]).toEqual([`sha256:${shaOf(BINARY_BYTES)}`, `sha256:${shaOf(Buffer.from("\\documentclass{article}", "utf8"))}`]);
  });

  it("REFUSES a healthy bundle whose members exceed the sealed byte cap BEFORE staging", async () => {
    // The runtime builder would only park it at the authority seal; the capture
    // refuses at the door, exactly as the source-evidence capture does.
    const root = await makeMembersRoot("aev-capture-bytecap");
    const ref = await writeBundle(root, twoMembers());
    const capped = await captureArtifactEvidenceInput(root, packWith({ ...EVIDENCE_DESCRIPTOR, maxBytes: 8 }), "demo.run", {
      "bundle-ref": `${ref.artifactType}/${ref.slug}@sha256:${ref.sha256}`,
    } as never);
    expect(capped).toMatchObject({ refused: expect.stringContaining("exceed the sealed maxBytes") });
  });

  it("REFUSES an unpinned ref and an UNHEALTHY bundle BEFORE staging; a descriptor-less action passes through", async () => {
    const root = await makeMembersRoot("aev-capture-refuse");
    const ref = await writeBundle(root, twoMembers());
    const unpinned = await captureArtifactEvidenceInput(root, packWith(EVIDENCE_DESCRIPTOR), "demo.run", { "bundle-ref": "bundle/probe" } as never);
    expect(unpinned).toMatchObject({ refused: expect.stringContaining("no pinned ref") });
    await writeFile(path.join(bundlePaths(root).expectedDir, "main.tex"), "TAMPERED", "utf8");
    const unhealthy = await captureArtifactEvidenceInput(root, packWith(EVIDENCE_DESCRIPTOR), "demo.run", {
      "bundle-ref": `${ref.artifactType}/${ref.slug}@sha256:${ref.sha256}`,
    } as never);
    expect(unhealthy).toMatchObject({ refused: expect.stringContaining("artifact-bytes-tampered") });
    const untouched = await captureArtifactEvidenceInput(root, packWith(undefined), "demo.run", { topic: "x" } as never);
    if ("refused" in untouched) throw new Error(untouched.refused);
    expect(untouched.input).toEqual({ topic: "x" });
  });
});
