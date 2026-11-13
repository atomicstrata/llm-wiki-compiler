/**
 * @file src/cli/review-errors.ts
 * @description The legacy human error handling shared by the non-batch
 * `review` actions: a throw prints a red `Error:` line and exits 1.
 */

/** Preserve the legacy human error handling for each non-batch review action. */
export function withReviewErrors<Args extends unknown[]>(action: (...args: Args) => Promise<void>) {
  return async (...args: Args): Promise<void> => {
    try {
      await action(...args);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  };
}
