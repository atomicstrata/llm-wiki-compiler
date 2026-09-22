/**
 * @file test/fixtures/src-tree.ts
 * @description The one src/ tree walker the structural gates share: the
 * absolute src/ root and every `.ts` or `.js` file under it as src-relative slash
 * paths. Two gates walking the tree with private copies is how their file
 * sets quietly diverge.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The absolute path of the repository's src/ directory. */
export const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

/** Every TypeScript or JavaScript file under src/, as src-relative slash paths. */
export function srcTsFiles(dir = SRC_DIR, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcTsFiles(path.join(dir, entry.name), rel));
    else if (/\.(?:ts|js)$/.test(entry.name)) out.push(rel);
  }
  return out;
}
