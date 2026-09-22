/**
 * @file test/operations-packs/provider-response.test.ts
 * @description Decoding a provider's answer into closed evidence.
 *
 * A PROVIDER'S OUTPUT IS THE LEAST TRUSTED DATA IN A RUN. Everything else the
 * pack runtime handles comes from the caller's sealed input or a previous
 * phase's validated output; this is the one place model-produced bytes become
 * evidence that later phases reconcile against and a terminal drafts pages
 * from. Every case here is therefore a REFUSAL rather than a repair.
 *
 * COERCING WOULD LET THE PROVIDER CHOOSE THE SHAPE. A phase whose output shape
 * is provider-chosen cannot be reconciled against a store whose shape is fixed
 * — the same vocabulary mismatch that made `identical` unreachable before
 * canonical projections existed.
 */

import { describe, expect, it } from "vitest";
import { decodeProviderResponse } from "../../src/operations-packs/handlers/provider-response.js";
import { PackHostHandlerError } from "../../src/operations-packs/handlers/types.js";

const FIELDS = [
  { fieldId: "title", valueKind: "string" as const },
  { fieldId: "year", valueKind: "integer" as const },
];
const BOUNDS = { maximumItems: 4 };

/** Encode a response body the way a provider would return it. */
function response(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body), "utf8");
}

/** Decode one well-formed response with a single item. */
function decodeOne(item: Record<string, unknown>) {
  return decodeProviderResponse(response({ items: [item] }), FIELDS, BOUNDS);
}

describe("decoding a well-formed response", () => {
  it("admits exactly the declared fields, keyed by the provider's item id", () => {
    expect(decodeOne({ itemId: "paper-1", title: "Alpha", year: 2024 }))
      .toEqual([{ itemId: "paper-1", fields: { title: "Alpha", year: 2024 } }]);
  });

  it("preserves response order, so a phase's output is deterministic", () => {
    const decoded = decodeProviderResponse(response({
      items: [
        { itemId: "b", title: "Beta", year: 2023 },
        { itemId: "a", title: "Alpha", year: 2024 },
      ],
    }), FIELDS, BOUNDS);
    expect(decoded.map((item) => item.itemId)).toEqual(["b", "a"]);
  });
});

describe("a deviating response is REFUSED, never repaired", () => {
  it("refuses a missing declared field rather than defaulting it", () => {
    expect(() => decodeOne({ itemId: "paper-1", title: "Alpha" })).toThrow(PackHostHandlerError);
  });

  it("refuses a wrong scalar kind rather than coercing it", () => {
    // "2024" is not an integer. Coercing would let the provider decide the
    // evidence's types, and a later reconcile compares by exact payload.
    expect(() => decodeOne({ itemId: "paper-1", title: "Alpha", year: "2024" })).toThrow(PackHostHandlerError);
  });

  it("refuses a non-integer where an integer is declared", () => {
    expect(() => decodeOne({ itemId: "paper-1", title: "Alpha", year: 2024.5 })).toThrow(PackHostHandlerError);
  });

  it("refuses a non-finite number, which canonical digesting cannot represent", () => {
    // Admitting it would throw later, further from the cause.
    const raw = Buffer.from('{"items":[{"itemId":"p","title":"A","year":1e999}]}', "utf8");
    expect(() => decodeProviderResponse(raw, FIELDS, BOUNDS)).toThrow(PackHostHandlerError);
  });

  it("refuses an UNDECLARED field rather than dropping it", () => {
    // Silently discarding it would hide a provider answering a different
    // question than the one the sealed plan asked.
    expect(() => decodeOne({ itemId: "paper-1", title: "Alpha", year: 2024, extra: "x" }))
      .toThrow(/undeclared field/);
  });

  it("refuses an item with no identity", () => {
    expect(() => decodeOne({ title: "Alpha", year: 2024 })).toThrow(/itemId/);
  });

  it("refuses repeated identities, which would collapse in every later phase", () => {
    expect(() => decodeProviderResponse(response({
      items: [
        { itemId: "same", title: "Alpha", year: 2024 },
        { itemId: "same", title: "Beta", year: 2023 },
      ],
    }), FIELDS, BOUNDS)).toThrow(/repeats an item identity/);
  });

  it("refuses an oversized response instead of truncating it", () => {
    // A truncated answer read as a complete one is a completeness lie the
    // reconcile phase downstream cannot detect.
    const items = Array.from({ length: 5 }, (_, index) => ({
      itemId: `p${index}`, title: "A", year: 2024,
    }));
    expect(() => decodeProviderResponse(response({ items }), FIELDS, BOUNDS))
      .toThrow(/item ceiling/);
  });

  it("refuses bytes that are not JSON, and an object with no items array", () => {
    expect(() => decodeProviderResponse(Buffer.from("not json", "utf8"), FIELDS, BOUNDS))
      .toThrow(/not valid JSON/);
    expect(() => decodeProviderResponse(response({ entities: [] }), FIELDS, BOUNDS))
      .toThrow(/no items array/);
  });
});
