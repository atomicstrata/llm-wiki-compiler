/**
 * @file test/artifacts/execution-provenance-scan-binding.test.ts
 * @description SCAN-BINDING ONLY. One witness that the execution-provenance
 * verifier's ROOT FORM, `verifyExecutionProvenance(root, …)`, reaches the real
 * preparation inventory scan on the local disk and answers from it.
 *
 * The directory is BARE: a fresh temporary directory with no `.llmwiki` and no
 * preparation store. The real scan of it reports no manifest and no problem, so
 * the verifier has no candidate and denies. The verdict AND its exact detail
 * are asserted, so a scan that degraded (a park) or a changed wording fails.
 *
 * WHAT THIS DOES NOT RUN. With no manifest the verifier's loop body never
 * executes, so of its three production reads only the SCAN is called here. The
 * sealed-input read and the run read are NOT executed by this file, or by any
 * other test: no test profile on disk declares an execution-provenance
 * requirement. `execution-provenance-conjuncts.test.ts` runs every decision of
 * the verifier over a double; nothing here shows a vouching, unreadable or
 * mismatching run on disk.
 *
 * It uses only the root form, so it runs unchanged before and after the
 * verifier's reads were made rootless.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { verifyExecutionProvenance } from "../../src/artifacts/execution-provenance.js";
import type { ExecutionProvenanceReq } from "../../src/profile/types.js";

const REQ: ExecutionProvenanceReq = { actionId: "demo.execute", slugInputField: "slug", resultOutputId: "result" };
const DIGEST = `sha256:${"a".repeat(64)}`;

describe("execution provenance: the production scan binding on an empty root (scan binding only)", () => {
  it("W1 denies, with its exact detail, on a bare directory that holds no preparation store", async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), "execution-provenance-scan-bare-"));
    try {
      expect(await verifyExecutionProvenance(bare, REQ, "probe", DIGEST)).toEqual({
        verdict: "deny",
        detail: `no succeeded 'demo.execute' run with slug="probe" admitted the pinned bytes under output 'result'`,
      });
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
