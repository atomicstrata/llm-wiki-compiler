// src/mcp/okf-tools.ts
/** @file MCP OKF tools: export_okf (confined) + import_okf (staging-only, confined, queue-capped). Extracted from tools.ts to stay under the file-size limit. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { confineUnderRoot } from "../utils/path-confine.js";
import { withQuiet } from "../utils/output.js";
import { runOkfExport } from "../export/okf/run.js";
import { runOkfImport } from "../import/run.js";
import { jsonResult, errorResult } from "./result.js";

const MAX_MCP_PENDING_CANDIDATES = 200;

/** Register the OKF export/import tools. Both confine agent-supplied paths under `root`. `maxPending` is injectable so a test can prove the cap is actually wired into import_okf (default keeps production behavior). */
export function registerOkfTools(server: McpServer, root: string, maxPending: number = MAX_MCP_PENDING_CANDIDATES): void {
  server.registerTool(
    "export_okf",
    {
      title: "Export OKF bundle",
      description: "Export the wiki as an Open Knowledge Format (OKF) v0.1 bundle. `out` defaults to dist/exports/okf and must stay inside the project.",
      inputSchema: { out: z.string().optional().describe("Output dir for the bundle (must resolve inside the project root)") },
    },
    // withQuiet: the export core can print skipped-reference warnings via output.status;
    // on the MCP stdio transport those would land on the JSON-RPC stream and corrupt it.
    async ({ out }) => withQuiet(async () => {
      try {
        const dest = await confineUnderRoot(out ?? "dist/exports/okf", root, { mustExist: false });
        const report = await runOkfExport(root, { out: dest });
        return jsonResult({ outDir: report.outDir, fileCount: report.writtenPaths.length, files: report.writtenPaths.slice(0, 20), warnings: report.warnings });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }),
  );

  server.registerTool(
    "import_okf",
    {
      title: "Import OKF bundle (staged for review)",
      description: "Import an OKF bundle from a path INSIDE the project as review candidates. Always staging-only — imported knowledge requires human review/approval before it enters the wiki. Use dryRun to preview.",
      inputSchema: {
        dir: z.string().describe("Bundle directory (must resolve inside the project root)"),
        dryRun: z.boolean().optional().describe("Preview only — stage nothing"),
      },
    },
    // withQuiet: same stdio-stream guard as export_okf (the import core may emit warnings).
    async ({ dir, dryRun }) => withQuiet(async () => {
      try {
        const bundle = await confineUnderRoot(dir, root, { mustExist: true });
        const report = await runOkfImport(root, bundle, { trusted: false, dryRun, maxNewCandidates: maxPending });
        return jsonResult({
          mode: report.mode,
          imported: report.pages.length,
          pages: report.pages,
          skipped: report.skipped,
          warnings: report.warnings,
          nextAction: report.mode === "dry-run"
            ? "Preview only — re-run without dryRun to stage these as review candidates."
            : "Imported docs are STAGED as review candidates — approve them via `llmwiki review` (human gate) before they enter the wiki.",
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }),
  );
}
