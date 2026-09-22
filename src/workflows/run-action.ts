/**
 * Standard compatibility entry points for run-action.
 * The engine receives services; this facade constructs the compiler host.
 */
export { runActionWithHost } from "@atomicstrata/llmwiki-local-workflows";
export type { ActionRunResult } from "@atomicstrata/llmwiki-local-workflows";
import { runActionWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { ActionRunResult } from "@atomicstrata/llmwiki-local-workflows";
import type { ActionSurface } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { nonInteractiveHumanGateIo, type HumanGateIo } from "./human-gate-confirm.js";


/**
 * Execute a declared workflow action under the composed authority.
 *
 * Resolves the action by OWN-property lookup ({@link UnknownActionError} on an
 * undeclared/prototype-chain id), validates inputs against its `inputSchema`
 * (fail-closed, BEFORE any authority check), composes the effective permission =
 * `min(profile request, local grant, surface cap)`, enforces the operation's
 * required capability, then dispatches to the existing run-lifecycle op.
 *
 * A `human:` gate action goes through the SAME interactive TTY proof as the direct
 * `gate approve` command (FIX A): `humanGateIo` is the injectable terminal seam. It
 * DEFAULTS to {@link nonInteractiveHumanGateIo}, so an SDK/MCP caller (which never
 * supplies a real TTY) can NEVER satisfy a human gate; only the cli `action run`
 * command passes a real `process` IO. There is thus EXACTLY ONE way to satisfy a
 * human gate — an interactive cli confirmation — whether reached via `gate approve`
 * or `action run`.
 *
 * @param root - Absolute project root.
 * @param actionId - The declared action id to execute.
 * @param inputs - Untrusted caller inputs, validated against the action's schema.
 * @param surface - The surface the action is invoked through.
 * @param humanGateIo - The terminal IO for a human-gate proof (default: non-interactive → deny).
 * @returns The action id, operation, effective permission, and the op's result.
 * @throws {UnknownActionError} When the id is not a declared OWN action key.
 * @throws {ActionInputError} On any input-schema violation.
 * @throws {ActionDeniedError} When the effective permission cannot satisfy the op (incl. an unconfirmed human gate).
 */
export async function runAction(
  root: string,
  actionId: string,
  inputs: Record<string, unknown>,
  surface: ActionSurface,
  humanGateIo: HumanGateIo = nonInteractiveHumanGateIo(),
): Promise<ActionRunResult> {
  return runActionWithHost(createLocalWorkflowHost(), root, actionId, inputs, surface, humanGateIo);
}
