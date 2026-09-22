/** Pure common history projections; domain state machines, authority, and signing stay with each store. */
interface CompletionWarning {
  code: string;
  attempted: number;
  completed: number;
  skipped: number;
  failed: number;
}

/** Copy annotation arrays and only the allowlisted fields of a new annotation. */
export function appendRunAnnotations(
  run: { completionWarnings: readonly CompletionWarning[]; notices: readonly { code: string }[] },
  warning?: CompletionWarning, notice?: { code: string },
) {
  const completionWarnings = [...run.completionWarnings];
  if (warning !== undefined) completionWarnings.push({
    code: warning.code, attempted: warning.attempted, completed: warning.completed,
    skipped: warning.skipped, failed: warning.failed,
  });
  const notices = [...run.notices];
  if (notice !== undefined) notices.push({ code: notice.code });
  return { completionWarnings, notices };
}

/** Build an unsigned successor envelope from an already cloned actor and checked predecessor. */
export function successorEnvelope<S extends string, A, T extends string, P, H extends string>(
  run: { state: S; transitions: readonly unknown[] }, previousHash: H,
  input: { actor: A; stateAfter: S; type: T; at: string; payload: P },
) {
  return {
    sequence: run.transitions.length, previousHash, actor: input.actor,
    stateBefore: run.state, stateAfter: input.stateAfter, type: input.type,
    at: input.at, payload: input.payload,
  };
}
