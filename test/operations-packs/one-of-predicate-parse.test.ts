/**
 * @file test/operations-packs/one-of-predicate-parse.test.ts
 * @description The parameterised `one-of` predicate entry in the select-body
 * grammar (section 16.3), driven through the PUBLIC pack parser: a select phase
 * whose `filterPredicateIds` mixes a plain registered id with the parameterised
 * form parses and is preserved, while every malformed value set — empty,
 * duplicated, an empty-string member — refuses at PARSE time, before any run
 * exists. The value-set admission rules live in the grammar deliberately, so a
 * pack shipping a broken closed set fails at load, not as runtime behaviour.
 */

import { describe, expect, it } from "vitest";
import { parseOperationsPack } from "../../src/operations-packs/parse.js";
import { buildPack, serialize } from "./pack-fixture.js";

/** One well-formed select phase carrying a one-of predicate plus a plain id. */
function selectPhaseWithValues(values: unknown): Record<string, unknown> {
  return {
    phaseId: "admit", kind: "select", dependencies: ["assemble"], disposition: "required",
    inputBindings: [{ bindingId: "evidence-in", source: "phase-output", ref: "assemble.evidence" }],
    outputSchema: [{ fieldId: "selected", valueKind: "evidence-ref" }],
    bounds: { maxItems: 64, maxOutputBytes: 32768 }, missingInputDisposition: "fail",
    body: {
      operation: "filter", identityFields: ["verdict"], sortFields: [],
      filterPredicateIds: ["non-empty", { id: "one-of", field: "verdict", values }],
      overflowDisposition: "record-deficit", completenessClass: "evidence-coverage",
    },
  };
}

/** The fixture pack's serialized text with the given select phase inserted. */
function packTextWith(phase: Record<string, unknown>): string {
  const pack = JSON.parse(serialize(buildPack()));
  pack.recipes["demo.prepare"].phases.splice(1, 0, phase);
  return JSON.stringify(pack);
}

describe("one-of predicate parse", () => {
  it("parses and preserves a mixed plain-id / parameterised predicate list", () => {
    const pack = parseOperationsPack(packTextWith(selectPhaseWithValues(["supported", "not_supported"])));
    const phase = pack.recipes["demo.prepare"]!.phases.find((entry) => entry.phaseId === "admit")!;
    expect(phase.kind === "select" && phase.body.filterPredicateIds).toEqual([
      "non-empty", { id: "one-of", field: "verdict", values: ["supported", "not_supported"] },
    ]);
  });

  it("refuses an empty values list", () => {
    expect(() => parseOperationsPack(packTextWith(selectPhaseWithValues([]))))
      .toThrow(/must declare at least one value/);
  });

  it("refuses duplicate values", () => {
    expect(() => parseOperationsPack(packTextWith(selectPhaseWithValues(["supported", "supported"]))))
      .toThrow(/contains duplicate values/);
  });

  it("refuses an empty-string value", () => {
    expect(() => parseOperationsPack(packTextWith(selectPhaseWithValues(["supported", ""]))))
      .toThrow(/must be a bounded string/);
  });

  it("refuses an unregistered parameterised predicate id", () => {
    const phase = selectPhaseWithValues(["supported"]);
    const body = phase.body as { filterPredicateIds: unknown[] };
    body.filterPredicateIds = [{ id: "two-of", field: "verdict", values: ["supported"] }];
    expect(() => parseOperationsPack(packTextWith(phase))).toThrow(/is unsupported/);
  });

  it("refuses a parameterised id written BARE — at parse, not mid-run", () => {
    // `one-of` is a well-formed ref-id, so the plain-string branch would accept
    // it and the HANDLER would throw "not registered" only once the phase ran —
    // in a judge recipe, after the provider phase already spent a model call.
    // The parser knows which ids are parameterised, so it refuses here.
    const phase = selectPhaseWithValues(["supported"]);
    const body = phase.body as { filterPredicateIds: unknown[] };
    body.filterPredicateIds = ["one-of"];
    expect(() => parseOperationsPack(packTextWith(phase)))
      .toThrow(/must declare one-of in its parameterised form, not as a bare id/);
  });

  it("still accepts a plain registered id that is not parameterised", () => {
    // The refusal above must be scoped to the parameterised ids alone: the
    // parameterless family parses exactly as it did before this grammar existed.
    const phase = selectPhaseWithValues(["supported"]);
    const body = phase.body as { filterPredicateIds: unknown[] };
    body.filterPredicateIds = ["non-empty", "has-identity"];
    const pack = parseOperationsPack(packTextWith(phase));
    const parsed = pack.recipes["demo.prepare"]!.phases.find((entry) => entry.phaseId === "admit")!;
    expect(parsed.kind === "select" && parsed.body.filterPredicateIds).toEqual(["non-empty", "has-identity"]);
  });

  it("refuses an extra key on the parameterised entry", () => {
    const phase = selectPhaseWithValues(["supported"]);
    const body = phase.body as { filterPredicateIds: unknown[] };
    body.filterPredicateIds = [{ id: "one-of", field: "verdict", values: ["supported"], trim: true }];
    expect(() => parseOperationsPack(packTextWith(phase))).toThrow(/unknown field trim/);
  });
});
