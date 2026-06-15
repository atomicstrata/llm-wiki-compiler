// test/okf-run-errors.test.ts
import { describe, it, expect } from "vitest";
import { LockUnavailableError, QueueFullError } from "../src/import/run-errors.js";

describe("OKF run errors", () => {
  it("are distinguishable Error subclasses with messages", () => {
    const lock = new LockUnavailableError();
    const queue = new QueueFullError("review queue would exceed the cap");
    expect(lock).toBeInstanceOf(Error);
    expect(lock).toBeInstanceOf(LockUnavailableError);
    expect(queue).toBeInstanceOf(QueueFullError);
    expect(lock.message).toMatch(/lock/i);
    expect(queue.message).toMatch(/queue/i);
  });
});
