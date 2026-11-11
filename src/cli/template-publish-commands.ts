/**
 * @file src/cli/template-publish-commands.ts
 * @description Configures the `template publish` group: author, build, and
 * verify template publisher distributions.
 */
import { Help, type Command } from "commander";
import { templatePublishAddCommand, templatePublishBuildCommand, templatePublishInitCommand, templatePublishRevokeCommand, templatePublishRotateCommand, templatePublishVerifyCommand, type TemplatePublishAddOptions, type TemplatePublishBuildOptions, type TemplatePublishInitOptions, type TemplatePublishRevokeOptions, type TemplatePublishRotateOptions, type TemplatePublishVerifyOptions } from "@atomicstrata/llmwiki-core/modules/commands/template-publish";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";

/** Add the `template publish` subcommands. Help lists `verify` without `[options]`. */
export function configureTemplatePublish(publish: Command): void {
  publish
    .configureHelp({
      subcommandTerm: (command) => {
        const term = new Help().subcommandTerm(command);
        return command.name() === "verify" ? term.replace(" [options]", "") : term;
      },
    });

  publish
    .command("init <directory>")
    .description("Create a publisher workspace with fresh tap and publisher keys")
    .requiredOption("--tap <name>", "Tap identity this workspace publishes")
    .requiredOption("--publisher <name>", "Publisher identity that signs packages")
    .option("--tap-key-id <id>", "Override the generated tap key id")
    .option("--publisher-key-id <id>", "Override the generated publisher key id")
    .option("--json", "Print a stable versioned JSON result")
    .action(async (directory: string, options: TemplatePublishInitOptions) =>
      runExitCodeCommand(() => templatePublishInitCommand(directory, options), { colorError: false }),
    );

  publish
    .command("add <package-file>")
    .description("Validate, sign, and record one template package")
    .requiredOption("--workspace <path>", "Publisher workspace directory")
    .requiredOption("--package-version <version>", "Version this package is published as")
    .option("--json", "Print a stable versioned JSON result")
    .action(async (packageFile: string, options: TemplatePublishAddOptions) =>
      runExitCodeCommand(() => templatePublishAddCommand(packageFile, options), { colorError: false }),
    );

  publish
    .command("build")
    .description("Build, verify, and publish a static distribution")
    .requiredOption("--workspace <path>", "Publisher workspace directory")
    .requiredOption("--out <path>", "Output directory, which must live outside the workspace")
    .requiredOption("--expires-in <duration>", "Index lifetime, such as 30d or 12h")
    .option("--refresh", "Republish unchanged content under a fresh lifetime, to renew an expiring index")
    .option("--force", "Republish even when nothing changed since the last build")
    .option("--json", "Print a stable versioned JSON result")
    .action(async (options: TemplatePublishBuildOptions) =>
      runExitCodeCommand(() => templatePublishBuildCommand(options), { colorError: false }),
    );

  publish
    .command("rotate")
    .description("Stage a tap-root or publisher key rotation, signed by the next build")
    .requiredOption("--workspace <path>", "Publisher workspace directory")
    .option("--tap-key-id <id>", "Rotate the tap root key to this new key id")
    .option("--publisher-key-id <id>", "Rotate the publisher key to this new key id")
    .action(async (options: TemplatePublishRotateOptions) =>
      runExitCodeCommand(() => templatePublishRotateCommand(options), { colorError: false }),
    );

  publish
    .command("revoke")
    .description("Stage a package or publisher-key revocation, published by the next build")
    .requiredOption("--workspace <path>", "Publisher workspace directory")
    .requiredOption("--reason <text>", "Why this evidence is revoked")
    .option("--package-digest <digest>", "Revoke one published package digest")
    .option("--publisher-key-id <id>", "Revoke one publisher key id")
    .action(async (options: TemplatePublishRevokeOptions) =>
      runExitCodeCommand(() => templatePublishRevokeCommand(options), { colorError: false }),
    );

  publish
    .command("verify <directory>")
    .description("Verify a signed publisher distribution offline")
    .requiredOption("--tap <name>", "Expected tap identity selected through a trusted channel")
    .requiredOption("--key-id <id>", "Trusted Ed25519 tap key id")
    .requiredOption("--key-file <path>", "Read the trusted base64 SPKI DER tap key")
    .option("--json", "Print a stable versioned JSON result")
    .action(async (directory: string, options: TemplatePublishVerifyOptions) =>
      runExitCodeCommand(() => templatePublishVerifyCommand(directory, options), { colorError: false }),
    );
}
