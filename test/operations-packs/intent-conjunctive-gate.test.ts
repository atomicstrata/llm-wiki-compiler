/**
 * @file test/operations-packs/intent-conjunctive-gate.test.ts
 * @description A group declaring BOTH `whenPresent` and `whenEquals` is a
 * conjunction — the item must carry the field AND match the value.
 *
 * WHY THE GRAMMAR NEEDED IT: a compiled recipe declares exactly ONE intent
 * phase, which receives the UNION of every compare output. With the gates
 * mutually exclusive, a group confined by `finding-class == absent` matched an
 * absent row of EVERY class — one `cites` relation row would be drafted into
 * the cites, authored-by, introduces-concept, and proposes-method groups at
 * once — and a group confined by its class key matched that class's rows in
 * EVERY finding state, overwriting pages the comparison said already exist.
 * "MY key field present AND finding-class == absent" needs both.
 *
 * The union case here is the §4.4 topology in miniature: two classes and a
 * relation type in one evidence set, each group drafting exactly its own.
 */

import { describe, expect, it } from "vitest";
import { compileIntents } from "../../src/operations-packs/handlers/intent-compile.js";
import type { IntentPhaseBodyV2 } from "../../src/operations-packs/recipe-types.js";
import type { PackEvidenceItemV1, PackHandlerBoundsV1, PackHostIdentitiesV1 } from "../../src/operations-packs/handlers/types.js";

const IDS: PackHostIdentitiesV1 = { runId: "run-7", principal: "tester", hostTimestamp: "2026-08-19T00:00:00.000Z" };
const BOUNDS: PackHandlerBoundsV1 = { maximumItems: 32, maximumOutputBytes: 65_536 };
const item = (itemId: string, fields: Record<string, string>): PackEvidenceItemV1 => ({ itemId, fields });

/** The §4.4 shape in miniature: per-class groups over one shared union. */
const body: IntentPhaseBodyV2 = { intentTemplateRef: "tmpl.intent", intents: [
  { mutationKind: "artifact-upsert", targetProfileClass: "papers",
    whenPresent: "paperKey", whenEquals: { field: "finding-class", value: "absent" },
    fieldMappings: [{ targetField: "title", source: "phase-input", ref: "title" }] },
  { mutationKind: "artifact-upsert", targetProfileClass: "research-concepts",
    whenPresent: "conceptKey", whenEquals: { field: "finding-class", value: "absent" },
    fieldMappings: [{ targetField: "title", source: "phase-input", ref: "title" }] },
  { mutationKind: "relation-upsert", targetProfileClass: "cites-link",
    whenPresent: "relationKey", whenEquals: { field: "relationType", value: "cites" },
    fieldMappings: [{ targetField: "relation-type", source: "constant", value: "cites" },
      { targetField: "from", source: "phase-input", ref: "fromId" },
      { targetField: "to", source: "phase-input", ref: "toId" }] },
] };

/** One union: an absent paper, an absent concept, a PRESENT concept, a cites row. */
const union = [
  item("p1", { paperKey: "attention-paper", title: "Attention", "finding-class": "absent" }),
  item("c1", { conceptKey: "mha", title: "MHA", "finding-class": "absent" }),
  item("c2", { conceptKey: "posenc", title: "PosEnc", "finding-class": "identical" }),
  item("r1", { relationKey: "e1", relationType: "cites", fromId: "wiki/papers/attention-paper", toId: "wiki/sources/arxiv" }),
];

describe("conjunctive intent-group gates", () => {
  it("confines each group to its OWN class's rows in the declared state", () => {
    const result = compileIntents({ body, evidence: union, identities: IDS, bounds: BOUNDS });
    const byClass = result.drafts.map((draft) => draft.targetProfileClass).sort();
    // One draft per matching row — NOT one per (group x absent row), which is
    // what the single-gate grammar produced: 2 groups x 2 absent rows = 4
    // artifact drafts plus a relation drafted from every row carrying nothing.
    expect(byClass).toEqual(["cites-link", "papers", "research-concepts"]);
  });

  it("keeps single-gate groups exactly as they were", () => {
    const single: IntentPhaseBodyV2 = { intentTemplateRef: "tmpl.intent", intents: [
      { mutationKind: "artifact-upsert", targetProfileClass: "papers", whenPresent: "paperKey",
        fieldMappings: [{ targetField: "title", source: "phase-input", ref: "title" }] },
    ] };
    const result = compileIntents({ body: single, evidence: union, identities: IDS, bounds: BOUNDS });
    // Presence alone still matches regardless of finding state.
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.fields.title).toBe("Attention");
  });

  it("drafts NOTHING for a row failing either half of the conjunction", () => {
    const relationOnly = [item("r2", { relationKey: "e2", relationType: "authored-by", fromId: "a", toId: "b" })];
    const result = compileIntents({ body, evidence: relationOnly, identities: IDS, bounds: BOUNDS });
    // relationKey present, but relationType != cites: the equals half refuses.
    expect(result.drafts).toEqual([]);
  });
});
