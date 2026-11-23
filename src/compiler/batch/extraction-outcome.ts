/**
 * @file src/compiler/batch/extraction-outcome.ts
 * @description The one rule a batch compile reads an extraction row by: an
 * extraction that yielded no concepts FAILED and is retried by the next run,
 * exactly as the classic compile treats it (`freezeFailedExtractions`).
 *
 * The classic compile has one more outcome, an explicit empty answer under
 * `--no-pages-limit`, which withdraws a source's earlier concepts. A batch
 * compile does not implement that withdrawal, so it refuses the option before
 * any effect (`./driver.ts`) and never records such a row.
 */

/** Whether an extraction row FAILED: it carries no concepts. */
export function isFailedExtraction(row: { readonly concepts: readonly unknown[] }): boolean {
  return row.concepts.length === 0;
}
