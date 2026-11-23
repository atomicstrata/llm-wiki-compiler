/**
 * @file src/scale/downgrade-cancel-state.ts
 * @description The CRASH-STATE CLASSIFIER of a pre-install cancel (design v2
 * §4 and §6): a pure function from what is on disk to one row of the reviewed
 * tables. It decides nothing about the file system itself; the observer
 * (`./downgrade-cancel-observe.ts`) reads, and the orchestrator
 * (`./downgrade-cancel.ts`) acts.
 *
 * Fenced rows: F0 fence, no cancel intent; F1 cancel intent and the fence; F2
 * cancel intent and the record is byte-for-byte the expected cancel record at
 * exactly its revision (the only proof accepted without a receipt); F3 cancel
 * intent and a record past the cancel revision, no receipt (FAILS CLOSED:
 * nothing proves this cancel wrote it); F4 anything else; F5 a bound receipt
 * with the intent still in place; F6 a bound receipt with the intent retired.
 * Bootstrapped rows (no record is ever written): B0 original record, no
 * cancel intent; B1 cancel intent and the original record; B2 cancel intent
 * and a newer record a positive never-fenced proof accepts; B3 anything else;
 * B4 and B5 as F5 and F6.
 */

/** What the observer found about the scale record, relative to this plan. */
export type RecordObservation = "fence" | "original" | "expected-cancel" | "later" | "never-fenced-later" | "other";

/** Everything the classifier needs, as observed. */
export interface CancelObservation {
  /** The bootstrap intent leaf: this plan's, absent, another, or unreadable. */
  readonly intent: "own" | "absent" | "other" | "unreadable";
  /** Whether `<dir>/intent.json` is exactly this plan's retired intent. */
  readonly retired: boolean;
  readonly record: RecordObservation;
  /** The cancel intent's phase, or null when there is none. */
  readonly cancel: "fenced" | "bootstrapped" | null;
  /** The cancel receipt: bound to this plan's cancel intent and outcome, present but not bound, or absent. */
  readonly receipt: "bound" | "unbound" | null;
}

/** One row of the reviewed tables, or why there is no cancel to act on. */
export type CancelRow =
  | "F0" | "F1" | "F2" | "F3" | "F4" | "F5" | "F6"
  | "B0" | "B1" | "B2" | "B3" | "B4" | "B5"
  | "fresh" | "foreign" | "not-pre-install" | "evidence-invalid";

/** The row of a state with a bound receipt. */
function receiptRow(observation: CancelObservation): CancelRow {
  const fenced = observation.cancel === "fenced";
  if (observation.cancel === null) return "evidence-invalid";
  if (observation.intent === "own") return fenced ? "F5" : "B4";
  return observation.intent === "absent" && observation.retired ? (fenced ? "F6" : "B5") : "evidence-invalid";
}

/** The row of a state with a cancel intent and no receipt. */
function intentRow(cancel: "fenced" | "bootstrapped", record: RecordObservation): CancelRow {
  if (cancel === "fenced") return record === "fence" ? "F1" : record === "expected-cancel" ? "F2" : record === "later" ? "F3" : "F4";
  return record === "original" ? "B1" : record === "never-fenced-later" ? "B2" : "B3";
}

/** Classify one observed state (see the file comment). */
export function classifyCancel(observation: CancelObservation): CancelRow {
  if (observation.receipt === "unbound" || observation.intent === "unreadable") return "evidence-invalid";
  if (observation.receipt === "bound") return receiptRow(observation);
  if (observation.intent === "other") return "foreign";
  if (observation.intent === "absent") return observation.cancel === null && !observation.retired ? "fresh" : "evidence-invalid";
  if (observation.cancel !== null) return intentRow(observation.cancel, observation.record);
  return observation.record === "fence" ? "F0" : observation.record === "original" ? "B0" : "not-pre-install";
}
