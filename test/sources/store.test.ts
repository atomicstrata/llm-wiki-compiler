import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listSources, getSource } from "../../src/sources/store.js";
import { PathSafetyError } from "../../src/viewer/path-safety.js";

async function seed(root: string) {
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(path.join(root, "sources/b.md"), "---\ntitle: B\nsource: s2\nsourceType: file\n---\nbody-b", "utf-8");
  await writeFile(path.join(root, "sources/a.md"), "---\ntitle: A\nsource: s1\nsourceType: web\ningestedAt: 2026-01-01T00:00:00.000Z\n---\nbody-a", "utf-8");
}

describe("source store reads", () => {
  it("lists sorted by id, bodies opt-in, with frontmatter metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "src-list-"));
    await seed(root);
    const { sources } = await listSources(root);
    expect(sources.map((s) => s.id)).toEqual(["a.md", "b.md"]);
    expect(sources[0]).toMatchObject({ id: "a.md", title: "A", source: "s1", sourceType: "web" });
    expect(sources[0].body).toBeUndefined();
    const withBody = await listSources(root, { includeBody: true });
    expect(withBody.sources.find((s) => s.id === "a.md")?.body).toContain("body-a");
  });

  it("paginates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "src-page-"));
    await seed(root);
    const p1 = await listSources(root, { limit: 1 });
    expect(p1.sources.map((s) => s.id)).toEqual(["a.md"]);
    expect(p1.cursor).toBeDefined();
    const p2 = await listSources(root, { limit: 1, cursor: p1.cursor });
    expect(p2.sources.map((s) => s.id)).toEqual(["b.md"]);
    expect(p2.cursor).toBeUndefined();
  });

  it("getSource hit/miss; rejects unsafe ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "src-get-"));
    await seed(root);
    expect((await getSource(root, "a.md"))?.body).toContain("body-a");
    expect(await getSource(root, "missing.md")).toBeNull();
    await expect(getSource(root, "../secret.md")).rejects.toBeInstanceOf(PathSafetyError);
    await expect(getSource(root, "a.txt")).rejects.toBeInstanceOf(PathSafetyError);
  });
});
