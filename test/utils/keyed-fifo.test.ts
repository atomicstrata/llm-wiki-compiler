import { describe, expect, it } from "vitest";
import { acquireKeyedFifo } from "../../src/utils/keyed-fifo.js";

const timeoutError = (): Error => new Error("queue stalled");
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("acquireKeyedFifo", () => {
  it("runs same-key entries in arrival order", async () => {
    const first = await acquireKeyedFifo("project", 100, timeoutError);
    const entered: number[] = [1];
    const second = acquireKeyedFifo("project", 100, timeoutError).then((release) => {
      entered.push(2);
      release();
    });
    const third = acquireKeyedFifo("project", 100, timeoutError).then((release) => {
      entered.push(3);
      release();
    });

    expect(entered).toEqual([1]);
    first();
    await Promise.all([second, third]);
    expect(entered).toEqual([1, 2, 3]);
  });

  it("does not serialize different keys", async () => {
    const first = await acquireKeyedFifo("a", 100, timeoutError);
    const second = await acquireKeyedFifo("b", 100, timeoutError);
    second();
    first();
  });

  it("rejects a waiter when the active entry makes no progress", async () => {
    const first = await acquireKeyedFifo("project", 100, timeoutError);
    try {
      await expect(acquireKeyedFifo("project", 20, timeoutError)).rejects.toThrow("queue stalled");
    } finally {
      first();
    }
  });

  it("resets the no-progress bound whenever an entry completes", async () => {
    const first = await acquireKeyedFifo("project", 100, timeoutError);
    const second = acquireKeyedFifo("project", 50, timeoutError).then(async (release) => {
      await delay(35);
      release();
      return 2;
    });
    const third = acquireKeyedFifo("project", 50, timeoutError).then((release) => {
      release();
      return 3;
    });

    await delay(35);
    first();
    await expect(Promise.all([second, third])).resolves.toEqual([2, 3]);
  });
});
