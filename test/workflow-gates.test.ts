/**
 * @file test/workflow-gates.test.ts
 * @description Unit tests for the shared gate parser ({@link parseGate} /
 * {@link isTrustGate}) the workflow surfaces consolidate onto. Pins the
 * fail-closed grammar: a well-formed known-kind gate parses; a malformed or
 * unknown-kind gate is `null`; the `trust:` prefix check matches only trust gates.
 */

import { describe, it, expect } from "vitest";
import { parseGate, isTrustGate, GATE_KINDS } from "../src/workflows/gates.js";

describe("parseGate", () => {
  it("parses each recognized kind into { kind, id }", () => {
    for (const kind of GATE_KINDS) {
      expect(parseGate(`${kind}:approve`)).toEqual({ kind, id: "approve" });
    }
  });

  it("keeps only the FIRST colon as the kind/id boundary", () => {
    expect(parseGate("trust:a:b")).toEqual({ kind: "trust", id: "a:b" });
  });

  it("returns null for an unknown kind", () => {
    expect(parseGate("system:x")).toBeNull();
    expect(parseGate("robot:x")).toBeNull();
  });

  it("returns null for a malformed string (no colon, empty kind, or empty id)", () => {
    expect(parseGate("human")).toBeNull();
    expect(parseGate(":id")).toBeNull();
    expect(parseGate("human:")).toBeNull();
  });
});

describe("isTrustGate", () => {
  it("is true only for a trust: gate", () => {
    expect(isTrustGate("trust:high")).toBe(true);
    expect(isTrustGate("human:x")).toBe(false);
    expect(isTrustGate("agent:x")).toBe(false);
  });

  it("is false for an undefined (gate-less) stage", () => {
    expect(isTrustGate(undefined)).toBe(false);
  });
});
