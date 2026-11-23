/**
 * @file test/scale/scale-readiness-public-types.test.ts
 * @description Compile-time witnesses that BOTH public facades of the current
 * candidate (`@atomicstrata/llmwiki-core` and `llm-wiki-compiler`) accept the
 * `restoring` scale readiness that disk status now reports for a foreign
 * indexed-authority restore, and that `wiki.scale.status()` returns that
 * facade's `ScaleReport`. The type check of the test program proves them;
 * the runtime test only keeps the witnesses referenced.
 *
 * COMPATIBILITY LIMIT (characterized, not hidden): a consumer that closed its
 * readiness handling over the PREVIOUS candidate union (an exhaustive switch
 * or a closed allowed-value decoder without `restoring`) no longer accepts
 * every value the current candidate emits; the `@ts-expect-error` below
 * records exactly that boundary. Version 1 JSON fields, `ok: true` and the
 * `scale status` exit 3 for blocked observations are unchanged.
 */

import { expect, test } from "bun:test";
import type { ScaleReadiness as CoreReadiness, ScaleReport as CoreReport, WikiScaleSurface as CoreScale } from "@atomicstrata/llmwiki-core";
import type { ScaleReadiness as RootReadiness, ScaleReport as RootReport, WikiScaleSurface as RootScale } from "llm-wiki-compiler";

/** The readiness union of the previous candidate (before `restoring`). */
type PreviousCandidateReadiness = "unconfigured" | "ready" | "preparing" | "parked" | "unavailable" | "downgrading" | "unreadable";
/** What a facade's `status()` resolves to. */
type StatusOf<Scale extends { status(): Promise<unknown> }> = Awaited<ReturnType<Scale["status"]>>;

const coreRestoring: CoreReadiness = "restoring";
const rootRestoring: RootReadiness = "restoring";
const coreStatusIsReport: StatusOf<CoreScale> extends CoreReport ? true : false = true;
const rootStatusIsReport: StatusOf<RootScale> extends RootReport ? true : false = true;
const coreReportCarriesRestoring: CoreReport["readiness"] = coreRestoring;
const rootReportCarriesRestoring: RootReport["readiness"] = rootRestoring;

/** A consumer written exhaustively against the previous candidate union. */
function previousCandidateLabel(readiness: PreviousCandidateReadiness): string {
  switch (readiness) {
    case "unconfigured": case "ready": return "go";
    case "preparing": case "parked": case "unavailable": case "downgrading": case "unreadable": return "wait";
    default: { const unreachable: never = readiness; return unreachable; }
  }
}

// @ts-expect-error The current union is wider than the previous candidate's closed union (`restoring`).
const previousCandidateAccepts: PreviousCandidateReadiness = coreRestoring;

test("both public facades accept the restoring readiness (compile-time witnesses)", () => {
  expect([coreRestoring, rootRestoring, coreReportCarriesRestoring, rootReportCarriesRestoring]).toEqual(["restoring", "restoring", "restoring", "restoring"]);
  expect([coreStatusIsReport, rootStatusIsReport, previousCandidateLabel("ready"), previousCandidateAccepts]).toEqual([true, true, "go", "restoring"]);
});
