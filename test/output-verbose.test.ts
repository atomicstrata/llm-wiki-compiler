/**
 * Unit tests for the verbose output mode in src/utils/output.ts.
 *
 * Covers:
 *  1. verbose() prints when verbose is on
 *  2. verbose() is silent when verbose is off
 *  3. quiet wins over verbose (quiet suppresses output even when verbose is on)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setVerbose,
  setQuiet,
  verbose,
  withVerbose,
  withQuiet,
  isVerbose,
} from "../src/utils/output.js";

/** Reset both flags to off between tests to avoid state leakage. */
beforeEach(() => {
  setVerbose(false);
  setQuiet(false);
});

afterEach(() => {
  setVerbose(false);
  setQuiet(false);
});

describe("verbose()", () => {
  it("prints a dimmed detail line when verbose is on", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      setVerbose(true);
      verbose("hello world");
      expect(spy).toHaveBeenCalledOnce();
      const arg = spy.mock.calls[0][0] as string;
      expect(arg).toContain("  · hello world");
    } finally {
      spy.mockRestore();
    }
  });

  it("prints nothing when verbose is off", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      setVerbose(false);
      verbose("silent message");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("prints nothing when quiet is on even if verbose is on", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      setVerbose(true);
      setQuiet(true);
      verbose("suppressed by quiet");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("withVerbose()", () => {
  it("scopes verbose to the call tree without mutating the global flag", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      setVerbose(false);
      let capturedInside = false;
      withVerbose(() => {
        capturedInside = isVerbose();
        verbose("scoped message");
      });
      expect(capturedInside).toBe(true);
      expect(isVerbose()).toBe(false); // global unchanged
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("quiet wins over verbose", () => {
  it("withQuiet suppresses verbose even inside withVerbose", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      withVerbose(() => {
        withQuiet(() => {
          verbose("should be silent");
        });
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
