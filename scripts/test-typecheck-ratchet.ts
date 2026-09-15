/** Per-file comparison for the test type-check gate; no repository-wide error budget. */

/** Report regressions and, during a normal check, unused diagnostic allowances. */
export function compareDiagnosticCounts(
  actual: Record<string, number>,
  baseline: Record<string, number>,
  allowDecrease = false,
): string[] {
  const errors: string[] = [];
  for (const file of [...new Set([...Object.keys(actual), ...Object.keys(baseline)])].sort()) {
    const current = actual[file] ?? 0;
    const allowed = baseline[file] ?? 0;
    if (current > allowed) errors.push(`${file}: ${current} diagnostics exceeds baseline ${allowed}`);
    else if (current < allowed && !allowDecrease) {
      errors.push(`${file}: diagnostics decreased from ${allowed} to ${current}; update the baseline`);
    }
  }
  return errors;
}
