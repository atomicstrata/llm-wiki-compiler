/**
 * @file test/operations-packs/pack-input-default.test.ts
 * @description An action input field's declared `default` must pass the SAME
 * kind + bounds validator as a caller value (design section 14.2). An over-long
 * string default, an out-of-range integer default, and an off-set enum default
 * each fail closed; an in-bounds default is accepted. Removing the P2-A default
 * validation reddens the over-long / out-of-range / off-set cases, which the
 * structural scalar reader alone would let through.
 */

import { describe, expect, it } from "vitest";
import { parseOperationsPack } from "../../src/operations-packs/parse.js";
import { PackParseError } from "../../src/operations-packs/problems.js";
import { buildPack, serialize } from "./pack-fixture.js";

const text = serialize(buildPack());
const COMMON = { required: true, overridable: true, sensitivityDisplay: "normal" };

/** Give the demo action one probe input field, then parse the mutated pack. */
function withProbe(field: Record<string, unknown>): () => void {
  const obj = JSON.parse(text);
  obj.actions["demo.run"].inputSchema.probe = field;
  return () => parseOperationsPack(JSON.stringify(obj));
}

describe("operations pack input defaults", () => {
  it("rejects an over-long string default", () => {
    expect(withProbe({ ...COMMON, kind: "string", maxBytes: 1, default: "far too long" })).toThrow(PackParseError);
  });

  it("rejects an out-of-range integer default", () => {
    expect(withProbe({ ...COMMON, kind: "integer", minimum: 0, maximum: 10, default: 99 })).toThrow(PackParseError);
  });

  it("rejects an enum default outside the closed set", () => {
    expect(withProbe({ ...COMMON, kind: "enum", values: ["alpha", "beta"], default: "gamma" })).toThrow(PackParseError);
  });

  it("rejects an over-long item in a string-list default", () => {
    expect(withProbe({ ...COMMON, kind: "string-list", maxItems: 4, maxItemBytes: 2, default: ["ok", "toolong"] })).toThrow(PackParseError);
  });

  it("accepts an in-bounds default for string, integer, and enum kinds", () => {
    expect(withProbe({ ...COMMON, kind: "string", maxBytes: 32, default: "ok" })).not.toThrow();
    expect(withProbe({ ...COMMON, kind: "integer", minimum: 0, maximum: 10, default: 5 })).not.toThrow();
    expect(withProbe({ ...COMMON, kind: "enum", values: ["alpha", "beta"], default: "alpha" })).not.toThrow();
  });
});
