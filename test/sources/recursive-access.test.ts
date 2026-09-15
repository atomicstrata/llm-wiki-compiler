/** Nested source IDs must survive store operations and the viewer's frozen allowlist. */
import { beforeEach, expect, it } from "vitest";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { listSources, getSource, deleteSource, sourceFileMissing } from "../../src/sources/store.js";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { readViewerSource } from "../../src/viewer/source-access.js";
import { startViewerServer } from "../../src/viewer/server.js";
import { saveSource } from "../../src/utils/source-writer.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { runCLI, expectCLIExit } from "../fixtures/run-cli.js";

const root = useTempRoot(["sources/a", "sources/b", "sources/inbox", ".llmwiki"]);
beforeEach(async () => {
  await writeFile(path.join(root.dir, ".llmwiki/config.json"), JSON.stringify({
    version: 1, sources: { recursive: true, exclude: ["inbox"] },
  }));
  await writeFile(path.join(root.dir, "sources/a/notes.md"), "# Alpha\n\nAlpha body.");
  await writeFile(path.join(root.dir, "sources/b/notes.md"), "# Beta\n\nBeta body.");
  await writeFile(path.join(root.dir, "sources/inbox/secret.md"), "untriaged");
});

it("lists and reads distinct nested source IDs without basename collisions", async () => {
  const listed = await listSources(root.dir, { includeBody: true });
  expect(listed.sources.map((entry) => entry.id)).toEqual(["a/notes.md", "b/notes.md"]);
  expect((await getSource(root.dir, "a/notes.md"))?.body).toContain("Alpha body.");
  expect((await getSource(root.dir, "b/notes.md"))?.body).toContain("Beta body.");
});

it("deletes only the exact nested source and preserves the same-basename sibling", async () => {
  expect(await deleteSource(root.dir, "a/notes.md")).toBe(true);
  expect(await sourceFileMissing(root.dir, "a/notes.md")).toBe(true);
  expect(await readFile(path.join(root.dir, "sources/b/notes.md"), "utf8")).toContain("Beta body.");
});

it("does not read or delete a nested source through a directory alias", async () => {
  await symlink(path.join(root.dir, "sources/a"), path.join(root.dir, "sources/alias"), "dir");
  expect(await getSource(root.dir, "alias/notes.md")).toBeNull();
  expect(await deleteSource(root.dir, "alias/notes.md")).toBe(false);
  expect(await readFile(path.join(root.dir, "sources/a/notes.md"), "utf8")).toContain("Alpha body.");
});

it("builds a selected nested viewer allowlist while retaining non-Markdown inventory", async () => {
  await mkdir(path.join(root.dir, "sources/papers"));
  await writeFile(path.join(root.dir, "sources/papers/original.pdf"), "placeholder PDF bytes");
  const snapshot = await buildViewerSnapshot(root.dir);
  expect(snapshot.sourceFilenames).toEqual(["a/notes.md", "b/notes.md", "papers/original.pdf"]);
  const selected = await readViewerSource(root.dir, snapshot.sourceFilenames, "a/notes.md", true);
  expect(selected).toMatchObject({ health: "ok", id: "a/notes.md" });
  expect(selected.body).toContain("Alpha body.");
  expect(await readViewerSource(root.dir, snapshot.sourceFilenames, "inbox/secret.md", true)).toMatchObject({ health: "missing" });
  expect(await readViewerSource(root.dir, snapshot.sourceFilenames, "papers/original.pdf", true)).toMatchObject({ health: "unsupported" });
});

it("serves the nested source through the real encoded-slash HTTP route", async () => {
  const handle = await startViewerServer(await buildViewerSnapshot(root.dir), { host: "127.0.0.1", port: 0 });
  try {
    const base = `http://127.0.0.1:${handle.port}/api/source`;
    const response = await fetch(`${base}/a%2Fnotes.md/content`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# Alpha\n\nAlpha body.");
    const excluded = await fetch(`${base}/inbox%2Fsecret.md/content`);
    expect(excluded.status).toBe(409);
    expect(await excluded.text()).not.toContain("untriaged");
    expect((await fetch(`${base}/a%2F..%2Fb%2Fnotes.md/content`)).status).toBe(400);
  } finally {
    await handle.close();
  }
});

it.each(["a", "inbox"])("re-ingests the existing nested identity in %s without duplicating it", async (directory) => {
  const filename = `${directory}/notes.md`;
  const sourcePath = path.join(root.dir, "sources", filename);
  await writeFile(sourcePath, "---\nsource: manual:nested\n---\nold");
  const result = await saveSource(root.dir, "New title", "---\nsource: manual:nested\n---\nupdated", "manual:nested");
  expect(result).toEqual({ path: await realpath(sourcePath), writeStatus: "updated" });
  expect(await readFile(sourcePath, "utf8")).toContain("updated");
});

it("the real rm command removes the named nested file, not its same-basename sibling", async () => {
  const result = await runCLI(["rm", "a/notes.md"], root.dir);
  expectCLIExit(result, 0);
  expect(await sourceFileMissing(root.dir, "a/notes.md")).toBe(true);
  expect(await readFile(path.join(root.dir, "sources/b/notes.md"), "utf8")).toContain("Beta body.");
});
