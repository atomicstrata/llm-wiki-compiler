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
 *
 * Each verb's module loads when it runs, so `product status` does not load the
 * install, invoke and apply paths.
 */

import type { Command } from "commander";
import { declareLazyCommands, type LazyCommand } from "./lazy-commands.js";

/**
 * The verbs in the order of the work (see above), with the module that
 * configures each: the package verbs put a package in the project and make it
 * authoritative; the action verbs run the active product's actions.
 */
const PRODUCT_COMMANDS: LazyCommand[] = [
  ["install [options] <sourceDir>", "Install a local product package inertly (activates nothing)",
    () => import("./product-package-commands.js").then((m) => m.configureProductInstall)],
  ["activate [options] <packageDigest>", "Make one installed package this project's knowledge and operations authority",
    () => import("./product-package-commands.js").then((m) => m.configureProductActivate)],
  ["init [options] <sourceDir>", "Cold-init a project: install + activate a package, then scaffold its entity directories",
    () => import("./product-package-commands.js").then((m) => m.configureProductInit)],
  ["preview [options] <token>", "Report what invoking this action would do, writing nothing",
    () => import("./product-action-commands.js").then((m) => m.configureProductPreview)],
  // THE DESCRIPTION NAMES THE LIMIT. An operator reading `--help` is deciding
  // whether this verb changes their wiki, and the honest answer is that it does
  // not: it produces a bundle proposing the change, for a separate approval.
  ["invoke [options] <token>", "Run an action to a reviewable handoff bundle (proposes the change; applies nothing)",
    () => import("./product-action-commands.js").then((m) => m.configureProductInvoke)],
  // The route back from a review gate. `invoke` reports `awaiting-review` and
  // names this command, so it must exist: a surface that tells an operator to
  // run something it does not implement is worse than one that never offered.
  ["resume [options] <runId> <token>", "Continue a run that stopped at a review gate, after deciding it with `preparation gate`",
    () => import("./product-action-commands.js").then((m) => m.configureProductResume)],
  // The readiness review. It sits beside the acting verbs deliberately: an
  // operator asking "can this product actually do its optional work here?"
  // should not have to know that the answer lives in a credential registry.
  ["status [options]", "Review every optional capability the active product declares — reads only, changes nothing",
    () => import("./product-status-command.js").then((m) => m.configureProductStatus)],
  // AND THIS DESCRIPTION NAMES THE OTHER HALF, for the same reason: `apply` is
  // the one verb in the group that changes the wiki, so `--help` says WRITES
  // rather than leaving an operator to infer it from the verb's name.
  ["apply [options] <bundle>", "Approve and apply a bundle `invoke` proposed — WRITES the change to your wiki. The bundle digest is resolved across every workspace, so no --workspace flag exists or is needed",
    () => import("./product-apply-command.js").then((m) => m.configureProductApply)],
];

/** Register the `product` command group. */
export function registerProductCommands(product: Command): void {
  declareLazyCommands(product, PRODUCT_COMMANDS);
}
