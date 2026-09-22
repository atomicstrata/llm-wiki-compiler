/** @file Real retained bundle observation witnesses. Current matching bytes
 * never substitute for authenticated application; unavailable custody stays unknown. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { stageOperationBundleLocked, type OperationBundleDraft } from "../../src/operation-bundles/stage.js";
import { digestBytes } from "../../src/operation-bundles/adapters/shared.js";
import { observeOperationBundle } from "../../src/operation-bundles/observe.js";

const root = useTempRoot();

/** Build a real single-page bundle; this fixture stages, but never approves it. */
async function staged() {
  const bytes = Buffer.from("# Synthetic record\n"), digest = digestBytes(bytes), payloadRef = digest.slice(7);
  const draft: OperationBundleDraft = {
    workspaceId: "demo", createdBy: "fixture", knowledgeAuthority: { id: "fixture", digest },
    operationsAuthority: { packId: "fixture", packDigest: digest, actionId: "record", actionDescriptorDigest: digest },
    grantDigest: digest, safetyFloorDigest: digest, inputs: [], preparationEvidence: [], bounds: [],
    completeness: { attempted: 0, completed: 0, skipped: 0, failed: 0, requiredMissing: 0, optionalMissing: 0, rationaleDigest: digest },
    reconciliations: [], planningWarnings: [], mutations: [{ kind: "page", operation: "create",
      target: { kind: "entity", entityType: "stories", slug: "one" }, payloadRef, dependsOn: [], reconciliationRefs: [],
      precondition: { kind: "absent" }, postcondition: { digest, byteCount: bytes.length } }],
    run: { actor: { id: "fixture", surface: "sdk", grants: [] }, declaredCompensatorIndexes: [], controlTransitionAllowance: 16 },
  };
  const result = await stageOperationBundleLocked(root.dir, { draft, payloads: new Map([[payloadRef, bytes]]) });
  return { ...result, bytes };
}

it("reports authenticated identities and current page bytes separately from application", async () => {
  const fixture = await staged();
  const first = await observeOperationBundle(root.dir, fixture.manifestDigest);
  expect(first.status).toBe("observed"); if (first.status !== "observed") return;
  expect(first.binding).toMatchObject({ workspaceId: "demo", bundleId: fixture.manifest.bundleId,
    runId: fixture.manifest.runId, manifestDigest: fixture.manifestDigest });
  expect(first.predecessor.chainTip).toMatch(/^sha256:/);
  expect(first.applicationStarted).toBe(false);
  expect(first.pages[0]?.current).toEqual({ kind: "absent" });
  await mkdir(path.join(root.dir, "wiki", "stories"), { recursive: true });
  await writeFile(path.join(root.dir, "wiki", "stories", "one.md"), fixture.bytes);
  const matching = await observeOperationBundle(root.dir, fixture.manifestDigest);
  expect(matching.status).toBe("observed"); if (matching.status !== "observed") return;
  expect(matching.pages[0]?.current).toEqual({ kind: "ok", digest: digestBytes(fixture.bytes) });
  expect(matching.applied).toBe(false);
  await writeFile(path.join(root.dir, "wiki", "stories", "one.md"), "changed");
  const changed = await observeOperationBundle(root.dir, fixture.manifestDigest);
  expect(changed.status).toBe("observed"); if (changed.status !== "observed") return;
  expect(changed.pages[0]?.current).toEqual({ kind: "ok", digest: digestBytes(Buffer.from("changed")) });
  expect(changed.predecessor).toEqual(first.predecessor);
});

it("does not report absent when the operation inventory is unreadable", async () => {
  const fixture = await staged();
  await writeFile(path.join(root.dir, ".llmwiki", "workspaces", "demo", "bundles", fixture.manifest.bundleId, "manifest.json"), "broken");
  expect((await observeOperationBundle(root.dir, fixture.manifestDigest)).status).toBe("unavailable");
});
