/**
 * @file src/cli/template-commands.ts
 * @description Registers the `template` command group with Commander. The
 * group is intentionally thin: parsing stays here, while registry inspection
 * and install behavior stay in `src/commands/template.ts`.
 */
import { Help, type Command } from "commander";
import {
  templateInspectCommand,
  templateInitCommand,
  templateListCommand,
  templateStatusCommand,
  templateUpdateCommand,
  type TemplateInitOptions,
  type TemplateStatusOptions,
  type TemplateUpdateOptions,
} from "../commands/template.js";
import { runExitCodeCommand } from "./shared.js";
import {
  templateTapAddCommand,
  templateTapForgetCommand,
  templateTapListCommand,
  templateTapRefreshCommand,
  templateTapRemoveCommand,
  type TapAddOptions,
  type TapForgetOptions,
  type TapOutputOptions,
} from "../commands/template-tap.js";
import {
  templateRemoteInspectCommand,
  templateSearchCommand,
  templateVerifyCommand,
  type RemoteOutputOptions,
  type TemplateSearchOptions,
} from "../commands/template-remote.js";
import {
  templatePublishAddCommand,
  templatePublishBuildCommand,
  templatePublishInitCommand,
  templatePublishRevokeCommand,
  templatePublishRotateCommand,
  templatePublishVerifyCommand,
  type TemplatePublishAddOptions,
  type TemplatePublishBuildOptions,
  type TemplatePublishInitOptions,
  type TemplatePublishRevokeOptions,
  type TemplatePublishRotateOptions,
  type TemplatePublishVerifyOptions,
} from "../commands/template-publish.js";

/** Register template list, inspect, and init commands. */
export function registerTemplateCommands(program: Command): void {
  const template = program
    .command("template")
    .description("List, inspect, and install profile templates")
    .configureHelp({
      subcommandTerm: (command) => {
        const term = new Help().subcommandTerm(command);
        return command.name() === "verify" ? term.replace(" [options]", "") : term;
      },
    });

  template
    .command("list")
    .description("List builtin profile templates")
    .action(async () => runExitCodeCommand(() => templateListCommand().then(() => 0)));

  template
    .command("inspect <id>")
    .description("Inspect one builtin id or qualified remote coordinate")
    .option("--json", "Print stable JSON for a remote coordinate")
    .action(async (id: string, options: RemoteOutputOptions) => runExitCodeCommand(() =>
      id.includes("/") ? templateRemoteInspectCommand(id, options) : templateInspectCommand(id).then(() => 0),
    ));

  template
    .command("search <query>")
    .description("Search accepted signed remote template indexes")
    .option("--tap <name>", "Search one configured tap")
    .option("--json", "Print stable JSON results")
    .action(async (query: string, options: TemplateSearchOptions) => runExitCodeCommand(() => templateSearchCommand(query, options)));

  template
    .command("verify <coordinate>")
    .description("Verify one qualified remote template package")
    .option("--json", "Print stable JSON provenance")
    .action(async (coordinate: string, options: RemoteOutputOptions) => runExitCodeCommand(() => templateVerifyCommand(coordinate, options)));

  const publish = template
    .command("publish")
    .description("Author, build, and verify template publisher distributions");

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
    .requiredOption("--version <version>", "Version this package is published as")
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

  template
    .command("status")
    .description("Report installed template provenance and profile drift")
    .option("--json", "Print a stable JSON status envelope")
    .action(async (options: TemplateStatusOptions) => runExitCodeCommand(() => templateStatusCommand(options)));

  template
    .command("update [id]")
    .description("Preview a builtin update or safely apply an exact remote update")
    .option("--dry-run", "Inspect compatibility without writing")
    .option("--to <version>", "Target exact remote template version")
    .option("--yes", "Confirm a compatible remote update non-interactively")
    .option("--json", "Print a stable JSON update plan")
    .action(async (id: string | undefined, options: TemplateUpdateOptions) =>
      runExitCodeCommand(() => templateUpdateCommand(id, options)),
    );

  template
    .command("init [id]")
    .description("Install a builtin, local, or qualified remote profile template")
    .option("--file <path>", "Install a local template package JSON file")
    .option("--force", "Overwrite an existing profile only when the typed corpus is empty")
    .option("--yes", "Confirm a verified remote install non-interactively")
    .option("--json", "Print a stable JSON result for remote installs")
    .action(async (id: string | undefined, options: TemplateInitOptions) =>
      runExitCodeCommand(() => templateInitCommand(id, options)),
    );

  registerTapCommands(template);
}

function registerTapCommands(template: Command): void {
  const tap = template.command("tap").description("Manage explicitly trusted template taps");
  tap.command("list").option("--json", "Print stable JSON").action(async (options: TapOutputOptions) =>
    runExitCodeCommand(() => templateTapListCommand(options)));
  tap.command("add <name> <index-url>")
    .requiredOption("--key-id <id>", "Trusted Ed25519 key id")
    .option("--key-file <path>", "Read base64 SPKI DER key from a file")
    .option("--key-base64 <value>", "Use a base64 SPKI DER key")
    .action(async (name: string, url: string, options: TapAddOptions) =>
      runExitCodeCommand(() => templateTapAddCommand(name, url, options)));
  tap.command("remove <name>").description("Disable a tap and retain trust history").action(async (name: string) =>
    runExitCodeCommand(() => templateTapRemoveCommand(name)));
  tap.command("forget <name>").description("Permanently delete a tap and all retained trust history")
    .option("--yes", "Confirm the irreversible trust reset")
    .action(async (name: string, options: TapForgetOptions) =>
      runExitCodeCommand(() => templateTapForgetCommand(name, options)));
  tap.command("refresh <name>").option("--json", "Print stable JSON").action(async (name: string, options: TapOutputOptions) =>
    runExitCodeCommand(() => templateTapRefreshCommand(name, options)));
}
