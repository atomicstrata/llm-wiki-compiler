/**
 * @file test/workflow-park-message.test.ts
 * @description The non-applied stage-output message must branch on WHY the output
 * parked. A `stage-for-review` park is a trust DOWNGRADE (untrusted actor, clean
 * content) that LLMWIKI_TRUSTED_WRITE lifts — so advising the grant is correct.
 * A `quarantine`/`deny` is a write-planner BLOCK that the grant does NOT override;
 * advising the grant there is both misleading and a security smell (it coaches the
 * operator to grant trust on flagged content). These pin the branch.
 */

import { describe, it, expect } from "vitest";
import { parkedOutputMessage } from "../src/commands/workflow-shared.js";

describe("parkedOutputMessage", () => {
  it("advises the LLMWIKI_TRUSTED_WRITE grant for a stage-for-review (trust-downgrade) park", () => {
    const message = parkedOutputMessage("page", "stage-for-review");
    expect(message).toContain("LLMWIKI_TRUSTED_WRITE");
    expect(message).toContain("stage-for-review");
  });

  it("does NOT advise the grant for a planner-quarantined output", () => {
    const message = parkedOutputMessage("page", "quarantine");
    expect(message).toContain("quarantine");
    expect(message).toContain("flagged");
    expect(message).not.toContain("set LLMWIKI_TRUSTED_WRITE to apply");
  });

  it("does NOT advise the grant for a denied output", () => {
    expect(parkedOutputMessage("relation", "deny")).not.toContain("set LLMWIKI_TRUSTED_WRITE to apply");
  });
});
