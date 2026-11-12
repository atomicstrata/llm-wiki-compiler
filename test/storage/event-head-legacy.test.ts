/**
 * @file test/storage/event-head-legacy.test.ts
 * @description The event store's head anchor through its ROOT functions, on real
 * files with nothing mocked. It states one behaviour a search of the existing
 * tests found unpinned, so that moving the anchor read behind consumer-owned
 * sources cannot change it. It is run byte for byte against the source both
 * before and after.
 *
 * What the two cases pin: a head anchor leaf that is NOT a plain regular file is
 * refused as the event store's own link error. The existing tests plant a link
 * at `events.jsonl`, and pin the anchor's size cap, its absence and a mismatch;
 * none replaces the anchor leaf itself.
 *  - H1: the anchor is a link to a file that holds the RIGHT digest, so reading
 *    through the link would look healthy. The read refuses it; the status
 *    summary reports one `event-store` problem and no event count; and an append
 *    refuses it too, leaving `events.jsonl` byte-identical.
 *  - H2: the anchor is a directory. The read refuses it the same way.
 *
 * These are compatibility coverage of the incumbent's behaviour. They are not a
 * proof that no other test reaches this path: that rests on a search.
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendEvent } from "../../src/events/store.js";
import { readEvents } from "../../src/events/store-read.js";
import { EventStoreSymlinkError } from "../../src/events/types.js";
import { collectStatus } from "../../src/status/collect.js";
import { EVENTS_FILE, EVENTS_HEAD_FILE, PROFILE_FILE } from "../../src/utils/constants.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-event-head-legacy-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const at = (relative: string): string => path.join(root, relative);
const append = () => appendEvent(root, { type: "relation-create", origin: "sdk", payload: {}, at: "2024-01-01T00:00:00Z" });
/** A non-default profile, so the status summary has a profile block to report through. */
const PROFILE = { schemaVersion: 1, profileId: "sample", displayName: "Sample", entities: { notes: { directory: "wiki/notes" } } };

/** A non-default project with one sealed event; answers the sealed anchor text. */
async function sealedProject(): Promise<string> {
  await mkdir(path.dirname(at(PROFILE_FILE)), { recursive: true });
  await writeFile(at(PROFILE_FILE), JSON.stringify(PROFILE));
  await append();
  return readFile(at(EVENTS_HEAD_FILE), "utf8");
}

describe("a head anchor leaf that is not a plain file, as the event store answers it today", () => {
  it("H1 refuses an anchor that is a link to the right digest: the read, the status summary and an append", async () => {
    const sealed = await sealedProject();
    await writeFile(at("anchor-target"), sealed);
    await rm(at(EVENTS_HEAD_FILE));
    await symlink(at("anchor-target"), at(EVENTS_HEAD_FILE));
    const before = await readFile(at(EVENTS_FILE));
    await expect(readEvents(root)).rejects.toBeInstanceOf(EventStoreSymlinkError);
    const status = await collectStatus(root);
    expect(status.profile?.problems?.map((problem) => problem.kind)).toEqual(["event-store"]);
    expect(status.profile !== undefined && "eventCount" in status.profile).toBe(false);
    await expect(append()).rejects.toBeInstanceOf(EventStoreSymlinkError);
    expect((await readFile(at(EVENTS_FILE))).equals(before)).toBe(true);
  });

  it("H2 refuses an anchor that is a directory", async () => {
    await sealedProject();
    await rm(at(EVENTS_HEAD_FILE));
    await mkdir(at(EVENTS_HEAD_FILE));
    await expect(readEvents(root)).rejects.toBeInstanceOf(EventStoreSymlinkError);
  });
});
