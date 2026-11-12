/**
 * @file test/source-excerpt-citations.test.ts
 * @description Fitting a page's citations to the lines its prompt showed: a span
 * across a gap is cut to the shown lines, a span inside them or a whole-file
 * citation is left as written, a span with no shown line (or in a file not
 * shown) is kept and counted, and fitting is idempotent.
 */

import { describe, expect, it } from "bun:test";
import { fitCitations } from "../src/compiler/source-excerpt.js";

const SHOWN = [{ file: "chat.md", ranges: [{ start: 94, end: 102 }, { start: 110, end: 114 }] }, { file: "note.md", ranges: [{ start: 1, end: 5 }] }];

describe("fitting citations to the shown lines", () => {
  it("cuts a span across a gap to the shown lines on each side", () => {
    expect(fitCitations("- Met. ^[chat.md:97-112]", SHOWN)).toEqual({ body: "- Met. ^[chat.md:97-102, 110-112]", outside: 0 });
  });

  it("leaves spans inside the shown lines, and whole-file citations, byte for byte", () => {
    const body = "- A. ^[chat.md:95-100]\n- B. ^[note.md:2-3, chat.md:111-111]\n- C. ^[note.md]";
    expect(fitCitations(body, SHOWN)).toEqual({ body, outside: 0 });
  });

  it("keeps and counts a span with no shown line, or in a file not shown", () => {
    const body = "- A. ^[chat.md:103-109]\n- B. ^[other.md:1-2]";
    expect(fitCitations(body, SHOWN)).toEqual({ body, outside: 2 });
  });

  it("fits only the span that needs it in a citation of several, and changes nothing the second time", () => {
    const once = fitCitations("- A. ^[note.md:2-3, chat.md:100-111]", SHOWN).body;
    expect(once).toBe("- A. ^[note.md:2-3, chat.md:100-102, 110-111]");
    expect(fitCitations(once, SHOWN)).toEqual({ body: once, outside: 0 });
  });

  it("leaves a marker with a malformed entry as written, for the linter to report", () => {
    const body = "- A. ^[a.md:12-5, chat.md:97-112]";
    expect(fitCitations(body, SHOWN).body).toBe(body);
  });

  it("joins a file's shown ranges from several sources before fitting", () => {
    const split = [{ file: "chat.md", ranges: [{ start: 1, end: 3 }] }, { file: "chat.md", ranges: [{ start: 4, end: 6 }] }];
    expect(fitCitations("- A. ^[chat.md:2-5]", split)).toEqual({ body: "- A. ^[chat.md:2-5]", outside: 0 });
  });
});
