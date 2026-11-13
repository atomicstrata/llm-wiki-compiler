/**
 * @file test/storage/mcp-resources-binding.test.ts
 * @description The MCP index, sources, concept and query resources over their
 * module-local reads, `registerWikiResourcesWith`, with no project directory.
 * This file uses it, which exists only after those resources were given reads
 * of their own, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. One small project is minted on real disk, once: an index, a
 * Markdown source with frontmatter, an unreadable-as-Markdown source, a
 * non-Markdown source, two concept pages (one whose slug needs URI encoding)
 * and a non-page file. The PRODUCTION `registerWikiResources(server, root)` is
 * read through a real `McpServer` (the index, the source listing, both page
 * listings, a concept read, a missing-concept refusal, the too-new state and the
 * eval report and history), then every regular
 * file's text and every directory listing is COPIED into memory and the
 * directory removed. Each case registers the same resources over reads of the
 * copy and requires what the disk gave.
 *
 * WHAT RUNS FOR REAL IN MEMORY. Every resource body: the index payload, the
 * source listing's order and frontmatter spread (through the REAL selected
 * source listing over the copy), the `.md` filter, slug stripping and URI
 * encoding of the page listings, an unlistable directory as an empty list, the
 * slug decoding, frontmatter parse and missing-page refusal of a page read, the
 * state resource's too-new refusal over the REAL classified state read, and the
 * eval resources over the REAL history reads (a malformed line skipped).
 *
 * THE ROOT ROUTE IS UNCHANGED. Every root reader the resources call is spied:
 * the bound route reaches none, and a fresh project read through
 * `registerWikiResources` reaches each with its exact arguments.
 *
 * NOT SHOWN HERE: what the disk decides (a slug that is not one component, a
 * page that escapes its directory, links); `page-resource-listing.test.ts` and
 * `mcp-resource-confinement.test.ts` show those. The doubles are not a hosted
 * store, not an access-control layer and not `ProjectStore`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { EvalFileReads } from "../../src/eval/file-reads.js";
import * as evalStats from "../../src/eval/stats.js";
import { registerWikiResources, registerWikiResourcesWith, type WikiResourceReads } from "../../src/mcp/resources.js";
import * as pageFileNames from "../../src/pages/file-names.js";
import * as pageRead from "../../src/pages/read.js";
import * as sourceScan from "../../src/sources/scan.js";
import { CONCEPTS_DIR, INDEX_FILE, QUERIES_DIR, SOURCES_DIR, STATE_FILE } from "../../src/utils/constants.js";
import * as markdown from "../../src/utils/markdown.js";
import * as stateRecords from "../../src/utils/state.js";
import { tempRootTracker } from "../temp-roots.js";
import { copiedSourceReadsOf } from "./copied-local-reads.js";
import { enoent, heldText, mintCopied, recordsOf, writeFiles, type Copy, type Minted } from "./copied-project.js";

const PREFIX = "mcp-resources-binding-";
/** The eval history file, as the eval reads name it. */
const HISTORY = ".llmwiki/eval/history.jsonl";
const SEED = {
  [INDEX_FILE]: "# Index\n\n- [[Alpha]]\n",
  [`${SOURCES_DIR}/paper.md`]: "---\ntitle: Paper\nsource_url: https://example.test/paper\n---\n\nBody.\n",
  [`${SOURCES_DIR}/plain.md`]: "No frontmatter.\n",
  [`${SOURCES_DIR}/notes.txt`]: "Not Markdown.\n",
  [`${CONCEPTS_DIR}/alpha.md`]: "---\ntitle: Alpha\nsummary: First.\n---\n\nAlpha body.\n",
  [`${CONCEPTS_DIR}/Foo #1.md`]: "---\ntitle: Foo\n---\n\nFoo body.\n",
  [`${CONCEPTS_DIR}/README.txt`]: "Not a page.\n",
  // A state written by a newer llmwiki: the state resource must refuse it, not stream it.
  [STATE_FILE]: JSON.stringify({ version: 999, indexHash: "", sources: {} }),
  [HISTORY]: '{"score":1}\nnot json\n{"score":2}\n',
};

/**
 * The registered resources and templates a client reaches through one server. The
 * SDK keys a fixed resource by its URI and a resource template by its name.
 */
interface Registered {
  resources: Record<string, { readCallback: (uri: URL) => Promise<unknown> }>;
  templates: Record<string, {
    resourceTemplate: { listCallback: (extra: unknown) => Promise<unknown> };
    readCallback: (uri: URL, vars: Record<string, string>) => Promise<unknown>;
  }>;
}

/** What a client observes of every resource: index, sources, both listings, a page, a missing page, the state, and the eval report and history. */
async function observe(register: (server: McpServer) => void): Promise<unknown[]> {
  const server = new McpServer({ name: "llmwiki", version: "test" });
  register(server);
  const { _registeredResources: resources, _registeredResourceTemplates: templates } = server as unknown as {
    _registeredResources: Registered["resources"]; _registeredResourceTemplates: Registered["templates"];
  };
  const concept = templates["wiki-concept"]!;
  const read = (uri: string): Promise<unknown> => resources[uri]!.readCallback(new URL(uri));
  return [
    await read("llmwiki://index"),
    await read("llmwiki://sources"),
    await concept.resourceTemplate.listCallback({}),
    await templates["wiki-query"]!.resourceTemplate.listCallback({}),
    await concept.readCallback(new URL("llmwiki://concept/Foo%20%231"), { slug: "Foo%20%231" }),
    await concept.readCallback(new URL("llmwiki://concept/missing"), { slug: "missing" }).catch((error: Error) => error.message),
    await read("llmwiki://state"),
    await read("llmwiki://eval/report"),
    await read("llmwiki://eval/history"),
  ];
}

const tracker = tempRootTracker();
let minted: Minted<unknown[]>;

beforeAll(async () => {
  minted = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, SEED), (root) => observe((server) => registerWikiResources(server, root)));
  await tracker.cleanup();
});
afterAll(() => tracker.cleanup());
afterEach(() => { vi.restoreAllMocks(); });

/** The JSON payload of one resource read result: its single content block's text, parsed. */
const payloadOf = (result: unknown): unknown => JSON.parse((result as { contents: [{ text: string }] }).contents[0].text);

/** The eval history reads over the copy: a path is there when the copy holds it as a file. */
const copiedEvalReads = (copy: Copy): EvalFileReads => ({
  existsSync: (rel) => copy.files.has(rel),
  readText: async (rel) => heldText(copy, rel),
});

/** The resource reads over the copy, each call logged; nothing here decides confinement. */
function copiedResourceReads(copy: Copy, log: string[]): WikiResourceReads {
  return {
    indexText: async () => { log.push("index"); return copy.files.get(INDEX_FILE) ?? ""; },
    sourceFiles: () => { log.push("sources"); return sourceScan.listSelectedSourceFilesFrom(copiedSourceReadsOf(copy, () => {})); },
    sourceText: async (file) => { log.push(`source ${file}`); return copy.files.get(`${SOURCES_DIR}/${file}`) ?? ""; },
    pageFileNames: async (dir) => {
      log.push(`list ${dir}`);
      const held = copy.listings.get(dir);
      if (held === undefined) throw enoent();
      return held.map((entry) => entry.name);
    },
    pageText: async (dir, slug) => { log.push(`page ${dir}/${slug}`); return copy.files.get(`${dir}/${slug}.md`) ?? null; },
    state: () => { log.push("state"); return stateRecords.readStateClassifiedFrom(recordsOf(copy, () => {})); },
    previousEvalReport: () => { log.push("eval report"); return evalStats.loadPreviousReportFrom(copiedEvalReads(copy)); },
    evalHistory: () => { log.push("eval history"); return evalStats.loadHistoryFrom(copiedEvalReads(copy)); },
  };
}

describe("the MCP read resources over a copied project, with the directory gone", () => {
  it("M1 answers every reads-backed resource exactly as the disk did", async () => {
    const observed = await observe((server) => registerWikiResourcesWith(server, copiedResourceReads(minted.copy, [])));
    expect(observed).toEqual(minted.onDisk);
    // The case only witnesses the listing, encoding, refusals and history when the disk gave them.
    expect(JSON.stringify(minted.onDisk)).toContain("llmwiki://concept/Foo%20%231");
    expect(minted.onDisk.at(-4)).toBe("Page not found: wiki/concepts/missing.md");
    expect(minted.onDisk.slice(-3).map(payloadOf)).toEqual([
      { stateStatus: "too-new", error: "written by a newer llmwiki version" }, { score: 2 }, [{ score: 1 }, { score: 2 }],
    ]);
  });

  it("M2 reads each listed source once, in listing order, after the listing", async () => {
    const log: string[] = [];
    await observe((server) => registerWikiResourcesWith(server, copiedResourceReads(minted.copy, log)));
    expect(log.slice(0, 4)).toEqual(["index", "sources", `source paper.md`, `source plain.md`]);
    expect(log.slice(4)).toEqual([
      `list ${CONCEPTS_DIR}`, "list wiki/queries", `page ${CONCEPTS_DIR}/Foo #1`, `page ${CONCEPTS_DIR}/missing`, "state", "eval report", "eval history",
    ]);
  });

  it("M3 reaches no root reader from the bound route, while the root route reaches each with its exact arguments", async () => {
    const spies = [vi.spyOn(markdown, "safeReadFile"), vi.spyOn(sourceScan, "listSelectedSourceFiles"), vi.spyOn(pageFileNames, "listPageFileNames"),
      vi.spyOn(pageRead, "readPageContent"), vi.spyOn(stateRecords, "readStateClassified"), vi.spyOn(evalStats, "loadPreviousReport"), vi.spyOn(evalStats, "loadHistory")];
    await observe((server) => registerWikiResourcesWith(server, copiedResourceReads(minted.copy, [])));
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual(spies.map(() => 0));
    const root = await tracker.create(PREFIX);
    await writeFiles(root, SEED);
    await observe((server) => registerWikiResources(server, root));
    expect(spies.map((spy) => spy.mock.calls)).toEqual([
      [[path.join(root, INDEX_FILE)], [path.join(root, SOURCES_DIR, "paper.md")], [path.join(root, SOURCES_DIR, "plain.md")]],
      [[root]], [[root, CONCEPTS_DIR], [root, QUERIES_DIR]], [[root, CONCEPTS_DIR, "Foo #1"], [root, CONCEPTS_DIR, "missing"]],
      [[root]], [[root]], [[root]],
    ]);
  });
});
