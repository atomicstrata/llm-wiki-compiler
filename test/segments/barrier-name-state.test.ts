/**
 * @file test/segments/barrier-name-state.test.ts
 * @description `barrierNameState` reports a reserved barrier name as absent
 * (null) ONLY for ENOENT. Any other lookup failure (EACCES here) propagates, so
 * a snapshot can never read an occupied but unreadable leaf as absent and make
 * a before/after or `NO_BARRIER_NAMES` assertion vacuous. The lookup is
 * injected, so no disk, permission or timing is involved.
 */

import { describe, expect, it } from "bun:test";
import { barrierNameState, NO_BARRIER_NAMES, type BarrierLookup } from "./barrier-publication-fixture.js";

/** A lookup that fails with `code` for every name. */
const failingWith = (code: string): BarrierLookup => () => Promise.reject(Object.assign(new Error(code), { code }));

describe("barrierNameState lookup failures", () => {
  it("propagates EACCES instead of reporting the name absent", async () => {
    await expect(barrierNameState("/unused", failingWith("EACCES"))).rejects.toMatchObject({ code: "EACCES" });
  });

  it("reports every name absent for ENOENT", async () => {
    expect(await barrierNameState("/unused", failingWith("ENOENT"))).toEqual(NO_BARRIER_NAMES);
  });
});
