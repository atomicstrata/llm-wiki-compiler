/**
 * @file src/cli/scale-commands.ts
 * @description Configures `llmwiki init` and the `scale` command group, each
 * already declared (name and description) by the lazy command table in
 * `src/cli.ts`, which loads this module only when one of them runs.
 *
 * `init` creates a local project explicitly, optionally with an expected
 * scale; `scale set|status|prepare` change, report and resume it;
 * `scale preview` shows what a change would do, `scale downgrade` explicitly
 * scales down to a smaller layout, and `scale archive` reads what a
 * scale-down retained. The `catalog` group of a `local-indexed` project has
 * its own lazy entry (`src/cli/catalog-commands.ts`). Every
 * architecture these commands prepare runs on this machine only, with no
 * daemon, container, cloud service or provider call, and an expected scale is
 * a planning target, not verified capacity. Exit codes: 0 ready, 3 blocked,
 * 2 refused with nothing changed, 4 a scale-down stopped part-way.
 */

import type { Command } from "commander";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";
import {
  initCommand, scaleArchiveListCommand, scaleArchiveReportCommand, scaleDowngradeCommand, scalePrepareCommand, scalePreviewCommand,
  scaleSetCommand, scaleStatusCommand,
  type InitCommandOptions, type ScaleArchiveCommandOptions, type ScaleDowngradeCommandOptions, type ScaleOutputOptions, type ScalePrepareCommandOptions,
  type ScalePreviewCommandOptions, type ScaleSetCommandOptions,
} from "@atomicstrata/llmwiki-core/compiler-cli";

const JSON_HELP = "Emit one versioned JSON envelope on stdout";
const SIZE_HELP = "Expected total source size, e.g. 5MB, 150MiB, 2GB (decimal KB/MB/GB/TB, binary KiB/MiB/GiB/TiB)";

const DOWNGRADE_HELP = "Explicitly scale the project down to a smaller local layout, preserving its data: preview with --target and the new estimate (--out saves the plan), then apply that plan with --apply --readers-offline from a new process. Every current indexed authority is exported to the incumbent files and verified, prior files and the indexed stores (batch run reports included) are retained in .llmwiki/scale-downgrade/, and the smaller layout is activated last; anything the smaller layout cannot represent is a blocker. Lowering an estimate with `scale set` never does this";
const READERS_OFFLINE_HELP = "Assert that no llmwiki build without reader leases and no other tool reads this project while the scale-down runs (required to apply)";

const CAPABILITY_HELP = "Hold and prepare a version 3 capability of a local-indexed layout (repeatable): segmented-compile-state-1 (the batch compile's segmented compile state). A scale record holding a version 3 capability is refused by llmwiki builds that do not support it";

/** Collect each `--capability` into a list. */
function collectCapability(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** Register `scale preview`, `scale downgrade` and `scale archive list|report` on the `scale` group. */
function registerScaleChangeCommands(scale: Command): void {
  scale.command("preview").description("Show what `scale set` with this estimate would do, read-only: the plan, whether the active layout changes, steps, free space and the measured project size")
    .option("--size <size>", SIZE_HELP).option("--documents <n>", "Expected document count").option("--capability <name>", CAPABILITY_HELP, collectCapability).option("--json", JSON_HELP)
    .action((options: ScalePreviewCommandOptions) => runExitCodeCommand(() => scalePreviewCommand(options)));
  scale.command("downgrade").description(DOWNGRADE_HELP)
    .option("--target <layout>", "local-standard or local-large").option("--size <size>", SIZE_HELP).option("--documents <n>", "The new expected document count")
    .option("--out <file>", "Save the preview's plan to a new file").option("--apply <file>", "Apply (or resume) exactly a saved plan").option("--cancel <file>", "Cancel exactly a saved plan before it moved anything (keeps the smaller estimate)").option("--readers-offline", READERS_OFFLINE_HELP).option("--json", JSON_HELP)
    .action((options: ScaleDowngradeCommandOptions) => runExitCodeCommand(() => scaleDowngradeCommand(options)));
  const archive = scale.command("archive").description("Read the archives scale-downs retained (read-only)");
  archive.command("list").description("List the retained scale-down archives and their batch runs").option("--json", JSON_HELP)
    .action((options: ScaleOutputOptions) => runExitCodeCommand(() => scaleArchiveListCommand(options)));
  archive.command("report <name> <runId>").description("Page an archived batch run's report").option("--cursor <cursor>", "Continue after this cursor").option("--json", JSON_HELP)
    .action((name: string, runId: string, options: ScaleArchiveCommandOptions) => runExitCodeCommand(() => scaleArchiveReportCommand(name, runId, options)));
}

/**
 * Add the options and action of the declared `init` command.
 *
 * @param command - The `init` command the lazy table declared.
 */
export function registerInitCommand(command: Command): void {
  command
    .option("--expected-size <size>", SIZE_HELP)
    .option("--expected-documents <n>", "Expected document count; either estimate alone is enough, the other is derived")
    .option("--json", JSON_HELP)
    .action((options: InitCommandOptions) => runExitCodeCommand(() => initCommand(options)));
}

/**
 * Add `scale set|status|prepare|preview|downgrade|archive` to the declared `scale` group.
 *
 * @param scale - The `scale` command the lazy table declared.
 */
export function registerScaleCommand(scale: Command): void {
  scale
    .command("set")
    .description("Record a new expected scale and prepare the local architecture it plans for; a lower estimate never downgrades an architecture already prepared")
    .option("--size <size>", SIZE_HELP)
    .option("--documents <n>", "Expected document count; give --size, --documents or both (a missing one is derived)")
    .option("--no-prepare", "Record the request but leave preparation pending (dependent work stays blocked)")
    .option("--expect-revision <n>", "Refuse unless the current record revision is exactly n (0 for none)")
    .option("--capability <name>", CAPABILITY_HELP, collectCapability)
    .option("--json", JSON_HELP)
    .action((options: ScaleSetCommandOptions) => runExitCodeCommand(() => scaleSetCommand(options)));
  scale
    .command("status")
    .description("Report the expected scale, active architecture, readiness and any blocked reason (read-only)")
    .option("--json", JSON_HELP)
    .action((options: ScaleOutputOptions) => runExitCodeCommand(() => scaleStatusCommand(options)));
  scale
    .command("prepare")
    .description("Resume or re-verify a pending local transition, or prepare requested capabilities on an active indexed project; an unavailable estimate is reported, not prepared")
    .option("--capability <name>", CAPABILITY_HELP, collectCapability)
    .option("--json", JSON_HELP)
    .action((options: ScalePrepareCommandOptions) => runExitCodeCommand(() => scalePrepareCommand(options)));
  registerScaleChangeCommands(scale);
}
