import { describe, it, expect } from "vitest";
import type { PlannedMutation } from "../../src/trust/planner.js";
import type { ApplyResult } from "../../src/trust/apply-result.js";

describe("artifact planned mutation + apply result shapes", () => {
  it("constructs an artifact planned mutation", () => {
    const m: PlannedMutation = { kind: "artifact", artifactType: "experiment-result", slug: "probe", body: "{}", origin: "cli" };
    expect(m.kind).toBe("artifact");
  });
  it("constructs an artifact apply result", () => {
    const r: ApplyResult = { kind: "artifact", ref: { artifactType: "experiment-result", slug: "probe", sha256: "a".repeat(64) }, decision: "allow" };
    expect(r.kind).toBe("artifact");
  });
});
