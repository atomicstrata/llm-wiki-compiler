/**
 * @file src/cli/product-commands.ts
 * @description Registers the `product` command group — the operator entry point
 * for installed product packages.
 *
 * THIS REGISTRATION IS WHAT MAKES THE VERTICAL EXIST. Four slices built the
 * whole path — an immutable package store, an activated binding, a deterministic
 * compiler, a driven runtime and the product service that joins them — and every
 * one of them was reachable only from a test fixture. `createWiki().product`
 * shipped refusing "no product is active in this project" in EVERY project,
 * because no public surface could install a package or activate one. Nothing was
 * broken; there was simply no door. These four verbs are the door.
 *
 * THE ORDER OF THE GROUP IS THE ORDER OF THE WORK: install bytes, activate the
 * authority, ask what an action would do, run it, then apply what it proposed.
 * `install` and `activate` are separate because the substrate separates them —
 * installing writes inert bytes and never writes `active-product.json` — and
 * `preview` sits before `invoke` because it is the grant-free way to see the
 * plan digest an invocation would be sealed against.
 *
 * `invoke` DOES NOT APPLY WHAT IT PROPOSES, and `apply` is why it does not have
 * to. Invoke drives the action to a Milestone A handoff bundle carrying a real
 * reviewable mutation and stops; `apply` approves that bundle and runs it. The
 * separation is the product's whole review story, so it is a separation of
 * VERBS and of AUTHORITY: invoke charges the preparation grant that staging a
 * run costs, and apply charges the operation grant `operation-bundle.approve`
 * that approving any bundle costs. Each description below says which side of
 * that line its verb is on, because `--help` is where an operator decides
 * whether running a verb will change their wiki.
 */

import type { Command } from "commander";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { productInvokeCommand, productResumeCommand, productPreviewCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { productApplyCommand, type ProductApplyOptions } from "@atomicstrata/llmwiki-core/compiler-cli";
import { productStatusCommand, type ProductStatusOptions } from "@atomicstrata/llmwiki-core/compiler-cli";
import type { ProductActionOptions } from "@atomicstrata/llmwiki-core/compiler-cli";
import { productActivateCommand, productInstallCommand, type ProductPackageOptions } from "@atomicstrata/llmwiki-core/compiler-cli";
import { productInitCommand } from "@atomicstrata/llmwiki-core/compiler-cli";

/** Every verb here answers `--json` with the same envelope contract. */
const JSON_DESCRIPTION = "Emit the machine-readable envelope instead of the human lines";

/**
 * The flags both action verbs take, declared ONCE.
 *
 * Registering them twice is how `--input` comes to mean one thing on `preview`
 * and another on `invoke` — and the entire value of preview is that it cannot
 * diverge from the invocation it previews, which has to include how its input is
 * spelled.
 */
function withActionOptions(command: Command): Command {
  return command
    .option("--input <pair...>", "Action input as key=value (repeatable; every value is a STRING)")
    .option("--input-json <json>",
      "Action input as a JSON object of typed values (numbers, booleans, lists); wins over --input on a key collision")
    .option("--workspace <id>", "Workspace the run is recorded under (default \"default\")")
    .option("--json", JSON_DESCRIPTION);
}

/** Register the `product` command group on the root program. */
export function registerProductCommands(program: Command): void {
  const product = program
    .command("product")
    .description("Install, activate, and run product packages");
  registerPackageVerbs(product);
  registerActionVerbs(product);
}

/** The verbs that put a package in the project and make it authoritative. */
function registerPackageVerbs(product: Command): void {
  product
    .command("install <sourceDir>")
    .description("Install a local product package inertly (activates nothing)")
    .option("--json", JSON_DESCRIPTION)
    .action(async (sourceDir: string, options: ProductPackageOptions) =>
      runExitCodeCommand(() => productInstallCommand(process.cwd(), sourceDir, options)));

  product
    .command("activate <packageDigest>")
    .description("Make one installed package this project's knowledge and operations authority")
    .option("--json", JSON_DESCRIPTION)
    .action(async (packageDigest: string, options: ProductPackageOptions) =>
      runExitCodeCommand(() => productActivateCommand(process.cwd(), packageDigest, options)));

  product
    .command("init <sourceDir>")
    .description("Cold-init a project: install + activate a package, then scaffold its entity directories")
    .option("--json", JSON_DESCRIPTION)
    .action(async (sourceDir: string, options: ProductPackageOptions) =>
      runExitCodeCommand(() => productInitCommand(process.cwd(), sourceDir, options)));
}

/** The verbs that run the active product's actions. */
function registerActionVerbs(product: Command): void {
  withActionOptions(product
    .command("preview <token>")
    .description("Report what invoking this action would do, writing nothing"))
    .action(async (token: string, options: ProductActionOptions) =>
      runExitCodeCommand(() => productPreviewCommand(process.cwd(), token, options)));

  // THE DESCRIPTION NAMES THE LIMIT. An operator reading `--help` is deciding
  // whether this verb changes their wiki, and the honest answer is that it does
  // not: it produces a bundle proposing the change, for a separate approval.
  withActionOptions(product
    .command("invoke <token>")
    .description("Run an action to a reviewable handoff bundle (proposes the change; applies nothing)"))
    .action(async (token: string, options: ProductActionOptions) =>
      runExitCodeCommand(() => productInvokeCommand(process.cwd(), token, options)));

  // The route back from a review gate. `invoke` reports `awaiting-review` and
  // names this command, so it must exist: a surface that tells an operator to
  // run something it does not implement is worse than one that never offered.
  withActionOptions(product
    .command("resume <runId> <token>")
    .description("Continue a run that stopped at a review gate, after deciding it with `preparation gate`"))
    .action(async (runId: string, token: string, options: ProductActionOptions) =>
      runExitCodeCommand(() => productResumeCommand(process.cwd(), runId, token, options)));

  // The readiness review. It sits beside the acting verbs deliberately: an
  // operator asking "can this product actually do its optional work here?"
  // should not have to know that the answer lives in a credential registry.
  product
    .command("status")
    .description("Review every optional capability the active product declares — reads only, changes nothing")
    .option("--json", JSON_DESCRIPTION)
    // A recorded skip stays LISTED in the review: the decision is the thing
    // being stored, so a reader can tell it apart from an oversight.
    .option("--skip <dimension>", "Record that you are declining this optional capability")
    .option("--unskip <dimension>", "Clear a previously recorded skip")
    .action(async (options: ProductStatusOptions) =>
      runExitCodeCommand(() => productStatusCommand(process.cwd(), options)));

  // AND THIS DESCRIPTION NAMES THE OTHER HALF, for the same reason: `apply` is
  // the one verb in the group that changes the wiki, so `--help` says WRITES
  // rather than leaving an operator to infer it from the verb's name.
  product
    .command("apply <bundle>")
    .description("Approve and apply a bundle `invoke` proposed — WRITES the change to your wiki. The bundle digest is resolved across every workspace, so no --workspace flag exists or is needed")
    .option("--json", JSON_DESCRIPTION)
    .action(async (bundle: string, options: ProductApplyOptions) =>
      runExitCodeCommand(() => productApplyCommand(process.cwd(), bundle, options)));
}
