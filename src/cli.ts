/**
 * CLI entry point for llmwiki — the knowledge compiler.
 *
 * Registers all commands (ingest, compile, query, watch, lint) via Commander.
 * Validates the correct API key for the selected LLM provider.
 * Designed for `npx llmwiki` or global install via `npm install -g llm-wiki-compiler`.
 */

import "dotenv/config";
import { createRequire } from "module";
import { Command } from "commander";
import ingestCommand from "./commands/ingest.js";
import ingestSessionCommand from "./commands/ingest-session.js";
import viewCommand from "./commands/view.js";
import compileCommand from "./commands/compile.js";
import queryCommand from "./commands/query.js";
import watchCommand from "./commands/watch.js";
import lintCommand from "./commands/lint.js";
import evalCommand, {
  evalCacheClearCommand,
  evalCacheShowCommand,
  evalReportCommand,
  evalHistoryCommand,
  evalJudgementsCommand,
} from "./commands/eval.js";
import exportCommand from "./commands/export.js";
import importCommand from "./commands/import.js";
import { schemaInitCommand, schemaShowCommand } from "./commands/schema.js";
import { profileShow, profileValidate, profileDiff } from "./commands/profile.js";
import reviewListCommand from "./commands/review-list.js";
import reviewShowCommand from "./commands/review-show.js";
import reviewApproveCommand from "./commands/review-approve.js";
import reviewRejectCommand from "./commands/review-reject.js";
import { stateResetCommand } from "./commands/state-reset.js";
import { registerRulesCommand } from "./commands/rules-register.js";
import nextCommand from "./commands/next.js";
import refreshCommand from "./commands/refresh.js";
import quickstartCommand, { type QuickstartOptions } from "./commands/quickstart.js";
import contextCommand, { type ContextCommandOptions } from "./commands/context.js";
import { startMCPServer } from "./mcp/server.js";
import { applyLanguageOption } from "./utils/output-language.js";
import { ensureProviderAvailable } from "./utils/provider-guard.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
  .name("llmwiki")
  .description("The knowledge compiler — raw sources in, interlinked wiki out")
  .version(version);

program
  .command("ingest <source>")
  .description("Ingest a URL or local file into sources/")
  .action(async (source: string) => {
    try {
      await ingestCommand(source);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("ingest-session <path>")
  .description("Ingest a coding-agent session export (Claude, Codex, Cursor) into sources/")
  .action(async (targetPath: string) => {
    try {
      await ingestSessionCommand(targetPath);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("view")
  .description("Start a local read-only web viewer for the current wiki project")
  .option("--port <port>", "Port to bind (default 0 — OS-assigned)")
  .option("--host <host>", "Host to bind (requires --allow-lan; default 127.0.0.1)")
  .option("--allow-lan", "Bind beyond loopback (requires --host); off by default for privacy")
  .option("--open", "Open the viewer in the default browser after startup")
  .action(async (options: { port?: string; host?: string; allowLan?: boolean; open?: boolean }) => {
    try {
      await viewCommand(options);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("compile")
  .description("Compile sources/ into an interlinked wiki")
  .option(
    "--review",
    "Write generated pages as review candidates under .llmwiki/candidates/ instead of mutating wiki/. Orphan-marking for deleted sources is deferred until the next non-review compile.",
  )
  .option(
    "--lang <code>",
    "Target language for generated wiki content (e.g. \"Chinese\", \"ja\", \"zh-CN\"). Equivalent to setting LLMWIKI_OUTPUT_LANG.",
  )
  .action(async (options: { review?: boolean; lang?: string }) => {
    try {
      applyLanguageOption(options.lang);
      requireProvider();
      await compileCommand({ review: options.review });
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("refresh")
  .description("Recompile only stale/changed pages without touching unrelated new sources")
  .option("--stale", "Resolve stale/orphaned pages and recompile them")
  .option("--dry-run", "Print the refresh plan without calling the LLM or writing files")
  .action(async (options: { stale?: boolean; dryRun?: boolean }) => {
    try {
      const code = await refreshCommand(options, requireProvider);
      process.exit(code);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

const reviewCommand = program
  .command("review")
  .description("Inspect and act on pending compile review candidates");

reviewCommand
  .command("list")
  .description("List pending review candidates")
  .action(async () => {
    try {
      await reviewListCommand();
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

reviewCommand
  .command("show <id>")
  .description("Print a single candidate's metadata and body")
  .action(async (id: string) => {
    try {
      await reviewShowCommand(id);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

reviewCommand
  .command("approve <id>")
  .description("Approve a candidate and promote it into wiki/concepts/")
  .action(async (id: string) => {
    try {
      await reviewApproveCommand(id);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

reviewCommand
  .command("reject <id>")
  .description("Reject a candidate and archive it without touching wiki/")
  .action(async (id: string) => {
    try {
      await reviewRejectCommand(id);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

const stateCommand = program
  .command("state")
  .description(
    "Back up and reset .llmwiki/state.json (recovery for a state written by a newer llmwiki version).",
  );

stateCommand
  .command("reset")
  .description("Back up and reset the project state file. Requires --yes to apply.")
  .option("--yes", "Apply the reset (back up and remove the state file)")
  .action(async (options: { yes?: boolean }) => {
    try {
      await stateResetCommand({ yes: options.yes });
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

registerRulesCommand(program, requireProvider);

program
  .command("query <question>")
  .description("Ask a question against the wiki")
  .option("--save", "Save the answer as a wiki page")
  .option("--debug", "Print which pages and chunks were selected and their scores")
  .option(
    "--lang <code>",
    "Target language for the answer (e.g. \"Chinese\", \"ja\", \"zh-CN\"). Equivalent to setting LLMWIKI_OUTPUT_LANG.",
  )
  .action(
    async (
      question: string,
      options: { save?: boolean; debug?: boolean; lang?: string },
    ) => {
      try {
        applyLanguageOption(options.lang);
        requireProvider();
        await queryCommand(process.cwd(), question, options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    },
  );

program
  .command("watch")
  .description("Watch sources/ and auto-recompile on changes")
  .action(async () => {
    try {
      requireProvider();
      await watchCommand();
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("lint")
  .description("Run rule-based quality checks against the wiki")
  .action(async () => {
    try {
      await lintCommand();
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

const evalCmd = program
  .command("eval")
  .description("Evaluate wiki quality (health, citation coverage, LLM judge)")
  .option("--suite <level>", "fast (deterministic) or full (+ LLM judge)", "fast")
  .option("--out <format>", "terminal or json", "terminal")
  .option("--sample <n>", "number of citations to judge in full suite", "20")
  .action(async (opts) => {
    try {
      await evalCommand(opts);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

const evalCacheCmd = evalCmd
  .command("cache")
  .description("Manage the citation judgement cache");

evalCacheCmd
  .command("clear")
  .description("Delete the cache so all judgements re-run on the next full eval")
  .action(async () => {
    try { await evalCacheClearCommand(); }
    catch (err) { console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`); process.exit(1); }
  });

evalCacheCmd
  .command("show")
  .description("Print a score distribution summary of cached citation judgements")
  .action(async () => {
    try { await evalCacheShowCommand(); }
    catch (err) { console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`); process.exit(1); }
  });

evalCmd
  .command("report")
  .description("Re-display the most recent eval report without running a new eval")
  .option("--out <format>", "terminal or json", "terminal")
  .action(async (opts) => {
    try { await evalReportCommand(opts); }
    catch (err) { console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`); process.exit(1); }
  });

evalCmd
  .command("history")
  .description("Show a trend table of past eval runs")
  .option("--n <count>", "number of runs to show", "10")
  .option("--out <format>", "terminal or json", "terminal")
  .action(async (opts) => {
    try { await evalHistoryCommand(opts); }
    catch (err) { console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`); process.exit(1); }
  });

evalCmd
  .command("judgements")
  .description("Browse cached citation judgements")
  .option("--score <0|1|2>", "filter by support score (0=unsupported, 1=partial, 2=full)")
  .option("--page <slug>", "filter by wiki page slug")
  .option("--n <count>", "limit number of judgements shown")
  .option("--out <format>", "terminal or json", "terminal")
  .action(async (opts) => {
    try { await evalJudgementsCommand(opts); }
    catch (err) { console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`); process.exit(1); }
  });

const schemaCmd = program
  .command("schema")
  .description("Inspect or initialize the project's wiki schema config");

schemaCmd
  .command("init")
  .description("Write a starter schema file to .llmwiki/schema.json")
  .action(async () => {
    try {
      await schemaInitCommand();
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

schemaCmd
  .command("show")
  .description("Print the resolved schema for this project")
  .action(async () => {
    try {
      await schemaShowCommand();
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

const profileCmd = program
  .command("profile")
  .description("Inspect the active wiki profile (read-only: show, validate, diff)");

profileCmd
  .command("show")
  .description("Print the active profile's id, digest, and source file")
  .action(async () => {
    try {
      await profileShow();
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

profileCmd
  .command("validate")
  .description("Validate the active profile; exit non-zero with a message if invalid")
  .action(async () => runExitCodeCommand(() => profileValidate()));

profileCmd
  .command("diff")
  .description(
    "Classify on-disk pages over the disposition lattice for an explicit old → new profile pair (read-only; writes nothing)",
  )
  .option("--candidate <file>", "Diff the active profile (old) against an uninstalled candidate file (new)")
  .option("--from <file>", "Old profile for a pure offline diff (requires --to)")
  .option("--to <file>", "New profile for a pure offline diff (requires --from)")
  .action(async (options: { candidate?: string; from?: string; to?: string }) =>
    runExitCodeCommand(() => profileDiff(options)),
  );

program
  .command("export")
  .description("Export wiki content to portable formats (llms.txt, JSON, GraphML, Marp, …)")
  .option("--target <name>", "Limit export to a single target format")
  .option(
    "--source <kind>",
    "For marp target: which pages to include — concepts, queries, or all (default: all)",
  )
  .option(
    "--project-id <id>",
    "Bridge identifier embedded in the JSON export envelope. Must match /^[a-z0-9][a-z0-9-]{0,62}$/.",
  )
  .option("--out <dir>", "Output directory for directory-style targets (e.g. okf)")
  .action(async (options: { target?: string; source?: string; projectId?: string; out?: string }) => {
    try {
      await exportCommand(process.cwd(), options);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("import")
  .description("Import an OKF bundle as review candidates (default) or live pages (--trusted)")
  .requiredOption("--okf <dir>", "Path to the OKF bundle directory to import")
  .option(
    "--trusted",
    "Write mapped pages directly into wiki/ instead of staging for review (you vouch for the bundle's contents and its self-declared provenance)",
  )
  .option("--dry-run", "Report what would be imported (and skipped) without writing anything")
  .action(async (options: { okf: string; trusted?: boolean; dryRun?: boolean }) => {
    try {
      await importCommand(process.cwd(), options);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("next")
  .description("Show the recommended next action for this llmwiki project (read-only)")
  .option("--json", "Emit a stable JSON envelope for agent consumption")
  .action(async (options: { json?: boolean }) =>
    runExitCodeCommand(() => nextCommand({ json: options.json })),
  );

program
  .command("context <prompt>")
  .description(
    "Build an agent-ready evidence pack for <prompt> from the compiled wiki " +
      "(read-only; provider credentials optional — semantic retrieval is used " +
      "when available and falls back to lexical otherwise)",
  )
  .option("--budget <tokens>", "Approximate output token budget (default 8000)")
  .option("--format <format>", "Output format: json | markdown (default markdown)")
  .option("--json", "Emit the stable v1 JSON envelope (overrides --format)")
  .option("--depth <n>", "Graph neighborhood depth, default 1, max 2; 0 disables expansion")
  .option("--top-pages <n>", "Max primary pages (default 5, max 20)")
  .option("--top-chunks <n>", "Max semantic chunks (default 8, max 50)")
  .option("--omit-root", "Emit project.root as null for privacy")
  .option("--no-neighbors", "Suppress graph expansion (keeps neighbors/gaps as empty arrays)")
  .option(
    "--include-sources",
    "Populate primary[].sourceWindows from claim-level citation spans (max 20 windows, 30 lines each)",
  )
  .action(async (prompt: string, options: ContextCommandOptions) =>
    runExitCodeCommand(() => contextCommand(prompt, options)),
  );

program
  .command("quickstart <source>")
  .description(
    "Ingest a source and compile it into a wiki in one step. Recommends the next action when finished.",
  )
  .option("--review", "Generate review candidates instead of mutating wiki/")
  .option("--no-open", "Skip the viewer handoff after a successful compile")
  .option(
    "--provider <name>",
    "Override LLMWIKI_PROVIDER for this run only (e.g. anthropic, openai, ollama)",
  )
  .option(
    "--lang <code>",
    "Target language for generated wiki content (e.g. \"Chinese\", \"ja\", \"zh-CN\"). Equivalent to setting LLMWIKI_OUTPUT_LANG.",
  )
  .option("--json", "Emit the quickstart JSON envelope instead of human output (implies --no-open)")
  .action(async (source: string, options: QuickstartOptions) =>
    runExitCodeCommand(() => quickstartCommand(source, options)),
  );

program
  .command("serve")
  .description("Start an MCP server exposing wiki tools and resources over stdio")
  .option("--root <dir>", "Project root directory", process.cwd())
  .action(async (options: { root: string }) => {
    try {
      // Per-tool credential checks happen inside the MCP layer so read-only
      // tools and ingest still work without an API key.
      await startMCPServer({ root: options.root, version });
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

/**
 * Run the shared provider guard but match the legacy CLI error path:
 * print the error in red and exit 1 instead of letting the throw
 * surface as a stack trace. Programmatic callers (quickstart, MCP) use
 * `ensureProviderAvailable` directly so they can convert the throw into
 * a structured envelope.
 */
function requireProvider(): void {
  try {
    ensureProviderAvailable();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31mError:\x1b[0m ${message}`);
    process.exit(1);
  }
}

/**
 * Wrap a command implementation that returns an exit code with the
 * shared CLI exit semantics: assign process.exitCode for non-zero
 * returns (so stdout can drain before the event loop exits) and
 * print a red-formatted error then process.exit(1) on throws.
 *
 * Centralised so command actions stay one-liners and fallow does not
 * flag the try/catch+exitCode skeleton as duplicated across siblings.
 */
async function runExitCodeCommand(work: () => Promise<number>): Promise<void> {
  try {
    const code = await work();
    if (code !== 0) process.exitCode = code;
  } catch (err) {
    console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

program.parse();
