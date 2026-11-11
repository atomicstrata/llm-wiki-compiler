/**
 * @file test/storage/preparation-lock-spies.ts
 * @description The incumbent calls every preparation root form that runs under
 * the BLOCKING project lock makes first and last: the blocking acquisition, the
 * authenticated run read, and the release. The root-form witnesses (the gate
 * moves, finalization) spy them identically, so they are spied once here, each
 * recording into the shared order log of `orderedStubs`. The run read answers
 * the given run. Nothing here decides anything; each suite asserts its own
 * arguments and order.
 */

import { vi } from "bun:test";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as runStore from "../../src/preparations/run-store.js";
import * as lock from "../../src/utils/lock.js";
import type { orderedStubs } from "./call-log.js";

/**
 * Spy the blocking acquisition, the run read and the release, each noting itself in order.
 *
 * @param stubs - The order log and stub maker the suite's other spies share.
 * @param run - The run the read answers.
 * @returns The three spies, for exact-argument assertions.
 */
export function spyBlockingLockedRunRead(stubs: ReturnType<typeof orderedStubs>, run: unknown) {
  return {
    acquire: vi.spyOn(lockGate, "acquireMutationLockBlocking").mockImplementation(stubs.note("acquire", undefined)),
    read: vi.spyOn(runStore, "readPreparationRun").mockImplementation(stubs.note("read", { status: "ok", run } as never)),
    release: vi.spyOn(lock, "releaseLock").mockImplementation(stubs.note("release", undefined)),
  };
}
