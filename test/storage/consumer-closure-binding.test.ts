/**
 * @file test/storage/consumer-closure-binding.test.ts
 * @description Six whole consumers as root-free bodies over their reads, each
 * against its unchanged root facade:
 *
 * - artifact discovery (`discoverArtifactFrom`);
 * - the workflow artifact manifest (`readLocalWorkflowArtifactManifestFrom`);
 * - the workflow process source (`readLocalWorkflowProcessSourceFrom`);
 * - the live target digest (`readLiveTargetDigestFrom`);
 * - template status (`collectTemplateStatusFrom`);
 * - operation target resolution (`resolveTargetRunFrom`).
 *
 * HOW IT IS BUILT. Each consumer is run over memory reads that log every call,
 * pinning the body's read order, its failure mapping and its outcome. Where a
 * real project is cheap (a bare root, one concept page), the root facade's
 * answer is compared with the body over the existing `From` seams. Each case
 * also shows the root facade reaching its incumbent readers with exact
 * arguments, through pass-through or answering spies.
 *
 * NOT SHOWN HERE: the physical leaves themselves (confinement, no-follow, the
 * live page's capture and re-read, the user's tap state). Those stay local and
 * are covered by the incumbent suites.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
  artifactDiscoveryReadsOver, discoverArtifact, discoverArtifactFrom, type ArtifactDiscoveryReads,
} from "../../src/artifacts/discover.js";
import * as readVerified from "../../src/artifacts/read-verified.js";
import type { ArtifactStoreReads } from "../../src/artifacts/resolve.js";
import * as artifactStore from "../../src/artifacts/store.js";
import * as operationTarget from "../../src/operation-bundles/bundle-target.js";
import { resolveTargetRun, resolveTargetRunFrom, targetRunReadsOver, type TargetRunReads } from "../../src/commands/operation/resolve.js";
import {
  readLocalWorkflowArtifactManifest, readLocalWorkflowArtifactManifestFrom, workflowArtifactManifestReadsOver,
} from "../../src/local-workflow-host/artifact-manifest.js";
import { liveTargetReadsOver, readLiveTargetDigest, readLiveTargetDigestFrom } from "../../src/local-workflow-host/live-target.js";
import {
  readLocalWorkflowProcessSource, readLocalWorkflowProcessSourceFrom, workflowProcessSourceReadsOver, type WorkflowProcessSourceReads,
} from "../../src/local-workflow-host/process-source.js";
import * as profileBlock from "../../src/profile/block.js";
import * as productBinding from "../../src/products/binding/resolve.js";
import type { ActiveProductSources } from "../../src/products/binding/resolve.js";
import type { ActiveBindingReads } from "../../src/products/binding/store.js";
import { MAX_PROCESS_DEFINITION_BYTES } from "../../src/products/constants.js";
import { digestDirectoryName } from "../../src/products/ids.js";
import type { ProductPackageReads } from "../../src/products/packages/store.js";
import * as templateLock from "../../src/profile/templates/lock.js";
import { collectTemplateStatus, collectTemplateStatusFrom, templateStatusReadsOver, type TemplateStatusReads } from "../../src/profile/templates/status.js";
import { resolveTapPaths } from "../../src/profile/templates/taps/paths.js";
import type { ProfilePack } from "../../src/profile/types.js";
import * as journalHealth from "../../src/trust/journal-health.js";
import { WorkflowVerifierError } from "../../src/local-workflow-host/verifier-error.js";
import { buildNamespaceDirs } from "../../src/utils/page-registry.js";
import { WorkflowProcessAuthorityError } from "../../src/workflow-history/process-authority.js";
import { bindingFor, buildActivatableProduct, serializeBinding } from "../products/binding-fixture.js";
import type { BuiltProductPackage } from "../products/product-package-fixture.js";
import { tempRootTracker } from "../temp-roots.js";
import { absentJournalOf, effectiveProfileOf, enoent, unasked, type Copy } from "./copied-project.js";

const roots = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await roots.cleanup(); });
const tempRoot = (): Promise<string> => roots.create("consumer-closure-");
/** A copy holding nothing: the default profile, no lock, no journal. */
const EMPTY: Copy = { files: new Map(), listings: new Map() };
const PROFILE = { artifacts: { report: { fileName: "report.md" } } } as unknown as ProfilePack;
const SHA = `sha256:${"a".repeat(64)}`;
const OK_MANIFEST = { kind: "ok", manifest: { sha256: SHA } } as unknown as artifactStore.ManifestRead;
/** What a failed promise rejected with, as `name: message`. */
const rejection = (pending: Promise<unknown>): Promise<string> => pending.then(() => "resolved", (error: Error) => `${error.name}: ${error.message}`);

/** Discovery reads answering `manifest` and `healthy`, each call logged. */
function discoveryReads(log: string[], manifest: artifactStore.ManifestRead | Error, healthy = true): ArtifactDiscoveryReads {
  return {
    manifest: async (type, slug, fileName) => { log.push(`manifest ${type}/${slug}/${fileName}`); if (manifest instanceof Error) throw manifest; return manifest; },
    verifiedBody: async (_profile, ref) => { log.push(`verified ${ref.sha256}`); return healthy ? { health: "ok", bytes: Buffer.from("x") } : { health: "hash-mismatch" as never }; },
  };
}

describe("artifact discovery and the workflow artifact manifest", () => {
  it("D1 captures the selector first, refuses undeclared types before any read, and maps every read fault to unavailable", async () => {
    const run = async (selector: unknown, manifest: artifactStore.ManifestRead | Error, healthy?: boolean) => {
      const log: string[] = [];
      const outcome = await discoverArtifactFrom(discoveryReads(log, manifest, healthy), PROFILE, selector as never).then((value) => value, (error: Error) => error.name);
      return [outcome, log];
    };
    const sel = { artifactType: "report", slug: "r1" };
    expect(await run({ artifactType: "../x", slug: "r1" }, OK_MANIFEST)).toEqual(["TypeError", []]);
    expect(await run({ artifactType: "other", slug: "r1" }, OK_MANIFEST)).toEqual([{ status: "unavailable" }, []]);
    expect(await run(sel, { kind: "absent" })).toEqual([{ status: "unavailable" }, ["manifest report/r1/report.md"]]);
    expect(await run(sel, new Error("EIO"))).toEqual([{ status: "unavailable" }, ["manifest report/r1/report.md"]]);
    expect(await run(sel, OK_MANIFEST, false)).toEqual([{ status: "unavailable" }, ["manifest report/r1/report.md", `verified ${SHA}`]]);
    expect(await run(sel, OK_MANIFEST)).toEqual([{ status: "found", ref: { ...sel, sha256: SHA } }, ["manifest report/r1/report.md", `verified ${SHA}`]]);
  });

  it("D2 reads the manifest leaf under the store's cap over the resolver seam, and the root facade reaches both incumbents", async () => {
    const asked: string[] = [];
    const store: ArtifactStoreReads = { artifactAt: (type, slug, fileName) => {
      asked.push(`at ${type}/${slug}/${fileName}`);
      return { readManifestText: async (cap) => { asked.push(`cap ${cap}`); return { kind: "ok", body: "{bad" }; },
        readBodyText: unasked("readBodyText"), listEntries: unasked("listEntries"), readMemberBytes: unasked("readMemberBytes") };
    } };
    const manifestSpy = vi.spyOn(artifactStore, "readArtifactManifest").mockResolvedValue(OK_MANIFEST);
    const bodySpy = vi.spyOn(readVerified, "readVerifiedArtifactBody").mockResolvedValue({ health: "ok", bytes: Buffer.from("x") });
    expect(await artifactDiscoveryReadsOver(store).manifest("report", "r1", "report.md")).toEqual({ kind: "malformed" });
    expect([asked, manifestSpy.mock.calls.length, bodySpy.mock.calls.length]).toEqual([["at report/r1/report.md", `cap ${artifactStore.ARTIFACT_MANIFEST_MAX_BYTES}`], 0, 0]);
    expect(await discoverArtifact("/project", PROFILE, { artifactType: "report", slug: "r1" })).toEqual({ status: "found", ref: { artifactType: "report", slug: "r1", sha256: SHA } });
    expect(manifestSpy).toHaveBeenCalledWith("/project", artifactStore.artifactPaths("/project", "report", "r1", "report.md"));
    expect(bodySpy).toHaveBeenCalledWith("/project", PROFILE, { artifactType: "report", slug: "r1", sha256: SHA });
  });

  it("D3 loads the profile first, returns null for the default profile or an undeclared type, and the root facade reaches both incumbents", async () => {
    const log: string[] = [];
    const store: ArtifactStoreReads = { artifactAt: () => { throw new Error("no manifest is read for the default profile"); } };
    expect(await readLocalWorkflowArtifactManifestFrom(workflowArtifactManifestReadsOver(effectiveProfileOf(EMPTY, (call) => log.push(call)), store), "report", "r1")).toBeNull();
    expect(log.length).toBeGreaterThan(0);
    const profileSpy = vi.spyOn(profileBlock, "loadNonDefaultProfile").mockResolvedValue({ profile: PROFILE } as never);
    const manifestSpy = vi.spyOn(artifactStore, "readArtifactManifest").mockResolvedValue({ kind: "absent" });
    expect([await readLocalWorkflowArtifactManifest("/project", "report", "r1"), await readLocalWorkflowArtifactManifest("/project", "other", "r1")]).toEqual([{ kind: "absent" }, null]);
    expect([profileSpy.mock.calls, manifestSpy.mock.calls]).toEqual([[["/project"], ["/project"]], [["/project", artifactStore.artifactPaths("/project", "report", "r1", "report.md")]]]);
    expect(await rejection(readLocalWorkflowArtifactManifest("/project", "report", "../escape"))).toBe(`ArtifactPathError: ${new artifactStore.ArtifactPathError("slug", "../escape").message}`);
  });
});

/** Process-source reads over one resolved package whose declared member has `digest`, each call logged. */
function processReads(log: string[], mode: "product" | "legacy", digest?: string): WorkflowProcessSourceReads {
  const manifest = { processDefinition: digest === undefined ? undefined : { digest } };
  return {
    activeProduct: async () => { log.push("active"); return (mode === "product" ? { mode, binding: { packageDigest: SHA }, manifest } : { mode }) as never; },
    memberText: async (packageDigest, member, maxBytes) => { log.push(`member ${packageDigest} ${member.digest} ${maxBytes}`); return "process text"; },
  };
}

/** One installed, bound product held in memory: the binding's and the package store's own seams, each member read logged. */
function productSourcesOf(product: BuiltProductPackage): { sources: ActiveProductSources; log: string[] } {
  const log: string[] = [];
  const ok = (body: Buffer) => ({ kind: "ok" as const, body });
  const entry = (name: string, isFile: boolean) => ({ name, isFile, isDirectory: !isFile });
  const members = product.manifest.members.map((member) => entry(digestDirectoryName(member.digest), true));
  const binding = {
    readBindingLeaf: async () => ok(Buffer.from(serializeBinding(bindingFor(product.manifest)))),
    privateAliasHasNoEntries: async () => false, resolvePrivateDir: async () => "mem:private", privateEntryKind: async () => { throw enoent(); },
  } as unknown as ActiveBindingReads;
  const packages = {
    readManifestLeaf: async () => ok(Buffer.from(product.manifestText)), checkMemberLeaf: async () => "matches", directoryKind: async () => "directory",
    readCheckedMemberLeaf: async (_hex: string, memberHex: string) => ({ kind: "matches", bytes: product.bytesByHex.get(memberHex)! }),
    listDirectory: async (_hex: string, directory: string) => (directory === "package" ? [entry("manifest.json", true), entry("members", false)] : members),
    readMemberLeaf: async (_hex: string, memberHex: string) => { log.push(`member ${memberHex}`); return ok(product.bytesByHex.get(memberHex)!); },
  } as unknown as ProductPackageReads;
  return { sources: { root: "/display/only", binding, packages }, log };
}

describe("the workflow process source and the live target", () => {
  it("P1 refuses outside product mode and on a stale digest before the member read, and reads only the declared member", async () => {
    const run = async (mode: "product" | "legacy", digest?: string) => {
      const log: string[] = [];
      return [await readLocalWorkflowProcessSourceFrom(processReads(log, mode, digest), "d1").then((value) => value, (error: Error) => error.message), log];
    };
    const [unavailable, stale] = [new WorkflowProcessAuthorityError("unavailable").message, new WorkflowProcessAuthorityError("stale-or-invalid").message];
    expect(await run("legacy", "d1")).toEqual([unavailable, ["active"]]);
    expect(await run("product", "d2")).toEqual([stale, ["active"]]);
    expect(await run("product")).toEqual([stale, ["active"]]);
    expect(await run("product", "d1")).toEqual(["process text", ["active", `member ${SHA} d1 ${MAX_PROCESS_DEFINITION_BYTES}`]]);
    const spy = vi.spyOn(productBinding, "resolveActiveProduct").mockResolvedValue({ mode: "legacy" } as never);
    expect([await rejection(readLocalWorkflowProcessSource("/project", "d1")), spy.mock.calls]).toEqual([`WorkflowProcessAuthorityError: ${unavailable}`, [["/project"]]]);
  });

  it("P2 reads the declared process member over the product binding's and the package store's own seams, and never a stale one", async () => {
    const product = buildActivatableProduct("Demo Product", "process: body\n");
    const declared = product.manifest.processDefinition!;
    const run = async (digest: string) => {
      const { sources, log } = productSourcesOf(product);
      const outcome = await readLocalWorkflowProcessSourceFrom(workflowProcessSourceReadsOver(sources, sources.packages), digest).then((text) => text, (error: Error) => error.message);
      return [outcome, log.includes(`member ${digestDirectoryName(declared.digest)}`)];
    };
    expect(await run(declared.digest)).toEqual(["process: body\n", true]);
    expect(await run(`sha256:${"0".repeat(64)}`)).toEqual([new WorkflowProcessAuthorityError("stale-or-invalid").message, false]);
  });

  it("L1 digests the same live page bytes as the root facade, over the profile's own sources and the two physical leaves", async () => {
    const root = await tempRoot();
    const text = "---\ntitle: Alpha\n---\nAlpha body.\n";
    const conceptsDir = buildNamespaceDirs().get("concepts")!;
    await mkdir(path.join(root, conceptsDir), { recursive: true });
    await writeFile(path.join(root, conceptsDir, "alpha.md"), text);
    const onDisk = await readLiveTargetDigest(root, "concepts/alpha");
    const log: string[] = [];
    const entry = { capturedRealpath: "/memory/wiki/concepts/alpha.md", expectedCanonicalDir: "/memory/wiki/concepts" } as never;
    const reads = (captured: unknown, read: string | null) => liveTargetReadsOver(effectiveProfileOf(EMPTY, () => {}), {
      captureEntry: async (pageId, dirs) => { log.push(`capture ${pageId} ${dirs.get("concepts")}`); return captured as never; },
      readCapturedPage: async (given) => { log.push(`read ${given === entry}`); return read; },
    });
    expect(await readLiveTargetDigestFrom(reads(entry, text), "concepts/alpha")).toEqual(onDisk);
    expect([onDisk.contentDigest, log]).toEqual([`sha256:${createHash("sha256").update(text).digest("hex")}`, [`capture concepts/alpha ${conceptsDir}`, "read true"]]);
    const unavailable = `WorkflowVerifierError: ${new WorkflowVerifierError("live-target-unavailable").message}`;
    expect([await rejection(readLiveTargetDigestFrom(reads(null, text), "concepts/alpha")), await rejection(readLiveTargetDigestFrom(reads(entry, null), "concepts/alpha"))])
      .toEqual([unavailable, unavailable]);
  });
});

/** Template-status reads answering a lock and a journal state, each call logged. */
function statusReads(log: string[], lock: templateLock.TemplateLockRead, journal: "ok" | "pending"): TemplateStatusReads {
  return {
    profile: async () => { log.push("profile"); return { profile: { profileId: "p" }, digest: "d", loadedFrom: null } as never; },
    lock: async () => { log.push("lock"); return lock; },
    journal: async () => { log.push("journal"); return { status: journal }; },
  };
}

describe("template status and operation target resolution", () => {
  it("T1 reads profile, lock and journal in order, gates on the journal, and answers a bare project as the root facade does", async () => {
    const log: string[] = [];
    const pending = await collectTemplateStatusFrom(statusReads(log, { kind: "absent" }, "pending"), resolveTapPaths());
    expect([pending.status, log]).toEqual(["interrupted-write", ["profile", "lock", "journal"]]);
    expect((await collectTemplateStatusFrom(statusReads([], { kind: "absent" }, "ok"), resolveTapPaths())).status).toBe("untracked");
    const root = await tempRoot();
    const lockSpy = vi.spyOn(templateLock, "readTemplateLock"), journalSpy = vi.spyOn(journalHealth, "journalHealth");
    const onDisk = await collectTemplateStatus(root);
    expect(lockSpy).toHaveBeenCalledWith(root);
    expect(journalSpy).toHaveBeenCalledWith(root);
    const bound = templateStatusReadsOver({ profile: effectiveProfileOf(EMPTY, () => {}), lock: { resolvePrivateDir: async () => null, readLockLeaf: unasked("readLockLeaf") }, journal: absentJournalOf(() => {}) });
    expect(await collectTemplateStatusFrom(bound, resolveTapPaths())).toEqual(onDisk);
  });

  it("R1 resolves inventory, then the key, then the run, each refusal its own message, and the root facade reaches the inventory", async () => {
    const manifest = { runId: "opr_1", bundleId: "bnd_1", workspaceId: "w" } as never;
    const resolved = operationTarget.resolvedFromManifest(manifest);
    const reads = (log: string[], key: string | null, run: unknown): TargetRunReads => ({
      inventory: async () => { log.push("inventory"); return { manifests: [manifest] } as never; },
      keyEpoch: async () => { log.push("key"); return key as never; },
      run: async (given, epoch) => { log.push(`run ${given.runId} ${epoch}`); return run as never; },
    });
    const run = async (target: string, key: string | null, read: unknown) => { const log: string[] = []; return [await resolveTargetRunFrom(reads(log, key, read), target), log]; };
    expect(await run("nope", "k", null)).toEqual([{ error: "No operation bundle or run matches \"nope\"." }, ["inventory"]]);
    expect(await run("opr_1", null, null)).toEqual([{ error: "No readable operation key for opr_1." }, ["inventory", "key"]]);
    expect(await run("bnd_1", "k", { status: "absent" })).toEqual([{ error: "Run opr_1 is absent." }, ["inventory", "key", "run opr_1 k"]]);
    expect(await run("opr_1", "k", { status: "ok", run: { state: "applying" } })).toEqual([{ resolved, run: { state: "applying" } }, ["inventory", "key", "run opr_1 k"]]);
    expect(await targetRunReadsOver({ inventory: unasked("inventory") as never, key: { readKeyLeaf: async () => ({ kind: "absent" }) } as never, runs: unasked("runs") as never }).keyEpoch()).toBeNull();
    const root = await tempRoot();
    const spy = vi.spyOn(operationTarget, "loadOperationInventory");
    expect([await resolveTargetRun(root, "nope"), spy.mock.calls]).toEqual([{ error: "No operation bundle or run matches \"nope\"." }, [[root]]]);
  });
});
