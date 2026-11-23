/**
 * MCP resource registrations for llmwiki.
 *
 * Resources expose read-only views of the wiki under the llmwiki:// URI
 * scheme. Hosts can attach these as context without invoking a tool —
 * useful for letting agents browse the wiki passively.
 *
 * Every resource reads through ONE module-local {@link WikiResourceReads}
 * object. {@link registerWikiResources} gives them the local root readers the
 * resources always called (with their exact empty, `null` and rejection
 * semantics); {@link registerWikiResourcesWith} takes any reads. The state
 * resource's one decision (fail closed on a too-new state) and the eval
 * resources' empty report stay in the resource bodies.
 */

import path from "path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONCEPTS_DIR, INDEX_FILE, QUERIES_DIR, SOURCES_DIR, STATE_FILE } from "@atomicstrata/llmwiki-core/compiler-cli";
import { safeReadFile, parseFrontmatter } from "@atomicstrata/llmwiki-core/compiler-cli";
import { readStateClassified, readPageContent } from "@atomicstrata/llmwiki-core/compiler-cli";
import { loadPreviousReport, loadHistory } from "@atomicstrata/llmwiki-core/compiler-cli";
import { listSelectedSourceFiles } from "@atomicstrata/llmwiki-core/compiler-cli";
import { indexedCatalogNote, routedPageFileNames, type CatalogListingNote } from "@atomicstrata/llmwiki-core/compiler-cli";

/** Standard JSON content block for an MCP resource read result. */
function jsonContent(uri: URL, payload: unknown): {
  uri: string;
  mimeType: string;
  text: string;
} {
  return {
    uri: uri.href,
    mimeType: "application/json",
    text: JSON.stringify(payload, null, 2),
  };
}

/** Standard markdown content block for an MCP resource read result. */
function markdownContent(uri: URL, text: string): {
  uri: string;
  mimeType: string;
  text: string;
} {
  return {
    uri: uri.href,
    mimeType: "text/markdown",
    text,
  };
}

/** The two page directories the page resources serve. */
type PageDirectory = typeof CONCEPTS_DIR | typeof QUERIES_DIR;

/** The reads every resource makes. No member takes a project root. */
export interface WikiResourceReads {
  /** The text of `wiki/index.md`; `""` when it cannot be read. */
  indexText(): Promise<string>;
  /** The selected Markdown source files, in listing order. Rejects raw. */
  sourceFiles(): Promise<string[]>;
  /** One listed source's text; `""` when it cannot be read. */
  sourceText(file: string): Promise<string>;
  /** One page directory's entry names, unsorted and unfiltered. Rejects when it cannot be listed. */
  pageFileNames(dir: PageDirectory): Promise<string[]>;
  /** OPTIONAL: the `local-indexed` catalog's freshness note, or `null` when the project is not indexed. */
  catalogNote?(): Promise<CatalogListingNote | null>;
  /** One page's text confined to `dir`; `null` for a refused slug, a missing page or an escape. */
  pageText(dir: PageDirectory, slug: string): Promise<string | null>;
  /** The classified compile state; never a recovering read. */
  state(): ReturnType<typeof readStateClassified>;
  /** The latest eval report, or `null` when there is none. */
  previousEvalReport(): ReturnType<typeof loadPreviousReport>;
  /** The eval run history, oldest first, as the eval history reads it. */
  evalHistory(): ReturnType<typeof loadHistory>;
}

/** LOCAL DISK. The root readers the resources always called, each called when asked. */
function diskWikiResourceReads(root: string): WikiResourceReads {
  return {
    indexText: () => safeReadFile(path.join(root, INDEX_FILE)),
    sourceFiles: () => listSelectedSourceFiles(root),
    sourceText: (file) => safeReadFile(path.join(root, SOURCES_DIR, file)),
    pageFileNames: (dir) => routedPageFileNames(root, dir),
    catalogNote: () => indexedCatalogNote(root),
    pageText: (dir, slug) => readPageContent(root, dir, slug),
    state: () => readStateClassified(root),
    previousEvalReport: () => loadPreviousReport(root),
    evalHistory: () => loadHistory(root),
  };
}

/** Register all 7 read-only wiki resources on the given MCP server. */
export function registerWikiResources(server: McpServer, root: string): void {
  registerWikiResourcesWith(server, diskWikiResourceReads(root));
}

/** {@link registerWikiResources} with every resource reading through `reads`. Registration order is unchanged. */
export function registerWikiResourcesWith(server: McpServer, reads: WikiResourceReads): void {
  registerIndexResource(server, reads);
  registerSourcesResource(server, reads);
  registerStateResource(server, reads);
  registerConceptResource(server, reads);
  registerQueryResource(server, reads);
  registerEvalReportResource(server, reads);
  registerEvalHistoryResource(server, reads);
}

function registerIndexResource(server: McpServer, reads: WikiResourceReads): void {
  server.registerResource(
    "wiki-index",
    "llmwiki://index",
    {
      title: "Wiki Index",
      description: "Full content of wiki/index.md (auto-generated table of contents).",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const content = await reads.indexText();
      return { contents: [markdownContent(uri, content)] };
    },
  );
}

function registerSourcesResource(server: McpServer, reads: WikiResourceReads): void {
  server.registerResource(
    "wiki-sources",
    "llmwiki://sources",
    {
      title: "Wiki Sources",
      description: "List of ingested source files with frontmatter metadata.",
      mimeType: "application/json",
    },
    async (uri) => {
      const note = await reads.catalogNote?.() ?? null;
      const catalog = note === null ? [] : [jsonContent(new URL("llmwiki://sources#catalog"), note)];
      return { contents: [jsonContent(uri, await listSources(reads)), ...catalog] };
    },
  );
}

function registerStateResource(server: McpServer, reads: WikiResourceReads): void {
  server.registerResource(
    "wiki-state",
    "llmwiki://state",
    {
      title: "Compilation State",
      description: "Per-source hashes, concepts, and last compile times from .llmwiki/state.json.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { status, state } = await reads.state();
      // Fail closed on a too-new state: every sibling surface branches on
      // `status`, so the resource must too rather than streaming a body written
      // by a newer llmwiki as if it were healthy. "ok"/"missing"/"corrupt" keep
      // their current byte-identical output (the carried state body).
      if (status === "too-new") {
        return {
          contents: [
            jsonContent(uri, {
              stateStatus: "too-new",
              error: "written by a newer llmwiki version",
            }),
          ],
        };
      }
      return { contents: [jsonContent(uri, state)] };
    },
  );
}

function registerConceptResource(server: McpServer, reads: WikiResourceReads): void {
  server.registerResource(
    "wiki-concept",
    new ResourceTemplate("llmwiki://concept/{slug}", {
      list: async () => listPagesUnder(reads, CONCEPTS_DIR, "concept"),
    }),
    {
      title: "Wiki Concept",
      description: "A single concept page from wiki/concepts/ — frontmatter plus body.",
      mimeType: "application/json",
    },
    async (uri, { slug }) => ({
      contents: [jsonContent(uri, await loadPageWithMeta(reads, CONCEPTS_DIR, decodeSlug(String(slug))))],
    }),
  );
}

function registerQueryResource(server: McpServer, reads: WikiResourceReads): void {
  server.registerResource(
    "wiki-query",
    new ResourceTemplate("llmwiki://query/{slug}", {
      list: async () => listPagesUnder(reads, QUERIES_DIR, "query"),
    }),
    {
      title: "Wiki Query",
      description: "A single saved query page from wiki/queries/ — frontmatter plus body.",
      mimeType: "application/json",
    },
    async (uri, { slug }) => ({
      contents: [jsonContent(uri, await loadPageWithMeta(reads, QUERIES_DIR, decodeSlug(String(slug))))],
    }),
  );
}

/** Source listing: filename, frontmatter (truncation, source URL, etc.). */
async function listSources(reads: WikiResourceReads): Promise<Array<Record<string, unknown>>> {
  const files = await reads.sourceFiles();

  const records: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const content = await reads.sourceText(file);
    const { meta } = parseFrontmatter(content);
    records.push({ filename: file, ...meta });
  }
  return records;
}

/**
 * Decode a URI template variable back to a slug.
 *
 * Resource URIs are built with `encodeURIComponent(slug)` (see
 * `listPagesUnder`), and the MCP SDK normalises the request URI — which
 * percent-encodes non-ASCII paths — before it matches the template, so
 * `{slug}` arrives still encoded. Without this step a page whose slug
 * contains non-ASCII characters (any CJK slug) resolves to
 * `wiki/concepts/ai%E7%90%86….md` and is reported as missing.
 *
 * Decoding can produce a path separator (`%2F`), so the result is untrusted;
 * `loadPageWithMeta` confines it before any read.
 *
 * @param value - Raw template variable, possibly percent-encoded.
 * @returns The decoded slug; the raw value when it is not valid escaping.
 */
function decodeSlug(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Read a single page and return a structured payload (slug, meta, body). The
 * slug is decoded from a caller's URI, so a `%2F` has become a real separator:
 * the page read ({@link readPageContent} locally) refuses anything but one
 * filename component and confines the read to `dir`, and every refusal reads as
 * a missing page.
 */
async function loadPageWithMeta(
  reads: WikiResourceReads,
  dir: PageDirectory,
  slug: string,
): Promise<{ slug: string; meta: Record<string, unknown>; body: string }> {
  const content = await reads.pageText(dir, slug);
  if (!content) {
    throw new Error(`Page not found: ${dir}/${slug}.md`);
  }

  const { meta, body } = parseFrontmatter(content);
  return { slug, meta, body: body.trim() };
}

function registerEvalReportResource(server: McpServer, reads: WikiResourceReads): void {
  server.registerResource(
    "eval-report",
    "llmwiki://eval/report",
    {
      title: "Eval Report",
      description: "Latest eval report — health score, citation coverage, corpus stats.",
      mimeType: "application/json",
    },
    async (uri) => {
      const report = await reads.previousEvalReport();
      return { contents: [jsonContent(uri, report ?? {})] };
    },
  );
}

function registerEvalHistoryResource(server: McpServer, reads: WikiResourceReads): void {
  server.registerResource(
    "eval-history",
    "llmwiki://eval/history",
    {
      title: "Eval History",
      description: "Eval run history — trend table of past eval reports.",
      mimeType: "application/json",
    },
    async (uri) => {
      const reports = await reads.evalHistory();
      return { contents: [jsonContent(uri, reports)] };
    },
  );
}

/** Build a resource list payload by enumerating .md files in a wiki directory. */
async function listPagesUnder(
  reads: WikiResourceReads,
  dir: PageDirectory,
  scheme: "concept" | "query",
): Promise<{ resources: Array<{ uri: string; name: string }>; _meta?: { catalog: CatalogListingNote } }> {
  let files: string[];
  try {
    files = await reads.pageFileNames(dir);
  } catch {
    return { resources: [] };
  }

  const resources = files
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const slug = f.replace(/\.md$/, "");
      // S13: percent-encode the slug so a page-part containing spaces or `#`
      // (e.g. `Foo #1`) round-trips through the URI rather than truncating at
      // the `#` fragment delimiter. `decodeSlug` undoes this on read.
      return { uri: `llmwiki://${scheme}/${encodeURIComponent(slug)}`, name: slug };
    });

  const note = await reads.catalogNote?.() ?? null;
  return note === null ? { resources } : { resources, _meta: { catalog: note } };
}
