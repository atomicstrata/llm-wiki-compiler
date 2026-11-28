/**
 * @file test/cstate/sample-state.ts
 * @description A realistic compile state for the segmented compile state
 * tests and their child processes (no test-runner import, so a bundled child
 * can use it): sources with concepts and an extraction snapshot, an extra
 * source key the state must keep verbatim, a dot-file and a name with a space, frozen slugs, and a
 * prompt modifiers digest.
 */

import type { WikiState } from "../../src/utils/types.js";

/** A realistic compile state, sources deliberately NOT in key order. */
export function sampleState(): WikiState {
  return {
    version: 1, indexHash: "idx-1", promptModifiers: "pm-digest", frozenSlugs: ["frozen-one"],
    sources: {
      "zeta.md": { hash: "h-z", concepts: ["shared", "zeta-only"], compiledAt: "2026-10-01T00:00:00.000Z" },
      ".notes.md": { hash: "h-n", concepts: ["shared"], compiledAt: "2026-10-02T00:00:00.000Z", hostNote: { kept: "an extra key the compile state must preserve verbatim" } } as WikiState["sources"][string],
      "my notes.md": { hash: "h-m", concepts: [], compiledAt: "2026-10-04T00:00:00.000Z", extraction: { fingerprint: "fp", sourceHash: "h-m", concepts: [] } },
    },
  };
}
