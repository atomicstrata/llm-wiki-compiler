/**
 * @file test/products/product-readiness-no-read.test.ts
 * @description One control: a readiness review with nothing to check must not
 * read operator credential state at all.
 *
 * WHY IT OBSERVES THE CALL RATHER THAN THE RESULT. Reading the registry through
 * an unusable path does not throw — the reader catches and reports `unreadable`
 * — so with zero dimensions the returned report is byte-identical whether the
 * short-circuit exists or not. A control asserting on the result therefore
 * passes with the short-circuit REMOVED, which is no control at all. The only
 * observable difference is whether the read happened, so that is what this
 * asserts.
 *
 * IT MATTERS BECAUSE THE READ IS NOT FREE. Resolving provider paths creates the
 * operator's config and cache roots, so a review of a product that declares no
 * optional capabilities would leave host directories behind — invisible to any
 * project-tree snapshot.
 *
 * SO THE GUARANTEE IS SCOPED, and stating it precisely matters: `product status`
 * does not change PROJECT OR WIKI KNOWLEDGE STATE. It is not "changes nothing"
 * in the absolute — a nonempty readiness declaration legitimately creates those
 * operator config and cache directories as a side effect of resolving what it
 * was asked to check. This control pins the case where there is nothing to
 * resolve, so the directories are not created for a product that asked for no
 * capability at all.
 *
 * The double lives in its own file because `vi.mock` is module-scoped: the
 * neighbouring suite must keep calling the REAL reader.
 */

import { describe, expect, it, vi } from "vitest";

const readCredentialRegistryState = vi.fn(async () => ({ kind: "absent" as const }));
vi.mock("../../src/capability-providers/authority/credentials.js", () => ({
  readCredentialRegistryState,
}));

const { reviewProductReadiness } = await import("../../src/products/readiness.js");
type Paths = Parameters<typeof reviewProductReadiness>[0];

describe("a review with nothing to check", () => {
  it("never reads the credential registry when no dimension is declared", async () => {
    readCredentialRegistryState.mockClear();
    const report = await reviewProductReadiness({} as Paths, []);
    expect(report).toEqual({ items: [], declaresNoOptionalCapabilities: true });
    expect(readCredentialRegistryState).not.toHaveBeenCalled();
  });

  it("DOES read it when a dimension declares a slot — the control's own precondition", async () => {
    // Without this, the assertion above would pass on a module that never reads
    // the registry under any circumstances, proving nothing about the guard.
    readCredentialRegistryState.mockClear();
    await reviewProductReadiness({} as Paths, [{ dimensionId: "d", credentialSlotId: "s" }]);
    expect(readCredentialRegistryState).toHaveBeenCalledTimes(1);
  });
});
