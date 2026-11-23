/**
 * @file test/portable/disk-identity-durability.test.ts
 * @description Bounded store/authority regressions of the CP192 identity/marker
 * repair. The three format-2 adoption cases live in
 * `disk-identity-adoption.test.ts` (CP195 split; identities unchanged).
 *
 * What they pin, on a real `DiskProjectStore` over a fresh redirected-temp
 * fixture (`disk-identity-fixture.ts`; never default host or operator state):
 *
 * - format 2 keeps the open-operation marker and the in-progress identity as
 *   the same record, removes the marker once the identity is terminal, and
 *   removes a stale marker beside a terminal identity;
 * - a missing identity is restored from its marker only when the marker holds
 *   no custody, refused when it does, and restored when a valid receipt or
 *   closure settles a custody-bearing operation;
 * - the replacing writer's exact `<safeId>.json.<16 hex>.tmp` sibling is
 *   skipped, untouched, by the open-marker view and by the format-1 identity
 *   scan (including a maximum-length safe id), while any other unknown regular
 *   or nonregular entry still refuses by name in the open-marker view;
 * - an identity write that throws stops `runOperation` before resolve or
 *   publish (an in-memory store; no filesystem mock, no new seam).
 *
 * These are AFTER-STATE and ordering-of-calls assertions. They do NOT prove
 * the order of writes on disk or physical power-loss durability.
 *
 * No case takes the project mutation lock or
 * launches a child process: the store methods used here never enter the
 * store's gate, and the in-memory store supplies its own. The static import
 * closure is still wider than these cases (`disk-store.ts` imports the lock
 * gate, which reaches `js-yaml` and the lock owner's `ps` code without calling
 * them here); it is bound separately and is not admitted until Root releases
 * it. No model is invoked and no listener is opened.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { runOperation } from "../../src/portable/authority/authority.js";
import type { OperationIdentityRecordV1, PrincipalContext, ReceiptV1 } from "../../src/portable/contracts.js";
import type { HostControl } from "../../src/portable/host/control.js";
import { allocateOperationId } from "../../src/portable/host/operation-ids.js";
import { ledgerDir } from "../../src/portable/store/disk-layout.js";
import { DiskProjectStore } from "../../src/portable/store/disk-store.js";
import type { ProjectStore } from "../../src/portable/store/store.js";
import { useIdentityFixture } from "./disk-identity-fixture.js";

const PROJECT = "prj_0a";
const NONCE = "0123456789abcdef";
/** The longest safe record id. */
const MAX_ID = `a${"b".repeat(200)}`;

const fixture = useIdentityFixture();

/** An identity record of this fixture project. */
function identity(operationId: string, changes: Partial<OperationIdentityRecordV1> = {}): OperationIdentityRecordV1 {
  return {
    tenant: "local", project: PROJECT, actor: "local:fixture", hostIncarnation: "inc", kind: "source.add", operationId,
    intentDigest: `sha256:${"0".repeat(64)}`, outcome: "in-progress", refusal: null, detail: null,
    holds: { approvalId: null, ticketId: null }, generationLease: null, resolution: null, supersedes: null, ...changes,
  };
}

/** A format-2 store over the fixture, with its open-marker directory established as adoption would. */
async function format2Store(): Promise<DiskProjectStore> {
  await fixture.ledger("open");
  return DiskProjectStore.open(PROJECT, fixture.root, { registration: async () => "format-2" });
}

/** The parsed JSON of one ledger file, or `null` when it is absent. */
async function record(kind: "open" | "identity", operationId: string): Promise<unknown> {
  return readFile(path.join(fixture.root, ledgerDir(kind), `${operationId}.json`), "utf8").then(JSON.parse, () => null);
}

describe("format 2: marker and identity stay in step", () => {
  it("keeps the in-progress marker and identity as the same record", async () => {
    const store = await format2Store();
    await store.putIdentity(identity("op_a"));
    expect(await record("open", "op_a")).toEqual(identity("op_a"));
    expect(await record("identity", "op_a")).toEqual(identity("op_a"));
    expect(await store.listOpenOperations()).toEqual(["op_a"]);
  });

  it("removes the marker once the identity is terminal", async () => {
    const store = await format2Store();
    await store.putIdentity(identity("op_a"));
    await store.putIdentity(identity("op_a", { outcome: "refused", refusal: "permission_denied" }));
    expect(await record("open", "op_a")).toBeNull();
    expect(await record("identity", "op_a")).toEqual(identity("op_a", { outcome: "refused", refusal: "permission_denied" }));
  });

  it("removes a stale marker left beside a terminal identity", async () => {
    const store = await format2Store();
    await store.putIdentity(identity("op_a"));
    await writeFile(path.join(fixture.root, ledgerDir("identity"), "op_a.json"), JSON.stringify(identity("op_a", { outcome: "committed" })));
    expect(await store.listOpenOperations()).toEqual([]);
    expect(await record("open", "op_a")).toBeNull();
  });
});

describe("format 2: restoring a missing identity from its marker", () => {
  it("restores it when the marker holds no custody", async () => {
    const store = await format2Store();
    await store.putIdentity(identity("op_a"));
    await rm(path.join(fixture.root, ledgerDir("identity"), "op_a.json"));
    expect(await store.listOpenOperations()).toEqual(["op_a"]);
    expect(await record("identity", "op_a")).toEqual(identity("op_a"));
  });

  it("refuses when the marker holds custody", async () => {
    const store = await format2Store();
    await store.putIdentity(identity("op_a", { holds: { approvalId: "apr_x", ticketId: null } }));
    await rm(path.join(fixture.root, ledgerDir("identity"), "op_a.json"));
    await expect(store.listOpenOperations()).rejects.toThrow("holds custody");
  });

  it.each(["receipts", "closed"] as const)("restores a held identity when a valid %s record decides it", async (kind) => {
    const store = await format2Store();
    const held = identity("op_a", { holds: { approvalId: "apr_x", ticketId: null } });
    await store.putIdentity(held);
    await rm(path.join(fixture.root, ledgerDir("identity"), "op_a.json"));
    const receipt: ReceiptV1 = {
      project: PROJECT, revision: null, operationId: "op_a", kind: "source.add", intentDigest: held.intentDigest,
      resolvedPlanDigest: held.intentDigest, actor: held.actor, onBehalfOf: [], policyFence: { policyRevision: 1, ticketRevision: 1 },
      published: [], skipped: [], consumedApprovalId: "apr_x", consumedTicketId: null, committedAt: "2026-01-01T00:00:00.000Z",
    };
    // The shape closeIntent writes (operationId, outcome, detail); getClosure itself validates no field.
    const closure = { operationId: "op_a", outcome: "refused", detail: "rolled_back" };
    const dir = path.join(fixture.root, ledgerDir(kind));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "op_a.json"), JSON.stringify(kind === "receipts" ? receipt : closure));
    expect(await store.listOpenOperations()).toEqual(["op_a"]);
    expect(await record("identity", "op_a")).toEqual(held);
    expect(await record("open", "op_a")).toEqual(held);
  });

  it("keeps refusing a held identity when the only receipt belongs to another project", async () => {
    const store = await format2Store();
    await store.putIdentity(identity("op_a", { holds: { approvalId: "apr_x", ticketId: null } }));
    await rm(path.join(fixture.root, ledgerDir("identity"), "op_a.json"));
    const dir = path.join(fixture.root, ledgerDir("receipts"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "op_a.json"), JSON.stringify({ project: "prj_other", operationId: "op_a" }));
    await expect(store.listOpenOperations()).rejects.toThrow("holds custody");
    expect(await record("identity", "op_a")).toBeNull();
  });
});

describe("replacing-write temp siblings are skipped, untouched; anything else refuses by name", () => {
  it("skips the open-marker temp sibling", async () => {
    const store = await format2Store();
    await store.putIdentity(identity("op_a"));
    await writeFile(path.join(await fixture.ledger("open"), `op_a.json.${NONCE}.tmp`), "partial");
    expect(await store.listOpenOperations()).toEqual(["op_a"]);
    expect(await readdir(await fixture.ledger("open"))).toContain(`op_a.json.${NONCE}.tmp`);
  });

  it("refuses an unknown regular file or a directory in the open-marker view", async () => {
    const store = await format2Store();
    await writeFile(path.join(await fixture.ledger("open"), "notes.txt"), "x");
    await expect(store.listOpenOperations()).rejects.toThrow("notes.txt");
    await rm(path.join(await fixture.ledger("open"), "notes.txt"));
    await mkdir(path.join(await fixture.ledger("open"), "op_d.json"));
    await expect(store.listOpenOperations()).rejects.toThrow("op_d.json");
  });

  it("format 1 skips the temp of a maximum-length safe id and keeps its scan otherwise", async () => {
    const store = await DiskProjectStore.open(PROJECT, fixture.root);
    await store.putIdentity(identity("op_b"));
    await writeFile(path.join(await fixture.ledger("identity"), `${MAX_ID}.json.${NONCE}.tmp`), "partial");
    expect(await store.listOpenOperations()).toEqual(["op_b"]);
    expect(await readdir(await fixture.ledger("identity"))).toContain(`${MAX_ID}.json.${NONCE}.tmp`);
  });
});

describe("authority ordering over a failing identity write", () => {
  it("stops before resolve or publish when the in-progress identity cannot be written", async () => {
    const calls = { resolve: 0, publish: 0 };
    const control = { incarnation: "inc", secret: Buffer.from("fixture-secret"), loadProject: async () => null } as unknown as HostControl;
    const principal: PrincipalContext = { tenant: "local", project: PROJECT, subject: "local:fixture", actor: "local:fixture", observedPolicyRevision: 1, sessionId: "s" };
    const store = {
      withGate: <T>(fn: () => Promise<T>) => fn(), recover: async () => [], unresolvedIntents: async () => [], listOpenOperations: async () => [],
      getIdentity: async () => null, putIdentity: async () => { throw new Error("identity sync failed"); },
      publish: async () => { calls.publish += 1; },
    } as unknown as ProjectStore;
    const request = { operationId: allocateOperationId(control, principal), kind: "source.add" as const, intentDigest: `sha256:${"0".repeat(64)}` as const, supersedes: null, requires: ["source.write" as const] };
    const run = runOperation({ control, store }, principal, request, async () => { calls.resolve += 1; throw new Error("resolve must not run"); });
    await expect(run).rejects.toThrow("identity sync failed");
    expect(calls).toEqual({ resolve: 0, publish: 0 });
  });
});
