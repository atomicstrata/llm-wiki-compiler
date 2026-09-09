/**
 * @file test/viewer-css-specificity.test.ts
 * @description Rules that must win the cascade against a competing rule.
 *
 * The JSDOM suites assert DOM STRUCTURE. They never load the stylesheets and
 * never compute style, so a rule that is written correctly and then loses the
 * cascade is invisible to every other test in this repo — the DOM is right, the
 * pixels are wrong, and nothing goes red.
 *
 * That is not hypothetical: `.entity-field-label` (0-1-0) was silently
 * overridden by `.support-rail dt` (0-1-1) in viewer-chrome.css, so the
 * frontmatter-key labels rendered in the sans face while the rule's own comment
 * insisted they were mono. Review caught it; no test could have.
 *
 * HONEST SCOPE: this checks specificity and source order, which is what that bug
 * was. It does NOT resolve custom properties, shorthand expansion, inheritance,
 * or `@media` — so it is a targeted guard for one failure mode, not a substitute
 * for looking at the page.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import path from "path";

const ASSETS = path.resolve("src/viewer/assets");

/**
 * Pairs where `winner` must out-rank `loser` for the declared look to survive.
 * `property` names what is at stake, so a failure says what breaks rather than
 * just which numbers differ.
 */
const MUST_WIN: { winner: string; loser: string; property: string; note: string }[] = [
  {
    winner: ".support-rail .entity-field-label",
    loser: ".support-rail dt",
    property: "font",
    note: "declared-field labels are mono — they are frontmatter keys, not prose",
  },
  {
    winner: ".support-rail .entity-field-label",
    loser: ".support-rail dd",
    property: "color",
    note: "the label is dimmer than the value it labels",
  },
];

/** WCAG-irrelevant but cascade-relevant: (ids, classes+attrs+pseudo-classes, elements). */
function specificity(selector: string): [number, number, number] {
  const cleaned = selector.replace(/::[a-z-]+/g, " ");
  const ids = cleaned.match(/#[\w-]+/g)?.length ?? 0;
  const classes = cleaned.match(/\.[\w-]+|\[[^\]]+\]|:[a-z-]+(\([^)]*\))?/g)?.length ?? 0;
  const elements = cleaned
    .replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:[a-z-]+(\([^)]*\))?/g, " ")
    .split(/[\s>+~,]+/)
    .filter((part) => /^[a-z][\w-]*$/i.test(part)).length;
  return [ids, classes, elements];
}

/** True when `a` ranks at or above `b`. */
function atLeast(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/** Every stylesheet the shell loads, concatenated in load order. */
async function stylesheets(): Promise<{ name: string; text: string }[]> {
  const shell = await readFile(path.join(ASSETS, "index.html"), "utf-8");
  const names = Array.from(shell.matchAll(/href="\/assets\/([\w.-]+\.css)"/g)).map((m) => m[1]);
  return Promise.all(
    names.map(async (name) => ({ name, text: await readFile(path.join(ASSETS, name), "utf-8") })),
  );
}

/** The sheet a selector is declared in, plus its index in load order. */
async function declaredIn(selector: string): Promise<{ name: string; order: number } | null> {
  const sheets = await stylesheets();
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[,}\\n])\\s*${escaped}\\s*[,{]`, "m");
  const index = sheets.findIndex((sheet) => pattern.test(sheet.text));
  return index === -1 ? null : { name: sheets[index].name, order: index };
}

describe("selectors that must win the cascade", () => {
  it("loads at least two stylesheets, or the ordering check means nothing", async () => {
    expect((await stylesheets()).length).toBeGreaterThan(1);
  });

  it.each(MUST_WIN)("$winner beats $loser for $property — $note", async ({ winner, loser }) => {
    const winnerSite = await declaredIn(winner);
    const loserSite = await declaredIn(loser);
    expect(winnerSite, `${winner} is not declared in any loaded stylesheet`).not.toBeNull();
    expect(loserSite, `${loser} is not declared in any loaded stylesheet`).not.toBeNull();

    const winnerRank = specificity(winner);
    const loserRank = specificity(loser);
    // Equal specificity is only safe when the winner also loads later; higher
    // specificity wins regardless of order.
    const wins =
      atLeast(winnerRank, loserRank) &&
      (winnerRank.join() !== loserRank.join() || winnerSite!.order >= loserSite!.order);
    expect(
      wins,
      `${winner} (${winnerRank.join("-")} in ${winnerSite!.name}) does not beat ` +
        `${loser} (${loserRank.join("-")} in ${loserSite!.name})`,
    ).toBe(true);
  });
});

describe("the specificity helper itself", () => {
  it.each([
    [".a", [0, 1, 0]],
    ["div", [0, 0, 1]],
    [".support-rail dt", [0, 1, 1]],
    [".support-rail .entity-field-label", [0, 2, 0]],
    ["#x .a div", [1, 1, 1]],
  ])("ranks %s as %j", (selector, expected) => {
    expect(specificity(selector as string)).toEqual(expected);
  });
});
