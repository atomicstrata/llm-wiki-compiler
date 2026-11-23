/**
 * @file test/capability-providers/provider-state-lock.test.ts
 * @description The provider-state lock's acquisition wait. Provider authority mutations hold this lock while
 * they write durably, which can take longer than the generic five-second lock wait on slow storage. A provider
 * waiter therefore keeps waiting for a live holder by default and then runs strictly after it. A shorter explicit
 * wait still refuses as busy without running the waiter or touching the holder's lock record. Invalid waits are
 * rejected before any lock side effect. Every started holder and waiter is released and awaited in `finally`, so
 * a failed assertion never abandons a lock operation.
 */
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, readFile, realpath } from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import { afterEach } from "../config/storage-profile-hooks.js";
import type { AuthorizedProviderPaths } from "../../src/capability-providers/packages/paths.js";
import { withProviderStateLock } from "../../src/capability-providers/packages/state-store.js";
import { removeProviderFixtureRoot } from "../fixtures/capability-provider-package.js";
import { authorizedProviderRoots } from "./provider-roots.js";

/** Longer than the generic exclusive-lock wait (5 s), which a provider waiter must outlast. */
const HOLD_PAST_GENERIC_WAIT_MS = 5_500;
/** A short explicit provider wait that a live holder outlasts. */
const SHORT_WAIT_MS = 300;

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeProviderFixtureRoot)));

/** Authorized provider roots in a fresh temporary directory. */
async function providerPaths(): Promise<AuthorizedProviderPaths> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "llmwiki-provider-lock-")));
  roots.push(root);
  return authorizedProviderRoots(root, () => new Date("2026-07-17T12:00:00Z"));
}

/** A provider lock holder that reports when it has entered and finishes only when released. */
function startHolder(paths: AuthorizedProviderPaths, order: string[]) {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const mayFinish = new Promise<void>((resolve) => { release = resolve; });
  const hasEntered = new Promise<void>((resolve) => { entered = resolve; });
  const done = withProviderStateLock(paths, async () => {
    order.push("holder-start");
    entered();
    await mayFinish;
    order.push("holder-end");
  });
  return { done, hasEntered, release };
}

/** Release the holder and await every started operation, whatever happened in the test body. */
async function settle(holder: ReturnType<typeof startHolder>, ...others: Promise<unknown>[]): Promise<void> {
  holder.release();
  await Promise.allSettled([holder.done, ...others]);
}

describe("provider-state lock acquisition wait", () => {
  it("keeps a default waiter waiting past the generic wait, then runs it after the holder", async () => {
    const paths = await providerPaths();
    const order: string[] = [];
    const holder = startHolder(paths, order);
    let waiter: Promise<void> = Promise.resolve();
    try {
      await holder.hasEntered;
      let waiterSettled = false;
      waiter = withProviderStateLock(paths, async () => { order.push("waiter"); })
        .finally(() => { waiterSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, HOLD_PAST_GENERIC_WAIT_MS));
      expect(waiterSettled).toBe(false);
      expect(order).toEqual(["holder-start"]);
      holder.release();
      await Promise.all([holder.done, waiter]);
      expect(order).toEqual(["holder-start", "holder-end", "waiter"]);
    } finally {
      await settle(holder, waiter);
    }
  });

  it("refuses a short explicit wait without running the waiter or disturbing the holder", async () => {
    const paths = await providerPaths();
    const holder = startHolder(paths, []);
    let waiterRan = false;
    let waiter: Promise<unknown> = Promise.resolve();
    try {
      await holder.hasEntered;
      const recordBefore = await readFile(paths.lockFile, "utf8");
      waiter = withProviderStateLock(paths, async () => { waiterRan = true; }, SHORT_WAIT_MS);
      await expect(waiter).rejects.toThrow(/busy/);
      expect(waiterRan).toBe(false);
      expect(await readFile(paths.lockFile, "utf8")).toBe(recordBefore);
      holder.release();
      await holder.done;
      await expect(withProviderStateLock(paths, async () => "fresh")).resolves.toBe("fresh");
    } finally {
      await settle(holder, waiter);
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 120_001])(
    "rejects the invalid wait %s before any lock side effect",
    async (timeoutMs) => {
      const paths = await providerPaths();
      let operationRan = false;
      await expect(withProviderStateLock(paths, async () => { operationRan = true; }, timeoutMs))
        .rejects.toThrow(RangeError);
      expect(operationRan).toBe(false);
      await expect(access(paths.lockFile)).rejects.toThrow();
    },
  );
});
