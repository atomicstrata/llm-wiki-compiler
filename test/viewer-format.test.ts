/**
 * Unit tests for the shared formatting helpers.
 *
 * `lintTotal` distinguishing null from 0 is the load-bearing behaviour here:
 * the sidebar badge and the compile receipt both depend on "never run" not
 * being reported as a clean run.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { JSDOM } from "jsdom";
import { readFile } from "fs/promises";
import path from "path";

const MODULE_PATH = path.resolve("src/viewer/assets/viewer-format.js");

interface Format {
  relativeAge(iso: unknown): string;
  lintTotal(lint: unknown): number | null;
  plural(count: number, noun: string): string;
}

let format: Format;

beforeEach(async () => {
  const source = await readFile(MODULE_PATH, "utf-8");
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  dom.window.eval(
    `${source.replace(/export\s+function\s+/g, "function ")}
     window.__format = { relativeAge, lintTotal, plural };`,
  );
  format = (dom.window as unknown as { __format: Format }).__format;
});

describe("relativeAge", () => {
  it("returns an empty string for a missing timestamp", () => {
    expect(format.relativeAge(undefined)).toBe("");
    expect(format.relativeAge("")).toBe("");
  });

  it("returns an empty string for an unparseable timestamp", () => {
    expect(format.relativeAge("not-a-date")).toBe("");
  });

  it("reports 'today' for a timestamp less than a day old", () => {
    expect(format.relativeAge(new Date().toISOString())).toBe("today");
  });

  it("reports whole days for an older timestamp", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(format.relativeAge(threeDaysAgo)).toBe("3d");
  });
});

describe("lintTotal", () => {
  it("returns null when lint has never run", () => {
    expect(format.lintTotal(null)).toBeNull();
    expect(format.lintTotal(undefined)).toBeNull();
  });

  it("distinguishes a clean run from no run", () => {
    expect(format.lintTotal({ warnings: 0, errors: 0 })).toBe(0);
  });

  it("sums warnings and errors", () => {
    expect(format.lintTotal({ warnings: 9, errors: 2 })).toBe(11);
  });

  it("treats missing counts as zero", () => {
    expect(format.lintTotal({ warnings: 4 })).toBe(4);
  });
});

describe("plural", () => {
  // The bug this guards: a hardcoded "s" suffix reads fine at the example
  // count a mockup happens to show (e.g. "11 dangling targets") and wrong
  // at exactly 1 ("1 dangling targets") — the boundary a fixed literal
  // never gets tested against.
  it("keeps the noun singular at exactly one", () => {
    expect(format.plural(1, "dangling target")).toBe("1 dangling target");
  });

  it("pluralises for any count other than one, including zero", () => {
    expect(format.plural(0, "dangling target")).toBe("0 dangling targets");
    expect(format.plural(2, "dangling target")).toBe("2 dangling targets");
    expect(format.plural(11, "dangling target")).toBe("11 dangling targets");
  });
});
