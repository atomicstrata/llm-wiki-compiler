/**
 * CLI entry point for llmwiki — the knowledge compiler.
 *
 * Lists every command with the module that implements it. Commander loads
 * that module just before it runs the command, so help loads none of them.
 * Designed for `npx llmwiki` or global install via `npm install -g llm-wiki-compiler`.
 */

import { createRequire } from "module";
import { Command } from "commander";
import { loadCliEnvironment } from "./cli/environment.js";

loadCliEnvironment();

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

type Configure = (command: Command) => void;

/**
 * Every top-level command in help order: its usage as help prints it, its
 * description, and the module that adds its options, action and subcommands.
 */
const COMMANDS: [usage: string, description: string, load: () => Promise<Configure>][] = [
  ["ingest [options] <source>", "Ingest a URL or local file into sources/",
    () => import("./cli/ingest-command.js").then((m) => m.registerIngestCommand)],
  ["ingest-session [options] <path>", "Ingest a coding-agent session export (Claude, Codex, Cursor) into sources/",
    () => import("./cli/ingest-session-command.js").then((m) => m.registerIngestSessionCommand)],
  ["view [options]", "Start a local read-only web viewer for the current wiki project",
    () => import("./cli/view-command.js").then((m) => m.registerViewCommand)],
  ["compile [options]", "Compile sources/ into an interlinked wiki",
    () => import("./cli/compile-command.js").then((m) => m.registerCompileCommand)],
  ["rm [options] <source>", "Delete a source and the concept pages derived exclusively from it",
    () => import("./cli/rm-command.js").then((m) => m.registerRmCommand)],
  ["refresh [options]", "Recompile only stale/changed pages without touching unrelated new sources",
    () => import("./cli/refresh-command.js").then((m) => m.registerRefreshCommand)],
  ["review", "Inspect and act on pending compile review candidates",
    () => import("./cli/review-commands.js").then((m) => m.registerReviewCommands)],
  ["state", "Back up and reset .llmwiki/state.json (recovery for a state written by a newer llmwiki version).",
    () => import("./cli/state-commands.js").then((m) => m.registerStateCommands)],
  ["recover", "Recover an incomplete compile (revert a crashed compile's journal) without a full recompile.",
    () => import("./cli/recover-command.js").then((m) => m.registerRecoverCommand)],
  ["rules", "Extract, review, and export machine-actionable RuleCandidate records for a downstream rule importer",
    () => import("./cli/rules-commands.js").then((m) => m.registerRulesCommands)],
  ["query [options] <question>", "Ask a question against the wiki",
    () => import("./cli/query-command.js").then((m) => m.registerQueryCommand)],
  ["watch [options]", "Watch sources/ and auto-recompile on changes",
    () => import("./cli/watch-command.js").then((m) => m.registerWatchCommand)],
  ["visualize [options]", "Create Obsidian graph configuration and Canvas knowledge maps without overwriting edits",
    () => import("./cli/visualize-command.js").then((m) => m.registerVisualizeCommand)],
  ["lint [options]", "Run rule-based quality checks against the wiki",
    () => import("./cli/lint-command.js").then((m) => m.registerLintCommand)],
  ["status [options]", "Report project status: page/source counts, stale and orphaned pages, pending changes, review queue, and state health",
    () => import("./cli/status-command.js").then((m) => m.registerStatusCommand)],
  ["eval [options]", "Evaluate wiki quality (health, citation coverage, LLM judge)",
    () => import("./cli/eval-commands.js").then((m) => m.registerEvalCommands)],
  ["schema", "Inspect or initialize the project's wiki schema config",
    () => import("./cli/schema-commands.js").then((m) => m.registerSchemaCommands)],
  ["profile", "Create or inspect the active wiki profile",
    () => import("./cli/profile-commands.js").then((m) => m.registerProfileCommands)],
  ["template", "List, inspect, and install profile templates",
    () => import("./cli/template-commands.js").then((m) => m.registerTemplateCommands)],
  ["workflow", "Run and inspect declarative profile workflows (experimental)",
    () => import("./cli/workflow-commands.js").then((m) => m.registerWorkflowCommands)],
  ["artifact", "Write and verify typed artifacts",
    () => import("./cli/artifact-commands.js").then((m) => m.registerArtifactCommands)],
  ["connector", "List and run first-party external-data connectors into review candidates",
    () => import("./cli/connector-commands.js").then((m) => m.registerConnectorCommands)],
  ["operation", "Inspect and drive operation-bundle execution/recovery (list, inspect, resume, compensate, cancel)",
    () => import("./cli/operation-commands.js").then((m) => m.registerOperationCommands)],
  ["product", "Install, activate, and run product packages",
    () => import("./cli/product-commands.js").then((m) => m.registerProductCommands)],
  ["preparation", "Inspect and drive preparation runs",
    () => import("./cli/preparation-commands.js").then((m) => m.registerPreparationCommands)],
  ["export [options]", "Export wiki content to portable formats (llms.txt, JSON, GraphML, Marp, …)",
    () => import("./cli/export-command.js").then((m) => m.registerExportCommand)],
  ["import [options]", "Import an OKF bundle as review candidates (default) or live pages (--trusted)",
    () => import("./cli/import-command.js").then((m) => m.registerImportCommand)],
  ["next [options]", "Show the recommended next action for this llmwiki project (read-only)",
    () => import("./cli/context-commands.js").then((m) => m.registerNextCommand)],
  ["context [options] <prompt>", "Build an agent-ready evidence pack for <prompt> from the compiled wiki (read-only; provider credentials optional — semantic retrieval is used when available and falls back to lexical otherwise)",
    () => import("./cli/context-commands.js").then((m) => m.registerContextCommand)],
  ["quickstart [options] <source>", "Ingest a source and compile it into a wiki in one step. Recommends the next action when finished.",
    () => import("./cli/quickstart-command.js").then((m) => m.registerQuickstartCommand)],
  ["serve [options]", "Start an MCP server exposing wiki tools and resources over stdio",
    () => import("./cli/serve-command.js").then((m) => (command) => m.registerServeCommand(command, version))],
];

const program = new Command();

program
  .name("llmwiki")
  .description("The knowledge compiler — raw sources in, interlinked wiki out")
  .version(version);

// Declare each command with its name and arguments only, so help needs no
// command module. Commander lists `[options]` only for a command that has
// options, and these have none until their module loads, so the usage text
// from the table is what the command list prints.
const OPTIONS_MARKER = " [options]";
const listed = new Map<Command, { usage: string; load: () => Promise<Configure> }>();
for (const [usage, description, load] of COMMANDS) {
  listed.set(program.command(usage.replace(OPTIONS_MARKER, "")).description(description), { usage, load });
}

const help = program.createHelp();
program.configureHelp({ subcommandTerm: (command) => listed.get(command)?.usage ?? help.subcommandTerm(command) });

/** Add a listed command's options, action and subcommands from its module. */
async function configure(command: Command): Promise<void> {
  const entry = listed.get(command);
  if (entry) (await entry.load())(command);
}

program.hook("preSubcommand", (_program, command) => configure(command));

// Commander's own `help <command>` prints the declared command without running
// the hook, so this one configures the command before printing its help.
program.helpCommand(false);
program
  .command("help [command]")
  .description("display help for command")
  .helpOption(false)
  .allowExcessArguments()
  .action(async (name?: string) => {
    const command = name === undefined ? program : program.commands.find((candidate) => candidate.name() === name);
    if (command === undefined) return program.help({ error: true });
    await configure(command);
    command.help();
  });

await program.parseAsync();
