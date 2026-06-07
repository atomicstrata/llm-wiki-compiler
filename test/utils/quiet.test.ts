/**
 * Tests for the quiet-aware note() output helper.
 *
 * Verifies that note() routes through console.warn and is a no-op
 * while the process-wide quiet flag is set.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { setQuiet, note } from "../../src/utils/output.js";

describe("output.note respects quiet flag", () => {
  afterEach(() => setQuiet(false));
  it("emits nothing while quiet", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setQuiet(true);
    note("retrying soon");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
