/**
 * @file test/exclusive-lock.test.ts
 * @description The generic token-owned file lock serializes holders and always
 * releases, including when the guarded operation throws.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withExclusiveLock, type LockPaths } from "../src/utils/exclusive-lock.js";
import { publisherTempRoots } from "./fixtures/publisher-workspace.js";

const roots = publisherTempRoots();
afterEach(roots.cleanup);

async function lockPaths(): Promise<LockPaths> {
  const root = await roots.create("lock");
  return { root, lockFile: path.join(root, "state.lock") };
}

describe("withExclusiveLock", () => {
  it("serializes two holders", async () => {
    const paths = await lockPaths();
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withExclusiveLock(paths, async () => {
      order.push("first-start");
      await firstMayFinish;
      order.push("first-end");
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = withExclusiveLock(paths, async () => { order.push("second"); });
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("releases the lock when the operation throws", async () => {
    const paths = await lockPaths();

    await expect(withExclusiveLock(paths, async () => { throw new Error("boom"); })).rejects.toThrow(/boom/);

    await expect(withExclusiveLock(paths, async () => "ok")).resolves.toBe("ok");
  });
});
