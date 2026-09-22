/**
 * @file test/preparation-service-cancel.test.ts
 * @description The `cancel` operation's own behaviour at the service seam.
 *
 * THE TWO PROPERTIES THAT ARE THE WHOLE REASON THIS OPERATION IS SHAPED
 * DIFFERENTLY from every other mutating verb, and neither is provable by a
 * happy-path test: it lands while the PROJECT LOCK IS HELD, and it lands while
 * the PREPARATION KEY IS UNREADABLE. Both are the wedged states an operator
 * reaches for cancellation in, and both are exactly what an `ordinary`-intent
 * acquisition or a readiness precheck would refuse. Each is written so that
 * adding the guard back turns it red.
 *
 * AND THE ONE THAT LOOKS LIKE IDEMPOTENCE AND IS NOT: `writeAdvisoryCreateOnly`
 * reports `exists` for ANY object already occupying the path — a valid pending
 * request, but equally a planted directory. Reporting the second as "already
 * pending" would tell an operator their cancellation is in flight when nothing
 * consumable is there.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readPreparationCancel } from "../src/preparations/cancellation.js";
import { preparationKeyFile, preparationPaths } from "../src/preparations/paths.js";
import type { CancelResultV1 } from "../src/preparations/service.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { driveToFailed } from "./preparations/lifecycle-fixture.js";
import {
  CANCEL_RECOVERY_GRANTS, serviceOn, stagedProject, type RunningRunFixture,
} from "./preparation-recovery-fixture.js";

/** The advisory leaf path for the fixture's single run. */
function cancelFile(fixture: RunningRunFixture): string {
  return preparationPaths(fixture.root, fixture.binding.workspaceId).cancelFile(fixture.binding.runId);
}

/** The validated advisory record on disk, or the reason it is not one. */
async function advisory(fixture: RunningRunFixture) {
  return readPreparationCancel(fixture.root, fixture.binding.workspaceId, fixture.binding.runId);
}

/** Request cancellation of the fixture's run through a granted `sdk` service. */
function cancel(fixture: RunningRunFixture, id = "host-2"): Promise<CancelResultV1> {
  return serviceOn(fixture.root, "sdk", CANCEL_RECOVERY_GRANTS, id).cancel({
    runId: fixture.binding.runId,
  });
}

describe("cancel publishes one operator request", () => {
  it("publishes a valid advisory record crediting the HOST principal", async () => {
    const fixture = await stagedProject("cancelpublish");
    try {
      expect(await cancel(fixture, "agent-7"))
        .toEqual({ status: "requested", runId: fixture.binding.runId, request: "created" });
      const read = await advisory(fixture);
      expect(read.status).toBe("present");
      // The requester is the principal the HOST assigned. No request field
      // carries an actor, so this is the only place it can have come from.
      if (read.status === "present") expect(read.request.requester).toBe("agent-7");
    } finally { await fixture.cleanup(); }
  });

  it("leaves an existing request byte-identical and reports it already pending", async () => {
    const fixture = await stagedProject("cancelidem");
    try {
      await cancel(fixture);
      const first = await readFile(cancelFile(fixture));
      expect(await cancel(fixture))
        .toEqual({ status: "requested", runId: fixture.binding.runId, request: "already-pending" });
      // CREATE-ONLY, proved on the bytes: the nonce and instant differ per call,
      // so a replacing write would be visible here even though both calls report
      // success.
      expect(await readFile(cancelFile(fixture))).toEqual(first);
    } finally { await fixture.cleanup(); }
  });
});

describe("cancel lands in the states every locked verb refuses", () => {
  it("publishes while the PROJECT LOCK is held by another holder", async () => {
    // The lock-free property, and the reason §5 row 8 has no gate intent. Under
    // an `ordinary` acquisition this call would refuse "project lock is busy" —
    // precisely when an operator most needs the request to land.
    const fixture = await stagedProject("cancellocked");
    await acquireLock(fixture.root, { quiet: true });
    try {
      expect(await cancel(fixture)).toMatchObject({ status: "requested", request: "created" });
      expect((await advisory(fixture)).status).toBe("present");
    } finally {
      await releaseLock(fixture.root);
      await fixture.cleanup();
    }
  });

  it("publishes while the preparation KEY is unreadable", async () => {
    // The readiness precheck `stage` and `fail` both take would refuse here.
    // Cancel deliberately does not take it: the advisory is not key-bound, and a
    // broken key is one of the wedges cancellation exists to escape.
    const fixture = await stagedProject("cancelnokey");
    try {
      await writeFile(preparationKeyFile(fixture.root), "not a key", "utf8");
      expect(await cancel(fixture)).toMatchObject({ status: "requested", request: "created" });
      expect((await advisory(fixture)).status).toBe("present");
    } finally { await fixture.cleanup(); }
  });
});

describe("cancel refuses without leaving litter", () => {
  it("refuses a TERMINAL run and writes no advisory at all", async () => {
    const fixture = await stagedProject("cancelterminal");
    try {
      await driveToFailed(fixture.root, fixture.binding);
      const result = await cancel(fixture);
      expect(result.status).toBe("refused");
      if (result.status === "refused") expect(result.reason).toMatch(/already terminal \(failed\)/u);
      // The load-bearing half: nothing consumable is left behind. A terminal run
      // is in no settleable state, so an advisory written over it would never be
      // removed by any settlement.
      expect((await advisory(fixture)).status).toBe("absent");
    } finally { await fixture.cleanup(); }
  });

  it("separates could-not-see from does-not-exist for an unknown run id", async () => {
    const fixture = await stagedProject("cancelunknown");
    try {
      const service = serviceOn(fixture.root, "sdk", CANCEL_RECOVERY_GRANTS);
      expect(await service.cancel({ runId: "prun_0000000000000000000000000000000000000000000000000000000000000000" }))
        .toEqual({ status: "refused", reason: "no such preparation run" });
    } finally { await fixture.cleanup(); }
  });
});

describe("the requester label is checked before anything is written", () => {
  it("REFUSES typed when the host principal is too long to be a requester", async () => {
    // TWO DIFFERENT BOUNDS, and the gap between them is the whole reason this
    // guard is not dead code: a principal id may be 255 bytes, a requester label
    // 128. A 200-byte id is therefore a perfectly VALID principal and an
    // inadmissible requester — the one shape that reaches the guard.
    //
    // Without it the substrate's own `boundedText` throws, and an untyped
    // `cancel text field is invalid` escapes the service to a caller who asked a
    // domain question. The guard routes through the SAME exported predicate the
    // writer enforces, so the check and its executor cannot drift.
    const fixture = await stagedProject("cancellongid");
    try {
      const result = await cancel(fixture, "a".repeat(200));
      expect(result).toEqual({
        status: "refused",
        reason: "the host principal's identity is not an admissible requester label",
      });
      // Nothing was written on the way to the refusal.
      expect((await advisory(fixture)).status).toBe("absent");
    } finally { await fixture.cleanup(); }
  });

  it("still publishes for a principal exactly AT the requester bound", async () => {
    // The other side, so the guard is pinned as a boundary rather than as a
    // blanket refusal: 128 bytes is admissible and must still land.
    const fixture = await stagedProject("cancelboundid");
    try {
      expect(await cancel(fixture, "b".repeat(128))).toMatchObject({ status: "requested" });
      expect((await advisory(fixture)).status).toBe("present");
    } finally { await fixture.cleanup(); }
  });
});

describe("a collision is classified, not assumed to be idempotence", () => {
  it("refuses over a PLANTED object and stays usable once it is cleared", async () => {
    // The refusal names the leaf workspace-relative, which is what makes it an
    // escape rather than a dead end — and the retry proves the escape works.
    const fixture = await stagedProject("cancelplanted");
    try {
      await mkdir(cancelFile(fixture), { recursive: true });
      const blocked = await cancel(fixture);
      expect(blocked.status).toBe("refused");
      if (blocked.status === "refused") {
        expect(blocked.reason).toMatch(/unreadable object already occupies/u);
        expect(blocked.reason).toContain(".llmwiki");
        // NEVER an absolute path in a result: the operator gets a remedy, not
        // the location of their home directory.
        expect(blocked.reason).not.toContain(fixture.root);
      }
      await rm(cancelFile(fixture), { recursive: true, force: true });
      expect(await cancel(fixture)).toMatchObject({ status: "requested", request: "created" });
    } finally { await fixture.cleanup(); }
  });
});
