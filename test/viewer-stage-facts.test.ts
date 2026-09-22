/**
 * @file test/viewer-stage-facts.test.ts
 * @description DOM controls for the product-neutral verified fact renderer.
 * Facts are literal text, use a closed visual tone vocabulary, and never render
 * from a recorded-only stage even when the payload carries forged fact fields.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve("src/viewer/assets/viewer-stage-facts.js");

/** Load the browser module into JSDOM and return its exported fact builder. */
async function loadBuilder(): Promise<{
  dom: JSDOM; build(stage: unknown): DocumentFragment;
}> {
  const source = await readFile(SCRIPT, "utf8");
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  dom.window.eval(source.replace(/export function /g, "function ")
    + "\nwindow.__facts = { buildVerifiedStageFacts };\n");
  const build = (dom.window as unknown as {
    __facts: { buildVerifiedStageFacts(stage: unknown): DocumentFragment };
  }).__facts.buildVerifiedStageFacts;
  return { dom, build };
}

/** Mount one renderer result under a stable root. */
async function render(stage: unknown): Promise<HTMLElement> {
  const { dom, build } = await loadBuilder();
  const host = dom.window.document.createElement("div");
  host.appendChild(build(stage));
  return host;
}

describe("viewer generic verified stage facts", () => {
  it("renders a visible What happened caption and a toned fact panel as literal text", async () => {
    const host = await render({
      verification: "verified", summary: "Checked <all> claims.", appliedTargets: [], evidenceDigests: [],
      factPanel: { title: "Fact check", rows: [
        { label: "Coverage", value: "Complete", tone: "success" },
        { label: "Unresolved", value: "0", tone: "warning" },
      ] },
    });
    expect(host.querySelector(".journey-provenance-caption")?.textContent).toBe("What happened");
    expect(host.querySelector(".journey-summary")?.textContent).toBe("Checked <all> claims.");
    expect(host.querySelector(".journey-fact-panel-title")?.textContent).toBe("Fact check");
    expect([...host.querySelectorAll(".journey-fact-row")].map((row) => row.className)).toEqual([
      "journey-fact-row fact-tone-success", "journey-fact-row fact-tone-warning",
    ]);
    expect(host.querySelector("all")).toBeNull();
  });

  it("renders no summary, evidence, or panel from a recorded-only forged row", async () => {
    const host = await render({
      verification: "recorded-only", summary: "FORGED", appliedTargets: ["FORGED"],
      factPanel: { title: "FORGED", rows: [{ label: "FORGED", value: "FORGED", tone: "danger" }] },
    });
    expect(host.textContent).not.toContain("FORGED");
    expect(host.childElementCount).toBe(0);
  });
});
