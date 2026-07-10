/**
 * @file test/workflow-authority.test.ts
 * @description Exhaustive tests for the PURE action authority model.
 *
 * Covers the three independent inputs (profileRequested, localGrant,
 * surfaceHardCap) composed most-restrictive-wins, plus the human-gate predicate.
 * The invariants under test: a profile can NEVER raise authority (result ≤ the
 * surface cap and ≤ the profile request); `disabled` in ANY input ⇒ disabled;
 * `minCapability` is total, order-independent, and disabled-dominant; MCP can
 * never trusted-write or satisfy a human gate.
 */

import { describe, it, expect } from "vitest";
import {
  CAPABILITY_ORDER,
  SURFACE_HARD_CAP,
  minCapability,
  effectivePermission,
  canSatisfyHumanGate,
} from "../src/workflows/authority.js";
import type { CapabilityClass, ActionSurface } from "../src/profile/types.js";

const CAPS = CAPABILITY_ORDER;
const SURFACES: ActionSurface[] = ["cli", "sdk", "mcp", "viewer"];

/** Ordinal index of a capability in the canonical order. */
function rank(cap: CapabilityClass): number {
  return CAPABILITY_ORDER.indexOf(cap);
}

describe("minCapability", () => {
  it("returns the single argument unchanged", () => {
    for (const cap of CAPS) expect(minCapability(cap)).toBe(cap);
  });

  it("returns the lowest-ordinal of every pair", () => {
    for (const a of CAPS)
      for (const b of CAPS)
        expect(minCapability(a, b)).toBe(rank(a) <= rank(b) ? a : b);
  });

  it("is order-independent (commutative)", () => {
    for (const a of CAPS)
      for (const b of CAPS) expect(minCapability(a, b)).toBe(minCapability(b, a));
  });

  it("short-circuits to disabled whenever any input is disabled", () => {
    for (const cap of CAPS) {
      expect(minCapability("disabled", cap)).toBe("disabled");
      expect(minCapability(cap, "disabled")).toBe("disabled");
    }
  });

  it("returns disabled (fail closed) for an empty arg list", () => {
    expect(minCapability()).toBe("disabled");
  });

  it("treats an unknown capability as disabled (fail closed)", () => {
    expect(minCapability("bogus" as CapabilityClass, "trusted-write")).toBe("disabled");
  });
});

describe("SURFACE_HARD_CAP", () => {
  it("caps cli/sdk at trusted-write and mcp/viewer at staged-write", () => {
    expect(SURFACE_HARD_CAP.cli).toBe("trusted-write");
    expect(SURFACE_HARD_CAP.sdk).toBe("trusted-write");
    expect(SURFACE_HARD_CAP.mcp).toBe("staged-write");
    expect(SURFACE_HARD_CAP.viewer).toBe("staged-write");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(SURFACE_HARD_CAP)).toBe(true);
  });
});

describe("effectivePermission", () => {
  it("clamps a trusted-write profile request on mcp to staged-write (surface cap wins)", () => {
    expect(effectivePermission("trusted-write", "trusted-write", "mcp")).toBe("staged-write");
  });

  it("clamps a trusted-write profile request on viewer to staged-write", () => {
    expect(effectivePermission("trusted-write", "trusted-write", "viewer")).toBe("staged-write");
  });

  it("lets a local read-only grant clamp a trusted-write profile request", () => {
    expect(effectivePermission("trusted-write", "read-only", "cli")).toBe("read-only");
  });

  it("yields disabled when ANY input is disabled", () => {
    expect(effectivePermission("disabled", "trusted-write", "cli")).toBe("disabled");
    expect(effectivePermission("trusted-write", "disabled", "cli")).toBe("disabled");
  });

  it("never exceeds the surface cap or either runtime input", () => {
    for (const profile of CAPS)
      for (const local of CAPS)
        for (const surface of SURFACES) {
          const result = effectivePermission(profile, local, surface);
          expect(rank(result)).toBeLessThanOrEqual(rank(profile));
          expect(rank(result)).toBeLessThanOrEqual(rank(local));
          expect(rank(result)).toBeLessThanOrEqual(rank(SURFACE_HARD_CAP[surface]));
        }
  });
});

describe("canSatisfyHumanGate", () => {
  const FLAGS = [true, false];
  /** Only surfaces whose HARD CAP is trusted-write (cli/sdk) may ever satisfy a gate. */
  const surfaceCanGate = (surface: ActionSurface): boolean =>
    SURFACE_HARD_CAP[surface] === "trusted-write";

  it("is false for mcp under EVERY permission/flag combination (even a passed trusted-write)", () => {
    for (const perm of CAPS)
      for (const profile of FLAGS)
        for (const local of FLAGS)
          expect(canSatisfyHumanGate(perm, "mcp", profile, local)).toBe(false);
  });

  it("is false for viewer under EVERY permission/flag combination (even a passed trusted-write)", () => {
    for (const perm of CAPS)
      for (const profile of FLAGS)
        for (const local of FLAGS)
          expect(canSatisfyHumanGate(perm, "viewer", profile, local)).toBe(false);
  });

  it("is false for any non-trusted-write permission even with both flags true", () => {
    const nonTrusted = CAPS.filter((c) => c !== "trusted-write");
    for (const perm of nonTrusted)
      for (const surface of SURFACES)
        expect(canSatisfyHumanGate(perm, surface, true, true)).toBe(false);
  });

  it("is true ONLY for trusted-write + a trusted-write-capped surface (cli/sdk) + both flags", () => {
    for (const surface of SURFACES) {
      const expected = surfaceCanGate(surface);
      expect(canSatisfyHumanGate("trusted-write", surface, true, true)).toBe(expected);
    }
  });

  it("requires BOTH flags even at trusted-write on a gate-capable surface", () => {
    expect(canSatisfyHumanGate("trusted-write", "cli", true, false)).toBe(false);
    expect(canSatisfyHumanGate("trusted-write", "cli", false, true)).toBe(false);
    expect(canSatisfyHumanGate("trusted-write", "cli", false, false)).toBe(false);
  });

  it("is permission- AND surface-cap-dominated across the full capability × surface × flag space", () => {
    for (const perm of CAPS)
      for (const surface of SURFACES)
        for (const profile of FLAGS)
          for (const local of FLAGS) {
            const expected =
              perm === "trusted-write" && surfaceCanGate(surface) && profile && local;
            expect(canSatisfyHumanGate(perm, surface, profile, local)).toBe(expected);
          }
  });
});
