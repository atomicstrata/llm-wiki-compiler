/**
 * MCP resource registrations for llmwiki.
 *
 * Resources expose read-only views of the wiki under the llmwiki:// URI
 * scheme. Hosts can attach these as context without invoking a tool —
 * useful for letting agents browse the wiki passively.
 */

import path from "path";
import { readdir } from "fs/promises";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CONCEPTS_DIR,
  INDEX_FILE,
  QUERIES_DIR,
  SOURCES_DIR,
  STATE_FILE,
} from "../utils/constants.js";
import { safeReadFile, parseFrontmatter } from "../utils/markdown.js";
import { readStateClassified } from "../utils/state.js";
import { loadPreviousReport, loadHistory } from "../eval/stats.js";

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

/** Register all 7 read-only wiki resources on the given MCP server. */
export function registerWikiResources(server: McpServer, root: string): void {
  registerIndexResource(server, root);
  registerSourcesResource(server, root);
  registerStateResource(server, root);
  registerConceptResource(server, root);
  registerQueryResource(server, root);
  registerEvalReportResource(server, root);
  registerEvalHistoryResource(server, root);
}

function registerIndexResource(server: McpServer, root: string): void {
  server.registerResource(
    "wiki-index",
    "llmwiki://index",
    {
      title: "Wiki Index",
      description: "Full content of wiki/index.md (auto-generated table of contents).",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const content = await safeReadFile(path.join(root, INDEX_FILE));
      return { contents: [markdownContent(uri, content)] };
    },
  );
}

function registerSourcesResource(server: McpServer, root: string): void {
  server.registerResource(
    "wiki-sources",
    "llmwiki://sources",
    {
      title: "Wiki Sources",
      description: "List of ingested source files with frontmatter metadata.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [jsonContent(uri, await listSources(root))],
    }),
  );
}

function registerStateResource(server: McpServer, root: string): void {
  server.registerResource(
    "wiki-state",
    "llmwiki://state",
    {
      title: "Compilation State",
      description: "Per-source hashes, concepts, and last compile times from .llmwiki/state.json.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { status, state } = await readStateClassified(root);
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

function registerConceptResource(server: McpServer, root: string): void {
  server.registerResource(
    "wiki-concept",
    new ResourceTemplate("llmwiki://concept/{slug}", {
      list: async () => listPagesUnder(root, CONCEPTS_DIR, "concept"),
    }),
    {
      title: "Wiki Concept",
      description: "A single concept page from wiki/concepts/ — frontmatter plus body.",
      mimeType: "application/json",
    },
    async (uri, { slug }) => ({
      contents: [jsonContent(uri, await loadPageWithMeta(root, CONCEPTS_DIR, String(slug)))],
    }),
  );
}

function registerQueryResource(server: McpServer, root: string): void {
  server.registerResource(
    "wiki-query",
    new ResourceTemplate("llmwiki://query/{slug}", {
      list: async () => listPagesUnder(root, QUERIES_DIR, "query"),
    }),
    {
      title: "Wiki Query",
      description: "A single saved query page from wiki/queries/ — frontmatter plus body.",
      mimeType: "application/json",
    },
    async (uri, { slug }) => ({
      contents: [jsonContent(uri, await loadPageWithMeta(root, QUERIES_DIR, String(slug)))],
    }),
  );
}

/** Source listing: filename, frontmatter (truncation, source URL, etc.). */
async function listSources(root: string): Promise<Array<Record<string, unknown>>> {
  const sourcesPath = path.join(root, SOURCES_DIR);
  let files: string[];
  try {
    files = await readdir(sourcesPath);
  } catch {
    return [];
  }

  const records: Array<Record<string, unknown>> = [];
  for (const file of files.filter((f) => f.endsWith(".md"))) {
    const content = await safeReadFile(path.join(sourcesPath, file));
    const { meta } = parseFrontmatter(content);
    records.push({ filename: file, ...meta });
  }
  return records;
}

/** Read a single page and return a structured payload (slug, meta, body). */
async function loadPageWithMeta(
  root: string,
  dir: string,
  slug: string,
): Promise<{ slug: string; meta: Record<string, unknown>; body: string }> {
  const filePath = path.join(root, dir, `${slug}.md`);
  const content = await safeReadFile(filePath);
  if (!content) {
    throw new Error(`Page not found: ${dir}/${slug}.md`);
  }

  const { meta, body } = parseFrontmatter(content);
  return { slug, meta, body: body.trim() };
}

function registerEvalReportResource(server: McpServer, root: string): void {
  server.registerResource(
    "eval-report",
    "llmwiki://eval/report",
    {
      title: "Eval Report",
      description: "Latest eval report — health score, citation coverage, corpus stats.",
      mimeType: "application/json",
    },
    async (uri) => {
      const report = await loadPreviousReport(root);
      return { contents: [jsonContent(uri, report ?? {})] };
    },
  );
}

function registerEvalHistoryResource(server: McpServer, root: string): void {
  server.registerResource(
    "eval-history",
    "llmwiki://eval/history",
    {
      title: "Eval History",
      description: "Eval run history — trend table of past eval reports.",
      mimeType: "application/json",
    },
    async (uri) => {
      const reports = await loadHistory(root);
      return { contents: [jsonContent(uri, reports)] };
    },
  );
}

/** Build a resource list payload by enumerating .md files in a wiki directory. */
async function listPagesUnder(
  root: string,
  dir: string,
  scheme: "concept" | "query",
): Promise<{ resources: Array<{ uri: string; name: string }> }> {
  const pagesPath = path.join(root, dir);
  let files: string[];
  try {
    files = await readdir(pagesPath);
  } catch {
    return { resources: [] };
  }

  const resources = files
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const slug = f.replace(/\.md$/, "");
      // S13: percent-encode the slug so a page-part containing spaces or `#`
      // (e.g. `Foo #1`) round-trips through the URI rather than truncating at
      // the `#` fragment delimiter. The read template decodes `{slug}` back.
      return { uri: `llmwiki://${scheme}/${encodeURIComponent(slug)}`, name: slug };
    });

  return { resources };
}
