/**
 * Filesystem snapshot witnesses exercise production page ordering and candidate
 * admission. Fault injection changes only individual filesystem operations;
 * confinement, parsing, and classification still run against real fixtures.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectAnswerCitationIndex } from "../src/citations/answer-index.js";
import { reportAnswerCitations } from "../src/citations/answer-report.js";
import { collectViewerPages, resolveBareSlug } from "../src/viewer/collect.js";
import { listCandidates } from "../src/compiler/candidate-read.js";
import { UnsafeCandidateDirError } from "../src/compiler/candidate-store-paths.js";
import * as output from "../src/utils/output.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";

vi.mock("fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile), realpath: vi.fn(actual.realpath),
    open: vi.fn(actual.open), readdir: vi.fn(actual.readdir) };
});

let root: string;
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "answer-index-"))); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

/** Create a page or queue fixture under the temporary project. */
async function put(relative: string, content: string) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

/** Use admission's real required fields, with deliberate invalid fields per test. */
async function candidate(id: string, extra: Record<string, unknown> = {}) {
  return put(`.llmwiki/candidates/${id}.json`, JSON.stringify({
    id, slug: id, title: id, body: "---\naliases: [Not A Pending Alias]\n---", sources: [],
    summary: "", generatedAt: "2026-09-18T00:00:00Z", reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }], ...extra,
  }));
}

/** Intercept one candidate read while forwarding all reads to the real filesystem. */
async function beforeCandidateRead(file: string, action: (actual: typeof fs) => void | Promise<void>): Promise<void> {
  const actual = await vi.importActual<typeof fs>("fs/promises");
  vi.mocked(fs.readFile).mockImplementation(async (target, ...args) => {
    if (target === file) await action(actual);
    return actual.readFile(target, ...args);
  });
}

it("matches production ordering, identities and aliases while ignoring typed-only pages", async () => {
  await put("wiki/concepts/alpha.md", "---\naliases: [Query Exact, Shared Alias, 42]\n---\nbody");
  await put("wiki/concepts/second.md", "---\naliases: [Shared Alias]\n---");
  await put("wiki/queries/query-exact.md", "---\naliases: [Query Alias]\n---");
  await put("wiki/queries/alpha.md", "no frontmatter");
  await put("wiki/concepts/Raw Name.md", "---\naliases: [Raw Alias]\n---");
  await put("wiki/papers/alpha.md", "---\naliases: [Typed Alias]\n---");
  await put("wiki/papers/typed-only.md", "typed");
  const index = await collectAnswerCitationIndex(root);
  const pages = await collectViewerPages(root);
  expect(index.retained).toEqual(pages.map(({ id, pageDirectory, slug, aliases }) => ({ id, pageDirectory, slug, aliases })));
  for (const target of ["alpha", "query-exact", "shared-alias", "query-alias", "raw-alias", "typed-alias", "typed-only"]) {
    const report = await reportAnswerCitations(root, `[[${target}]]`);
    const pageId = resolveBareSlug(target, pages);
    expect(report.citations).toEqual([pageId ? { target, status: "resolved", pageId } : { target, status: "broken" }]);
  }
});

it("admits default and imported query candidates, excluding typed, malformed and unsupported targets", async () => {
  await candidate("default");
  await candidate("imported", { targetDirectory: "queries", reviewMode: "imported", slug: "query-answer" });
  await candidate("typed-only", { targetEntityType: "papers" });
  await candidate("bad-dir", { targetDirectory: "papers" });
  await candidate("unnormalized", { slug: "Raw Name" });
  await candidate("malformed", { sources: null });
  await put(".llmwiki/candidates/broken.json", "{");
  const notes = vi.spyOn(output, "note").mockImplementation(() => {});
  const index = await collectAnswerCitationIndex(root);
  expect(index.pending).toEqual([
    { target: "default", candidateId: "default" }, { target: "query-answer", candidateId: "imported" },
  ]);
  expect(notes.mock.calls.flat().join("\n")).toContain("Skipping malformed candidate file: malformed.json");
  expect(notes.mock.calls.flat().join("\n")).toContain("Skipping unparseable candidate file: broken.json");
  const report = await reportAnswerCitations(root, "[[typed-only]] [[malformed]] [[bad-dir]] [[Raw Name]] [[Not A Pending Alias]]");
  expect(report.citations.every((entry) => entry.status === "broken")).toBe(true);
});

it("allows in-directory leaf aliases and rejects escaping leaves and redirected directories", async () => {
  const target = await put("wiki/concepts/alpha.md", "---\naliases: [Alias]\n---");
  await fs.symlink(target, path.join(root, "wiki/concepts/local.md"));
  const outside = await put("outside/secret.md", "---\naliases: [Secret]\n---");
  await fs.symlink(outside, path.join(root, "wiki/concepts/escape.md"));
  await fs.symlink(path.dirname(outside), path.join(root, "wiki/queries"));
  expect((await collectAnswerCitationIndex(root)).retained.map((page) => page.id)).toEqual(["concepts/alpha", "concepts/local"]);
});

it("drops a page disappearing between listing and opening", async () => {
  const file = await put("wiki/concepts/alpha.md", "---\naliases: [Alias]\n---");
  const actual = await vi.importActual<typeof fs>("fs/promises");
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    await actual.unlink(file);
    return actual.open(...args);
  });
  expect((await collectAnswerCitationIndex(root)).retained).toEqual([]);
});

it("rejects a handle opened during a parent swap even after the path is restored", async () => {
  await put("wiki/concepts/alpha.md", "---\naliases: [Inside]\n---");
  await put("outside/alpha.md", "---\naliases: [Secret]\n---");
  const actual = await vi.importActual<typeof fs>("fs/promises");
  const dir = path.join(root, "wiki/concepts");
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    await actual.rename(dir, `${dir}-saved`);
    await actual.symlink(path.join(root, "outside"), dir);
    const handle = await actual.open(...args);
    await actual.unlink(dir);
    await actual.rename(`${dir}-saved`, dir);
    return handle;
  });
  expect((await collectAnswerCitationIndex(root)).retained).toEqual([]);
});

it.each(["open", "read", "realpath", "readdir"] as const)("propagates genuine retained %s faults", async (operation) => {
  const file = await put("wiki/concepts/alpha.md", "---\naliases: [Alias]\n---");
  const fault = Object.assign(new Error("I/O fault"), { code: "EIO" });
  if (operation === "read") {
    const actual = await vi.importActual<typeof fs>("fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, "read").mockRejectedValueOnce(fault);
      return handle;
    });
  } else if (operation === "realpath") {
    const actual = await vi.importActual<typeof fs>("fs/promises");
    vi.mocked(fs.realpath).mockImplementation(async (target, ...args) => {
      if (target === file) throw fault;
      return actual.realpath(target, ...args);
    });
  } else vi.mocked(fs[operation]).mockRejectedValueOnce(fault);
  await expect(collectAnswerCitationIndex(root)).rejects.toMatchObject({ code: "EIO" });
});

it("closes the collector handle on success and on a read fault", async () => {
  await put("wiki/concepts/alpha.md", "---\naliases: [Alias]\n---");
  const actual = await vi.importActual<typeof fs>("fs/promises");
  let opened: FileHandle | undefined;
  vi.mocked(fs.open).mockImplementation(async (...args) => { opened = await actual.open(...args); return opened; });
  await collectAnswerCitationIndex(root);
  await expect(opened!.stat()).rejects.toMatchObject({ code: "EBADF" });
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    opened = await actual.open(...args);
    vi.spyOn(opened, "read").mockRejectedValueOnce(Object.assign(new Error("fault"), { code: "EIO" }));
    return opened;
  });
  await expect(collectAnswerCitationIndex(root)).rejects.toMatchObject({ code: "EIO" });
  await expect(opened!.stat()).rejects.toMatchObject({ code: "EBADF" });
});

it("does not hide candidate read faults while legacy listing keeps its default", async () => {
  const file = await candidate("alpha");
  await beforeCandidateRead(file, () => {
    throw Object.assign(new Error("I/O fault"), { code: "EIO" });
  });
  expect(await listCandidates(root)).toEqual([]);
  await expect(collectAnswerCitationIndex(root)).rejects.toMatchObject({ code: "EIO" });
});

it("does not hide candidate directory realpath faults in either listing mode", async () => {
  await candidate("alpha");
  const actual = await vi.importActual<typeof fs>("fs/promises");
  vi.mocked(fs.realpath).mockImplementation(async (target, ...args) => {
    if (target === path.join(root, ".llmwiki/candidates")) throw Object.assign(new Error("I/O fault"), { code: "EACCES" });
    return actual.realpath(target, ...args);
  });
  // The store binding fails closed for every caller: a directory fault is a
  // typed refusal, never an empty queue presented as trustworthy.
  await expect(listCandidates(root)).rejects.toBeInstanceOf(UnsafeCandidateDirError);
  await expect(collectAnswerCitationIndex(root)).rejects.toBeInstanceOf(UnsafeCandidateDirError);
});

it("preserves candidate confinement refusal", async () => {
  await fs.mkdir(path.join(root, ".llmwiki"));
  await fs.symlink(os.tmpdir(), path.join(root, ".llmwiki/candidates"));
  await expect(collectAnswerCitationIndex(root)).rejects.toBeInstanceOf(UnsafeCandidateDirError);
});

it("collects fresh metadata on each call without taking a mutation lock", async () => {
  expect(await acquireLock(root)).toBe(true);
  const first = await reportAnswerCitations(root, "[[alpha]]");
  expect(first.citations).toEqual([{ target: "alpha", status: "broken" }]);
  await candidate("alpha");
  expect((await reportAnswerCitations(root, "[[alpha]]")).citations).toEqual([{ target: "alpha", status: "pending", candidateIds: ["alpha"] }]);
  await put("wiki/concepts/alpha.md", "no frontmatter");
  expect((await reportAnswerCitations(root, "[[alpha]]")).citations).toEqual([{ target: "alpha", status: "resolved", pageId: "concepts/alpha" }]);
  expect(await acquireLock(root, { quiet: true })).toBe(false);
  await releaseLock(root);
});

it("skips a candidate disappearing after listing without manufacturing pending", async () => {
  const file = await candidate("alpha");
  await beforeCandidateRead(file, (actual) => actual.unlink(file));
  expect((await reportAnswerCitations(root, "[[alpha]]")).citations).toEqual([{ target: "alpha", status: "broken" }]);
});

it("retains malformed and missing frontmatter pages without inventing aliases", async () => {
  await put("wiki/concepts/malformed.md", "---\naliases: [invalid\n---");
  await put("wiki/concepts/missing.md", "plain markdown");
  expect((await collectAnswerCitationIndex(root)).retained).toEqual([
    { id: "concepts/malformed", pageDirectory: "concepts", slug: "malformed", aliases: [] },
    { id: "concepts/missing", pageDirectory: "concepts", slug: "missing", aliases: [] },
  ]);
});
