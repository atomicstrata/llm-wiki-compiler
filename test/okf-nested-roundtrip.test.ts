import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { importOkfBundle } from "../src/import/okf-import.js";
import { collectExportPages } from "../src/export/collect.js";
import { buildOkfBundle } from "../src/export/okf/bundle.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/**
 * Import `bundle` into a fresh `<dir>/<name>` project. The root is created first so
 * the fail-closed profile load resolves it (a non-existent root under a symlinked
 * tmp dir would otherwise trip confinement); `wiki/concepts/` is pre-made for callers
 * that write the imported pages back.
 */
async function importIntoFreshProject(name: string, bundle: string): Promise<{
  proj: string; pages: Awaited<ReturnType<typeof importOkfBundle>>["pages"];
}> {
  const proj = path.join(dir, name);
  await mkdir(path.join(proj, "wiki/concepts"), { recursive: true });
  const { pages } = await importOkfBundle(bundle, proj);
  return { proj, pages };
}

describe("OKF nested-path round-trip", () => {
  it("restores foreign nested paths and keeps foreign->foreign links resolving", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-nrt-"));
    const bundle = path.join(dir, "kb");
    await mkdir(path.join(bundle, "tables"), { recursive: true });
    await writeFile(path.join(bundle, "tables/customers.md"), "---\ntype: concept\ntitle: Customers\n---\n\nA table.\n");
    await writeFile(path.join(bundle, "tables/orders.md"), "---\ntype: concept\ntitle: Orders\n---\n\nSee [Customers](/tables/customers.md).\n");
    const { proj, pages } = await importIntoFreshProject("proj", bundle);
    for (const p of pages) await writeFile(path.join(proj, `wiki/concepts/${p.slug}.md`), p.body);
    const exp = await collectExportPages(proj);
    const out = path.join(dir, "out");
    await buildOkfBundle(proj, exp, out);
    expect((await stat(path.join(out, "tables/customers.md"))).isFile()).toBe(true);
    expect((await stat(path.join(out, "tables/orders.md"))).isFile()).toBe(true);
    expect(await readFile(path.join(out, "tables/orders.md"), "utf-8")).toContain("(/tables/customers.md)");
    // re-import the exported bundle still works
    const { pages: again } = await importIntoFreshProject("proj2", out);
    expect(again.map((p) => p.slug).sort()).toEqual(["tables-customers", "tables-orders"]);
  });

  it("native [[tables-customers]] round-trips: -> /tables/customers.md -> back to [[tables-customers]]", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-n2f-"));
    // Seed a foreign customers doc (gets x-okf.okfPath) + a NATIVE home page that wikilinks it.
    const bundle = path.join(dir, "kb"); await mkdir(path.join(bundle, "tables"), { recursive: true });
    await writeFile(path.join(bundle, "tables/customers.md"), "---\ntype: concept\ntitle: Customers\n---\n\nA table.\n");
    const { proj, pages } = await importIntoFreshProject("proj", bundle);  // pages[0] is the foreign customers doc
    await writeFile(path.join(proj, `wiki/concepts/${pages[0].slug}.md`), pages[0].body); // slug tables-customers, has x-okf
    await writeFile(path.join(proj, "wiki/concepts/home.md"), "---\ntitle: Home\nkind: concept\n---\n\nSee [[tables-customers]].\n");
    const out = path.join(dir, "out");
    await buildOkfBundle(proj, await collectExportPages(proj), out);
    expect(await readFile(path.join(out, "concepts/home.md"), "utf-8")).toContain("(/tables/customers.md)"); // export emits the real path
    const { pages: round } = await importIntoFreshProject("proj2", out);
    const home = round.find((p) => p.slug === "home")!;
    expect(home.body).toContain("[[tables-customers]]");                  // re-import reverses BACK to a wikilink (no drift)
  });
});
