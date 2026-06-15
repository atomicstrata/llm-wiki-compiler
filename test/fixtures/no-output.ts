import { vi, expect } from "vitest";
/** Run `fn` asserting it writes nothing to stdout/stderr (the output-free-core guard). Returns fn's result. */
export async function assertNoOutput<T>(fn: () => Promise<T>): Promise<T> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await fn();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    return result;
  } finally {
    log.mockRestore(); warn.mockRestore(); error.mockRestore();
  }
}
