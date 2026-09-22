/**
 * @file test/capability-providers/evidence-retention.test.ts
 * @description F1 regression: accepted outputs must be retained into a
 * host-owned evidence store whose bytes survive backend termination. The
 * streaming custodian copies each accepted output's bytes into the store and
 * returns a durable evidence reference on the accepted artifact, so a downstream
 * consumer has the artifact bytes after the provider process is gone.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createEvidenceStore } from "../../src/capability-providers/runtime/evidence-store.js";
import { createStreamingCustodian } from "../../src/capability-providers/runtime/custodian.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { custodyOptions as options, useCustodyOutputRoots } from "./custody-fixture.js";

const { scratch, outputRoot } = useCustodyOutputRoots();

describe("accepted-evidence retention", () => {
  it("durably retains accepted bytes and returns a matching reference", async () => {
    const store = await createEvidenceStore(await scratch("llmwiki-evidence-host-"));
    const bytes = Buffer.from("retained-bytes");
    const digest = parseSha256Digest(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    const ref = await store.retain(bytes, digest);
    expect(ref.byteCount).toBe(bytes.byteLength);
    expect(ref.digest).toBe(digest);
    expect(await readFile(ref.evidencePath)).toEqual(bytes);
  });

  it("attaches a durable evidence reference to each accepted artifact", async () => {
    const root = await outputRoot({ report: "report-bytes" });
    const store = await createEvidenceStore(await scratch("llmwiki-evidence-host-"));
    const custody = await createStreamingCustodian(options(root, { retainEvidence: store.retain })).custody({
      artifactClaims: [{ outputId: "report", outputToken: "report" }],
    } as never);
    expect(custody.kind).toBe("accepted");
    if (custody.kind !== "accepted") return;
    const evidence = custody.artifacts[0].evidence;
    expect(evidence).toBeDefined();
    expect(await readFile(evidence!.evidencePath, "utf8")).toBe("report-bytes");
  });
});
