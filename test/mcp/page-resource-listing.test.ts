/**
 * @file test/mcp/page-resource-listing.test.ts
 * @description FIXED outcomes for the two MCP resource-template listings
 * (`llmwiki://concept/{slug}` and `llmwiki://query/{slug}`), driven through
 * the PRODUCTION registration: `registerWikiResources` on a real `McpServer`,
 * then the list callback the server would call for `resources/list`.
 *
 * The listing reaches the directory through the core's `listPageFileNames`.
 * What is pinned is what a client observes and what the migration must not
 * change: names come back in the order the directory read gives them, with no
 * sort; an entry is listed when its name ends in `.md` and for no other
 * reason, so a directory, a link, a dangling link and a file named exactly
 * `.md` are listed too; the slug is the name without one trailing `.md`, the
 * URI carries `encodeURIComponent` of it; and EVERY listing failure is an
 * empty list, never a rejection. The read path is separate and is shown to
 * behave as before.
 *
 * Entries are real files, directories and links. Order and faults that cannot
 * be made on disk are planted through a module mock of `fs/promises` that
 * forwards to the real filesystem. The storage file imports
 * `node:fs/promises`; the mock reaching it is part of what is shown.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as real from "fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Every directory read seen, plus a planted answer or failure per directory. */
const watch = (() => ({
  seen: [] as Array<{ target: string; extraArguments: number }>,
  answer: new Map<string, string[]>(),
  fail: new Map<string, Error>(),
}))();

// Snapshot real modules before mock.module replaces them for this file.
const realFsPromises = { ...(await import("fs/promises")) };

vi.mock("fs/promises", async () => {
  const disk = (realFsPromises as typeof import("fs/promises"));
  const readdir = (target: unknown, ...rest: unknown[]): unknown => {
    watch.seen.push({ target: String(target), extraArguments: rest.length });
    const failure = watch.fail.get(String(target));
    if (failure) return Promise.reject(failure);
    const planted = watch.answer.get(String(target));
    if (planted) return Promise.resolve([...planted]);
    return (disk.readdir as (...args: unknown[]) => unknown)(target, ...rest);
  };
  return { ...disk, readdir };
});

import { registerWikiResources } from "../../src/mcp/resources.js";
import { listPageFileNames } from "../../src/pages/file-names.js";

type Listed = Array<{ uri: string; name: string }>;
type Template = {
  resourceTemplate: { listCallback: (extra: unknown) => Promise<{ resources: Listed }> };
  readCallback: (uri: URL, vars: Record<string, string>) => Promise<{ contents: Array<{ text: string }> }>;
};

let root = "";
const concepts = (): string => path.join(root, "wiki/concepts");
const queries = (): string => path.join(root, "wiki/queries");

/** The template the production registration put on a fresh server. */
function template(name: "wiki-concept" | "wiki-query"): Template {
  const server = new McpServer({ name: "llmwiki", version: "test" });
  registerWikiResources(server, root);
  return (server as unknown as { _registeredResourceTemplates: Record<string, Template> })._registeredResourceTemplates[name]!;
}

const list = async (name: "wiki-concept" | "wiki-query"): Promise<Listed> => (await template(name).resourceTemplate.listCallback({})).resources;
const page = (title: string): string => `---\ntitle: ${title}\n---\n\nBody of ${title}.\n`;

/** A coded error to plant on one directory read. */
function refuse(directory: string, code: string): Error {
  const error = Object.assign(new Error(`planted ${code}`), { code });
  watch.fail.set(directory, error);
  return error;
}

beforeEach(async () => {
  root = await real.realpath(await real.mkdtemp(path.join(tmpdir(), "page-resource-listing-")));
  await real.mkdir(concepts(), { recursive: true });
  await real.mkdir(queries(), { recursive: true });
  watch.seen = [];
  watch.answer.clear();
  watch.fail.clear();
});

afterEach(async () => {
  watch.answer.clear();
  watch.fail.clear();
  await real.rm(root, { recursive: true, force: true });
});

describe("page resource listing", () => {
  // Node's readdir arrived name-sorted (libuv sorts); Bun's returns raw directory
  // order. The listing primitive now orders names itself, so the resource list
  // never depends on the runtime or filesystem: any raw order lists the same.
  it("lists in name order whatever order the directory read gives", async () => {
    watch.answer.set(concepts(), ["b.md", "a.md", "c.md"]);
    expect((await list("wiki-concept")).map((entry) => entry.name)).toEqual(["a", "b", "c"]);
  });

  it("reads each page directory once, by its joined path and nothing else", async () => {
    await list("wiki-concept");
    await list("wiki-query");
    expect(watch.seen).toEqual([{ target: concepts(), extraArguments: 0 }, { target: queries(), extraArguments: 0 }]);
  });

  it("lists a name only when it ends in .md, and strips one trailing .md", async () => {
    watch.answer.set(concepts(), ["note.txt", "x.MD", "a.md.bak", "README", "a.b.md", "a.md.md"]);
    expect(await list("wiki-concept")).toEqual([
      { uri: "llmwiki://concept/a.b", name: "a.b" },
      { uri: "llmwiki://concept/a.md", name: "a.md" },
    ]);
  });

  it("lists entries that are present but are not pages", async () => {
    await real.writeFile(path.join(concepts(), "real.md"), page("Real"));
    await real.mkdir(path.join(concepts(), "dir.md"));
    await real.symlink("real.md", path.join(concepts(), "link.md"));
    await real.symlink("no-such-target.md", path.join(concepts(), "dangling.md"));
    await real.writeFile(path.join(concepts(), ".md"), "");
    const names = (await list("wiki-concept")).map((entry) => entry.name).sort();
    expect(names).toEqual(["", "dangling", "dir", "link", "real"]);
  });

  it("percent-encodes the slug in the URI and leaves the name raw", async () => {
    const slugs = ["Foo #1", "a b", "理", "50%", "q?x"];
    watch.answer.set(queries(), slugs.map((slug) => `${slug}.md`));
    const listed = [...slugs].sort((a, b) => (`${a}.md` < `${b}.md` ? -1 : 1));
    expect(await list("wiki-query")).toEqual(listed.map((slug) => ({ uri: `llmwiki://query/${encodeURIComponent(slug)}`, name: slug })));
  });

  it("answers an empty list for a missing directory, and the other listing is unaffected", async () => {
    await real.rm(queries(), { recursive: true });
    await real.writeFile(path.join(concepts(), "kept.md"), page("Kept"));
    expect(await list("wiki-query")).toEqual([]);
    expect(await list("wiki-concept")).toEqual([{ uri: "llmwiki://concept/kept", name: "kept" }]);
  });

  it("swallows every listing error into an empty list", async () => {
    refuse(concepts(), "EACCES");
    expect(await list("wiki-concept")).toEqual([]);
    await real.rm(queries(), { recursive: true });
    await real.writeFile(queries(), "a file where the directory should be");
    expect(await list("wiki-query")).toEqual([]);
  });
});

describe("listPageFileNames, called directly", () => {
  it("returns every name unfiltered in name order, and rejects with the listing's own error", async () => {
    watch.answer.set(concepts(), ["z.txt", "b.md", ".hidden", "a.md"]);
    expect(await listPageFileNames(root, "wiki/concepts")).toEqual([".hidden", "a.md", "b.md", "z.txt"]);
    const error = refuse(queries(), "EPERM");
    await expect(listPageFileNames(root, "wiki/queries")).rejects.toBe(error);
  });
});

describe("the read path beside the listing", () => {
  it("still reads a listed page and still refuses a traversal", async () => {
    await real.writeFile(path.join(concepts(), "Foo #1.md"), page("Foo One"));
    const [entry] = await list("wiki-concept");
    const encoded = entry!.uri.slice("llmwiki://concept/".length);
    const read = await template("wiki-concept").readCallback(new URL(entry!.uri), { slug: encoded });
    expect(JSON.parse(read.contents[0]!.text)).toMatchObject({ slug: "Foo #1", body: "Body of Foo One." });
    const escape = encodeURIComponent("../../outside");
    await expect(template("wiki-concept").readCallback(new URL(`llmwiki://concept/${escape}`), { slug: escape })).rejects.toThrow(/Page not found/);
  });
});
