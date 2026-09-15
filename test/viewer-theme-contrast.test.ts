/**
 * New palette contrast regression for links rendered on recessed surfaces.
 * The Minimal accent was readable on white but fell below 4.5:1 on controls,
 * navigation, and code surfaces. Read the actual palette declarations here.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { contrast } from "./fixtures/color-contrast.js";

/** Read an opaque token from the first (light) theme block. */
function lightToken(css: string, name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[a-f0-9]{6})`));
  if (!match) throw new Error(`Missing opaque ${name}`);
  return match[1];
}

describe("Minimal light link contrast", () => {
  it.each(["surface-recessed", "surface-raised", "surface-muted"])("clears 4.5:1 on %s", async (surface) => {
    const css = await readFile("src/viewer/assets/themes/minimal.css", "utf8");
    expect(contrast(lightToken(css, "text-interactive"), lightToken(css, surface))).toBeGreaterThanOrEqual(4.5);
  });
});
