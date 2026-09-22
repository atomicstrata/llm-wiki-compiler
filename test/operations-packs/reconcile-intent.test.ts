/**
 * @file test/operations-packs/reconcile-intent.test.ts
 * @description reconcile (design section 16.6) classifies proposals into the
 * declared finding classes, suppresses an undeclared class as a counted deficit,
 * reports a duplicate identity, and never writes; intent-compile (section 16.7)
 * compiles proposals into typed Milestone A mutation DRAFTS with a payload digest
 * and no path field, rejects a deferred mutation kind, and fails closed on a missing
 * bound input. Both fail closed when the input set exceeds the item ceiling.
 */

import { describe, expect, it } from "vitest";
import { reconcileEvidence } from "../../src/operations-packs/handlers/reconcile.js";
import { compileIntents } from "../../src/operations-packs/handlers/intent-compile.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { PackHostHandlerError } from "../../src/operations-packs/handlers/types.js";
import { PackDeferredError } from "../../src/operations-packs/problems.js";
import type { IntentPhaseBodyV2, ReconcilePhaseBodyV2 } from "../../src/operations-packs/recipe-types.js";
import type { PackEvidenceItemV1, PackHandlerBoundsV1, PackHostIdentitiesV1 } from "../../src/operations-packs/handlers/types.js";

const BOUNDS: PackHandlerBoundsV1 = { maximumItems: 100, maximumOutputBytes: 262_144 };
const IDS: PackHostIdentitiesV1 = { runId: "run-7", principal: "user", hostTimestamp: "2026-08-14T00:00:00.000Z" };
function item(itemId: string, fields: PackEvidenceItemV1["fields"]): PackEvidenceItemV1 { return { itemId, fields }; }

describe("reconcile", () => {
  it("classifies proposals into the declared finding classes", () => {
    const body: ReconcilePhaseBodyV2 = { reconcilePolicyId: "policy.rec", comparedEvidenceClass: "artifact", findingClasses: ["absent", "identical", "supersession-candidate", "conflicting"] };
    const proposed = [item("new", { v: 1 }), item("same", { version: 1, title: "t" }), item("up", { version: 2 }), item("clash", { title: "z" })];
    const snapshot = [item("same", { version: 1, title: "t" }), item("up", { version: 1 }), item("clash", { title: "a" })];
    const byId = Object.fromEntries(reconcileEvidence({ body, proposed, snapshot, bounds: BOUNDS }).findings.map((f) => [f.identity, f.findingClass]));
    expect(byId).toEqual({ new: "absent", same: "identical", up: "supersession-candidate", clash: "conflicting" });
  });

  it("suppresses an undeclared finding class as a deficit and reports a duplicate", () => {
    const body: ReconcilePhaseBodyV2 = { reconcilePolicyId: "p", comparedEvidenceClass: "artifact", findingClasses: ["duplicate-identity"] };
    const result = reconcileEvidence({ body, proposed: [item("only", { title: "n" }), item("dup", { v: 1 }), item("dup", { v: 2 })], snapshot: [], bounds: BOUNDS });
    expect(result.findings).toEqual([{ identity: "dup", findingClass: "duplicate-identity" }]);
    expect(result.deficits).toEqual([{ completenessClass: "artifact", reason: "suppressed-finding", droppedCount: 1 }]);
  });

  it("fails closed when the proposed set exceeds the item ceiling", () => {
    const body: ReconcilePhaseBodyV2 = { reconcilePolicyId: "p", comparedEvidenceClass: "artifact", findingClasses: ["absent"] };
    expect(() => reconcileEvidence({ body, proposed: [item("a", {}), item("b", {})], snapshot: [], bounds: { maximumItems: 1, maximumOutputBytes: 262_144 } })).toThrow(PackHostHandlerError);
  });
});

describe("intent-compile", () => {
  const upsert: IntentPhaseBodyV2 = { intentTemplateRef: "tmpl.intent", intents: [{ mutationKind: "artifact-upsert", targetProfileClass: "note", fieldMappings: [
    { targetField: "title", source: "phase-input", ref: "title" }, { targetField: "count", source: "constant", value: 3 }, { targetField: "run", source: "host-identity", identityKind: "run-id" },
  ] }] };

  it("compiles proposals into typed mutation drafts deterministically", () => {
    const input = { body: upsert, evidence: [item("a", { title: "Hello" })], identities: IDS, bounds: BOUNDS };
    const first = compileIntents(input);
    expect(canonicalBytes(first)).toEqual(canonicalBytes(compileIntents(input)));
    expect(first.drafts[0].fields).toEqual({ title: "Hello", count: 3, run: "run-7" });
    expect(first.drafts[0]).not.toHaveProperty("path");
    expect(first.drafts[0].payloadDigest).toMatch(/^sha256:/);
  });

  it("drafts per GROUP with whenPresent gating and a verbatim string constant", () => {
    const body: IntentPhaseBodyV2 = { intentTemplateRef: "tmpl.intent", intents: [
      { mutationKind: "artifact-upsert", targetProfileClass: "note", whenPresent: "title",
        fieldMappings: [{ targetField: "title", source: "phase-input", ref: "title" }] },
      { mutationKind: "relation-upsert", targetProfileClass: "cites-link", whenPresent: "to",
        fieldMappings: [{ targetField: "relation-type", source: "constant", value: "cites" },
          { targetField: "from", source: "phase-input", ref: "title" }, { targetField: "to", source: "phase-input", ref: "to" }] },
    ] };
    const evidence = [item("a", { title: "A", to: "B" }), item("b", { title: "B" })];
    const result = compileIntents({ body, evidence, identities: IDS, bounds: BOUNDS });
    const kinds = result.drafts.map((draft) => draft.mutationKind).sort();
    expect(kinds).toEqual(["artifact-upsert", "artifact-upsert", "relation-upsert"]);
    const relation = result.drafts.find((draft) => draft.mutationKind === "relation-upsert")!;
    expect(relation.fields).toEqual({ "relation-type": "cites", from: "A", to: "B" });
  });

  it("REFUSES a relation group naming a projection whose target is not a slug", () => {
    // The page-field vocabulary is scoped by mutation KIND at parse time, but a
    // projection is substituted for EVERY kind at compile time — so without
    // this guard a relation group could name a page-shaped projection and
    // persist a camelCase relation attribute, bypassing the scoping entirely.
    const projections = {
      "project.page": {
        projectionId: "project.page", targetProfileClass: "note",
        fieldMappings: [{ targetField: "resultSummary", source: "phase-input", ref: "summary" }],
      },
    } as unknown as Parameters<typeof compileIntents>[0]["projections"];
    const body: IntentPhaseBodyV2 = { intentTemplateRef: "tmpl.intent", intents: [
      { mutationKind: "relation-upsert", targetProfileClass: "cites-link", projectionRef: "project.page",
        fieldMappings: [{ targetField: "relation-type", source: "constant", value: "cites" }] },
    ] };
    const evidence = [item("a", { resultSummary: "s", summary: "s" })];
    expect(() => compileIntents({ body, evidence, identities: IDS, bounds: BOUNDS, projections }))
      .toThrow(/not a slug/);
    // CONTROL: the same projection is legal for a PAGE group, so the refusal
    // above is attributable to the KIND and not to the projection itself.
    const pageBody: IntentPhaseBodyV2 = { intentTemplateRef: "tmpl.intent", intents: [
      { mutationKind: "artifact-upsert", targetProfileClass: "note", projectionRef: "project.page",
        fieldMappings: [{ targetField: "title", source: "phase-input", ref: "summary" }] },
    ] };
    expect(() => compileIntents({ body: pageBody, evidence, identities: IDS, bounds: BOUNDS, projections }))
      .not.toThrow();
  });

  it("defers a mutation kind the launch set does not admit", () => {
    // `artifact-delete` used to be this case's example and is now a launch kind,
    // so the example moved to one the parser cannot produce at all. The control
    // is worth keeping: it is the only thing proving the deferral REFUSES
    // rather than silently compiling an unsupported kind.
    const body = { intentTemplateRef: "tmpl.intent", intents: [{ mutationKind: "page-rename", targetProfileClass: "note", fieldMappings: [] }] } as unknown as IntentPhaseBodyV2;
    expect(() => compileIntents({ body, evidence: [item("a", {})], identities: IDS, bounds: BOUNDS })).toThrow(PackDeferredError);
  });

  it("admits every kind the pack GRAMMAR can express, so none is silently deferred", () => {
    // The two sets drifting apart is the real hazard: a kind a pack can declare
    // but the compiler defers would fail only at run time, after the plan was
    // sealed. Deriving the expectation from the grammar means adding a kind
    // forces a deliberate answer here.
    const grammarKinds = [
      "artifact-upsert", "artifact-update", "artifact-delete", "catalog-append",
      "projection-register", "relation-upsert", "lifecycle-transition",
    ];
    for (const mutationKind of grammarKinds) {
      const body = { intentTemplateRef: "t", intents: [{ mutationKind, targetProfileClass: "note", fieldMappings: [] }] } as unknown as IntentPhaseBodyV2;
      expect(() => compileIntents({ body, evidence: [], identities: IDS, bounds: BOUNDS }), mutationKind)
        .not.toThrow(PackDeferredError);
    }
  });

  it("fails closed on a missing bound input", () => {
    const missing: IntentPhaseBodyV2 = { intentTemplateRef: "t", intents: [{ mutationKind: "catalog-append", targetProfileClass: "c", fieldMappings: [{ targetField: "x", source: "phase-input", ref: "absent" }] }] };
    expect(() => compileIntents({ body: missing, evidence: [item("a", {})], identities: IDS, bounds: BOUNDS })).toThrow(PackHostHandlerError);
  });

  it("fails closed when EXPANSION overflows the ceiling: one item, three groups, cap two", () => {
    // The input passes the item cap (1 ≤ 2); only the POST-expansion guard can
    // refuse the three drafts the groups fan the item out into. The message is
    // asserted so the pre-expansion cap cannot satisfy this case.
    const group = { mutationKind: "artifact-upsert" as const, fieldMappings: [{ targetField: "title" as const, source: "phase-input" as const, ref: "title" }] };
    const fanned: IntentPhaseBodyV2 = { intentTemplateRef: "t", intents: [
      { ...group, targetProfileClass: "a", fieldMappings: [...group.fieldMappings] },
      { ...group, targetProfileClass: "b", fieldMappings: [...group.fieldMappings] },
      { ...group, targetProfileClass: "c", fieldMappings: [...group.fieldMappings] },
    ] };
    expect(() => compileIntents({
      body: fanned, evidence: [item("a", { title: "A" })], identities: IDS,
      bounds: { maximumItems: 2, maximumOutputBytes: 262_144 },
    })).toThrow(/drafts exceed the declared item ceiling/);
  });
});
