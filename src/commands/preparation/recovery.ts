/**
 * @file src/commands/preparation/recovery.ts
 * @description `llmwiki preparation recover <runId>` — park one stranded run
 * and report the project's outstanding lifecycle maintenance.
 *
 * AN ADAPTER, and nothing else (D-10-1). The `recovery`-intent acquisition, the
 * stranded-versus-busy liveness test, the derived park target and the lifecycle
 * projection all live in the service; what remains here is the run id the
 * operator typed and how the three outcomes read.
 *
 * THE LIFECYCLE LINE IS WHY THIS VERB IS WORTH RUNNING ON A HEALTHY RUN TOO.
 * Recovery is the only intent the mutation gate lets past, so it is the only
 * surface that can report unfinished destructive maintenance rather than being
 * refused by it — and that report is printed whether or not anything was parked.
 */

import * as output from "../../utils/output.js";
import { withQuietJson } from "../../cli/shared.js";
import { emitJson } from "../operation/render.js";
import type {
  LifecyclePendingUnitV1, RecoveryLifecycleV1, RecoveryResultV1,
} from "../../preparations/service.js";
import { cliPreparationService } from "./host.js";

/** Count the pending units by the operation that owns them, in a stable order. */
function pendingOperationSummary(units: readonly LifecyclePendingUnitV1[]): string {
  const counts = new Map<string, number>();
  for (const unit of units) {
    // `null` reads as UNKNOWN rather than being folded into a neighbour: it is
    // the one class no shipped verb can retire, so it must not look like one
    // that can.
    const operation = unit.operation ?? "unknown-operation";
    counts.set(operation, (counts.get(operation) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([operation, count]) => `${count} ${operation}`).join(", ");
}

/** CLI options for `preparation recover`. */
export interface PreparationRecoverOptions {
  /** Emit the machine-readable envelope instead of the human lines. */
  json?: boolean;
}

/**
 * The human line describing what this call saw of lifecycle maintenance.
 *
 * IT NAMES THE OPERATIONS, not just a count. A pending unit can only be retired
 * by the command that owns it, so "2 pending unit(s)" told an operator that
 * something was wrong and nothing about which verb would fix it. The operations
 * are counted rather than the unit ids listed, because the remedy is per
 * operation and a large registry must not unbound the line.
 */
function lifecycleLine(lifecycle: NonNullable<RecoveryLifecycleV1>): string {
  if (lifecycle.status === "clean") return "no unfinished lifecycle maintenance";
  if (lifecycle.status === "pending") {
    return `unfinished lifecycle maintenance: ${pendingOperationSummary(lifecycle.units)}`;
  }
  // UNREADABLE IS NOT CLEAN, and it must not print as though it were.
  return `lifecycle maintenance state could not be read: ${lifecycle.detail}`;
}

/** Print the lifecycle report when this call got far enough to observe one. */
function reportLifecycle(lifecycle: RecoveryLifecycleV1): void {
  if (lifecycle !== null) output.status("i", output.info(lifecycleLine(lifecycle)));
}

/** Render one outcome in whichever mode the operator asked for. */
function report(outcome: RecoveryResultV1, json: boolean): void {
  if (json) {
    emitJson(outcome);
    return;
  }
  if (outcome.status === "refused") output.status("!", output.warn(outcome.reason));
  else if (outcome.status === "parked") {
    output.status("✓", output.info(`${outcome.runId} parked for recovery`));
  } else output.status("✓", output.info(`${outcome.runId} was already parked for recovery`));
  reportLifecycle(outcome.lifecycle);
}

/** `llmwiki preparation recover <runId>`. Returns the process exit code. */
export async function preparationRecoverCommand(
  root: string, runId: string, options: PreparationRecoverOptions = {},
): Promise<number> {
  const json = options.json === true;
  const outcome = await withQuietJson(json, () => cliPreparationService(root).recovery({ runId }));
  report(outcome, json);
  // ALREADY-PARKED IS A SUCCESS: the run is in the state this verb drives to,
  // so an idempotent retry must not read as a failure.
  return outcome.status === "refused" ? 1 : 0;
}
