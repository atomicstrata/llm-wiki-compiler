/** @file Real preparation through the project lock and existing bundle store.
 * Preparation retains proposed bytes but must never create the target page. */
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { digestBytes } from "../../src/operation-bundles/adapters/shared.js";
import path from "node:path";
import { expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { SAMPLE_PROFILE, writeProfileFile } from "../fixtures/profile-fixtures.js";
import { loadProfile } from "../../src/profile/load.js";
import { prepareRecordEffect } from "../../src/operation-bundles/prepare-record.js";
import { observeRecordEffect, retireRecordEffect } from "../../src/operation-bundles/record-effect.js";
import type { OperationPrincipal } from "../../src/operation-bundles/principal.js";
import { cliProductApplyDependencies } from "../../src/commands/product/host.js";
import { applyProductBundle } from "../../src/products/apply.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { assertBundleId } from "../../src/operation-bundles/ids.js";
import { readOperationManifest } from "../../src/operation-bundles/manifest-store.js";

const root = useTempRoot();
const principal: OperationPrincipal = { id: "local-flow", surface: "sdk", grants: ["operation-bundle.prepare"] };
async function input() {
  await writeProfileFile(root.dir, SAMPLE_PROFILE);
  const profile = await loadProfile(root.dir);
  return { schema: "llmwiki-record-intent-v1", workspaceId: "demo", effectId: "note-1",
    profileDigest: `sha256:${profile.digest}`, target: { entityType: "notes", slug: "one" },
    precondition: { kind: "absent" }, proposedBody: "---\ntitle: Synthetic note\n---\nProposed only.\n",
    origin: { provider: "llmflow", runId: "run", occurrenceId: "work-1", proposalDigest: `sha256:${"a".repeat(64)}` } };
}

it("prepares one stable bundle without applying it, even after its allocation index is lost", async () => {
  const intent = await input(), first = await prepareRecordEffect(root.dir, principal, intent);
  expect(first.manifestDigest).toMatch(/^sha256:/);
  expect(await prepareRecordEffect(root.dir, principal, intent)).toEqual(first);
  await expect(readFile(path.join(root.dir, "wiki", "notes", "one.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await rm(path.join(root.dir, ".llmwiki", "operation-effect-reservations"), { recursive: true });
  expect(await prepareRecordEffect(root.dir, principal, intent)).toEqual(first);
  await expect(prepareRecordEffect(root.dir, principal, { ...intent, proposedBody: "changed" })).rejects.toThrow("effect-intent-conflict");
});

it("requires explicit preparation authority and the current profile", async () => {
  const intent = await input();
  await expect(prepareRecordEffect(root.dir, { ...principal, grants: [] }, intent)).rejects.toThrow("record-prepare-grant-required");
  await expect(prepareRecordEffect(root.dir, principal, { ...intent, profileDigest: `sha256:${"b".repeat(64)}` })).rejects.toThrow("record-profile-drift");
});

it("does not return a prepared effect when its retained intent bytes have drifted", async () => {
  const intent = await input(), ref = await prepareRecordEffect(root.dir, principal, intent);
  const bundleId = assertBundleId(ref.bundleId);
  const read = await readOperationManifest(root.dir, ref.workspaceId, bundleId);
  expect(read.status).toBe("ok"); if (read.status !== "ok") return;
  const evidence = read.manifest.preparationEvidence.find(item => item.type === "record-intent-v1")!;
  const file = operationPaths(root.dir, ref.workspaceId).payloadFile(bundleId, evidence.digest.slice(7));
  await writeFile(file, "{}");
  expect((await observeRecordEffect(root.dir, ref)).status).toBe("unavailable");
  await expect(prepareRecordEffect(root.dir, principal, intent)).rejects.toThrow("operation bundle recovery is required");
});

it("binds observations exactly and retires only the host preparer's never-started effect", async () => {
  const ref = await prepareRecordEffect(root.dir, principal, await input());
  expect((await observeRecordEffect(root.dir, ref)).status).toBe("observed");
  expect((await observeRecordEffect(root.dir, { ...ref, effectId: "foreign" })).status).toBe("unavailable");
  await expect(retireRecordEffect(root.dir, { ...principal, id: "other" }, ref)).rejects.toThrow("record-preparer-mismatch");
  const retired = await retireRecordEffect(root.dir, principal, ref);
  expect(retired.status).toBe("observed");
  if (retired.status !== "observed") return;
  expect(retired.runState).toBe("superseded");
  expect(retired.applicationStarted).toBe(false);
  expect(retired.applied).toBe(false);
  expect(await retireRecordEffect(root.dir, principal, ref)).toEqual(retired);
  const lateApply = await applyProductBundle(cliProductApplyDependencies(root.dir), { bundle: ref.manifestDigest });
  expect(lateApply.status).not.toBe("applied");
  await expect(readFile(path.join(root.dir, "wiki", "notes", "one.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("observes real operator application independently of subsequent page drift", async () => {
  const intent = await input(), ref = await prepareRecordEffect(root.dir, principal, intent);
  const applied = await applyProductBundle(cliProductApplyDependencies(root.dir), { bundle: ref.manifestDigest });
  expect(applied.status).toBe("applied");
  expect(await readFile(path.join(root.dir, "wiki", "notes", "one.md"), "utf8")).toBe(intent.proposedBody);
  const observed = await observeRecordEffect(root.dir, ref);
  expect(observed.status).toBe("observed"); if (observed.status !== "observed") return;
  expect(observed.applied).toBe(true); expect(observed.applicationStarted).toBe(true);
  await expect(retireRecordEffect(root.dir, principal, ref)).rejects.toThrow("record-retirement-refused");
  await writeFile(path.join(root.dir, "wiki", "notes", "one.md"), "later record");
  const drifted = await observeRecordEffect(root.dir, ref);
  expect(drifted.status).toBe("observed"); if (drifted.status !== "observed") return;
  expect(drifted.applied).toBe(true);
  expect(drifted.predecessor).toEqual(observed.predecessor);
  expect(drifted.pages[0]?.current).not.toEqual(observed.pages[0]?.current);
});

it("refuses stale preimages and lifecycle resets before reservation", async () => {
  const intent = await input();
  await mkdir(path.join(root.dir, "wiki", "notes"), { recursive: true });
  await writeFile(path.join(root.dir, "wiki", "notes", "one.md"), "existing");
  await expect(prepareRecordEffect(root.dir, principal, intent)).rejects.toThrow("record-preimage-drift");
  const profile = structuredClone(SAMPLE_PROFILE);
  profile.entities.notes!.fields!.state = { type: "enum", enum: ["draft", "published"] };
  profile.entities.notes!.lifecycle = { field: "state", initial: "draft", terminal: ["published"], transitions: { draft: ["published"] } };
  await writeProfileFile(root.dir, profile);
  const old = Buffer.from("---\ntitle: Existing\nstate: published\n---\nPublished\n");
  await writeFile(path.join(root.dir, "wiki", "notes", "one.md"), old);
  await expect(prepareRecordEffect(root.dir, principal, { ...intent, profileDigest: `sha256:${(await loadProfile(root.dir)).digest}`,
    proposedBody: "---\ntitle: Reset\nstate: draft\n---\nReset\n",
    precondition: { kind: "digest", digest: digestBytes(old) } })).rejects.toThrow("record-lifecycle-transition-unsupported");
});
