/**
 * WCAG contrast floors for the Nebula palette.
 *
 * The design mockup is a static image and says nothing about contrast, so
 * this file measures the shipped tokens against the stylesheets' own real
 * consumers rather than assuming.
 *
 * `--fg-ghost`, `--fg-faint`, and `--warn-muted` are the tokens most at
 * risk: every real consumer of the three renders at 9.5-12.5px (see the
 * per-row comments on MUTED_TEXT_CASES below), nowhere near WCAG 2.1
 * SC 1.4.3's large-text thresholds (>=24px, or >=18.66px bold). The
 * applicable floor for all of them is therefore the body-text 4.5:1 — an
 * earlier version of this file asserted the large-text 3:1 floor for these
 * three instead, which is wrong for every one of their consumers and let
 * the test pass while the real requirement failed.
 *
 * Measured against every background a real stylesheet rule actually puts
 * them on (2026-08-05 review), 11 of 16 (fg-ghost x2 backgrounds + fg-faint
 * x5 backgrounds + warn-muted x1 background, x2 themes) fail 4.5:1 at the
 * currently shipped token values. Fixing `--fg-ghost` or `--fg-faint` would
 * require moving each up to (or past) `--fg-dim` -- the next-brightest rung
 * in the muted-text scale -- which is a visible design change, not a
 * "smallest step" nudge. That call was escalated rather than made silently;
 * see `.superpowers/sdd/2026-08-04-nebula-viewer-ui/final-fix-report.md`
 * for the full before/after table and reasoning. MUTED_TEXT_CASES below
 * pins the CURRENTLY SHIPPED state -- including the known failures -- so a
 * regression (something gets worse) and a fix (something gets better) are
 * both caught: a "fail" row that starts passing flips this test red,
 * which is the prompt to update that row to "pass".
 *
 * `--fg-disabled` joined this file in the 2026-08-05 fidelity pass, when it
 * was restored to viewer-tokens.css (a prior branch had deleted it as
 * "consumed by nothing") and wired to zero-valued nav counts. At 10.5px on
 * --bg-sidebar it is well below 4.5:1 in both themes — a deliberately
 * near-invisible "disabled" treatment, pinned below like the other three.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import path from "path";

const TOKENS = path.resolve("src/viewer/assets/viewer-tokens.css");

/** Relative luminance of an #rrggbb colour, per WCAG 2.1. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** Contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Read a token's value from a given theme block in the tokens stylesheet. */
async function token(name: string, theme: "dark" | "light"): Promise<string> {
  const css = await readFile(TOKENS, "utf-8");
  const blockStart =
    theme === "dark" ? css.indexOf(":root {") : css.indexOf(':root[data-theme="light"]');
  const block = css.slice(blockStart, css.indexOf("}", blockStart));
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`token ${name} not found in the ${theme} block`);
  return match[1];
}

type ThemeName = "dark" | "light";
type Expectation = "pass" | "fail";

/**
 * Every real (foreground, background, theme) combination the stylesheets
 * put `--fg-ghost`, `--fg-faint`, or `--warn-muted` against, and whether
 * it clears 4.5:1 at the CURRENTLY SHIPPED token values. Each group's
 * comment names the consuming rule(s) and their rendered font-size, which
 * is what pins the 4.5:1 floor as the correct one (never large text).
 */
const MUTED_TEXT_CASES: [fg: string, bg: string, theme: ThemeName, expected: Expectation][] = [
  // .nav-section-label (viewer-chrome.css), 9.5px, on the sidebar.
  ["--fg-ghost", "--bg-sidebar", "dark", "fail"],
  ["--fg-ghost", "--bg-sidebar", "light", "fail"],
  // .graph-legend-heading / .tip-hint (viewer-graph.css, 10px) -- both
  // card-hosted. (.pattern-eyebrow used to be a third consumer here; the
  // 2026-08-05 fidelity pass moved it to --accent-text -- mockup tree line
  // 269 -- which is not one of the at-risk tokens tracked in this file.)
  // --bg-card is LIGHTER than --bg-sidebar in dark theme (#100f19 vs
  // #0a0912), so this pairing is worse than the sidebar one above, not
  // safer -- see the fix report for why an earlier task believed the
  // opposite.
  ["--fg-ghost", "--bg-card", "dark", "fail"],
  ["--fg-ghost", "--bg-card", "light", "fail"],
  // .result-kind (viewer-content.css, 9.5px), .meter-caption
  // (viewer-dashboard.css, 10.5px, mockup tree line 327), .recent-age
  // (viewer-dashboard.css, 10.5px as of the 2026-08-05 fidelity pass --
  // mockup tree line 169) -- all card-hosted, all still well under the
  // large-text threshold. (.action-hint moved to --fg-dim in the rail's own
  // fidelity pass -- mockup tree line 339 -- confirmed to still clear 4.5:1
  // on --bg-card in both themes, so it did not need to join this file.)
  ["--fg-faint", "--bg-card", "dark", "fail"],
  ["--fg-faint", "--bg-card", "light", "pass"],
  // .search-kbd (viewer-content.css, 10px), .list-citations
  // (viewer-content.css, 9.5px), .stat-badge (viewer-dashboard.css, 9.5px).
  ["--fg-faint", "--bg-chip", "dark", "fail"],
  ["--fg-faint", "--bg-chip", "light", "fail"],
  // .sidebar-search ::placeholder (viewer-content.css), 12.5px.
  ["--fg-faint", "--bg-inset", "dark", "fail"],
  ["--fg-faint", "--bg-inset", "light", "pass"],
  // .list-age (viewer-content.css), 11px. The list routes set no
  // background of their own, so this inherits the app shell's.
  ["--fg-faint", "--bg-shell", "dark", "fail"],
  ["--fg-faint", "--bg-shell", "light", "pass"],
  // .nav-count (viewer-chrome.css), 10.5px, on the sidebar -- non-zero
  // counts only; zero-valued counts use --fg-disabled instead, tracked
  // separately below (see viewer-sidebar.js appendNavCount).
  ["--fg-faint", "--bg-sidebar", "dark", "fail"],
  ["--fg-faint", "--bg-sidebar", "light", "fail"],
  // .stat-card.is-warn .stat-sub (viewer-dashboard.css, 11px as of the
  // 2026-08-05 fidelity pass -- mockup tree line 132; was 12.5px). The one
  // pairing that was already safe -- §6 of the design spec predicted this
  // one was at risk and it was not.
  ["--warn-muted", "--warn-bg", "dark", "pass"],
  ["--warn-muted", "--warn-bg", "light", "pass"],
  // .nav-count.nav-count-zero (viewer-chrome.css), 10.5px, on the sidebar
  // -- restored 2026-08-05 (see file header). Deliberately near-invisible
  // by design (a "disabled" treatment), not a candidate for the same
  // "smallest step" nudge the other rows above got.
  ["--fg-disabled", "--bg-sidebar", "dark", "fail"],
  ["--fg-disabled", "--bg-sidebar", "light", "fail"],
];

/** Pairs that were always body-sized text and always clear 4.5:1 — unchanged regression pins. */
const BODY_TEXT_PAIRS: [string, string][] = [
  ["--fg-body", "--bg-card"],
  ["--fg-muted", "--bg-card"],
  ["--fg", "--bg-shell"],
  // .entity-field-link (viewer-content.css), body-sized, in the support rail.
  // The rail declares no background, so it inherits the app shell's. This is
  // the only interactive text the declared-field block renders, so it is the
  // one pairing there a reader has to be able to read AND recognise as a link.
  ["--accent-text", "--bg-shell"],
];

describe("muted-token contrast — --fg-ghost / --fg-faint / --warn-muted / --fg-disabled", () => {
  it.each(MUTED_TEXT_CASES)(
    "%s on %s (%s theme) is expected to %s 4.5:1",
    async (fg, bg, theme, expected) => {
      const ratio = contrast(await token(fg, theme), await token(bg, theme));
      if (expected === "pass") {
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      } else {
        // Known failure at the currently shipped value, escalated rather
        // than fixed — see file header. Asserting the failure (rather than
        // skipping the case) means a future token change is caught either
        // way: still broken keeps this passing-as-expected; fixed flips it
        // to an unexpected pass, which is exactly the prompt to update this
        // row to "pass".
        expect(ratio).toBeLessThan(4.5);
      }
    },
  );
});

describe.each(["dark", "light"] as const)("%s theme contrast", (theme) => {
  it.each(BODY_TEXT_PAIRS)("%s on %s clears 4.5:1", async (fg, bg) => {
    const ratio = contrast(await token(fg, theme), await token(bg, theme));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
