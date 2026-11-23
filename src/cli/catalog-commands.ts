/**
 * @file src/cli/catalog-commands.ts
 * @description Registers the `catalog` command group: bounded status and
 * keyset pages of a `local-indexed` project's catalog, its explicit
 * reconciliation with the files (`catalog sync`), full verification, and
 * maintenance: segment collection, pinned snapshots, indexed-authority backup
 * and restore, and explicit retirement of finished batch compile runs.
 */

import type { Command } from "commander";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";
import {
  catalogBackupCommand, catalogGcCommand, catalogPagesCommand, catalogRestoreCommand, catalogPinCommand, catalogPinsCommand, catalogRunsCommand, catalogSourcesCommand, catalogStatusCommand,
  catalogSyncCommand, catalogUnpinCommand, catalogVerifyCommand, type CatalogCommandOptions, type CatalogGcCommandOptions, type CatalogRunsCommandOptions,
} from "@atomicstrata/llmwiki-core/compiler-cli";

const JSON_HELP = "Emit one versioned JSON envelope on stdout";
const READERS_OFFLINE_HELP = "Assert that no llmwiki process from a build without reader leases, and no other tool, is reading .llmwiki/indexed (reader leases cannot reveal them)";
const RUNS_HELP = "Preview (read-only) or apply a retirement of finished batch compile runs. Only finished runs other than the compile state's last run, and superseded runs with no restart publication evidence, can go; pinned, active and evidence-carrying runs and the newest --keep finished runs stay. Retiring DELETES those runs' reports (page them first with `llmwiki compile --report <runId>`). Preview with --out, then apply that plan with --retire from a new process";

/** Register `catalog gc|pin|unpin|pins|backup|runs|restore` on the `catalog` group. */
function registerMaintenanceCommands(catalog: Command): void {
  catalog.command("gc").description("Preview a collection of unreferenced segments (read-only), or apply a saved plan")
    .option("--out <file>", "Save the preview's plan to a new file").option("--apply <file>", "Apply a saved plan (run in a fresh process)")
    .option("--readers-offline", READERS_OFFLINE_HELP).option("--json", JSON_HELP)
    .action((options: CatalogGcCommandOptions) => runExitCodeCommand(() => catalogGcCommand(options)));
  catalog.command("pin <label>").description("Pin every store's current manifest so a collection keeps its segments").option("--json", JSON_HELP)
    .action((label: string, options: CatalogCommandOptions) => runExitCodeCommand(() => catalogPinCommand(label, options)));
  catalog.command("unpin <label>").description("Remove a pin").option("--json", JSON_HELP)
    .action((label: string, options: CatalogCommandOptions) => runExitCodeCommand(() => catalogUnpinCommand(label, options)));
  catalog.command("pins").description("List the pins and any that cannot be trusted").option("--json", JSON_HELP)
    .action((options: CatalogCommandOptions) => runExitCodeCommand(() => catalogPinsCommand(options)));
  catalog.command("backup <dir>").description("Back up the indexed authority set only (stores, head anchor, bound legacy files) into a new directory outside the project; not a wiki backup").option("--json", JSON_HELP)
    .action((dir: string, options: CatalogCommandOptions) => runExitCodeCommand(() => catalogBackupCommand(dir, options)));
  catalog.command("runs").description(RUNS_HELP)
    .option("--keep <n>", "Keep the newest n finished runs for their reports (default 10, at most 1000; preview only)")
    .option("--out <file>", "Save the preview's plan to a new file").option("--retire <file>", "Retire exactly what a saved, still-current plan names (run in a fresh process)")
    .option("--readers-offline", READERS_OFFLINE_HELP).option("--json", JSON_HELP)
    .action((options: CatalogRunsCommandOptions) => runExitCodeCommand(() => catalogRunsCommand(options)));
  catalog.command("restore <dir>").description("Replace the current indexed authority set with a backup's, at the same project root only (take a fresh `catalog backup` first if you may need the current one); Markdown, sources, config and custody are not restored, so keep them consistent with the backup yourself")
    .option("--readers-offline", READERS_OFFLINE_HELP).option("--json", JSON_HELP)
    .action((dir: string, options: CatalogGcCommandOptions) => runExitCodeCommand(() => catalogRestoreCommand(dir, options)));
}

/**
 * Add `catalog status|sync|verify|pages|sources|gc|pin|unpin|pins|backup|runs|restore` to the declared `catalog` group.
 *
 * @param catalog - The `catalog` command the lazy table in `src/cli.ts` declared (name and description).
 */
export function registerCatalogCommand(catalog: Command): void {
  catalog.command("status").description("Report catalog counts and freshness (bounded; changes no store)").option("--json", JSON_HELP)
    .action((options: CatalogCommandOptions) => runExitCodeCommand(() => catalogStatusCommand(options)));
  catalog.command("sync").description("Reconcile the catalog with the files under the project lock (explicit full walk)").option("--json", JSON_HELP)
    .action((options: CatalogCommandOptions) => runExitCodeCommand(() => catalogSyncCommand(options)));
  catalog.command("verify").description("Fully verify every indexed store and its backup (changes no store; registers a reader lease)").option("--json", JSON_HELP)
    .action((options: CatalogCommandOptions) => runExitCodeCommand(() => catalogVerifyCommand(options)));
  catalog.command("pages").description("List one keyset page of pages").option("--cursor <cursor>", "Continue after this cursor")
    .option("--limit <n>", "Pages per page (default and maximum 1000 on an indexed project)")
    .option("--include-archived", "Include archived pages").option("--include-orphaned", "Include orphaned pages")
    .option("--profile-cursor <cursor>", "Continue a custom profile's entity pages after this cursor (code-unit key order)")
    .option("--problem-cursor <cursor>", "Continue a custom profile's problems after this cursor")
    .option("--include-body", "Include each entity page's body").option("--json", JSON_HELP)
    .action((options: CatalogCommandOptions) => runExitCodeCommand(() => catalogPagesCommand(options)));
  catalog.command("sources").description("List one keyset page of sources").option("--cursor <cursor>", "Continue after this cursor")
    .option("--limit <n>", "Sources per page (default and maximum 1000 on an indexed project)").option("--json", JSON_HELP)
    .action((options: CatalogCommandOptions) => runExitCodeCommand(() => catalogSourcesCommand(options)));
  registerMaintenanceCommands(catalog);
}
