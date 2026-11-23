/**
 * @file src/scale/step-outcome.ts
 * @description The outcome helpers every `local-indexed` preparation step
 * shares: a bounded outcome, and the rule that a step never throws on an
 * indexed-store fault but PARKS (so the transition stays visible and
 * resumable, with the incumbent files still authoritative).
 */

import { IndexedStoreError } from "../segments/contracts.js";
import { MAX_STEP_DETAIL_CHARS } from "./contracts.js";
import type { StepOutcome } from "./steps.js";

/** A bounded outcome. */
export function stepOutcome(status: StepOutcome["status"], detail: string): StepOutcome {
  return { status, detail: detail.slice(0, MAX_STEP_DETAIL_CHARS) };
}

/** Run `work`, parking (never throwing) on a store fault so the transition stays visible and resumable. */
export async function parkOnStoreFault(label: string, work: () => Promise<StepOutcome>): Promise<StepOutcome> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof IndexedStoreError) return stepOutcome("parked", `${label}: ${error.message}`);
    throw error;
  }
}
