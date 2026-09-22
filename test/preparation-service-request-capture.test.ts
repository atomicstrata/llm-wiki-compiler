/**
 * @file test/preparation-service-request-capture.test.ts
 * @description The OUTER request read, for every operation that takes one.
 *
 * WHY THIS SEAM AND NOT THE FACADE. The defect was only reachable through a host
 * constructing the service directly, which is why the existing cases all passed:
 * they entered BELOW it, at the per-operation capture, and the read that handed
 * that capture its value was never exercised. Every case here goes through
 * `createPreparationService` for that reason.
 *
 * EVERY REQUEST IS WELL-FORMED IN EVERY RESPECT EXCEPT THE ACCESSOR. Each case
 * sets up the state its operation acts on — a stranded run for `recovery`, a run
 * at its gate for `gate`, a ready preparation and a real obligation set for
 * `handoff` — so that removing the capture makes the operation SUCCEED and
 * commit. A probe that is malformed in a second respect refuses either way, and
 * then its durable witness proves nothing.
 *
 * WHAT EACH CASE PINS, and all three halves are required. A typed refusal alone
 * is satisfied by code that RAN the caller's accessor and then rejected what it
 * returned — a strictly weaker property than never running it. So every case
 * asserts the refusal, a getter-invocation count, AND a durable side-effect
 * witness, because a refusal returned after a commit is not a refusal.
 *
 * THE COUNT ASSERTION IS TOTAL, not a list of fields that must stay unread: the
 * probe reports every field whose getter fired and the assertion is that the set
 * is EMPTY. A field added to a request type later cannot slip past it.
 */

import { describe, expect, it } from "vitest";
import { readPreparationCancel } from "../src/preparations/cancellation.js";
import { REQUEST_CAPTURE_REFUSAL } from "../src/preparations/service-request-capture.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { accessorRequest } from "./fixtures/accessor-request.js";
import { SEED_GATE_ID, gateServiceOn, gatedRun, readGateRun } from "./preparation-gate-fixture.js";
import { readRun, serviceOn, stagedProject, strandedRun } from "./preparation-recovery-fixture.js";
import { stageDocuments, stageableProject } from "./preparation-sdk-fixture.js";
import { handoffObligations, stageReadyPreparation } from "./preparations/handoff-fixture.js";
import type { PreparationGrant } from "../src/preparations/principals.js";

/** Every grant these six operations charge, so no case guesses a token. */
const GRANTS: readonly PreparationGrant[] = [
  "preparation.run", "preparation.cancel", "preparation.recovery", "preparation.gate.decide",
];

/** One refusal, as every operation's refused arm renders it. */
interface RefusalLike { readonly status: string; readonly reason?: string }

/** The refusal and the untouched-accessor half, which every case shares. */
function expectRefusedUnread(result: RefusalLike, fired: Record<string, number>): void {
  expect(result.status).toBe("refused");
  expect(result.reason).toBe(REQUEST_CAPTURE_REFUSAL);
  // TOTAL: the set of fields whose getter fired, not a denylist of names.
  expect(fired).toEqual({});
}

/** Valid in-memory plan and seed readers, as a well-formed caller supplies them. */
async function documentReaders(): Promise<{ plan: () => Promise<unknown>; seed: () => Promise<unknown> }> {
  const documents = await stageDocuments();
  return {
    plan: () => Promise.resolve({ ok: true, text: documents.planDocument }),
    seed: () => Promise.resolve({ ok: true, text: documents.seedDocument }),
  };
}

describe("preparation service outer request capture", () => {
  const root = useTempRoot();

  it("stage refuses an accessor-bearing request and creates no run", async () => {
    const cwd = await stageableProject("reqcapstage");
    const service = serviceOn(cwd, "sdk", GRANTS);
    const before = JSON.stringify(await service.list());
    const probe = accessorRequest({
      documents: await documentReaders(), controlTransitionAllowance: 3,
    });

    expectRefusedUnread(await service.stage(probe.request as never), probe.fired());
    expect(JSON.stringify(await service.list())).toBe(before);
  });

  it("fail refuses an accessor-bearing request and drives no run terminal", async () => {
    const fixture = await stagedProject("reqcapfail");
    try {
      const probe = accessorRequest({ runId: fixture.binding.runId });

      const result = await serviceOn(fixture.root, "sdk", GRANTS).fail(probe.request as never);

      expectRefusedUnread(result, probe.fired());
      expect((await readRun(fixture)).state).toBe("planned");
    } finally { await fixture.cleanup(); }
  });

  it("cancel refuses an accessor-bearing request and publishes nothing", async () => {
    const fixture = await stagedProject("reqcapcancel");
    try {
      const probe = accessorRequest({ runId: fixture.binding.runId });

      const result = await serviceOn(fixture.root, "sdk", GRANTS).cancel(probe.request as never);

      expectRefusedUnread(result, probe.fired());
      const published = await readPreparationCancel(
        fixture.root, fixture.binding.workspaceId, fixture.binding.runId);
      expect(published.status).not.toBe("present");
    } finally { await fixture.cleanup(); }
  });

  it("recovery refuses an accessor-bearing request and parks nothing", async () => {
    // STRANDED, so a read request would genuinely park this run.
    const fixture = await strandedRun("reqcaprecovery");
    try {
      const probe = accessorRequest({ runId: fixture.binding.runId });

      const result = await serviceOn(fixture.root, "sdk", GRANTS).recovery(probe.request as never);

      expectRefusedUnread(result, probe.fired());
      expect((await readRun(fixture)).state).toBe("running");
    } finally { await fixture.cleanup(); }
  });

  it("gate refuses an accessor-bearing request and decides no gate", async () => {
    // A run standing AT the gate, with the id and decision it would accept.
    const fixture = await gatedRun("reqcapgate");
    try {
      const before = JSON.stringify(await readGateRun(fixture));
      const probe = accessorRequest({
        runId: fixture.binding.runId, gateId: SEED_GATE_ID, decision: "approved",
      });

      const result = await gateServiceOn(fixture.root, "sdk", GRANTS).gate(probe.request as never);

      expectRefusedUnread(result, probe.fired());
      expect(JSON.stringify(await readGateRun(fixture))).toBe(before);
    } finally { await fixture.cleanup(); }
  });

  it("handoff refuses an accessor-bearing request and stages no bundle", async () => {
    // A READY preparation and a real obligation set: this request hands off.
    const binding = await stageReadyPreparation(root.dir);
    const probe = accessorRequest({
      runId: binding.runId, obligations: handoffObligations(binding),
    });

    const result = await serviceOn(root.dir, "sdk", GRANTS).handoff(probe.request as never);

    expectRefusedUnread(result, probe.fired());
    expect((await readRun({ root: root.dir, binding } as never)).state).toBe("handoff-ready");
  });

  /**
   * The DECLARED-METHOD exception, and it asserts ONE rather than zero.
   *
   * `plan()`/`seed()` are declared as methods, so a class-based provider is a
   * legitimate caller shape and refusing an accessor there would be a contract
   * change rather than a hardening — the service invokes them by design. The
   * property that matters is that each is read EXACTLY once and bound, because
   * `.bind` pins the function only if a second read never happens. A count of 2
   * is the regression this guards.
   */
  it("reads each declared document member exactly once", async () => {
    const cwd = await stageableProject("reqcapdocs");
    const readers = await documentReaders();
    const counted = accessorRequest({ plan: readers.plan, seed: readers.seed });

    const result = await serviceOn(cwd, "sdk", GRANTS).stage({
      documents: counted.request, controlTransitionAllowance: 3,
    } as never);

    expect(result.status).toBe("staged");
    expect(counted.fired()).toEqual({ plan: 1, seed: 1 });
  });
});
