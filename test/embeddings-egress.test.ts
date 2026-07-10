/**
 * Egress tests for page-embedding collection.
 *
 * `collectPageRecords` reads concept/query pages that are later sent to the
 * embedding provider. A symlinked page escaping the project tree must be
 * DROPPED before it is read, so its bytes are never embedded — i.e. the
 * provider is never called for it. A normal page and a legit in-dir symlinked
 * page must still embed exactly as before.
 */

import { describe, it, expect, vi } from "vitest";
import { writeFile, symlink, realpath } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";
import { writePage } from "./fixtures/write-page.js";
import { collectPageRecords, embedPages } from "../src/utils/embeddings-pages.js";
import * as providerMod from "../src/utils/provider.js";

/** Spy a counting embedBatch provider; returns the batched-input texts seen. */
function spyProvider(): { texts: string[][] } {
  const texts: string[][] = [];
  vi.spyOn(providerMod, "getProvider").mockReturnValue({
    embed: async () => [1, 1],
    embedBatch: async (t: string[]) => { texts.push(t); return t.map(() => [1, 1]); },
  } as any);
  return { texts };
}

describe("collectPageRecords egress confinement", () => {
  it("does NOT read or embed an out-of-tree symlinked concept/query page", async () => {
    const root = await makeTempRoot("egress-escape");
    const outside = await makeOutsideDir();
    await writeFile(path.join(outside, "leak.md"), "---\ntitle: Secret\n---\nleaked");
    await symlink(path.join(outside, "leak.md"), path.join(root, "wiki/concepts/leak.md"));
    await symlink(path.join(outside, "leak.md"), path.join(root, "wiki/queries/leak.md"));

    const records = await collectPageRecords(root);
    expect(records.find((r) => r.title === "Secret")).toBeUndefined();

    const { texts } = spyProvider();
    const out = await embedPages(records, new Set(records.map((r) => r.slug)), 256);
    expect(out.requests).toBe(0); // nothing to embed → provider never called
    expect(texts.flat().join("\n")).not.toContain("Secret");
  });

  it("embeds a normal page as before", async () => {
    const root = await makeTempRoot("egress-normal");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "sa" }, "Body.");
    const records = await collectPageRecords(root);
    const { texts } = spyProvider();
    const out = await embedPages(records, new Set(["alpha"]), 256);
    expect(out.requests).toBe(1);
    expect(texts[0]).toContain("Alpha\n\nsa");
  });

  it("embeds a legit IN-DIR symlinked page (resolves inside the dir)", async () => {
    const root = await makeTempRoot("egress-alias");
    const dir = path.join(root, "wiki/concepts");
    await writePage(dir, "original", { title: "Orig", summary: "so" }, "Body.");
    await symlink(path.join(dir, "original.md"), path.join(dir, "alias.md"));
    await realpath(path.join(dir, "alias.md")); // sanity: link is resolvable

    const records = await collectPageRecords(root);
    const slugs = records.map((r) => r.slug).sort();
    expect(slugs).toEqual(["alias", "original"]); // both read
    const { texts } = spyProvider();
    const out = await embedPages(records, new Set(slugs), 256);
    expect(out.requests).toBe(1);
    expect(texts[0]).toHaveLength(2);
  });
});
