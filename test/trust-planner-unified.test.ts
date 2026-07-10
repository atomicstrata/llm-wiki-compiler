/**
 * @file test/trust-planner-unified.test.ts
 * @description Coverage for the UNIFIED, discriminated-target
 * {@link planPageMutation} (`src/trust/planner.ts`). One entry point now plans
 * BOTH default raw pages (`{ kind: "raw", directory, slug }` — no EntityId,
 * Unicode-tolerant filename floor) and typed profile entity pages
 * (`{ kind: "entity", entityType, slug }` — mints a branded EntityId, slug-safe
 * grammar). The discriminant selects the identity floor and target shape; the
 * shared floor→compose→build core is unchanged.
 */

import { describe, it, expect } from "vitest";
import { planPageMutation } from "../src/trust/planner.js";
import { COMPILE_ORIGIN } from "../src/trust/checks.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

describe("unified planPageMutation", () => {
  it("plans a raw default page (no EntityId)", async () => {
    const root = await makeTempRoot("planner-unified-raw");
    const r = await planPageMutation({
      root,
      target: { kind: "raw", directory: "concepts", slug: "café-society" },
      body: "---\ntitle: X\n---\n\nbody\n",
      origin: COMPILE_ORIGIN,
      reviewRouted: false,
      allowOverwrite: true,
    });
    expect(r.decision).toBe("allow");
    expect(r.planned[0].target).toEqual({ directory: "concepts", slug: "café-society" });
  });

  it("plans a typed entity page (mints EntityId) and blocks an unsafe slug", async () => {
    const root = await makeTempRoot("planner-unified-entity");
    const ok = await planPageMutation({
      root,
      target: { kind: "entity", entityType: "papers", slug: "attention" },
      body: "---\ntitle: X\n---\n\nb\n",
      origin: "agent",
      reviewRouted: false,
    });
    expect("id" in ok.planned[0].target).toBe(true);
    const bad = await planPageMutation({
      root,
      target: { kind: "entity", entityType: "papers", slug: "../escape" },
      body: "b",
      origin: "agent",
      reviewRouted: false,
    });
    expect(bad.planned).toHaveLength(0); // invalid-identity → block, no throw
  });
});
