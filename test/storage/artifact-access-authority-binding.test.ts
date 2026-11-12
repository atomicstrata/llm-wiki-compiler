/**
 * @file test/storage/artifact-access-authority-binding.test.ts
 * @description Two request-time decisions as ONE body each over the one read
 * they make, with no project directory: the viewer's artifact projection
 * (`readViewerArtifactWith`, bound by `readViewerArtifactFrom`) and a new run's
 * process authority (`resolveWorkflowProcessAuthorityFrom`). This file uses
 * them, which exist only after each was given its read, so it has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. The artifact projection runs over a memory verified read
 * that logs its refs, so the ref refusal, the declared-metadata filter and the
 * loopback gate are pinned against each health. The authority body runs with
 * the product resolution answered by a spy on `resolveActiveProductFrom`, so
 * each mode's outcome is pinned, and the authority it mints is shown passing
 * the neighbouring revalidation body unchanged. The bound and root forms are
 * shown reaching their readers with exact arguments.
 *
 * NOT SHOWN HERE: artifact verification itself and the product resolver; the
 * artifact resolver, viewer access and product binding suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { formatArtifactRef } from "../../src/artifacts/ref.js";
import * as resolve from "../../src/artifacts/resolve.js";
import type { VerifiedArtifactRead } from "../../src/artifacts/resolve.js";
import * as binding from "../../src/products/binding/resolve.js";
import type { ProfilePack } from "../../src/profile/types.js";
import type { ActiveProductResolution, ActiveProductSources } from "../../src/products/binding/resolve.js";
import { readViewerArtifact, readViewerArtifactFrom, readViewerArtifactWith } from "../../src/viewer/artifact-access.js";
import { PathSafetyError } from "../../src/viewer/path-safety.js";
import {
  assertCurrentWorkflowProcessAuthorityFrom, resolveWorkflowProcessAuthority, resolveWorkflowProcessAuthorityFrom,
} from "../../src/workflow-history/process-authority.js";
import type { WorkflowRun } from "../../src/workflow-history/types.js";

afterEach(() => { vi.restoreAllMocks(); });

const ARTIFACTS = { report: { fileName: "report.json", contentKind: "json" as const, maxBytes: 1000, metadata: { score: { type: "number" as const, required: true } } } };
const REF = { artifactType: "report", slug: "a", sha256: "a".repeat(64) };
const RAW = formatArtifactRef(REF);
const BODY = '{"score":4,"secret":"hidden"}';

/** Project `raw` over a memory read answering `answer`; the refs it was asked for. */
async function project(answer: VerifiedArtifactRead, isLoopback: boolean, raw = RAW, artifacts: ProfilePack["artifacts"] = ARTIFACTS) {
  const asked: unknown[] = [];
  const projected = await readViewerArtifactWith(async (ref) => { asked.push(ref); return answer; }, artifacts, raw, isLoopback);
  return { projected, asked };
}

describe("the viewer artifact projection over its one verified read", () => {
  it("A1 a verified body yields only declared metadata remotely, and the bytes only on loopback", async () => {
    const remote = await project({ health: "ok", body: BODY }, false);
    expect(remote).toEqual({ asked: [REF], projected: { kind: "artifact", ref: RAW, health: "ok", contentAccess: "loopback-only", fileName: "report.json", metadata: { score: 4 } } });
    expect((await project({ health: "ok", body: BODY }, true)).projected).toEqual({ ...remote.projected, contentAccess: "available", body: BODY });
  });

  it("A2 an unhealthy read keeps its verdict, drops the store fault, and yields neither metadata nor bytes; an undeclared type has no file name", async () => {
    const tampered = await project({ health: "artifact-store-unavailable", storeFault: "genuine-fault" }, true);
    expect(tampered.projected).toEqual({ kind: "artifact", ref: RAW, health: "artifact-store-unavailable", contentAccess: "available", fileName: "report.json" });
    expect((await project({ health: "artifact-dangling" }, true, RAW, {})).projected).toEqual({ kind: "artifact", ref: RAW, health: "artifact-dangling", contentAccess: "available" });
  });

  it("A3 a malformed ref refuses before any read", async () => {
    const asked: unknown[] = [];
    await expect(readViewerArtifactWith(async (ref) => { asked.push(ref); return { health: "ok" }; }, ARTIFACTS, "report/../x", true)).rejects.toBeInstanceOf(PathSafetyError);
    expect(asked).toEqual([]);
  });

  it("A4 the bound form reads through the store's own body; the root form through the incumbent root reader", async () => {
    const store = {} as resolve.ArtifactStoreReads;
    const from = vi.spyOn(resolve, "readVerifiedArtifactFrom").mockResolvedValue({ health: "ok", body: BODY });
    const root = vi.spyOn(resolve, "readVerifiedArtifact").mockResolvedValue({ health: "ok", body: BODY });
    const bound = await readViewerArtifactFrom(store, ARTIFACTS, RAW, false);
    expect(await readViewerArtifact("/project", ARTIFACTS, RAW, false)).toEqual(bound);
    expect([from.mock.calls, root.mock.calls]).toEqual([[[store, { artifacts: ARTIFACTS }, REF]], [["/project", { artifacts: ARTIFACTS }, REF]]]);
  });
});

const DIGEST = (letter: string) => `sha256:${letter.repeat(64)}`;
const BINDING = {
  productId: "paper", runtimeAuthorityDigest: DIGEST("1"), operationsPackDigest: DIGEST("2"), knowledgeProfileDigest: DIGEST("3"),
  compositionLockDigest: DIGEST("4"), processDefinitionDigest: DIGEST("5"),
};
const product = (fields: Record<string, unknown> = {}) => ({ mode: "product", binding: { ...BINDING, ...fields }, loaded: {} }) as unknown as ActiveProductResolution;
const SOURCES = {} as ActiveProductSources;

/** The authority for `workspaceId` (required or not) with the product resolving to `active`, or the refusal reason. */
async function authority(active: ActiveProductResolution, workspaceId?: string, required = false): Promise<unknown> {
  vi.spyOn(binding, "resolveActiveProductFrom").mockResolvedValue(active);
  return resolveWorkflowProcessAuthorityFrom(SOURCES, workspaceId, required).catch((error: { reason?: string }) => `refused ${error.reason ?? "invalid"}`);
}

describe("a new run's process authority over the active product sources", () => {
  it("W1 no process definition is no authority, refused only when required", async () => {
    for (const active of [{ mode: "legacy" }, { mode: "conflict" }, { mode: "unavailable", detail: "x" }, product({ processDefinitionDigest: undefined })] as ActiveProductResolution[]) {
      expect([await authority(active, "alpha"), await authority(active, "alpha", true)]).toEqual([undefined, "refused not-declared"]);
    }
  });

  it("W2 a declared process needs a valid workspace, and its authority passes the revalidation body unchanged", async () => {
    expect([await authority(product()), await authority(product(), "../x")]).toEqual(["refused missing-workspace", "refused invalid"]);
    const minted = await authority(product(), "alpha") as WorkflowRun["processAuthority"];
    expect(minted).toMatchObject({ schemaVersion: 1, productId: "paper", runtimeAuthorityDigest: DIGEST("1"), processDefinitionDigest: DIGEST("5"), workspaceId: "alpha" });
    await expect(assertCurrentWorkflowProcessAuthorityFrom(SOURCES, { processAuthority: minted } as WorkflowRun)).resolves.toBeUndefined();
  });

  it("W3 the root form resolves over the local disk sources for its root", async () => {
    const disk = vi.spyOn(binding, "diskActiveProductSources").mockReturnValue(SOURCES);
    const from = vi.spyOn(binding, "resolveActiveProductFrom").mockResolvedValue({ mode: "legacy" });
    expect(await resolveWorkflowProcessAuthority("/project", "alpha")).toBeUndefined();
    expect([disk.mock.calls, from.mock.calls]).toEqual([[["/project"]], [[SOURCES]]]);
  });
});
