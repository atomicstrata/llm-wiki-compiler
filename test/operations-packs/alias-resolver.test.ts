/**
 * @file test/operations-packs/alias-resolver.test.ts
 * @description The invocation-token resolver (design section 19.1, WOP-INV-21).
 *
 * TWO CLASSES OF CASE, deliberately. Most drive a pack through the REAL
 * `composeSingleRoot`, so what the resolver sees is what composition produced.
 * A few hand the resolver a (pack, graph) pair composition would have REFUSED —
 * an alias reaching an unexposed surface, an alias absent from the export table
 * — because those prove the resolver's own controls hold independently rather
 * than being carried by the upstream check. A control that only ever sees inputs
 * a prior gate already filtered has no measured strength of its own.
 */

import { describe, expect, it } from "vitest";
import { resolveActionToken } from "../../src/operations-packs/aliases.js";
import { composeSingleRoot } from "../../src/operations-packs/composition.js";
import type {
  AliasDescriptorV1, ComposedGraphV1, InvocationSurfaceV1, WorkspaceOperationsPackV2,
} from "../../src/operations-packs/types.js";
import { buildPack } from "./pack-fixture.js";

const ACTION_ID = "demo.run";

/** The shared pack with its alias list replaced, so each case names its own. */
function packWithAliases(aliases: AliasDescriptorV1[]): WorkspaceOperationsPackV2 {
  const pack = buildPack();
  pack.aliases = aliases;
  return pack;
}

/** Resolve one token against the REAL composed graph of `pack`. */
function resolveComposed(pack: WorkspaceOperationsPackV2, token: string, surface: InvocationSurfaceV1) {
  return resolveActionToken({ pack, composed: composeSingleRoot(pack), token, surface });
}

/** A hand-built graph exposing exactly the named action and alias ids. */
function graphOf(actionIds: string[], aliasIds: string[]): ComposedGraphV1 {
  const row = (kind: "action" | "alias", exposedId: string) => ({
    kind, exposedId, sourcePackDigest: `sha256:${"1".repeat(64)}` as never,
    sourceId: exposedId, objectDigest: `sha256:${"2".repeat(64)}` as never,
  });
  return {
    rootPackDigest: `sha256:${"3".repeat(64)}` as never, members: [],
    resolvedExports: [...actionIds.map((id) => row("action", id)), ...aliasIds.map((id) => row("alias", id))],
  };
}

describe("invocation token resolution", () => {
  it("resolves a canonical action id on the caller's own surface", () => {
    const resolved = resolveComposed(packWithAliases([]), ACTION_ID, "sdk");
    expect(resolved).toEqual({ status: "resolved", actionId: ACTION_ID, requestedSurface: "sdk", route: "action-id" });
  });

  it("resolves an alias to the same action and the same surface as the direct id", () => {
    const pack = packWithAliases([{ aliasId: "a1", surface: "sdk", token: "draft", actionId: ACTION_ID }]);
    const direct = resolveComposed(pack, ACTION_ID, "sdk");
    const alias = resolveComposed(pack, "draft", "sdk");
    if (direct.status !== "resolved" || alias.status !== "resolved") throw new Error("expected both to resolve");
    // THE PAIR the compiler is called with, not merely the action id: the
    // surface selects the capability ceiling sealed into the plan.
    expect(alias.actionId).toBe(direct.actionId);
    expect(alias.requestedSurface).toBe(direct.requestedSurface);
    expect(alias.aliasId).toBe("a1");
  });

  it("resolves an agent alias through its declared transport surface", () => {
    const pack = packWithAliases([
      { aliasId: "a1", surface: "agent", transportSurface: "sdk", token: "draft", actionId: ACTION_ID },
    ]);
    const resolved = resolveComposed(pack, "draft", "sdk");
    expect(resolved).toMatchObject({ status: "resolved", actionId: ACTION_ID, requestedSurface: "sdk" });
  });

  it("does not resolve an alias whose transport is a different surface", () => {
    const pack = packWithAliases([{ aliasId: "a1", surface: "cli", token: "draft", actionId: ACTION_ID }]);
    expect(resolveComposed(pack, "draft", "sdk")).toMatchObject({ status: "refused", code: "unknown-token" });
  });

  it("refuses a token no action or alias declares", () => {
    expect(resolveComposed(packWithAliases([]), "nope", "sdk"))
      .toMatchObject({ status: "refused", code: "unknown-token" });
  });

  it("refuses a token that is both an action id and an alias on this surface", () => {
    const pack = packWithAliases([{ aliasId: "a1", surface: "sdk", token: ACTION_ID, actionId: ACTION_ID }]);
    expect(resolveComposed(pack, ACTION_ID, "sdk")).toMatchObject({ status: "refused", code: "ambiguous-token" });
  });

  it("refuses two aliases claiming one token on one transport", () => {
    // DISTINCT under composition's (surface, host, locale, token) uniqueness rule
    // — a `sdk` alias and an `agent` alias transported over `sdk` — and both
    // reach an SDK caller, so only this resolver can catch the collision.
    const pack = packWithAliases([
      { aliasId: "a1", surface: "sdk", token: "draft", actionId: ACTION_ID },
      { aliasId: "a2", surface: "agent", transportSurface: "sdk", token: "draft", actionId: ACTION_ID },
    ]);
    expect(resolveComposed(pack, "draft", "sdk")).toMatchObject({ status: "refused", code: "ambiguous-token" });
  });

  it("refuses an alias declaring default inputs", () => {
    const pack = packWithAliases([
      { aliasId: "a1", surface: "sdk", token: "draft", actionId: ACTION_ID, defaultInputs: { topic: "physics" } },
    ]);
    expect(resolveComposed(pack, "draft", "sdk"))
      .toMatchObject({ status: "refused", code: "alias-default-inputs-deferred" });
  });

  it("admits an alias whose default inputs are declared but empty", () => {
    const pack = packWithAliases([
      { aliasId: "a1", surface: "sdk", token: "draft", actionId: ACTION_ID, defaultInputs: {} },
    ]);
    expect(resolveComposed(pack, "draft", "sdk")).toMatchObject({ status: "resolved", actionId: ACTION_ID });
  });

  it("refuses a direct id on a surface the action does not expose", () => {
    // The shared fixture's action declares caps for `cli` and `sdk` only.
    expect(resolveComposed(packWithAliases([]), ACTION_ID, "mcp"))
      .toMatchObject({ status: "refused", code: "surface-not-exposed" });
  });

  it("refuses an alias reaching a surface the action does not expose", () => {
    // Composition refuses this pack outright, so the graph is hand-built: the
    // resolver's own surface check must hold without that upstream gate.
    const pack = packWithAliases([{ aliasId: "a1", surface: "mcp", token: "draft", actionId: ACTION_ID }]);
    const resolved = resolveActionToken({
      pack, composed: graphOf([ACTION_ID], ["a1"]), token: "draft", surface: "mcp",
    });
    expect(resolved).toMatchObject({ status: "refused", code: "surface-not-exposed" });
  });

  it("refuses an action the composed export table does not expose", () => {
    // THE GRAPH IS THE EXPOSURE AUTHORITY. The pack declares the action; the
    // export table does not, and a resolver reading the pack directly would be a
    // second index that could disagree with the one composition validated.
    const resolved = resolveActionToken({
      pack: packWithAliases([]), composed: graphOf([], []), token: ACTION_ID, surface: "sdk",
    });
    expect(resolved).toMatchObject({ status: "refused", code: "unknown-token" });
  });

  it("refuses an alias whose target the export table does not expose", () => {
    const pack = packWithAliases([{ aliasId: "a1", surface: "sdk", token: "draft", actionId: ACTION_ID }]);
    const resolved = resolveActionToken({
      pack, composed: graphOf([], ["a1"]), token: "draft", surface: "sdk",
    });
    expect(resolved).toMatchObject({ status: "refused", code: "unknown-token" });
  });
});
