/**
 * @file test/storage/query-facade-async.test.ts
 * @description The query and publication ROOT facades stay asynchronous after
 * they became thin delegations to their one bodies: a malformed argument is a
 * REJECTED promise, never a synchronous throw, exactly as when each facade was
 * an `async` body itself. No facade here reaches a project: every call fails on
 * its malformed argument before any read or write.
 */

import { describe, expect, it, vi } from "bun:test";
import { validateCitationPublication } from "../../src/citations/answer-publication.js";
import { generateAnswer } from "../../src/commands/query.js";
import { reportQueryAnswerCitations } from "../../src/commands/query-citation-report.js";
import { stageQueryProposal } from "../../src/commands/query-proposal.js";
import { maybeSaveQueryPage } from "../../src/commands/query-publication.js";
import { saveQueryPageLocked } from "../../src/commands/query-save.js";
import * as output from "../../src/utils/output.js";

/** Call `facade` and require that calling it did not throw; hand back what it returned. */
function returnedBy(facade: () => unknown): unknown {
  let returned: unknown;
  expect(() => { returned = facade(); }).not.toThrow();
  return returned;
}

const malformed = undefined as never;

describe("query and publication facades stay asynchronous", () => {
  it("A1 rejects a malformed argument as a promise, for every facade that fails on it", async () => {
    for (const facade of [
      () => maybeSaveQueryPage(malformed), () => stageQueryProposal(malformed), () => generateAnswer(malformed, malformed),
      () => validateCitationPublication(malformed, malformed, "direct", malformed), () => saveQueryPageLocked(malformed, malformed, malformed),
    ]) {
      await expect(returnedBy(facade)).rejects.toBeInstanceOf(Error);
    }
  });

  it("A2 the citation report keeps its recovery boundary: a malformed argument resolves to no report, asynchronously", async () => {
    vi.spyOn(output, "note").mockImplementation(() => {});
    await expect(returnedBy(() => reportQueryAnswerCitations(malformed, malformed))).resolves.toEqual({});
    vi.restoreAllMocks();
  });
});
