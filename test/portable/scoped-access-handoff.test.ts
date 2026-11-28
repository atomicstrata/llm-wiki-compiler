/**
 * @file test/portable/scoped-access-handoff.test.ts
 * @description What the scoped compile access still guarantees after its
 * write-only handoff log was removed: every protected input it hands to the
 * compile is recorded as a dependency with its bound labels, and every handoff,
 * including a cached one, is re-authorized against CURRENT authority.
 *
 * It drives the real {@link ScopedCompileAccess} (and so the real
 * BoundedScopedAccess authorization and recording) over the smallest in-memory
 * {@link ReadView}: a pinned view and a separate current head whose label
 * bindings a test can change. Authority is the real `reauthorize` callback the
 * host passes. Nothing is mocked inside the access; no disk, provider or model.
 *
 * Covered: an exact read (dependency, bound labels, consumed labels); present
 * and absent existence facts from bare citations (no bytes read); a cached
 * exact read refused once authority is withdrawn; a cached existence fact
 * refused after a clearance downgrade; a cached absent fact refused once
 * authority is withdrawn; and a same-byte relabel on the current head stopping
 * the next handoff.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import type { ContentDigest, LabelSet } from "../../src/portable/contracts.js";
import { SCOPED_HOST_CEILINGS, type CompileScopeV2 } from "../../src/portable/scoped/contracts.js";
import { ScopedCompileAccess } from "../../src/portable/scoped/scoped-access.js";
import type { ScopedCounters } from "../../src/portable/scoped/store-types.js";
import { PersistentMap } from "../../src/portable/store/persistent-map.js";
import type { ReadView } from "../../src/portable/store/store.js";

/** One stored object and the labels its bytes are bound to. */
interface StoredObject { bytes: Uint8Array; digest: ContentDigest; labels: LabelSet }

/** The host authority the access asks: current clearances, or `null` once the caller is no longer authorized. */
interface Authority { clearances: LabelSet | null }

const TEAM = ["team"], OPS = ["ops"];
const PAGE = "wiki/ns/page.md";

/** A stored object holding `text`, bound to `labels`. */
function stored(text: string, labels: LabelSet): StoredObject {
  const bytes = new TextEncoder().encode(text);
  return { bytes, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, labels };
}

/** The smallest ReadView over `objects`: reads, observations, listings and exact label bindings. */
function memoryView(objects: Map<string, StoredObject>): ReadView {
  return {
    read: async (path) => objects.get(path)?.bytes ?? null,
    observe: async (path) => {
      const object = objects.get(path);
      return object === undefined ? null : { bytes: object.bytes, digest: object.digest, revision: "r1" };
    },
    list: async (prefix) => [...objects.keys()].filter((path) => path.startsWith(prefix)).sort(),
    labelsFor: async (path, digest) => (objects.get(path)?.digest === digest ? objects.get(path)?.labels ?? null : null),
    getReceipt: async () => null,
  };
}

/** Zeroed scoped work counters. */
function zeroCounters(): ScopedCounters {
  return { objectsObserved: 0, bytesObserved: 0, titleEntriesEnumerated: 0, fencesCompared: 0, postingsInserted: 0,
    maxBufferBytes: 0, retainedBytes: 0, coldObjectsRead: 0, coldBytesRead: 0 };
}

/** A scope over `names` in namespace `ns`, with no context, at the host ceilings. */
function scopeOf(names: string[]): CompileScopeV2 {
  return { sources: { kind: "source-names", names }, namespace: { kind: "concept-namespace", name: "ns" }, context: null,
    bounds: { ...SCOPED_HOST_CEILINGS } };
}

/** A project with `a.md` (team) and `b.md` (ops); `gone.md` is named but absent. The current head starts as the pin. */
async function fixture() {
  const pinned = new Map([["sources/a.md", stored("alpha\n", TEAM)], ["sources/b.md", stored("bravo\n", OPS)]]);
  const current = new Map(pinned);
  const authority: Authority = { clearances: ["ops", "team"] };
  const names = ["a.md", "b.md", "gone.md"];
  const access = await ScopedCompileAccess.create({
    pin: { view: memoryView(pinned), namespaces: PersistentMap.empty(), sourceNamespaces: PersistentMap.empty(), labelEpoch: "e1", context: null },
    scope: scopeOf(names), allowedSources: names, clearances: ["ops", "team"],
    reauthorize: async () => authority.clearances, current: memoryView(current), counters: zeroCounters(),
  });
  return { access, authority, current, digestOf: (path: string) => pinned.get(path)?.digest };
}

/** Run the citation check over a page citing `files` bare: existence only, never a body read. */
function cite(access: ScopedCompileAccess, files: string[]) {
  return access.checkBrokenCitations(files.map((file) => `Claim ^[${file}].`).join("\n"), PAGE);
}

/** The refusal code a rejected handoff carried. */
async function refusalOf(pending: Promise<unknown>): Promise<string> {
  return pending.then(() => "accepted", (error: { code?: string }) => error.code ?? String(error));
}

describe("dependency facts the scoped access records", () => {
  it("records an exact read with its bound labels and joins them to the consumed labels", async () => {
    const { access, digestOf } = await fixture();
    expect(await access.readSource("a.md")).toBe("alpha\n");
    expect(access.recordedForms()).toContainEqual({ form: "exact", path: "sources/a.md", digest: digestOf("sources/a.md"), labels: TEAM });
    expect(access.consumedLabels()).toEqual(TEAM);
  });

  it("records present and absent existence facts from bare citations without reading bytes", async () => {
    const { access } = await fixture();
    await cite(access, ["b.md", "gone.md"]);
    const forms = access.recordedForms();
    expect(forms).toContainEqual({ form: "existence", path: "sources/b.md", exists: true, labels: OPS });
    expect(forms).toContainEqual({ form: "existence", path: "sources/gone.md", exists: false, labels: null });
    expect(access.recordedObjects()).toEqual([]);
    expect(access.consumedLabels()).toEqual(OPS);
  });
});

describe("every handoff, cached or not, is re-authorized against current authority", () => {
  it("refuses a cached exact read once the caller is no longer authorized", async () => {
    const { access, authority } = await fixture();
    await access.readSource("a.md");
    authority.clearances = null;
    expect(await refusalOf(access.readSource("a.md"))).toBe("permission_denied");
  });

  it("refuses a cached present existence fact after the clearance covering it is withdrawn", async () => {
    const { access, authority } = await fixture();
    await cite(access, ["b.md"]);
    authority.clearances = TEAM;
    expect(await refusalOf(cite(access, ["b.md"]))).toBe("permission_denied");
  });

  it("checks current authority even for a cached absent existence fact", async () => {
    const { access, authority } = await fixture();
    await cite(access, ["gone.md"]);
    authority.clearances = null;
    expect(await refusalOf(cite(access, ["gone.md"]))).toBe("permission_denied");
  });

  it("stops the next handoff when the current head binds the same bytes to an uncleared label", async () => {
    const { access, current } = await fixture();
    await access.readSource("a.md");
    const read = current.get("sources/a.md") as StoredObject;
    current.set("sources/a.md", { ...read, labels: ["secret", "team"] });
    expect(await refusalOf(access.readSource("a.md"))).toBe("permission_denied");
  });
});
