/**
 * Reconciled viewer layout contract: public shell/styles remain authoritative,
 * with the restored journey layer added explicitly. The archived shell used
 * different selectors and a different layout; testing its unloaded stylesheets
 * would not verify the interface that actually ships. Accessibility, theme and
 * cascade behavior retain their dedicated public test suites.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ASSETS = path.resolve("src/viewer/assets");

/** Read the real asset selected by the shipping shell. */
function asset(name: string): Promise<string> {
  return readFile(path.join(ASSETS, name), "utf8");
}

describe("combined public viewer and workflow journey layout", () => {
  it("loads public structural layers and the journey layer, not the archived shell", async () => {
    const html = await asset("index.html");
    const sheets = [...html.matchAll(/rel="stylesheet" href="\/assets\/([^"]+)"/g)].map(match => match[1]);
    expect(sheets).toEqual([
      "viewer-tokens.css", "viewer-content.css", "viewer-chrome.css",
      "viewer-dashboard.css", "viewer-health.css", "viewer-pipeline.css",
      "viewer-graph.css", "viewer-material.css", "viewer-journey.css",
    ]);
    for (const sheet of sheets) expect((await asset(sheet)).length).toBeGreaterThan(0);
  });

  it("preserves the public content-width cap", async () => {
    expect(await asset("viewer-content.css")).toContain("width: min(100%, var(--max-content-width));");
  });
});
