/** @file Stable preparation identities across caller re-entry. Reservations
 * allocate IDs only; they are neither approval nor an authenticated effect receipt. */
import { expect, it } from "vitest";
import { readdir, rename } from "node:fs/promises";
import path from "node:path";
import { durableWritingPath } from "../../src/utils/atomic-write-no-replace-durable.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { reserveRecordEffectLocked } from "../../src/operation-bundles/effect-reservation.js";
import { captureRecordIntent } from "../../src/operation-bundles/record-intent.js";

const root = useTempRoot();
function intent(body = "# Synthetic story\n") {
  const digest = `sha256:${"a".repeat(64)}`;
  return captureRecordIntent({ schema: "llmwiki-record-intent-v1", workspaceId: "demo", effectId: "story-1",
    profileDigest: digest, target: { entityType: "stories", slug: "one" }, precondition: { kind: "absent" },
    proposedBody: body, origin: { provider: "llmflow", runId: "run", occurrenceId: "one", proposalDigest: digest } });
}

it("reuses core-minted identities and creation time for the same effect", async () => {
  const first = await reserveRecordEffectLocked(root.dir, "preparer", intent());
  expect(first.bundleId).toMatch(/^bnd_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  expect(first.runId).toMatch(/^opr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  expect(await reserveRecordEffectLocked(root.dir, "preparer", intent())).toEqual(first);
});

it("refuses changed intent without replacing its reservation", async () => {
  const first = await reserveRecordEffectLocked(root.dir, "preparer", intent());
  await expect(reserveRecordEffectLocked(root.dir, "preparer", intent("changed"))).rejects.toThrow("effect-intent-conflict");
  expect(await reserveRecordEffectLocked(root.dir, "preparer", intent())).toEqual(first);
});

it("partitions by host preparer identity, not caller provider attribution", async () => {
  const first = await reserveRecordEffectLocked(root.dir, "preparer", intent());
  const second = await reserveRecordEffectLocked(root.dir, "other-preparer", intent());
  expect(second.bundleId).not.toBe(first.bundleId);
});

it("parks an unpublished reservation companion rather than minting another identity", async () => {
  await reserveRecordEffectLocked(root.dir, "preparer", intent());
  const directory = path.join(root.dir, ".llmwiki", "operation-effect-reservations");
  const [name] = await readdir(directory), file = path.join(directory, name!);
  await rename(file, durableWritingPath(file));
  await expect(reserveRecordEffectLocked(root.dir, "preparer", intent())).rejects.toThrow("effect-reservation-unavailable");
  expect(await readdir(directory)).toEqual([path.basename(durableWritingPath(file))]);
});
