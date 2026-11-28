/**
 * @file src/scale/downgrade-plan.ts
 * @description The PLAN of a scale-down: the inventory it binds
 * (`./downgrade-inventory.ts`), the canonical project root it is for, and the
 * SHA-256 digest over the RFC 8785 canonical form of all of that.
 *
 * A plan is an explicit, transportable statement of what the apply will do.
 * The apply never trusts its lists: it recomputes the inventory under the
 * project lock and refuses unless the recomputed plan has exactly the plan's
 * digest (`scale_downgrade_stale_plan`). Parsing is STRICT and closed: a
 * malformed, forged or tampered plan (any field, any digest mismatch) is
 * `scale_downgrade_invalid_plan`; a plan for another project root too. The
 * nested inventory is validated closed and bounded (`./downgrade-schema.ts`),
 * so no malformed field reaches the apply. The digest only detects accidental
 * edits (anyone can recompute it); the apply's fresh recomputation is what
 * establishes that a plan describes the project. A plan carrying blockers is
 * reported, never applied.
 */

import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { DOWNGRADE_PLAN_FORMAT, MAX_DOWNGRADE_PLAN_BYTES, MAX_DOWNGRADE_WORKSPACES, ScaleDowngradeError } from "./downgrade-contracts.js";
import type { DowngradeInventoryV1 } from "./downgrade-inventory.js";
import { SchemaViolation, validateInventory } from "./downgrade-schema.js";

/** A scale-down plan: its format, root, inventory and digest. */
export interface DowngradePlanV1 {
  readonly format: typeof DOWNGRADE_PLAN_FORMAT;
  readonly version: 1;
  /** The canonical project root the plan is for. */
  readonly root: string;
  readonly inventory: DowngradeInventoryV1;
  /** SHA-256 of the canonical form of the plan without this field. */
  readonly digest: string;
}

/** The digest of the plan body (everything but the digest). */
function digestOf(root: string, inventory: DowngradeInventoryV1): string {
  const canonical = canonicalize({ format: DOWNGRADE_PLAN_FORMAT, version: 1, root, inventory });
  if (canonical === undefined) throw new Error("the scale-down plan cannot be canonicalized");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The plan of `inventory` for canonical `root`. */
export function buildDowngradePlan(root: string, inventory: DowngradeInventoryV1): DowngradePlanV1 {
  if (inventory.units.length > MAX_DOWNGRADE_WORKSPACES + 4) throw new ScaleDowngradeError("scale_downgrade_blocked", `more than ${MAX_DOWNGRADE_WORKSPACES} workspace catalogs; this build does not scale such a project down`);
  return { format: DOWNGRADE_PLAN_FORMAT, version: 1, root, inventory, digest: digestOf(root, inventory) };
}

/** The plan's exact text. */
export function serializeDowngradePlan(plan: DowngradePlanV1): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/** Refuse a plan whose top level is not exactly a plan's. */
function assertPlanShape(value: unknown): asserts value is DowngradePlanV1 {
  if (!isPlanShaped(value)) throw new ScaleDowngradeError("scale_downgrade_invalid_plan", "this is not a scale-down plan");
}

/** Whether `value` has exactly a plan's top-level keys, format, version and field kinds. */
function isPlanShaped(value: unknown): boolean {
  const keys = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join() : "";
  if (keys !== "digest,format,inventory,root,version") return false;
  const plan = value as Partial<DowngradePlanV1>;
  return plan.format === DOWNGRADE_PLAN_FORMAT && plan.version === 1 && typeof plan.root === "string" && typeof plan.digest === "string" && isObject(plan.inventory);
}

/** Whether `value` is a non-null object. */
function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/**
 * Parse plan text strictly for canonical `root`. The digest catches an edited
 * body; the apply then proves the plan CURRENT by recomputing it.
 */
export function parseDowngradePlan(text: string, root: string): DowngradePlanV1 {
  if (Buffer.byteLength(text) > MAX_DOWNGRADE_PLAN_BYTES) throw new ScaleDowngradeError("scale_downgrade_invalid_plan", `the plan exceeds ${MAX_DOWNGRADE_PLAN_BYTES} bytes`);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ScaleDowngradeError("scale_downgrade_invalid_plan", "the plan is not valid JSON"); }
  assertPlanShape(value);
  if (value.root !== root) throw new ScaleDowngradeError("scale_downgrade_invalid_plan", "the plan is for another project");
  try { validateInventory(root, value.inventory); } catch (error) {
    if (error instanceof SchemaViolation) throw new ScaleDowngradeError("scale_downgrade_invalid_plan", `the plan is malformed: ${error.message}`);
    throw error;
  }
  let digest: string;
  try { digest = digestOf(value.root, value.inventory); } catch { throw new ScaleDowngradeError("scale_downgrade_invalid_plan", "the plan cannot be canonicalized"); }
  if (digest !== value.digest) throw new ScaleDowngradeError("scale_downgrade_invalid_plan", "the plan's digest does not match its contents (it was edited or forged)");
  return value;
}

/** Refuse unless `current` (recomputed now) is exactly `plan`. */
export function assertPlanCurrent(plan: DowngradePlanV1, current: DowngradePlanV1): void {
  if (current.digest !== plan.digest) throw new ScaleDowngradeError("scale_downgrade_stale_plan", "the project changed since this plan was made; preview again");
}

/** Refuse a plan that carries blockers. */
export function assertUnblocked(plan: DowngradePlanV1): void {
  const blockers = plan.inventory.blockers;
  if (blockers.length > 0) throw new ScaleDowngradeError("scale_downgrade_blocked", blockers.map((blocker) => `${blocker.code}: ${blocker.detail}`).join("; "), { blockers });
}
