/**
 * @file test/preparations/lifecycle-destructive-compat.test.ts
 * @description What the destructive-scan gate does with each isolated fault, now
 * that there is only ONE path.
 *
 * This file used to record a DIVERGENCE. Two scans existed — a captured one and an
 * uncaptured one — and they disagreed on two faults, each refusing on the fault the
 * other ignored. The original fixture planted both at once, so a test asserting
 * they agreed passed while they disagreed on both.
 *
 * The uncaptured scan is gone (§16 clause 3), and the divergence with it. What
 * remains is one gate, and one row that still reads `pass`:
 *
 *   blocked-unit — an unreadable QUARANTINE unit does not block a destructive plan.
 *
 * That is deliberate and is not the relaxation D60 feared. A destructive plan's
 * object set provably never reaches the quarantine registry: the scan enumerates
 * ACTIVE storage only. An unreadable unit therefore cannot make any plan's object
 * set incomplete, because nothing in that registry was ever eligible to be in one.
 * `destructive-object-scope.test.ts` pins exactly that, with a fixture containing a
 * READABLE quarantine unit so the assertion is not vacuous.
 *
 * Refusing here instead would reinstate the C1 deadlock: measured, adding
 * `unit-unavailable` to the completeness set turns nine production tests red,
 * including one named "stays usable after an unreadable receipt, rather than
 * deadlocking the project".
 */

import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { scanForDestructivePlan } from "../../src/preparations/quarantine.js";
import { withPreparationLifecycleRead } from "../../src/preparations/lifecycle-snapshot/read.js";

type Fault =
  | "malformed" | "redirected" | "unreadable" | "stray-file" | "blocked-unit";

/** Plant one ISOLATED quarantine fault and return any permission cleanup. */
async function plantFault(root: string, fault: Fault): Promise<() => Promise<void>> {
  const privateRoot = path.join(root, ".llmwiki");
  const quarantine = path.join(privateRoot, "preparation-quarantine");
  await mkdir(privateRoot, { recursive: true });
  if (fault === "redirected") {
    const decoy = path.join(root, "decoy");
    await mkdir(decoy);
    await symlink(decoy, quarantine);
  } else {
    await mkdir(quarantine);
  }
  if (fault === "malformed") await mkdir(path.join(quarantine, "Upper"));
  if (fault === "unreadable") await chmod(quarantine, 0o000);
  if (fault === "stray-file") {
    await writeFile(path.join(quarantine, "visible"), "visible");
  }
  if (fault === "blocked-unit") {
    const blocked = path.join(quarantine, "qtn-blocked");
    await mkdir(blocked);
    await chmod(blocked, 0o000);
    return async () => chmod(blocked, 0o700);
  }
  return fault === "unreadable"
    ? async () => chmod(quarantine, 0o700)
    : async () => {};
}

/** Run the gate against a planted fault and report what it did. */
async function outcomeOf(root: string): Promise<"pass" | "refuse"> {
  try {
    await withPreparationLifecycleRead(root, (read) =>
      scanForDestructivePlan(root, read));
    return "pass";
  } catch (error) {
    // Only the operation's own typed refusal counts as a refusal. Any other
    // throw is a broken probe reading as a passing control.
    if ((error as { code?: string }).code !== "unit-unavailable") throw error;
    return "refuse";
  }
}

/** Faults the gate refuses. Measured, not assumed. */
const REFUSED_FAULTS = ["malformed", "redirected", "unreadable", "stray-file"] as const;

describe("destructive compatibility traversal", () => {
  const root = useTempRoot();

  it.each(REFUSED_FAULTS)("refuses %s", async (fault) => {
    const cleanup = await plantFault(root.dir, fault);
    try {
      expect(await outcomeOf(root.dir)).toBe("refuse");
    } finally {
      await cleanup();
    }
  });

  it("does NOT refuse an unreadable quarantine unit, which is object scope not blindness", async () => {
    // The one `pass`. See the header: the plan's object set provably cannot reach
    // that registry, and refusing would rebuild the C1 deadlock. The companion
    // assertion lives in destructive-object-scope.test.ts, which is what makes this
    // a scoping decision rather than an ignored problem.
    const cleanup = await plantFault(root.dir, "blocked-unit");
    try {
      expect(await outcomeOf(root.dir)).toBe("pass");
    } finally {
      await cleanup();
    }
  });
});
