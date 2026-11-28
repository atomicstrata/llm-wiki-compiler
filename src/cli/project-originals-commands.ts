/**
 * @file src/cli/project-originals-commands.ts
 * @description Registers slice S3's commands on the `project` group:
 * `project originals add|stat|read|export` against a host that offers
 * retained originals.
 */

import type { Command } from "commander";
import {
  projectOriginalsAddCommand, projectOriginalsExportCommand, projectOriginalsReadCommand,
  projectOriginalsStatCommand,
} from "@atomicstrata/llmwiki-core/compiler-cli";

/** The option helpers the `project` group shares. */
export interface OriginalsCommandKit {
  withProjectRef(command: Command): Command;
  exitWith(run: Promise<number>): Promise<void>;
}

/** Register `project originals …` on the `project` group. */
export function registerOriginalsCommands(project: Command, kit: OriginalsCommandKit): void {
  const originals = project.command("originals")
    .description("Retained originals and a streamed export (slice S3), on a host that offers them. Others refuse by name.");
  kit.withProjectRef(originals.command("add <file>").description("Stream a file into a stage, seal it, and publish it as a source with its original retained."))
    .option("--name <name>", "Source name (defaults to the file name)")
    .action((file, options) => kit.exitWith(projectOriginalsAddCommand(file, options)));
  kit.withProjectRef(originals.command("stat <name>").description("Show a source's current original: digest, size and derivative, no bytes."))
    .action((name, options) => kit.exitWith(projectOriginalsStatCommand(name, options)));
  kit.withProjectRef(originals.command("read <name>").description("Write a byte range of a source's original to a file."))
    .requiredOption("--out <file>", "Destination; written as <file>.partial and renamed only when the read ends complete")
    .option("--start <n>", "First byte (default 0)")
    .option("--end <n>", "End byte, exclusive (default the size)")
    .action((name, options) => kit.exitWith(projectOriginalsReadCommand(name, options)));
  kit.withProjectRef(originals.command("export").description("Export the project, originals included, as a frame stream to a file."))
    .requiredOption("--out <file>", "Destination; finalized only after the export's completed fence")
    .action((options) => kit.exitWith(projectOriginalsExportCommand(options)));
}
