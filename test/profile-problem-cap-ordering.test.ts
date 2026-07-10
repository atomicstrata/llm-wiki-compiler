/**
 * @file test/profile-problem-cap-ordering.test.ts
 * @description Regression for the problem-cap starvation bug: the profile summary
 * caps its combined `problems` list at PROFILE_PROBLEM_CAP before it reaches the
 * status/viewer/context surfaces (the context pack derives its standing warnings
 * from that capped array). If the unbounded, low-severity per-entity field
 * problems lead the list, a project with ≥cap of them STARVES the rare store-
 * integrity and standing lifecycle-drift signals out of the cap — reporting a
 * drifted project as silently healthy. These pin the high-severity-first order.
 */

import { describe, it, expect } from "vitest";
import { orderProblemViews, PROFILE_PROBLEM_CAP } from "../src/profile/block.js";
import type { EntityProblemView } from "../src/profile/types.js";

/** A synthetic low-severity per-entity field problem. */
const entityProblem = (n: number): EntityProblemView => ({ kind: "field-violation", entityType: "ideas", path: `ideas/e${n}.md`, message: `bad ${n}` });
const storeProblem: EntityProblemView = { kind: "relation-store", message: "relation store unreadable" };
const standingProblem: EntityProblemView = { kind: "lifecycle-relation-requirement-unmet", entityType: "experiments", path: "experiments/x.md", message: "drifted" };

describe("orderProblemViews — high-severity signals survive the cap", () => {
  it("keeps the store and standing problems within the cap even under a flood of entity problems", () => {
    const entity = Array.from({ length: PROFILE_PROBLEM_CAP + 25 }, (_unused, i) => entityProblem(i));
    const capped = orderProblemViews(entity, [storeProblem], [standingProblem]).slice(0, PROFILE_PROBLEM_CAP);
    expect(capped).toContain(storeProblem);
    expect(capped).toContain(standingProblem);
  });

  it("orders store first, then standing, then entity problems", () => {
    const ordered = orderProblemViews([entityProblem(0)], [storeProblem], [standingProblem]);
    expect(ordered).toEqual([storeProblem, standingProblem, entityProblem(0)]);
  });
});
