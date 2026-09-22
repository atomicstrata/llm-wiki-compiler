/**
 * @file test/preparation-cancel-collision-window.test.ts
 * @description The third answer at `cancel`'s collision leg: the request was
 * CONSUMED between the failed create and the read-back.
 *
 * D-10-4 AT THIS READ LEG. `readPreparationCancel` answers absent, present or
 * unavailable, and the collision classifier originally separated only `present` —
 * so a settlement that removed the advisory in that window produced "an
 * unreadable object already occupies this run's cancel request path; remove it",
 * naming a leaf that is not there and handing the operator an instruction they
 * cannot carry out. Could-not-see is not does-not-qualify, at every read leg.
 *
 * HOW THE WINDOW IS INJECTED, and what that does and does not prove. The window
 * is a genuine TOCTOU between two syscalls and cannot be hit on demand from
 * outside, so the CREATE is mocked to report the collision it would report if a
 * request existed, while writing nothing. Everything after that is real: the
 * READER is the production one, the leaf is genuinely absent, and the
 * classification under test is the one that runs in production. What this cannot
 * prove is how OFTEN the window is reachable — only what the operation says when
 * it is.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/advisory-file.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/advisory-file.js")>();
  return {
    ...actual,
    // Reports the collision WITHOUT writing, which is exactly the state a lock
    // holder settling the run in the window leaves behind: the create loses the
    // race, and by the time the classifier reads, nothing is there.
    writeAdvisoryCreateOnly: async () => "exists" as const,
  };
});

const { CANCEL_RECOVERY_GRANTS, serviceOn, stagedProject } =
  await import("./preparation-recovery-fixture.js");
const { readPreparationCancel } = await import("../src/preparations/cancellation.js");

describe("a collision whose request is already gone", () => {
  it("reports it as RETRYABLE, never as an object the operator must remove", async () => {
    const fixture = await stagedProject("cancelconsumed");
    try {
      // PIN THE PRECONDITION: the leaf really is absent, so the classifier is
      // answering about a genuine could-not-see rather than about a planted shape.
      expect((await readPreparationCancel(
        fixture.root, fixture.binding.workspaceId, fixture.binding.runId)).status).toBe("absent");

      const result = await serviceOn(fixture.root, "sdk", CANCEL_RECOVERY_GRANTS)
        .cancel({ runId: fixture.binding.runId });

      expect(result).toEqual({
        status: "refused",
        reason: "a cancellation request for this run was settled while this one was being published; "
          + "re-run to see the run's current state",
      });
    } finally { await fixture.cleanup(); }
  });
});
