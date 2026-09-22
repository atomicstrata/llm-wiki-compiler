/**
 * @file test/operations-packs/composition.test.ts
 * @description Single-root composition (design section 11.3) flattens the export
 * table across kinds without mutating the pack bytes, sorts it canonically, and
 * fails closed on a colliding destination id, an alias to an unknown action, an
 * alias-invocation collision, an undeclared provider-role reference (from a recipe
 * provider phase or the workspace contract), and a deferred configuration-flow reference.
 */

import { describe, expect, it } from "vitest";
import { composeSingleRoot } from "../../src/operations-packs/composition.js";
import { parseOperationsPack } from "../../src/operations-packs/parse.js";
import { PackDeferredError, PackParseError } from "../../src/operations-packs/problems.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { buildPack, serialize } from "./pack-fixture.js";

const text = serialize(buildPack());

describe("single-root composition", () => {
  it("flattens the export table across kinds", () => {
    const graph = composeSingleRoot(parseOperationsPack(text));
    const ids = graph.resolvedExports.map((row) => `${row.kind}:${row.exposedId}`);
    expect(ids).toContain("action:demo.run");
    expect(ids).toContain("recipe:demo.prepare");
    expect(ids).toContain("alias:run");
    expect(ids).toContain("provider-requirement:primary-model");
  });

  it("recomputes the export table without mutating the pack bytes", () => {
    const pack = parseOperationsPack(text);
    const before = canonicalBytes(pack);
    composeSingleRoot(pack);
    expect(canonicalBytes(pack).equals(before)).toBe(true);
  });

  it("sorts the export table by canonical identity", () => {
    const keys = composeSingleRoot(parseOperationsPack(text)).resolvedExports.map((row) => `${row.kind}|${row.exposedId}`);
    expect([...keys].sort()).toEqual(keys);
  });

  it("rejects a colliding destination id across kinds", () => {
    const clash = JSON.parse(text);
    clash.recipes["demo.run"] = { ...clash.recipes["demo.prepare"], recipeId: "demo.run" };
    expect(() => composeSingleRoot(parseOperationsPack(JSON.stringify(clash)))).toThrow(PackParseError);
  });

  it("rejects an alias targeting an unknown action", () => {
    const bad = JSON.parse(text);
    bad.aliases[0].actionId = "demo.missing";
    expect(() => composeSingleRoot(parseOperationsPack(JSON.stringify(bad)))).toThrow(PackParseError);
  });

  it("rejects two aliases sharing one invocation", () => {
    const dup = JSON.parse(text);
    dup.aliases.push({ aliasId: "run2", surface: "cli", token: "run", actionId: "demo.run" });
    expect(() => composeSingleRoot(parseOperationsPack(JSON.stringify(dup)))).toThrow(PackParseError);
  });

  it("rejects an alias to a surface the action does not expose", () => {
    const bad = JSON.parse(text);
    bad.aliases[0].surface = "mcp";
    expect(() => composeSingleRoot(parseOperationsPack(JSON.stringify(bad)))).toThrow(PackParseError);
  });

  it("refuses a configuration action as a deferred flow reference", () => {
    const cfg = JSON.parse(text);
    cfg.actions["demo.run"].execution = { kind: "configuration", flowRef: "demo.flow" };
    expect(() => composeSingleRoot(parseOperationsPack(JSON.stringify(cfg)))).toThrow(PackDeferredError);
  });

  it("rejects a recipe provider phase referencing an unknown provider role", () => {
    const bad = JSON.parse(text);
    const phases: Array<{ kind: string; body: { providerRoleId: string } }> = bad.recipes["demo.prepare"].phases;
    phases.find((phase) => phase.kind === "provider")!.body.providerRoleId = "ghost-role";
    expect(() => composeSingleRoot(parseOperationsPack(JSON.stringify(bad)))).toThrow(PackParseError);
  });

  it("rejects a workspace contract requiring an undeclared provider capability role", () => {
    const bad = JSON.parse(text);
    bad.workspaceContract.requiredProviderCapabilityRoles = ["unknown-role"];
    expect(() => composeSingleRoot(parseOperationsPack(JSON.stringify(bad)))).toThrow(PackParseError);
  });
});
