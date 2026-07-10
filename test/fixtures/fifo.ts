/**
 * Test fixture: plant a POSIX FIFO (named pipe) at a path, for regression tests
 * proving a locked write/read path refuses a non-regular target instead of
 * hanging on it (see `test/workflow-store-confine.test.ts` for the pattern this
 * extracts).
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Create a FIFO at `fifoPath` via the system `mkfifo`. POSIX-only; callers on a
 * platform without `mkfifo` (e.g. Windows) should skip the test instead of
 * calling this.
 *
 * @param fifoPath - Absolute path the FIFO is created at.
 */
export async function makeFifo(fifoPath: string): Promise<void> {
  await execFileAsync("mkfifo", [fifoPath]);
}
