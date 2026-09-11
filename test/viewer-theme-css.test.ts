/**
 * Public theme asset and cascade contract.
 * Verify that the browser receives complete token maps, local fonts, and
 * reduced-motion protection while retaining the public structural layers.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = "src/viewer/assets";
const MAPS = ["theme-base", "public-tokens", "minimal", "scientific-clay", "nebula"];
const STRUCTURE = ["content", "chrome", "dashboard", "health", "pipeline", "graph", "material"];

/** Read assets exactly as shipped, ignoring comments when inspecting declarations. */
async function source(file: string): Promise<string> {
  return (await readFile(path.join(ROOT, file), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("public viewer theme CSS", () => {
  it("loads base and aliases before palettes without replacing public route layers", async () => {
    const entry = await source("viewer-tokens.css");
    const imports = [...entry.matchAll(/@import url\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(imports).toEqual(["./viewer-fonts.css", ...MAPS.map((name) => `./themes/${name}.css`)]);
    const html = await source("index.html");
    const links = [...html.matchAll(/href="\/assets\/viewer-([\w-]+)\.css"/g)].map((m) => m[1]);
    expect(links).toEqual(["tokens", ...STRUCTURE]);
  });

  it("defines every public structural token and every alias target", async () => {
    const maps = await Promise.all(MAPS.map((name) => source(`themes/${name}.css`)));
    const structure = await Promise.all(STRUCTURE.map((name) => source(`viewer-${name}.css`)));
    const declarations = new Set([...maps.join("\n").matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    for (const match of [...maps, ...structure].join("\n").matchAll(/var\((--[\w-]+)/g)) {
      expect(declarations.has(match[1]), `missing ${match[1]}`).toBe(true);
    }
    for (const css of structure) expect(css).not.toMatch(/--[\w-]+\s*:/);
  });

  it("ships the thirteen font faces from local WOFF2 files", async () => {
    const css = await source("viewer-fonts.css");
    const urls = [...css.matchAll(/url\("\/assets\/fonts\/([^"]+)"\)/g)].map((m) => m[1]).sort();
    expect(urls).toHaveLength(13);
    expect(urls).toEqual((await readdir(path.join(ROOT, "fonts"))).sort());
    for (const name of urls) expect((await readFile(path.join(ROOT, "fonts", name))).subarray(0, 4).toString()).toBe("wOF2");
  });

  it("keeps palette choices scoped and free of product-specific rules", async () => {
    for (const name of MAPS) {
      const css = await source(`themes/${name}.css`);
      expect(css).not.toMatch(/https?:|autosci|newsroom|hypothesis|experiment|edition/);
      expect(css.split("\n").filter((line) => line.trim()).length).toBeLessThan(400);
    }
    expect(await source("themes/scientific-clay.css")).not.toContain("prefers-color-scheme");
    expect(await source("themes/minimal.css")).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*\[data-theme="minimal"\]/);
    expect(await source("themes/nebula.css")).not.toContain("prefers-color-scheme");
  });

  it("stops ambient animation and preserves universal keyboard focus", async () => {
    const css = await source("viewer-tokens.css");
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
    expect(css).toMatch(/\*, \*::before, \*::after/);
    expect(css).toContain("transition: none !important");
    const clay = await source("themes/scientific-clay.css");
    expect([...clay.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1])).toEqual(["clay-float", "clay-float-delayed", "clay-breathe"]);
  });
});
