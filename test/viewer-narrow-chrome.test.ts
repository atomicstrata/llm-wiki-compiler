/** Responsive chrome cascade guards; browser layout acceptance remains separate. */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";

/** Apply the narrow media rules through the CSSOM, which JSDOM does not evaluate. */
function narrowStyles() {
  const css = readFileSync("src/viewer/assets/viewer-chrome.css", "utf8");
  const dom = new JSDOM(`<style>${css}</style><aside class="sidebar"></aside>
    <header class="app-header"><div class="app-actions"></div></header>`);
  const sheet = dom.window.document.styleSheets[0];
  const rules = [...sheet.cssRules].filter((rule) => rule.type === 4);
  const style = dom.window.document.createElement("style");
  style.textContent = rules.map((rule) => [...(rule as CSSMediaRule).cssRules]
    .map((child) => child.cssText).join("\n")).join("\n");
  dom.window.document.head.append(style);
  return dom;
}

it("releases the stacked sidebar from viewport-height sticky positioning", () => {
  const dom = narrowStyles();
  const style = dom.window.getComputedStyle(dom.window.document.querySelector(".sidebar")!);
  expect(style.position).toBe("static");
  expect(style.height).toBe("auto");
  dom.window.close();
});

it("allows header controls to wrap instead of squeezing the project identity", () => {
  const dom = narrowStyles();
  const doc = dom.window.document;
  expect(dom.window.getComputedStyle(doc.querySelector(".app-header")!).flexDirection).toBe("column");
  expect(dom.window.getComputedStyle(doc.querySelector(".app-actions")!).flexWrap).toBe("wrap");
  dom.window.close();
});
