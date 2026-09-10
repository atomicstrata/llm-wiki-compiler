/** Real source discovery controls for opt-in recursion and explicit deselection. */
import { expect, it, vi } from "vitest";
import { mkdir, readFile, unlink, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { detectChanges, hashFile } from "../src/compiler/hasher.js";
import { printChangesSummary } from "../src/compiler/compile-report.js";
import type { WikiState } from "../src/utils/types.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot(["sources", ".llmwiki"]);
const emptyState = (): WikiState => ({ version: 1, indexHash: "", sources: {} });

/** Write a canonical source without flattening its path. */
async function source(id: string, body = id): Promise<string> {
  const file = path.join(root.dir, "sources", id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  return file;
}

/** Set project selection while preserving the versioned config envelope. */
async function config(sources: unknown): Promise<void> {
  await writeFile(path.join(root.dir, ".llmwiki", "config.json"), JSON.stringify({ version: 1, sources }));
}

it("keeps flat discovery and dot-prefixed Markdown unchanged by default", async () => {
  await source("top.md");
  await source(".note.md");
  await source("nested/notes.md");
  expect(await detectChanges(root.dir, emptyState())).toEqual([
    { file: ".note.md", status: "new" }, { file: "top.md", status: "new" },
  ]);
});

it("keeps default discovery for legacy connector-only config without a version", async () => {
  await source("top.md");
  await writeFile(path.join(root.dir, ".llmwiki/config.json"), JSON.stringify({ connectors: {} }));
  expect(await detectChanges(root.dir, emptyState())).toEqual([{ file: "top.md", status: "new" }]);
});

it("requires version 1 when explicit source settings are present", async () => {
  await writeFile(path.join(root.dir, ".llmwiki/config.json"), JSON.stringify({ sources: { recursive: true } }));
  await expect(detectChanges(root.dir, emptyState())).rejects.toThrow('requires "version": 1');
});

it("discovers same-basename nested sources as distinct relative keys", async () => {
  await source("a/notes.md", "alpha");
  await source("b/notes.md", "beta");
  await config({ recursive: true });
  expect(await detectChanges(root.dir, emptyState())).toEqual([
    { file: "a/notes.md", status: "new" }, { file: "b/notes.md", status: "new" },
  ]);
});

it("excludes exact paths and their descendants without excluding similarly named siblings", async () => {
  await source("inbox/secret.md");
  await source("inbox-old/keep.md");
  await source("top.md");
  await config({ recursive: true, exclude: ["./inbox/", "top.md"] });
  expect(await detectChanges(root.dir, emptyState())).toEqual([{ file: "inbox-old/keep.md", status: "new" }]);
});

it("tracks nested changes and real deletion against their canonical keys", async () => {
  const file = await source("records/note.md", "original");
  await config({ recursive: true });
  const state = emptyState();
  state.sources["records/note.md"] = { hash: await hashFile(file), concepts: [], compiledAt: "2026-01-01" };
  expect(await detectChanges(root.dir, state)).toEqual([{ file: "records/note.md", status: "unchanged" }]);
  await writeFile(file, "changed");
  expect(await detectChanges(root.dir, state)).toEqual([{ file: "records/note.md", status: "changed" }]);
  await unlink(file);
  expect(await detectChanges(root.dir, state)).toEqual([{ file: "records/note.md", status: "deleted" }]);
});

it.each([
  { recursive: true, exclude: ["records"] },
  { recursive: false },
])("distinguishes deselection from missing files and leaves source bytes untouched: %j", async (selection) => {
  const file = await source("records/note.md", "keep these bytes");
  const state = emptyState();
  state.sources["records/note.md"] = { hash: await hashFile(file), concepts: ["shared"], compiledAt: "2026-01-01" };
  await config(selection);
  expect(await detectChanges(root.dir, state)).toEqual([
    { file: "records/note.md", status: "deleted", reason: "deselected" },
  ]);
  expect(await readFile(file, "utf8")).toBe("keep these bytes");
});

it.each([[], { recursive: "yes" }, { exclude: ["../outside"] }, { exclude: ["a\\b"] }, { exclude: [""] }].map((selection) => ({ selection })))(
  "rejects invalid source selection rather than silently changing its scope: $selection", async ({ selection }) => {
    await config(selection);
    await expect(detectChanges(root.dir, emptyState())).rejects.toThrow();
  },
);

it("does not discover Markdown through a symlinked subtree", async () => {
  await mkdir(path.join(root.dir, "outside"));
  await writeFile(path.join(root.dir, "outside", "secret.md"), "not a source");
  await symlink(path.join(root.dir, "outside"), path.join(root.dir, "sources", "alias"), "dir");
  await source("records/live.md");
  await config({ recursive: true });
  expect(await detectChanges(root.dir, emptyState())).toEqual([{ file: "records/live.md", status: "new" }]);
});

it("reports contribution deselection without saying the file was deleted", () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
  printChangesSummary([{ file: "records/note.md", status: "deleted", reason: "deselected" }]);
  expect(lines.join("\n")).toContain("records/note.md [deselected; file untouched]");
  expect(lines.join("\n")).toContain("select it again");
});
