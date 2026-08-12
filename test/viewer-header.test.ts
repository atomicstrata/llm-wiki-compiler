/**
 * Header chrome contract.
 *
 * The header carries the project identity, a whole-wiki verdict pill, and a
 * meta line. The pill reports the WHOLE verdict — lint findings as well as
 * freshness — because a freshness-only pill said "ALL PAGES FRESH" over a
 * wiki with open lint errors, and said it again when freshness could not be
 * computed at all: a missing state.json leaves `stale` and `orphaned` both 0
 * for the wrong reason, so zero-because-unchecked rendered identically to
 * zero-because-current.
 *
 * The meta line says "snapshot" rather than "compiled" because generatedAt is
 * viewer start time, not compile time — labelling it "compiled" would assert
 * something false.
 */

import { describe, expect, it } from "vitest";
import { jsonResponse, mountViewerDom, type FetchResponder } from "./fixtures/viewer-jsdom.js";

/** Lint cache shape the verdict reads; `null` means lint has never run. */
type Lint = { errors: number; warnings: number } | null;

/** One profile-collector problem, in the shape `/api/pages` serialises. */
type ProfileProblem = { kind: string; message: string; path?: string };

/** What the two bootstrap payloads report for one header scenario. */
interface Scenario {
  stale?: number;
  orphaned?: number;
  stateStatus?: string;
  lint?: Lint;
  /**
   * Collector problems on the `/api/pages` envelope. A default-profile project
   * sends NEITHER key, which is why both are optional here: the absent case is
   * the control, and it must keep producing the pre-existing verdict.
   */
  profileProblems?: ProfileProblem[];
  profileProblemTotal?: number;
}

/** A single field violation — enough to prove a project is not healthy. */
const ONE_PROFILE_PROBLEM: ProfileProblem[] = [
  { kind: "field-violation", path: "wiki/notes/a.md", message: 'missing required field "title"' },
];

/** Everything measured, nothing wrong — the ALL CLEAR baseline every case varies from. */
const CLEAN: Scenario = {
  stale: 0,
  orphaned: 0,
  stateStatus: "ok",
  lint: { errors: 0, warnings: 0 },
};

/** The capped-list/true-total pair, omitted entirely when a scenario declares no problems. */
function profileFields({ profileProblems, profileProblemTotal }: Scenario) {
  if (!profileProblems) return {};
  return { profileProblems, profileProblemTotal: profileProblemTotal ?? profileProblems.length };
}

/** Build an `/api/pages` envelope carrying a scenario's counts and state status. */
function envelopeFor(scenario: Scenario) {
  const { stale = 0, orphaned = 0, stateStatus = "ok" } = scenario;
  return {
    project: { title: "my-llm-wiki", rootName: "my-llm-wiki" },
    stateStatus,
    profileId: "default",
    counts: {
      concepts: 7, queries: 0, sourceFiles: 1, pendingReviews: 0,
      compiledSources: 1, stale, orphaned,
    },
    graph: { nodeCount: 12, edgeCount: 20, danglingCount: 0 },
    sourceFilenames: [],
    index: { available: true, href: "/#/index" },
    recentPages: [],
    pages: [],
    updatedAt: "2026-08-04T10:14:00.000Z",
    ...profileFields(scenario),
  };
}

/** Mount the viewer against one scenario and return its document. */
async function mountWith(scenario: Scenario): Promise<Document> {
  const responder: FetchResponder = (url) => {
    if (url.endsWith("/api/pages")) return jsonResponse(envelopeFor(scenario));
    if (url.endsWith("/api/health")) return jsonResponse({ lint: scenario.lint ?? null });
    return null;
  };
  const { dom } = await mountViewerDom(responder);
  return dom.window.document;
}

/** Mount one scenario and read the verdict pill's text and tone modifier. */
async function verdictOf(scenario: Scenario): Promise<{ text: string; tone: string }> {
  const pill = (await mountWith(scenario)).querySelector("[data-verdict]");
  return { text: pill?.textContent ?? "", tone: pill?.className ?? "" };
}

describe("header chrome — identity and meta line", () => {
  it("shows the project title", async () => {
    const doc = await mountWith(CLEAN);
    expect(doc.querySelector("[data-app-title]")?.textContent).toBe("my-llm-wiki");
  });

  it("labels the meta line as a snapshot, not a compile", async () => {
    const doc = await mountWith(CLEAN);
    const meta = doc.querySelector("[data-app-meta]")?.textContent ?? "";
    expect(meta).toContain("snapshot");
    expect(meta).not.toContain("compiled");
    expect(meta).toContain("profile default");
    expect(meta).toContain("state ok");
  });
});

describe("header verdict pill — measured problems win", () => {
  it("needs attention when lint reports errors", async () => {
    const verdict = await verdictOf({ ...CLEAN, lint: { errors: 3, warnings: 0 } });
    expect(verdict.text).toBe("NEEDS ATTENTION");
    expect(verdict.tone).toContain("is-warn");
  });

  it("needs attention on warnings alone, matching the sidebar badge's count", async () => {
    const verdict = await verdictOf({ ...CLEAN, lint: { errors: 0, warnings: 2 } });
    expect(verdict.text).toBe("NEEDS ATTENTION");
    expect(verdict.tone).toContain("is-warn");
  });

  it("needs attention when pages are stale", async () => {
    expect((await verdictOf({ ...CLEAN, stale: 3 })).text).toBe("NEEDS ATTENTION");
  });

  it("needs attention when pages are orphaned", async () => {
    expect((await verdictOf({ ...CLEAN, orphaned: 2 })).text).toBe("NEEDS ATTENTION");
  });
});

/**
 * The profile collector's problems are the one input purpose-built to stop a
 * broken project reading as healthy — a bad entity directory or an invalid
 * entity page is a KNOWN defect, so it belongs in the attention tier beside
 * lint, not in the unmeasured tier.
 */
describe("header verdict pill — profile collector problems", () => {
  it("needs attention when the collector reported a problem", async () => {
    const verdict = await verdictOf({ ...CLEAN, profileProblems: ONE_PROFILE_PROBLEM });
    expect(verdict.text).toBe("NEEDS ATTENTION");
    expect(verdict.tone).toContain("is-warn");
  });

  it("never reads all clear while a collector problem stands", async () => {
    const verdict = await verdictOf({ ...CLEAN, profileProblems: ONE_PROFILE_PROBLEM });
    expect(verdict.text).not.toBe("ALL CLEAR");
    expect(verdict.tone).not.toContain("is-ok");
  });

  it("outranks the unmeasured tier when freshness could not be computed too", async () => {
    const scenario = { ...CLEAN, stateStatus: "missing", profileProblems: ONE_PROFILE_PROBLEM };
    const verdict = await verdictOf(scenario);
    expect(verdict.text).toBe("NEEDS ATTENTION");
    expect(verdict.tone).toContain("is-warn");
  });

  it("warns on a directory-level problem, which names no page at all", async () => {
    const problem = { kind: "invalid-directory", message: "wiki/notes is not a directory" };
    expect((await verdictOf({ ...CLEAN, profileProblems: [problem] })).text).toBe("NEEDS ATTENTION");
  });

  it("leaves a default-profile project untouched — an absent block is not a problem", async () => {
    expect((await verdictOf(CLEAN)).text).toBe("ALL CLEAR");
    expect((await verdictOf({ ...CLEAN, stateStatus: "missing" })).text).toBe("FRESHNESS UNVERIFIED");
  });
});

describe("header verdict pill — what was never measured", () => {
  it("names unverifiable freshness rather than claiming all clear", async () => {
    const verdict = await verdictOf({ ...CLEAN, stateStatus: "missing" });
    expect(verdict.text).toBe("FRESHNESS UNVERIFIED");
    expect(verdict.tone).toContain("is-unknown");
    expect(verdict.tone).not.toContain("is-ok");
  });

  it("names a lint run that never happened rather than claiming all clear", async () => {
    const verdict = await verdictOf({ ...CLEAN, lint: null });
    expect(verdict.text).toBe("LINT NEVER RUN");
    expect(verdict.tone).toContain("is-unknown");
  });

  it("names both when neither freshness nor lint was ever measured", async () => {
    const verdict = await verdictOf({ ...CLEAN, stateStatus: "corrupt", lint: null });
    expect(verdict.text).toBe("FRESHNESS UNVERIFIED · LINT NEVER RUN");
  });
});

describe("header verdict pill — precedence and the all-clear", () => {
  it("reports attention, not merely unknown, when errors coexist with bad state", async () => {
    const verdict = await verdictOf({ ...CLEAN, stateStatus: "missing", lint: { errors: 7, warnings: 0 } });
    expect(verdict.text).toBe("NEEDS ATTENTION");
    expect(verdict.tone).toContain("is-warn");
  });

  it("reads all clear only when everything was measured and nothing is wrong", async () => {
    const verdict = await verdictOf(CLEAN);
    expect(verdict.text).toBe("ALL CLEAR");
    expect(verdict.tone).toContain("is-ok");
  });
});
