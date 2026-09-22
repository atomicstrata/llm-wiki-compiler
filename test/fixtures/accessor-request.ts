/** Hostile request fixture counting accessor execution at service boundaries. */

/** Build own enumerable getters and expose their per-field invocation counts. */
export function accessorRequest(fields: Record<string, unknown>): {
  request: Record<string, unknown>; fired: () => Record<string, number>;
} {
  const counts: Record<string, number> = {};
  const request: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(request, key, {
      enumerable: true, configurable: true,
      get() { counts[key] = (counts[key] ?? 0) + 1; return value; },
    });
  }
  return { request, fired: () => counts };
}
