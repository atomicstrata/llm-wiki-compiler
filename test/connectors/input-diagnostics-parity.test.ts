/**
 * @file Connector input compatibility: preserve useful public validation reasons
 * while retaining data-only capture that never invokes caller-owned accessors.
 */
import { describe, expect, it } from "vitest";
import { captureConnectorInputs } from "../../src/connectors/input-validation.js";

describe("public connector input diagnostics", () => {
  it.each([
    [{ extra: "x" }, "unknown connector input: extra"],
    [{}, "missing connector input: id"],
    [{ id: undefined }, "connector input id must be a string"],
    [{ id: "" }, "connector input id is empty"],
  ])("preserves the baseline refusal for %j", (input, reason) => {
    expect(captureConnectorInputs(["id"], input)).toEqual({ kind: "refused", reason });
  });

  it("does not invoke an accessor while producing diagnostics", () => {
    let calls = 0;
    const input = { get id() { calls += 1; return "x"; } };
    expect(captureConnectorInputs(["id"], input).kind).toBe("refused");
    expect(calls).toBe(0);
  });
});
