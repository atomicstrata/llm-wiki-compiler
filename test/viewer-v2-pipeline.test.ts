/** The lifecycle screen's derivations: reachability, state roles, and the sentences that explain a row. */
import { describe, expect, it } from "bun:test";
import {
  calloutReason, chipLabel, classifyStates, declaredText, displayLabel, displayedStates, footerText, gapText,
  hasDeclaredOrder, reachableOrder, rowVerdict, totalRejected,
} from "../viewer-v2/src/pipeline-model.js";
import { entityType, lifecycle } from "./fixtures/viewer-v2-fixtures.js";

const ORDERLESS = lifecycle({ terminal: [], transitions: {}, declaredStates: ["open", "closed"] });

describe("reachability", () => {
  it("walks the transitions breadth-first from the initial state, never the enum", () => {
    expect(reachableOrder(lifecycle({ declaredStates: ["published", "draft", "review"] }))).toEqual(["draft", "review", "published"]);
    expect(reachableOrder(lifecycle({ transitions: { draft: ["a", "b"], a: ["c"], b: ["c"] } }))).toEqual(["draft", "a", "b", "c"]);
    expect(reachableOrder(undefined)).toEqual([]);
  });

  it("finds an order only when a terminal state or a transition is declared", () => {
    expect(hasDeclaredOrder(lifecycle())).toBe(true);
    expect(hasDeclaredOrder(lifecycle({ terminal: [], transitions: { draft: ["review"] } }))).toBe(true);
    expect(hasDeclaredOrder(ORDERLESS)).toBe(false);
    expect(hasDeclaredOrder(undefined)).toBe(false);
  });
});

describe("classifyStates", () => {
  it("orders by the chain and names terminal and unreachable states", () => {
    const states = classifyStates(lifecycle(), { published: 2, draft: 3, limbo: 1, review: 0 });
    expect(states.map((state) => [state.state, state.role])).toEqual([
      ["draft", "flight"], ["published", "terminal"], ["limbo", "unreachable"],
    ]);
  });

  it("keeps every state of an orderless type in flight, biggest pile first", () => {
    const states = classifyStates(ORDERLESS, { open: 1, closed: 4 });
    expect(states.map((state) => [state.state, state.role])).toEqual([["closed", "flight"], ["open", "flight"]]);
  });

  it("adds declared and reachable states at zero without inventing warnings", () => {
    const shown = displayedStates(lifecycle(), classifyStates(lifecycle(), { draft: 1 }));
    expect(shown.map((state) => `${state.state}:${state.role}`)).toEqual(["draft:flight", "review:empty", "published:empty"]);
  });
});

describe("row sentences", () => {
  it("labels chips with their role only when it matters", () => {
    expect(chipLabel({ state: "draft", count: 3, role: "flight" })).toBe("3 draft");
    expect(chipLabel({ state: "published", count: 2, role: "terminal" })).toBe("2 published · terminal");
    expect(chipLabel({ state: "limbo", count: 1, role: "unreachable" })).toBe("1 limbo · unreachable");
  });

  it("states what the profile declared rather than what was derived", () => {
    expect(declaredText(undefined)).toBe("No stages configured");
    expect(declaredText(lifecycle())).toBe("initial draft · terminal published");
    expect(declaredText(lifecycle({ terminal: [] }))).toBe("initial draft");
    expect(declaredText(ORDERLESS)).toBe("2 states declared · no transitions, no terminal — order not derivable, so none is implied");
  });

  it("tells an undeclared state apart from a declared one no transition reaches", () => {
    expect(calloutReason("limbo", lifecycle())).toBe("not a declared `status` value at all");
    expect(calloutReason("archived", lifecycle({ declaredStates: ["draft", "archived"] }))).toBe("declared on `status` but no transition reaches it from `draft`");
  });

  it("reads the rejected pages off the gap between the tally and the valid count", () => {
    const row = entityType({ pageCount: 5, stateCounts: { draft: 4, published: 2 } });
    expect(rowVerdict(row)).toEqual({ sum: 6, rejected: 1 });
    expect(gapText(rowVerdict(row))).toBe("1 rejected page counted here");
    expect(gapText({ sum: 0, rejected: 0 })).toBe("No records with a recorded state");
    expect(gapText({ sum: 3, rejected: 0 })).toBe("All counted records have recognized states");
    expect(totalRejected([row, entityType({ type: "notes", pageCount: 1, stateCounts: { draft: 3 } })])).toBe(3);
  });

  it("writes the footer as a floor, since a page without the field is in no tally", () => {
    expect(footerText(0)).toBe("No rejected page declares a lifecycle state, so every tally above counts profile-valid pages only.");
    expect(footerText(1)).toContain("1 rejected page still declares a lifecycle state and is counted");
    expect(footerText(2)).toContain("2 rejected pages still declare a lifecycle state and are counted");
  });

  it("spells relation and metadata keys for reading", () => {
    expect(displayLabel("peer_review")).toBe("Peer review");
    expect(displayLabel("citedBy")).toBe("Cited By");
    expect(displayLabel("doi")).toBe("DOI");
  });
});
