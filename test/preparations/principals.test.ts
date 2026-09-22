/**
 * @file test/preparations/principals.test.ts
 * @description Transport-independent preparation principal authority (design
 * section 17.2). A local CLI invocation holds the local-operator preparation
 * grants by transport; SDK and MCP callers hold only explicit grants and a
 * missing grant fails closed; `operation-bundle.approve` is never implied; and a
 * forged, accessor-bearing, or unknown-token principal is rejected before any
 * authority decision.
 */

import { describe, expect, it } from "vitest";
import {
  capturePreparationPrincipal, effectivePreparationGrants, PREPARATION_GRANTS,
  PREPARATION_SURFACES, PrincipalAuthorityError, principalHasGrant,
  requirePreparationGrant, type PreparationPrincipal,
} from "../../src/preparations/principals.js";

const cli: PreparationPrincipal = { id: "operator", surface: "cli", grants: [] };
const sdk: PreparationPrincipal = { id: "svc", surface: "sdk", grants: [] };

describe("preparation principal authority", () => {
  it("closes the surface and grant vocabularies to their exact contract", () => {
    expect([...PREPARATION_SURFACES]).toEqual(["cli", "sdk", "mcp"]);
    expect([...PREPARATION_GRANTS]).toEqual([
      "preparation.run", "preparation.gate.decide", "preparation.effect.approve", "preparation.cancel",
      "preparation.recovery", "preparation.abandon", "preparation.quarantine", "operation-bundle.approve",
    ]);
  });

  it("gives a CLI invocation local-operator authority by transport", () => {
    const grants = effectivePreparationGrants(cli);
    expect(grants.has("preparation.gate.decide")).toBe(true);
    expect(grants.has("preparation.effect.approve")).toBe(true);
    expect(() => requirePreparationGrant(cli, "preparation.recovery")).not.toThrow();
  });

  it("never implies operation-bundle.approve, even for CLI", () => {
    expect(principalHasGrant(cli, "operation-bundle.approve")).toBe(false);
    expect(() => requirePreparationGrant(cli, "operation-bundle.approve")).toThrow(PrincipalAuthorityError);
  });

  it("fails an SDK caller closed without an explicit grant", () => {
    expect(() => requirePreparationGrant(sdk, "preparation.gate.decide")).toThrow(/missing-grant/);
    expect(principalHasGrant({ ...sdk, grants: ["preparation.gate.decide"] }, "preparation.gate.decide")).toBe(true);
  });

  it("does not let an SDK grant bleed into a different authority", () => {
    const scoped = { ...sdk, grants: ["preparation.gate.decide"] as const };
    expect(() => requirePreparationGrant(scoped, "preparation.effect.approve")).toThrow(/missing-grant/);
  });

  it("rejects an unknown surface and an unknown grant token", () => {
    expect(() => capturePreparationPrincipal({ id: "x", surface: "web", grants: [] })).toThrow(/invalid-principal/);
    expect(() => capturePreparationPrincipal({ id: "x", surface: "sdk", grants: ["wiki.admin"] })).toThrow(/invalid-principal/);
  });

  it("rejects an accessor-bearing or proxied principal record", () => {
    const hostile = Object.defineProperty({ surface: "cli", grants: [] } as Record<string, unknown>, "id", {
      enumerable: true, get: () => "operator",
    });
    expect(() => capturePreparationPrincipal(hostile)).toThrow(PrincipalAuthorityError);
    const proxy = new Proxy({ id: "operator", surface: "cli", grants: [] }, {});
    expect(() => capturePreparationPrincipal(proxy)).toThrow(PrincipalAuthorityError);
  });
});
