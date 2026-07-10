/**
 * @file src/cli/artifact-commands.ts
 * @description Registers the `artifact` command group: write and verify
 * typed artifacts (`artifact write`, `artifact verify`). Moved out of
 * `src/cli.ts` verbatim (pure move, no behavior change) as part of the
 * per-domain command split.
 */

import type { Command } from "commander";
import { artifactWriteCommand, artifactVerifyCommand } from "../commands/artifact.js";
import type { ArtifactWriteOptions, ArtifactVerifyOptions } from "../commands/artifact.js";

/** Register the `artifact` command group (`write`, `verify`) on `program`. */
export function registerArtifactCommands(program: Command): void {
  const artifactCmd = program.command("artifact").description("Write and verify typed artifacts");

  artifactCmd
    .command("write")
    .description("Write a typed artifact's bytes (requires a profile-declared type and the LLMWIKI_TRUSTED_WRITE grant)")
    .requiredOption("--type <t>", "Profile-declared artifact type")
    .requiredOption("--slug <s>", "Artifact slug")
    .option("--body <inline>", "Inline body (exactly one of --body / --body-file)")
    .option("--body-file <path>", "Body file, read as strict UTF-8 (exactly one of --body / --body-file)")
    .action(async (options: ArtifactWriteOptions) => {
      try {
        await artifactWriteCommand(options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  artifactCmd
    .command("verify")
    .description("Resolve a hash-pinned artifact ref to its health verdict (metadata only, never the body)")
    .requiredOption("--type <t>", "Profile-declared artifact type")
    .requiredOption("--slug <s>", "Artifact slug")
    .requiredOption("--sha256 <hex>", "64-character lowercase-hex sha256 to verify against")
    .action(async (options: ArtifactVerifyOptions) => {
      try {
        await artifactVerifyCommand(options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
