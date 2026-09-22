/**
 * @file test/operations-packs/page-evidence-synthetic.test.ts
 * @description The SYNTHETIC page-evidence consumer (P5c §2a): a tiny
 * "gadgets" profile no product ships, driving the capture and the runtime
 * builder directly. What it proves is GENERICITY — the seam holds with zero
 * product vocabulary — and the per-form contracts the product journeys
 * cannot isolate: hostile fields, capture-then-mutate drift, and
 * exposure-digest movement when a SOURCE changes under identical bytes.
 * (Run-binding positives and hostiles live in the pilot-judge suite, which
 * owns a real authenticated run.)
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempRoot } from "../fixtures/temp-root.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import { writePage } from "../fixtures/write-page.js";
import { mkdir, readFile } from "node:fs/promises";
import { createWiki } from "../../src/sdk/wiki.js";
import { appendRelation } from "../../src/relations/store.js";
import { loadNonDefaultProfile } from "../../src/profile/block.js";
import { capturePageEvidenceInput } from "../../src/products/page-evidence-capture.js";
import { buildPageEvidenceSpecs } from "../../src/operations-packs/runtime/page-evidence.js";
import type { ProfilePack } from "../../src/profile/types.js";
import type { PageEvidenceDescriptorV2 } from "../../src/operations-packs/recipe-types.js";
import type { WorkspaceOperationsPackV2 } from "../../src/operations-packs/types.js";

/** A profile NO product ships: gadgets measured by widgets, with a report artifact. */
const GADGET_PROFILE = {
  schemaVersion: 1, profileId: "gadgets-synthetic",
  entities: {
    gadgets: {
      directory: "wiki/gadgets",
      fields: { title: { type: "string" }, spec: { type: "string" }, report: { type: "string" } },
    },
    widgets: { directory: "wiki/widgets", fields: { title: { type: "string" }, note: { type: "string" } } },
  },
  relations: { measures: { from: ["gadgets"], to: ["widgets"], direction: "directed" } },
  artifacts: { "gadget-report": { fileName: "report.json", maxBytes: 4_096, contentKind: "json" } },
} as unknown as ProfilePack;

/** The three page-anchored forms over the gadget page. */
function gadgetDescriptor(): PageEvidenceDescriptorV2 {
  const tail = { kind: "page-evidence", mediaType: "text/plain", maxBytes: 512 } as const;
  return {
    pathTableKey: "page-evidence-files",
    target: { entityType: "gadgets", slugField: "slug" },
    captures: [
      { form: "page-field", captureId: "spec", field: "spec", inputId: "in-spec", provenanceLabel: "gadget-spec", ...tail },
      { form: "artifact-deref", captureId: "report", refField: "report", artifactType: "gadget-report",
        inputId: "in-report", provenanceLabel: "gadget-report", kind: "page-evidence",
        mediaType: "application/json", maxBytes: 4_096 },
      { form: "relation-target", captureId: "measured", relationType: "measures", sourceRole: "from",
        targetEntityType: "widgets",
        then: [{ form: "page-field", captureId: "widget-note", field: "note",
          inputId: "in-widget-note", provenanceLabel: "widget-note", ...tail }] },
    ],
  };
}

/** A pack shape just deep enough for the capture's descriptor walk. */
function packFor(descriptor: PageEvidenceDescriptorV2): WorkspaceOperationsPackV2 {
  return {
    actions: { "syn.judge": { execution: { recipeRef: "syn.recipe" } } },
    recipes: { "syn.recipe": { phases: [{ kind: "provider", body: { pageEvidenceDescriptor: descriptor } }] } },
  } as unknown as WorkspaceOperationsPackV2;
}

/** A project with one gadget (spec+report artifact) measuring one widget. */
async function gadgetProject(): Promise<{ root: string; ref: string }> {
  const root = await makeTempRoot("page-evidence-syn-");
  await writeProfileFile(root, GADGET_PROFILE);
  await mkdir(path.join(root, "wiki", "widgets"), { recursive: true });
  await writePage(path.join(root, "wiki", "widgets"), "w-1", { title: "Widget one", note: "calibrated" }, "# w\n");
  const { ref } = await createWiki({ root }).writeArtifact({
    artifactType: "gadget-report", slug: "g-1", body: JSON.stringify({ reading: 42 }),
  });
  const canonical = `gadget-report/g-1@sha256:${ref.sha256}`;
  await mkdir(path.join(root, "wiki", "gadgets"), { recursive: true });
  await writePage(path.join(root, "wiki", "gadgets"), "g-1",
    { title: "Gadget one", spec: "measures widget torque", report: canonical }, "# g\n");
  const loaded = await loadNonDefaultProfile(root);
  await appendRelation(root, loaded!.profile, {
    type: "measures", from: "gadgets/g-1", to: "widgets/w-1", confidence: 1,
  } as never);
  return { root, ref: canonical };
}

const INPUT = { slug: "g-1" };

// The SDK's artifact write is trust-gated; the synthetic suite holds the
// grant for its own profile exactly as the product fixtures do for theirs.
const priorGrant = process.env.LLMWIKI_TRUSTED_WRITE;
beforeAll(() => { process.env.LLMWIKI_TRUSTED_WRITE = "gadgets-synthetic"; });
afterAll(() => {
  if (priorGrant === undefined) delete process.env.LLMWIKI_TRUSTED_WRITE;
  else process.env.LLMWIKI_TRUSTED_WRITE = priorGrant;
});

describe("the page-evidence seam is generic: a product-free profile drives all page forms", () => {
  it("captures, seals, re-verifies, and materializes — with the SOURCE identities in the exposure set", async () => {
    const { root, ref } = await gadgetProject();
    const captured = await capturePageEvidenceInput(root, packFor(gadgetDescriptor()), "syn.judge", INPUT);
    if ("refused" in captured) throw new Error(captured.refused);
    expect(captured.input["spec-value"]).toBe("measures widget torque");
    expect(captured.input["report-ref"]).toBe(ref);
    expect(captured.input["measured-target"]).toBe("widgets/w-1");
    expect(captured.input["widget-note-value"]).toBe("calibrated");
    const built = await buildPageEvidenceSpecs(root, gadgetDescriptor(), captured.input);
    if (built.status !== "ok") throw new Error(built.reason);
    const ids = built.built.specs.map((spec) => spec.inputId).sort();
    expect(ids).toEqual(["in-report", "in-spec", "in-widget-note", "page-evidence-identity"]);
    const identity = JSON.parse(Buffer.from(
      built.built.specs.find((spec) => spec.inputId === "page-evidence-identity")!.bytes).toString("utf8"));
    expect(identity.captures.report).toBe(ref);
    expect(identity.captures.measured).toBe("widgets/w-1");
    expect(identity.target).toBe("gadgets/g-1");
  });

  it("HOSTILE: an undeclared field, a caller-squatted prefix, zero and two relation edges all refuse", async () => {
    const { root } = await gadgetProject();
    const undeclared = structuredClone(gadgetDescriptor());
    (undeclared.captures[0] as { field: string }).field = "smuggled";
    const gadgetFile = path.join(root, "wiki", "gadgets", "g-1.md");
    const original = await readFile(gadgetFile, "utf8");
    await writeFile(gadgetFile, original.replace("title:", "smuggled: attacker\ntitle:"), "utf8");
    const refusedField = await capturePageEvidenceInput(root, packFor(undeclared), "syn.judge", INPUT);
    expect("refused" in refusedField && refusedField.refused).toContain("not a declared field");
    const squatted = await capturePageEvidenceInput(root, packFor(gadgetDescriptor()), "syn.judge",
      { ...INPUT, "spec-anything": "mine" });
    expect("refused" in squatted && squatted.refused).toContain("host-owned page-evidence key");
    const loaded = await loadNonDefaultProfile(root);
    await appendRelation(root, loaded!.profile, {
      type: "measures", from: "gadgets/g-1", to: "widgets/w-2", confidence: 1,
    } as never);
    await writePage(path.join(root, "wiki", "widgets"), "w-2", { title: "Widget two", note: "n" }, "# w2\n");
    const twoEdges = await capturePageEvidenceInput(root, packFor(gadgetDescriptor()), "syn.judge", INPUT);
    expect("refused" in twoEdges && twoEdges.refused).toContain("exactly one is required");
  });

  it("HOSTILE artifacts and ZERO edges refuse: unpinned ref, wrong type, missing body, edge-less page", async () => {
    const { root } = await gadgetProject();
    const gadgetFile = path.join(root, "wiki", "gadgets", "g-1.md");
    const original = await readFile(gadgetFile, "utf8");
    // An UNPINNED ref (no digest) is not evidence.
    await writeFile(gadgetFile, original.replace(/^report:.*$/m, 'report: "gadget-report/g-1"'), "utf8");
    const unpinned = await capturePageEvidenceInput(root, packFor(gadgetDescriptor()), "syn.judge", INPUT);
    expect("refused" in unpinned && unpinned.refused).toContain("no pinned ref");
    // A ref to a TYPE the descriptor does not seal refuses.
    await writeFile(gadgetFile, original.replace(/^report:.*$/m,
      'report: "other-type/g-1@sha256:0000000000000000000000000000000000000000000000000000000000000000"'), "utf8");
    const wrongType = await capturePageEvidenceInput(root, packFor(gadgetDescriptor()), "syn.judge", INPUT);
    expect("refused" in wrongType && wrongType.refused).toContain("the descriptor seals");
    // A pinned ref whose artifact is GONE refuses at resolve.
    await writeFile(gadgetFile, original.replace(/^report:.*$/m,
      'report: "gadget-report/vanished@sha256:0000000000000000000000000000000000000000000000000000000000000000"'), "utf8");
    const missing = await capturePageEvidenceInput(root, packFor(gadgetDescriptor()), "syn.judge", INPUT);
    expect("refused" in missing && missing.refused).toMatch(/artifact is|body is/);
    await writeFile(gadgetFile, original, "utf8");
    // ZERO edges: a second gadget with no measures edge refuses exact-one.
    const goodRef = /^report: "?([^"\n]+)"?$/m.exec(original)?.[1];
    if (!goodRef) throw new Error("could not extract the good report ref");
    await writePage(path.join(root, "wiki", "gadgets"), "g-2",
      { title: "Gadget two", spec: "s", report: goodRef }, "# g2\n");
    const zeroEdges = await capturePageEvidenceInput(root, packFor(gadgetDescriptor()), "syn.judge", { slug: "g-2" });
    expect("refused" in zeroEdges && zeroEdges.refused).toContain("has 0 outgoing");
  });

  it("FAIL CLOSED: an entity with NO fields map can declare nothing — capture refuses", async () => {
    const root = await makeTempRoot("page-evidence-nofields-");
    // `plainthings` declares NO fields map: extra frontmatter is legal there,
    // so the guard must refuse the capture rather than admit anything.
    await writeProfileFile(root, {
      schemaVersion: 1, profileId: "gadgets-synthetic",
      entities: { plainthings: { directory: "wiki/plainthings" } },
    } as unknown as ProfilePack);
    await mkdir(path.join(root, "wiki", "plainthings"), { recursive: true });
    await writePage(path.join(root, "wiki", "plainthings"), "p-1", { title: "P", spec: "attacker" }, "# p\n");
    const descriptor: PageEvidenceDescriptorV2 = {
      pathTableKey: "page-evidence-files",
      target: { entityType: "plainthings", slugField: "slug" },
      captures: [{ form: "page-field", captureId: "spec", field: "spec", inputId: "in-spec",
        provenanceLabel: "p-spec", kind: "page-evidence", mediaType: "text/plain", maxBytes: 512 }],
    };
    const refused = await capturePageEvidenceInput(root, packFor(descriptor), "syn.judge", { slug: "p-1" });
    expect("refused" in refused && refused.refused).toContain("not a declared field");
  });

  it("CAPTURE-THEN-MUTATE drift refuses at runtime for every page form", async () => {
    const { root } = await gadgetProject();
    const descriptor = gadgetDescriptor();
    const captured = await capturePageEvidenceInput(root, packFor(descriptor), "syn.judge", INPUT);
    if ("refused" in captured) throw new Error(captured.refused);
    // page-field drift: the spec changes after capture.
    const gadgetFile = path.join(root, "wiki", "gadgets", "g-1.md");
    const original = await readFile(gadgetFile, "utf8");
    await writeFile(gadgetFile, original.replace("measures widget torque", "rewritten spec"), "utf8");
    const drifted = await buildPageEvidenceSpecs(root, descriptor, captured.input);
    expect(drifted.status).toBe("unavailable");
    await writeFile(gadgetFile, original, "utf8");
    // artifact drift: the report body is rewritten in place behind its ref.
    await writeFile(path.join(root, "artifacts", "gadget-report", "g-1", "report.json"),
      JSON.stringify({ reading: 43 }), "utf8");
    const tampered = await buildPageEvidenceSpecs(root, descriptor, captured.input);
    expect(tampered.status).toBe("unavailable");
    const restored = await createWiki({ root }).writeArtifact({
      artifactType: "gadget-report", slug: "g-1", body: JSON.stringify({ reading: 42 }),
    });
    expect(`gadget-report/g-1@sha256:${restored.ref.sha256}`).toBe(String(captured.input["report-ref"]));
    // relation drift: the measured widget is re-pointed after capture.
    const loaded = await loadNonDefaultProfile(root);
    await writePage(path.join(root, "wiki", "widgets"), "w-2", { title: "Widget two", note: "n" }, "# w2\n");
    await appendRelation(root, loaded!.profile, {
      type: "measures", from: "gadgets/g-1", to: "widgets/w-2", confidence: 1,
    } as never);
    const repointed = await buildPageEvidenceSpecs(root, descriptor, captured.input);
    expect(repointed.status).toBe("unavailable");
  });

  it("EXPOSURE MOVES with the SOURCE: identical bytes under a different artifact change the identity spec", async () => {
    const { root } = await gadgetProject();
    const descriptor = gadgetDescriptor();
    const first = await capturePageEvidenceInput(root, packFor(descriptor), "syn.judge", INPUT);
    if ("refused" in first) throw new Error(first.refused);
    const builtFirst = await buildPageEvidenceSpecs(root, descriptor, first.input);
    if (builtFirst.status !== "ok") throw new Error(builtFirst.reason);
    // A SECOND artifact with IDENTICAL bytes under a different slug: re-point
    // the page's ref to it — every content byte agrees, only the SOURCE moved.
    const { ref: twin } = await createWiki({ root }).writeArtifact({
      artifactType: "gadget-report", slug: "g-1-twin", body: JSON.stringify({ reading: 42 }),
    });
    const gadgetFile = path.join(root, "wiki", "gadgets", "g-1.md");
    const text = await readFile(gadgetFile, "utf8");
    const next = text.replace(/^report:.*$/m, `report: "gadget-report/g-1-twin@sha256:${twin.sha256}"`);
    if (next === text) throw new Error("the gadget page carries no report line to re-point");
    await writeFile(gadgetFile, next, "utf8");
    const second = await capturePageEvidenceInput(root, packFor(descriptor), "syn.judge", INPUT);
    if ("refused" in second) throw new Error(second.refused);
    const builtSecond = await buildPageEvidenceSpecs(root, descriptor, second.input);
    if (builtSecond.status !== "ok") throw new Error(builtSecond.reason);
    // The AUTHORITY-HASHED digest itself must move (P2d-r2): comparing the
    // identity bytes alone would stay green if the identity spec ever fell
    // out of the exposure hashing.
    const { providerInputSpecsContentExposureDigest } = await import("../../src/preparations/attempts/provider.js");
    const digestOf = (specs: typeof builtFirst.built.specs): string =>
      String(providerInputSpecsContentExposureDigest(specs as unknown as readonly Readonly<Record<string, unknown>>[]));
    expect(digestOf(builtSecond.built.specs)).not.toBe(digestOf(builtFirst.built.specs));
    // The CONTENT specs agree byte for byte — the identity spec alone moves.
    const contentOf = (specs: typeof builtFirst.built.specs): string[] =>
      specs.filter((spec) => spec.inputId === "in-report").map((spec) => Buffer.from(spec.bytes).toString("utf8"));
    expect(contentOf(builtSecond.built.specs)).toEqual(contentOf(builtFirst.built.specs));
  });
});
