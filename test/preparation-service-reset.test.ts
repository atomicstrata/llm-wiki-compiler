/**
 * @file test/preparation-service-reset.test.ts
 * @description The `reset` operation's own behaviour: both eligible key states,
 * both passes, and the exit for an operator who lost the continuation secret.
 *
 * THE FIRST CASE IS THE ONE THAT FOUND A DEFECT, and it is kept first so a
 * reader meets it before the happy path. `reset` was written from `prune`'s
 * shape, which takes the shared host-readiness precheck before acquiring —
 * sound for an operation that destroys bytes in a project that must be readable.
 * That precheck refuses when the preparation key is present but UNREADABLE, and
 * an unreadable key is one of exactly two states reset exists to repair. So the
 * verb refused the state it was built for, with a message telling the operator
 * that preparation commands cannot proceed — which is true of every command
 * EXCEPT this one.
 *
 * A GUARD THAT STRANDS IS A DEFECT, and copying a sibling's preflight is how one
 * arrives. The fix is not to drop the check but to narrow it to the half that is
 * still a real precondition: the project's own profile must be readable, because
 * a reset cannot be attested in a project whose configuration cannot be loaded.
 * The KEY half belongs to the substrate, which reads it under the lock and
 * classifies all three states — healthy refuses as `key-healthy`, absent is
 * `missing-key`, unreadable is `unreadable-key-forced`. Two readers of one fact,
 * one of them out here and fail-closed against the other's whole purpose, is the
 * shape that produced this.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPreparationService } from "../src/preparations/service.js";
import type { PreparationPrincipal, PreparationServiceV1 } from "../src/preparations/service.js";
import { preparationKeyFile } from "../src/preparations/paths.js";
import { FORCED_KEY_CONFIRMATION, MISSING_KEY_CONFIRMATION } from "../src/preparations/reset.js";
import {
  makePreparationKeyUnreadable, removePreparationKey, stagePreparation,
} from "./preparations/lifecycle-fixture.js";

/** The local operator, exactly as `host.ts` constructs it. */
const CLI_PRINCIPAL = { id: "cli-operator", surface: "cli", grants: [] } as PreparationPrincipal;

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "prep-svc-reset-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** The service as the CLI host constructs it. */
function cliService(): PreparationServiceV1 {
  return createPreparationService({
    root, surface: "cli", principals: { principalFor: () => CLI_PRINCIPAL },
  });
}

describe("reset acts in the key states it exists to repair", () => {
  it("records an intent for an UNREADABLE key rather than refusing as unready", async () => {
    await stagePreparation(root);
    await makePreparationKeyUnreadable(root);
    const outcome = await cliService().reset({ confirmation: FORCED_KEY_CONFIRMATION });
    // NAMED, not just non-refused: a refusal here reports the reason, so a
    // regression says which guard fired rather than only that one did.
    expect(outcome).toMatchObject({ status: "intent-recorded", reason: "unreadable-key-forced" });
  });

  it("records an intent for an ABSENT key", async () => {
    await stagePreparation(root);
    await removePreparationKey(root);
    const outcome = await cliService().reset({ confirmation: MISSING_KEY_CONFIRMATION });
    expect(outcome).toMatchObject({ status: "intent-recorded", reason: "missing-key" });
  });

  it("still refuses a project whose own profile cannot be read", async () => {
    // THE HALF OF READINESS THAT SURVIVED. Narrowing the precheck to the profile
    // is only honest if the profile really is still checked, so this pins it —
    // otherwise "narrowed" would be indistinguishable from "removed".
    await stagePreparation(root);
    await removePreparationKey(root);
    await writeFile(path.join(root, ".llmwiki", "profile.json"), "{not json", "utf8");
    const outcome = await cliService().reset({ confirmation: MISSING_KEY_CONFIRMATION });
    expect(outcome).toMatchObject({ status: "refused" });
  });

  it("refuses a HEALTHY key, and the substrate is what says so", async () => {
    await stagePreparation(root);
    const outcome = await cliService().reset({ confirmation: MISSING_KEY_CONFIRMATION });
    expect(outcome).toMatchObject({ status: "refused", reason: expect.stringContaining("key-healthy") });
  });
});

describe("the two passes complete a reset", () => {
  it("completes when pass two presents the unit and secret pass one returned", async () => {
    await stagePreparation(root);
    await removePreparationKey(root);
    const service = cliService();
    const first = await service.reset({ confirmation: MISSING_KEY_CONFIRMATION });
    expect(first.status).toBe("intent-recorded");
    if (first.status !== "intent-recorded") return;
    const second = await service.reset({
      confirmation: MISSING_KEY_CONFIRMATION,
      continuation: { unitId: first.unitId, token: first.continuationToken },
    });
    expect(second).toMatchObject({ status: "completed", unitId: first.unitId });
  });

  it("refuses a continuation whose secret does not authorize the named unit", async () => {
    await stagePreparation(root);
    await removePreparationKey(root);
    const service = cliService();
    const first = await service.reset({ confirmation: MISSING_KEY_CONFIRMATION });
    if (first.status !== "intent-recorded") throw new Error("pass one did not record");
    const second = await service.reset({
      confirmation: MISSING_KEY_CONFIRMATION,
      continuation: { unitId: first.unitId, token: Buffer.alloc(32, 7).toString("base64") },
    });
    expect(second).toMatchObject({
      status: "refused", reason: expect.stringContaining("continuation-mismatch"),
    });
  });
});

describe("supersede is the exit for a lost continuation secret", () => {
  it("clears the pending marker and records a fresh intent in one call", async () => {
    await stagePreparation(root);
    await removePreparationKey(root);
    const service = cliService();
    const stranded = await service.reset({ confirmation: MISSING_KEY_CONFIRMATION });
    if (stranded.status !== "intent-recorded") throw new Error("pass one did not record");
    // THE SECRET IS NOW LOST, and without this flag the project is wedged: the
    // gate refuses ordinary work because a unit is pending and every other
    // destructive intent because that unit is a reset holding custody.
    const superseded = await service.reset({
      confirmation: MISSING_KEY_CONFIRMATION, supersede: true,
    });
    // A FRESH INTENT, not a bare clearance: the key is still missing, so the
    // same call that clears the dead marker opens the reset that replaces it.
    expect(superseded).toMatchObject({ status: "intent-recorded" });
    if (superseded.status !== "intent-recorded") return;
    expect(superseded.unitId).not.toBe(stranded.unitId);
  });

  it("reports what it superseded when the key turned out to be healthy again", async () => {
    await stagePreparation(root);
    const backup = await readFile(preparationKeyFile(root));
    await removePreparationKey(root);
    const service = cliService();
    const stranded = await service.reset({ confirmation: MISSING_KEY_CONFIRMATION });
    if (stranded.status !== "intent-recorded") throw new Error("pass one did not record");
    // THE KEY RESTORED FROM BACKUP between the two passes — the byte-identical
    // original, because a different one would fail every run's integrity check
    // and this case is about the marker, not the epoch. The marker still has to
    // go, and there is no new reset to open, so the answer is neither an intent
    // nor the `key-healthy` refusal an unsuperseded call would have earned.
    await writeFile(preparationKeyFile(root), backup, { mode: 0o600 });
    const superseded = await service.reset({
      confirmation: MISSING_KEY_CONFIRMATION, supersede: true,
    });
    expect(superseded).toMatchObject({ status: "superseded", unitIds: [stranded.unitId] });
  });
});

describe("the request is read by descriptor, at both levels", () => {
  it("refuses an outer request whose fields are accessors", async () => {
    const request = {};
    Object.defineProperty(request, "confirmation", {
      enumerable: true, get: () => MISSING_KEY_CONFIRMATION,
    });
    const outcome = await cliService().reset(request as { confirmation: string });
    expect(outcome).toMatchObject({ status: "refused" });
  });

  it("refuses a NESTED continuation whose fields are accessors", async () => {
    // THE LEVEL THE OUTER CAPTURE DOES NOT REACH. `captureOwnDataRecord` copies
    // own data VALUES and does not descend, so `continuation` arrives as the
    // caller's own object; without the inner capture, reading `.unitId` off it
    // is the plain `[[Get]]` the outer capture exists to prevent.
    const continuation = {};
    Object.defineProperty(continuation, "unitId", { enumerable: true, get: () => "rst-x" });
    Object.defineProperty(continuation, "token", { enumerable: true, get: () => "t" });
    const outcome = await cliService().reset({
      confirmation: MISSING_KEY_CONFIRMATION,
      continuation: continuation as { unitId: string; token: string },
    });
    expect(outcome).toMatchObject({ status: "refused" });
  });

  it("refuses a continuation carrying a key beyond the exact two", async () => {
    const outcome = await cliService().reset({
      confirmation: MISSING_KEY_CONFIRMATION,
      continuation: { unitId: "rst-x", token: "t", extra: 1 } as unknown as
        { unitId: string; token: string },
    });
    expect(outcome).toMatchObject({ status: "refused" });
  });
});
