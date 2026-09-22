/**
 * @file test/preparation-reset-cli-only.test.ts
 * @description D-10-14's MANDATORY mutation test: `reset` is CLI-only, and the
 * restriction is enforced at the door rather than on the menu.
 *
 * THE CONTROL THIS REPLACES TESTED THE WRONG THING, and that is why the plan
 * names this one specifically. The superseded design kept reset off the SDK by
 * omitting it from the facade and pinning that omission with a registry-absence
 * test. But `createPreparationService` is a public export, and reset costs
 * `preparation.quarantine` — the SAME token an SDK or MCP host legitimately
 * holds for `prune` and `sweep`. So any embedder could construct the service
 * itself and call reset directly: the control certified the menu while the door
 * stood open, and a green run said nothing about the boundary.
 *
 * SO THE PRIMARY CASE CONSTRUCTS THE SERVICE EXACTLY AS THE SDK DOES — not a
 * facade, not a CLI host, but `createPreparationService` with `surface: "sdk"`
 * and a resolver assigning the destructive grant — and watches reset refuse.
 * That is the shape of the attack, so it is the shape of the control.
 *
 * THE GRANT IS PROVED PRESENT AND EFFECTIVE, and this is the half that makes the
 * refusal mean something. A refusal proves nothing if the principal could not
 * have done anything anyway, so the SAME service and the SAME principal call
 * `sweep` and succeed. Whatever stopped reset, it was not the authority.
 *
 * AND THE PRECONDITION IS PINNED FROM THE OTHER SIDE: the identical request on a
 * `cli` service — with a principal holding NO explicit grants at all, which is
 * how `host.ts` really builds it — records the intent. One variable differs
 * between the two, and it is the surface.
 *
 * OBSERVING A THROW IS NOT OBSERVING A REFUSAL. A door that rejects AFTER doing
 * the work satisfies a rejection assertion perfectly, so every refusal here is
 * paired with a durable read: no reset unit exists, and the key is untouched.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPreparationService } from "../src/preparations/service.js";
import { PreparationSurfaceError } from "../src/preparations/service.js";
import type {
  PreparationPrincipal, PreparationServiceV1, PreparationSurface,
} from "../src/preparations/service.js";
import { buildPreparationFacade } from "../src/sdk/preparation-facade.js";
import { PREPARATION_QUARANTINE_SEGMENT, preparationKeyFile } from "../src/preparations/paths.js";
import { MISSING_KEY_CONFIRMATION } from "../src/preparations/reset.js";
import { removePreparationKey, stagePreparation } from "./preparations/lifecycle-fixture.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "prep-reset-surface-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/**
 * The service as a NON-CLI host constructs it, holding the destructive token.
 *
 * This is the exploit, written out: nothing here is a facade, and nothing here
 * is privileged. It is the public constructor, a surface an embedder names, and
 * the grant an embedder legitimately holds for `prune` and `sweep`.
 */
function serviceOn(surface: PreparationSurface, id = "sdk-consumer"): PreparationServiceV1 {
  const principal = { id, surface, grants: ["preparation.quarantine"] } as PreparationPrincipal;
  return createPreparationService({ root, surface, principals: { principalFor: () => principal } });
}

/** The service as `host.ts` builds it: `cli`, and no explicit grants at all. */
function cliService(): PreparationServiceV1 {
  const principal = { id: "cli-operator", surface: "cli", grants: [] } as PreparationPrincipal;
  return createPreparationService({
    root, surface: "cli", principals: { principalFor: () => principal },
  });
}

/** A project whose preparation key is gone — a real reset would be eligible. */
async function strandedProject(): Promise<void> {
  await stagePreparation(root);
  await removePreparationKey(root);
}

/** Every `rst-…` unit the project currently holds. */
async function resetUnits(): Promise<string[]> {
  const quarantine = path.join(root, ".llmwiki", PREPARATION_QUARANTINE_SEGMENT);
  const entries = await readdir(quarantine).catch(() => [] as string[]);
  return entries.filter((entry) => entry.startsWith("rst-"));
}

describe("reset refuses every surface but the CLI", () => {
  it("refuses an SDK host holding the destructive grant, and writes nothing", async () => {
    await strandedProject();
    await expect(serviceOn("sdk").reset({ confirmation: MISSING_KEY_CONFIRMATION }))
      .rejects.toBeInstanceOf(PreparationSurfaceError);
    // THE DURABLE HALF. A door that refused after recording the intent would
    // satisfy the rejection above and would have wedged the project anyway.
    expect(await resetUnits()).toEqual([]);
  });

  it("refuses an MCP host on the same terms", async () => {
    await strandedProject();
    await expect(serviceOn("mcp").reset({ confirmation: MISSING_KEY_CONFIRMATION }))
      .rejects.toBeInstanceOf(PreparationSurfaceError);
    expect(await resetUnits()).toEqual([]);
  });

  it("names the surface it refused, rather than blaming the principal", async () => {
    await strandedProject();
    // THE MESSAGE IS PART OF THE CONTRACT here, because the failure this class
    // exists to avoid is telling a correctly-granted host that its PRINCIPAL is
    // invalid. An embedder who reads that goes looking at its grant set, which
    // is the one thing that was never the problem.
    await expect(serviceOn("sdk").reset({ confirmation: MISSING_KEY_CONFIRMATION }))
      .rejects.toThrow(/available only on the cli surface/u);
  });
});

describe("the refusal is about the surface and nothing else", () => {
  it("lets the SAME principal on the SAME service run a destructive sweep", async () => {
    // POSITIVE EVIDENCE THAT THE GRANT IS HELD AND EFFECTIVE. Without this, the
    // refusals above are equally consistent with an SDK principal that could not
    // have done anything at all, and the control would prove nothing about
    // reset in particular.
    await stagePreparation(root);
    const outcome = await serviceOn("sdk").sweep();
    expect(outcome.status).not.toBe("refused");
  });

  it("records the intent for the SAME request on the cli surface", async () => {
    // THE PRECONDITION, PINNED FROM THE OTHER SIDE. Delete the fault — the
    // non-cli surface — and the call must succeed; otherwise every refusal above
    // could be a refusal of something else entirely, and the control would pass
    // against code that simply never resets.
    await strandedProject();
    const outcome = await cliService().reset({ confirmation: MISSING_KEY_CONFIRMATION });
    expect(outcome).toMatchObject({ status: "intent-recorded" });
    expect(await resetUnits()).toHaveLength(1);
  });
});

describe("the facade absence is the SECONDARY control, and it is exact", () => {
  it("exposes no reset method on the SDK preparation surface", async () => {
    // THE COMPLETE KEY SET, not a name filter. A denylist only refuses the names
    // somebody thought of, so a future `repairPreparationKey` reaching
    // `service.reset` would pass one and fail this. The set is read off the
    // CONSTRUCTED facade rather than a declared list, so it is what an embedder
    // actually holds.
    const facade = buildPreparationFacade(root, async (fn) => fn(), { id: "sdk", grants: [] });
    expect(Object.keys(facade).sort()).toEqual([
      "cancelPreparation", "failPreparation", "gatePreparation", "handoffPreparation",
      "listPreparations", "pausePreparation", "previewPreparation", "prunePreparation",
      "recoverPreparation", "resumePreparation", "showPreparation", "stagePreparation",
      "sweepPreparations",
    ]);
  });

  it("is an absence on the FACADE, not on the service the facade wraps", async () => {
    // ANTI-VACUITY, and it is the difference between this control and the one it
    // replaces. The method really does exist on an sdk-surface service — that is
    // exactly why the facade's silence cannot be the boundary — so the set above
    // is a statement about the menu while the cases above are about the door.
    expect(typeof serviceOn("sdk").reset).toBe("function");
  });
});

describe("the key is untouched by a refused reset", () => {
  it("leaves a healthy project's key exactly as it was", async () => {
    await stagePreparation(root);
    const before = await readFile(preparationKeyFile(root));
    await expect(serviceOn("sdk").reset({ confirmation: MISSING_KEY_CONFIRMATION }))
      .rejects.toBeInstanceOf(PreparationSurfaceError);
    expect(await readFile(preparationKeyFile(root))).toEqual(before);
  });
});
