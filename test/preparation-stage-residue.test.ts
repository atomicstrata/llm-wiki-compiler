/**
 * @file test/preparation-stage-residue.test.ts
 * @description The durable boundary of the staging transaction: a first-ever
 * `stagePreparationLocked` that refuses must leave the project byte-identical.
 *
 * Staging cannot preflight a fresh project without a key epoch, because every
 * remaining gate measures the manifest and the manifest BINDS the epoch id. So
 * the epoch is minted in memory (`prepareKeyForEmptyEpochLocked`) and its durable
 * write is carried into the publish phase. These pins hold both halves of that
 * seam — preparing writes nothing, publishing writes exactly the key — plus the
 * ordering that makes publishing first mandatory rather than incidental.
 *
 * The CLI-visible half of the same property lives in
 * `preparation-capacity-matrix-store.test.ts`; this file owns the in-process
 * refusals and the crash state, which no CLI flag can reach.
 */

import { describe, expect, it } from "vitest";
import { canonicalBytes } from "../src/profile/templates/signing/canonical.js";
import { scanPreparationInventory } from "../src/preparations/capacity.js";
import {
  MAX_LOGICAL_PHASES_PER_PLAN, MAX_PREPARATION_MANIFEST_BYTES,
} from "../src/preparations/constants.js";
import { prepareKeyForEmptyEpochLocked } from "../src/preparations/key-epoch.js";
import { parsePreparationPlan } from "../src/preparations/plan-parse.js";
import { stagePreparationLocked } from "../src/preparations/stage.js";
import {
  KEY_LEAF, chainPlan, keyEpochOf, leafNames, storeInventory,
} from "./preparation-capacity-fixture.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { fixturePlan, stageRequest } from "./preparations/store-fixture.js";

const root = useTempRoot();

/**
 * A ceiling just above the largest manifest measured on this branch.
 *
 * Deliberately near the observation rather than near the 2 MiB cap: see the
 * capacity FINDING below for why the cap alone is not a usable tripwire.
 */
const OBSERVED_MANIFEST_CEILING_BYTES = 60_000;

/** Mint a first key epoch in memory, without publishing it. */
async function mintUnpublishedKey(dir: string) {
  const inventory = await scanPreparationInventory(dir);
  return prepareKeyForEmptyEpochLocked(dir, inventory.epoch);
}

/**
 * One refusal per structural family a first-ever staging can raise.
 *
 * They are green for DIFFERENT reasons, which is why both are here. The
 * allowance is proven from the plan alone, so its gate sits ahead of the key
 * epoch outright. The supersession edge resolves against the manifest, which
 * binds the epoch id, so its gate cannot run until the epoch exists — it passes
 * only because minting is now separate from publishing. A fresh project has no
 * manifest for that edge to resolve against, so naming a target that does not
 * exist is an ordinary user error rather than a contrived state.
 */
const FIRST_STAGE_REFUSALS = [
  {
    label: "an unresolvable supersession edge",
    request: () => stageRequest(fixturePlan((object) => {
      object.supersedesPreparationId = `prp_${"a".repeat(32)}`;
    })),
    message: /supersedes a dangling target/u,
  },
  {
    label: "the declared control allowance",
    request: () => stageRequest(fixturePlan(), { controlTransitionAllowance: 0 }),
    message: /control transition headroom/u,
  },
] as const;

describe("a refused first-ever staging", () => {
  for (const refusal of FIRST_STAGE_REFUSALS) {
    it(`writes nothing when it refuses on ${refusal.label}`, async () => {
      expect(await storeInventory(root.dir)).toEqual([]);

      await expect(stagePreparationLocked(root.dir, refusal.request()))
        .rejects.toThrow(refusal.message);

      expect(await storeInventory(root.dir)).toEqual([]);
      expect(await keyEpochOf(root.dir)).toBeNull();
    });
  }
});

describe("the key epoch seam", () => {
  it("writes nothing when a minted epoch is never published", async () => {
    // The property the whole fix rests on. If preparing wrote, every refusal
    // above would be back to leaving residue no matter where the gates sit.
    const minted = await mintUnpublishedKey(root.dir);

    expect(await storeInventory(root.dir)).toEqual([]);
    expect(await keyEpochOf(root.dir)).toBeNull();
    expect(minted.keyEpochId).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("refuses to mint over an epoch that already holds content", async () => {
    // The emptiness proof is the whole authority for minting a FIRST key, and it
    // was unpinned: deleting `assertEmptyEpochInventory` survived the full suite.
    // The message matters as much as the throw — without the proof the next
    // check refuses on the existing key instead, a different guard reached for a
    // different reason, so a bare `rejects.toThrow()` would not have noticed.
    expect((await stagePreparationLocked(root.dir, stageRequest(fixturePlan()))).status).toBe("staged");
    const populated = await scanPreparationInventory(root.dir);

    await expect(prepareKeyForEmptyEpochLocked(root.dir, populated.epoch))
      .rejects.toThrow(/requires an empty epoch inventory/u);
  });

  it("publishes exactly the key, under the identity it already minted", async () => {
    // Publication must not re-mint: the preflight above ran against this exact
    // epoch id, so a publish that generated fresh material would have validated
    // a manifest bound to an epoch that never reached disk.
    const minted = await mintUnpublishedKey(root.dir);

    await minted.publish();

    expect(leafNames(await storeInventory(root.dir))).toEqual([KEY_LEAF]);
    expect(await keyEpochOf(root.dir)).toBe(minted.keyEpochId);
  });
});

/** Crash one real staging at the seam between the key epoch and the evidence. */
async function crashAfterKeyPublished(dir: string): Promise<void> {
  const request = stageRequest(fixturePlan(), {
    faultsForTest: { beforeEvidenceSync: () => Promise.reject(new Error("crash")) },
  });
  await expect(stagePreparationLocked(dir, request)).rejects.toThrow(/crash/u);
}

describe("a crash immediately after the key epoch is published", () => {
  it("leaves exactly the state a refusal used to leave", async () => {
    // The equivalence claim, made executable through the PRODUCTION path rather
    // than by synthesizing the state: a real staging is interrupted at the seam
    // where the key is durable and nothing else is. That is the same
    // key-plus-empty-epoch state every refused first stage left before this
    // change — a state the project has always tolerated.
    await crashAfterKeyPublished(root.dir);

    const inventory = await scanPreparationInventory(root.dir);
    expect(leafNames(await storeInventory(root.dir))).toEqual([KEY_LEAF]);
    expect(inventory.problems).toEqual([]);
    const populated = Object.values(inventory.epoch)
      .filter((entry) => entry.count !== 0 || entry.bytes !== 0 || entry.health !== "ok");
    expect(populated).toEqual([]);
  });

  it("is recoverable: the next staging succeeds against the published epoch", async () => {
    // Tolerated is not the same as usable. A key-compatibility guard that
    // accepted this state while staging refused it would be a dead end, so the
    // recovery is asserted end to end rather than inferred from the guard.
    await crashAfterKeyPublished(root.dir);
    const crashed = await keyEpochOf(root.dir);
    // The crash must have left an epoch to recover ONTO, or this passes for the
    // wrong reason — a staging that simply mints its own key is not a recovery.
    expect(crashed).not.toBeNull();

    const staged = await stagePreparationLocked(root.dir, stageRequest(fixturePlan()));

    expect(staged.status).toBe("staged");
    expect(await keyEpochOf(root.dir)).toBe(crashed);
  });
});

describe("the capacity family has no first-stage case (FINDING)", () => {
  it("cannot be driven: the plan grammar binds far below the manifest cap", async () => {
    // The residue question named three refusal families. Two are pinned above.
    // The third — a CAPACITY refusal on a project that has never staged — was
    // reported as inference, and measuring it says it has no reachable case:
    //   newPreparations, activeNonterminalRuns, workspacePreparations   all 1 vs 10/50/10
    //   runBytes         the run budget refuses first, and now ahead of the epoch
    //   preparedInputs   DISTINCT extra inputs are bound by the manifest parser's
    //                    evidence array cap (manifest-parse.ts), which runs before
    //                    assertStageCapacity; duplicates park earlier still, as
    //                    `initial-input-changed-digest`
    //   evidenceObjectBytes, activeBytes   2 GiB and 32 GiB
    // manifestBytes is the last candidate and the only one worth a tripwire, so
    // it is MEASURED here rather than argued: the largest plan the grammar admits
    // is staged and its real manifest is weighed against the cap it would have to
    // cross. If a grammar change ever puts a plan within reach of that cap, this
    // goes red and the first-stage capacity question is open again.
    const largest = parsePreparationPlan(JSON.stringify(chainPlan(MAX_LOGICAL_PHASES_PER_PLAN)));

    const staged = await stagePreparationLocked(root.dir, stageRequest(largest));

    expect(staged.status).toBe("staged");
    const manifestBytes = staged.status === "staged" ? canonicalBytes(staged.manifest).byteLength : Infinity;
    expect(manifestBytes).toBeLessThan(MAX_PREPARATION_MANIFEST_BYTES);
    // The cap assertion alone cannot see drift 44x below itself: this figure was
    // reported as 47,249 B and had already moved to 48,042 B at 3053f26 with
    // nothing noticing. The threshold sits near the observation so that growth in
    // the plan grammar surfaces here while it is still cheap.
    expect(manifestBytes).toBeLessThan(OBSERVED_MANIFEST_CEILING_BYTES);
  }, 60_000);
});

describe("durable ordering inside the publish phase", () => {
  it("publishes the key epoch before the first evidence object", async () => {
    // Not a stylistic ordering. `assertKeyCompatible` refuses a missing key
    // whenever the epoch holds anything, so evidence landing before the key
    // would leave a project that no later staging could recover without an
    // operator key reset.
    //
    // The observation seam is the whole point. An earlier revision of this test
    // watched at `afterEvidenceSync`, which fires AFTER the evidence is written,
    // so a publish sitting between the evidence and the hook read as ordered and
    // the mutant survived the full suite. `beforeEvidenceSync` fires with the
    // next await being the evidence write, so BOTH halves are witnessed here:
    // the key is already durable, and no epoch content is.
    const observed: { key: string | null; store: string[] }[] = [];
    const request = stageRequest(fixturePlan(), {
      faultsForTest: {
        beforeEvidenceSync: async () => {
          observed.push({ key: await keyEpochOf(root.dir), store: leafNames(await storeInventory(root.dir)) });
        },
      },
    });

    const staged = await stagePreparationLocked(root.dir, request);

    expect(staged.status).toBe("staged");
    expect(observed).toHaveLength(1);
    // Store first: it names BOTH failure directions readably — an empty store
    // means the key had not landed yet, an extra leaf means content beat it.
    expect(observed[0]!.store).toEqual([KEY_LEAF]);
    expect(observed[0]!.key).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});
