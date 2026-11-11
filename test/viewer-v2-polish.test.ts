/**
 * The v2 polish pass: when route changes animate, which taps close the page
 * details sheet, and the sheet's closed rendering. Pure checks and static
 * markup only, so no browser globals are set up.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { closesSheet, RailSheet } from "../viewer-v2/src/rail-sheet.js";
import { supportsViewTransitions } from "../viewer-v2/src/use-route.js";

describe("route transitions", () => {
  it("animate only where the API exists; the stylesheet handles reduced motion", () => {
    const supported = { startViewTransition: () => undefined } as unknown as Pick<Document, "startViewTransition">;
    expect(supportsViewTransitions(supported)).toBe(true);
    expect(supportsViewTransitions({})).toBe(false);
    expect(supportsViewTransitions(undefined)).toBe(false);
  });
});

describe("page details sheet", () => {
  it("closes on the backdrop and on links or buttons, not on plain content", () => {
    const sheet = {};
    const inside = (match: boolean) => ({ closest: () => (match ? {} : null) });
    expect(closesSheet(sheet as EventTarget, sheet as EventTarget)).toBe(true);
    expect(closesSheet(inside(true) as unknown as EventTarget, sheet as EventTarget)).toBe(true);
    expect(closesSheet(inside(false) as unknown as EventTarget, sheet as EventTarget)).toBe(false);
    expect(closesSheet(null, sheet as EventTarget)).toBe(false);
  });

  it("renders its button and an empty closed sheet until opened", () => {
    const html = renderToStaticMarkup(createElement(RailSheet, null, createElement("p", null, "rail content")));
    expect(html).toContain(">Page details</button>");
    expect(html).toMatch(/<dialog[^>]*aria-labelledby="([^"]+)"[\s\S]*<h2 id="\1"[^>]*>Page details<\/h2>/);
    expect(html).not.toContain("rail content");
  });
});
