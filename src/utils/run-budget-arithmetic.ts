/** Shared run-budget arithmetic; each store retains its own limits and error class. */

/** Common error presentation without merging the stores' instanceof identities. */
export class RunBudgetErrorBase extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunBudgetError";
  }
}

/** Validate a count while preserving the caller's refusal type and message. */
export function budgetCount(value: number, label: string, ErrorType: new (message: string) => Error): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ErrorType(`${label} must be a nonnegative safe integer`);
  return value;
}

/** Size ordinary and reserved lanes using the store's exact record-size model. */
export function budgetLanes(
  baseBytes: number, counts: { total: number; controls: number },
  size: (base: number, count: number) => number,
): { ordinary: number; total: number; controlBytes: number } {
  const ordinary = size(baseBytes, counts.total - counts.controls);
  const total = size(baseBytes, counts.total);
  return { ordinary, total, controlBytes: total - ordinary };
}
