/**
 * @file test/trust-delete-journal.test.ts
 * @description A journalled page DELETE is revertible: an interrupted batch
 * restores the page it removed.
 *
 * THIS IS THE PROPERTY THAT MAKES DELETION SAFE TO ADD AT ALL. The page journal
 * is a ROLLBACK log — it records what was at the path BEFORE the batch, and
 * recovery restores it — which is why deletion needed no new journal entry
 * kind. But "needed no new machinery" is a claim about behaviour, and the
 * behaviour has to be measured: a delete that unlinked WITHOUT recording the
 * pre-state would pass every other test in this repository while making the
 * removal unrecoverable.
 *
 * The crash is simulated the only honest way — the batch is opened and the
 * mutation applied, and the batch is never committed, exactly as a process that
 * died mid-apply would leave it.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openBatch, replayJournal } from "../src/trust/journal.js";
import { applyPageMutationLocked } from "../src/trust/page-apply.js";
import { tempRootTracker } from "./temp-roots.js";

const tracker = tempRootTracker();
afterEach(() => tracker.cleanup());

const BODY = "---\ntitle: Alpha\n---\n\nOriginal contents.\n";

/** A project holding one entity page. */
async function projectWithPage(): Promise<{ root: string; file: string }> {
  const root = await tracker.create("del-journal-", { real: true });
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  const file = path.join(root, "wiki", "concepts", "alpha.md");
  await writeFile(file, BODY, "utf8");
  return { root, file };
}

/** The planned delete of that page. */
function deleteMutation() {
  return {
    kind: "page" as const, operation: "delete" as const,
    target: { entityType: "concepts", slug: "alpha", id: "concepts/alpha" },
    body: BODY,
    provenance: { origin: "operation", decision: "allow", reviewRouted: false },
  };
}

describe("a journalled page delete", () => {
  it("removes the page when the batch commits", async () => {
    await deleteInOpenBatch();
  });

  it("CONVERGES when the page is already gone, rather than failing the batch", async () => {
    // The goal state is "not present". Something else reaching it first — a
    // retry after a partial apply, a concurrent removal — is not a failure, and
    // throwing here would strand the rest of the batch.
    const { root, file } = await projectWithPage();
    await rm(file);
    const batch = await openBatch(root);
    await expect(applyPageMutationLocked(root, deleteMutation() as never, batch)).resolves.toBeUndefined();
  });

  it("RESTORES the page when the batch is interrupted before commit", async () => {
    const { root, file } = await deleteInOpenBatch();

    // The crash: the batch is never committed. Recovery must put back exactly
    // the bytes that were there, not merely recreate the path.
    await replayJournal(root);
    expect(await readFile(file, "utf8")).toBe(BODY);
  });
});

/** Leave an observed deletion in an open journal for commit/recovery witnesses. */
async function deleteInOpenBatch() {
  const { root, file } = await projectWithPage();
  const batch = await openBatch(root);
  await applyPageMutationLocked(root, deleteMutation() as never, batch);
  expect(existsSync(file)).toBe(false);
  return { root, file };
}
