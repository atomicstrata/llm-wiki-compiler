/**
 * @file test/storage/profile-viewer-legacy.test.ts
 * @description The effective profile, the active-product readers and the
 * viewer's typed pages through their ROOT functions, on real files with nothing
 * mocked. It states behaviours that a full reading of the existing tests found
 * unpinned, so that moving these reads behind consumer-owned sources cannot
 * change them. It is run byte for byte against the source both before and after.
 *
 * What the cases pin:
 *  - the SINGLE-LINK rule on three leaves no existing test hard-links: the
 *    binding leaf, the package manifest leaf, and a member read directly (the
 *    member CHECK is already pinned by `product-package-store.test.ts`);
 *  - a `profile.json` that is a DIRECTORY beside a binding is a conflict (a file
 *    and a dangling link are pinned elsewhere);
 *  - a private directory that is a confined alias with no binding is plain
 *    legacy mode: the binding is absent, the default profile loads, and a
 *    profile behind the alias loads with its LOGICAL path;
 *  - the viewer snapshot of a typed project whose relation store is a link, or
 *    whose graph directory is a link, still builds, with its typed pages and no
 *    relation edge (status, lint and export are pinned elsewhere; the viewer is
 *    not). The link's target HOLDS one relation the profile accepts, the same
 *    bytes D9 reads as one edge from a plain leaf, so "no edge" means the link
 *    was refused and not that there was nothing to read;
 *  - the root-named `collectTypedViewerInputs` itself, which had no direct disk
 *    test: the built-in default answers `undefined`; a typed project answers
 *    its declared types, its pages and its relation edges; a linked relation
 *    store that holds a relation answers no edges. After the snapshot was composed from sources this
 *    root form has no production caller left; these cases keep its behaviour
 *    stated. They are compatibility coverage, not evidence of production reach;
 *  - a caller's MISTAKE, which the types forbid and nothing else pinned: a root
 *    that is not a string REJECTS from each of the six root-named readers here
 *    and never throws at the call, and a malformed package digest is classified
 *    before the root is looked at, so it answers `unavailable: digest` even then.
 *
 * A hard link is made by giving the leaf a second name, which is enough for the
 * single-link rule to refuse it.
 */

import { link, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { loadNonDefaultProfile } from "../../src/profile/block.js";
import { loadProfile } from "../../src/profile/load.js";
import { ActiveProductUnavailableError, ProductBindingError } from "../../src/products/binding/problems.js";
import { readStoredMemberText } from "../../src/products/binding/manifest-authority.js";
import { resolveActiveProduct } from "../../src/products/binding/resolve.js";
import { recordChecksum } from "../../src/relations/store-record.js";
import type { RelationRef } from "../../src/relations/types.js";
import { activeProductBindingPath, readActiveProductBinding, writeActiveProductBinding } from "../../src/products/binding/store.js";
import { MAX_KNOWLEDGE_PROFILE_BYTES } from "../../src/products/constants.js";
import { digestDirectoryName } from "../../src/products/ids.js";
import { readInstalledProductPackage } from "../../src/products/packages/store.js";
import { productStorePaths } from "../../src/products/paths.js";
import { LLMWIKI_DIR, PROFILE_FILE, RELATIONS_FILE, WIKI_GRAPH_DIR } from "../../src/utils/constants.js";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { collectTypedViewerInputs } from "../../src/viewer/typed-pages.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { bindingFor, buildProfileOnlyProduct, commitBuilt } from "../products/binding-fixture.js";

const root = useTempRoot();
const at = (relative: string): string => path.join(root.dir, relative);
/** Give `leaf` a second name inside the project, so it is no longer single-link. */
const secondName = (leaf: string): Promise<void> => link(leaf, at(`second-name-${path.basename(leaf)}`));

/** Install and bind the profile-only product; answers what the cases need to find its leaves. */
async function bound() {
  const product = buildProfileOnlyProduct();
  await commitBuilt(root.dir, product);
  await writeActiveProductBinding(root.dir, bindingFor(product.manifest));
  const hex = digestDirectoryName(product.manifest.packageDigest);
  return { manifest: product.manifest, hex, paths: productStorePaths(root.dir) };
}

describe("the single-link rule on three leaves, as it behaves today", () => {
  it("D1 refuses a hard-linked binding leaf as unsafe, and never falls back to legacy", async () => {
    await bound();
    await secondName(activeProductBindingPath(root.dir));
    expect(await readActiveProductBinding(root.dir)).toEqual({ kind: "malformed", detail: "unsafe-leaf" });
    expect(await resolveActiveProduct(root.dir)).toEqual({ mode: "unavailable", detail: "unsafe-leaf" });
    await expect(loadProfile(root.dir)).rejects.toBeInstanceOf(ActiveProductUnavailableError);
  });

  it("D2 refuses a hard-linked manifest leaf", async () => {
    const { manifest, hex, paths } = await bound();
    await secondName(paths.manifestFile(hex));
    expect(await readInstalledProductPackage(root.dir, manifest.packageDigest)).toEqual({ status: "unavailable", detail: "manifest-leaf" });
  });

  it("D3 reads a member's text directly, and refuses the same member once it is hard-linked", async () => {
    const { manifest, hex, paths } = await bound();
    const member = manifest.knowledgeProfile;
    const read = (): Promise<string> => readStoredMemberText(root.dir, manifest.packageDigest, member, MAX_KNOWLEDGE_PROFILE_BYTES);
    expect(JSON.parse(await read()).profileId).toBe("custom");
    await secondName(paths.memberFile(hex, digestDirectoryName(member.digest)));
    await expect(read()).rejects.toThrow(new ProductBindingError(`${member.kind} member is unavailable`));
  });
});

describe("profile presence and the confined alias, as they behave today", () => {
  it("D4 treats a directory named profile.json beside a binding as a conflict", async () => {
    await bound();
    await mkdir(at(PROFILE_FILE));
    expect(await resolveActiveProduct(root.dir)).toEqual({ mode: "conflict" });
  });

  it("D5 reads a confined alias with no binding as legacy mode, and loads a profile behind it with its logical path", async () => {
    await mkdir(at("private-store"));
    await symlink(at("private-store"), at(LLMWIKI_DIR), "dir");
    expect(await readActiveProductBinding(root.dir)).toEqual({ kind: "absent" });
    expect((await loadProfile(root.dir)).loadedFrom).toBeNull();
    const profile = { schemaVersion: 1, profileId: "behind-alias", displayName: "Alias", entities: { notes: { directory: "wiki/notes" } } };
    await writeFile(at("private-store/profile.json"), JSON.stringify(profile));
    const loaded = await loadProfile(root.dir);
    expect([loaded.profile.profileId, loaded.loadedFrom]).toEqual(["behind-alias", at(PROFILE_FILE)]);
  });
});

describe("the viewer's typed pages with an unreadable relation store, as they behave today", () => {
  const LAB = {
    schemaVersion: 1, profileId: "lab", displayName: "Lab",
    entities: { experiments: { directory: "wiki/experiments" }, ideas: { directory: "wiki/ideas" } },
    relations: { tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } },
  };
  const HEADER = `${JSON.stringify({ kind: "relation-store-header", schemaVersion: 1 })}\n`;
  const RELATION = { id: "rel_one", type: "tests", from: "experiments/a", to: "ideas/b", attributes: {}, contentHash: "c" } as unknown as RelationRef;
  /** A store holding one relation the LAB profile accepts. D9 reads exactly these bytes from a plain leaf as one edge. */
  const STORE_WITH_ONE_RELATION = `${HEADER}${JSON.stringify({ ...RELATION, checksum: recordChecksum(RELATION) })}\n`;

  /** A typed project with one page in each declared directory, and that store kept outside the graph directory. */
  async function typedProject(): Promise<void> {
    for (const dir of [LLMWIKI_DIR, "wiki/experiments", "wiki/ideas", "elsewhere"]) await mkdir(at(dir), { recursive: true });
    await writeFile(at(PROFILE_FILE), JSON.stringify(LAB));
    await writeFile(at("wiki/experiments/a.md"), "---\ntitle: A\n---\nRun.\n");
    await writeFile(at("wiki/ideas/b.md"), "---\ntitle: B\n---\nThink.\n");
    await writeFile(at("elsewhere/relations.jsonl"), STORE_WITH_ONE_RELATION);
  }

  /** The typed project with its store leaf a link to the store that holds the relation. */
  async function linkedStoreLeaf(): Promise<void> {
    await typedProject();
    await mkdir(at(WIKI_GRAPH_DIR), { recursive: true });
    await symlink(at("elsewhere/relations.jsonl"), at(RELATIONS_FILE));
  }

  /** What the snapshot says about typed pages and relation edges. */
  async function typedView() {
    const built = await buildViewerSnapshot(root.dir);
    const typedNodes = built.graph.nodes.filter((node) => node.nodeKind === "entity").map((node) => node.id).sort();
    return { entityTypes: built.entityTypes, typedNodes, relationEdges: built.graph.edges.filter((edge) => edge.edgeKind === "relation") };
  }

  const EXPECTED = { entityTypes: ["experiments", "ideas"], typedNodes: ["experiments/a", "ideas/b"], relationEdges: [] };
  /** What the root-named typed reader answers, reduced to literals. */
  const typedInputs = async () => {
    const typed = await collectTypedViewerInputs(root.dir);
    return typed === undefined ? undefined : { entityTypes: typed.entityTypes, pages: typed.pages.map((page) => page.id), relations: typed.graph.relations };
  };

  it("D6 builds the snapshot with typed pages and no relation edge when the store leaf is a link", async () => {
    await linkedStoreLeaf();
    expect(await typedView()).toEqual(EXPECTED);
  });

  it("D7 builds the same snapshot when the graph directory itself is a link", async () => {
    await typedProject();
    await rename(at("elsewhere"), at("graph-target"));
    await symlink(at("graph-target"), at(WIKI_GRAPH_DIR), "dir");
    expect(await typedView()).toEqual(EXPECTED);
  });

  it("D8 answers undefined from the root-named typed reader for a project on the built-in default profile", async () => {
    expect(await typedInputs()).toBeUndefined();
  });

  it("D9 answers a typed project's declared types, pages and relation edges from the root-named typed reader", async () => {
    await typedProject();
    await mkdir(at(WIKI_GRAPH_DIR), { recursive: true });
    await writeFile(at(RELATIONS_FILE), STORE_WITH_ONE_RELATION);
    expect(await typedInputs()).toEqual({
      entityTypes: ["experiments", "ideas"], pages: ["experiments/a", "ideas/b"],
      relations: [{ type: "tests", from: "experiments/a", to: "ideas/b", direction: "directed" }],
    });
  });

  it("D10 answers no relation edge from the root-named typed reader when the store leaf is a link to a store that holds one", async () => {
    await linkedStoreLeaf();
    expect(await typedInputs()).toEqual({ entityTypes: ["experiments", "ideas"], pages: ["experiments/a", "ideas/b"], relations: [] });
  });
});

describe("a caller's mistake with the root, as the root-named readers answer it today", () => {
  const NOT_A_ROOT = 42 as unknown as string;
  const DIGEST = `sha256:${"a".repeat(64)}` as never;
  const MEMBER = { kind: "knowledge-profile", digest: DIGEST, byteCount: 1 } as never;

  /** How one call ends: thrown at the call, resolved, or rejected with which error code. */
  function ending(call: () => Promise<unknown>): Promise<string> {
    try {
      return call().then(() => "resolved", (error: { code?: string }) => `rejected ${error.code}`);
    } catch {
      return Promise.resolve("threw at the call");
    }
  }

  it("D11 classifies a malformed package digest before it looks at the root", async () => {
    expect(await readInstalledProductPackage(NOT_A_ROOT, "not-a-digest" as never)).toEqual({ status: "unavailable", detail: "digest" });
  });

  it("D12 rejects, and never throws at the call, when the root is not a string", async () => {
    const endings = await Promise.all([
      ending(() => loadProfile(NOT_A_ROOT)),
      ending(() => loadNonDefaultProfile(NOT_A_ROOT)),
      ending(() => resolveActiveProduct(NOT_A_ROOT)),
      ending(() => readInstalledProductPackage(NOT_A_ROOT, DIGEST)),
      ending(() => readStoredMemberText(NOT_A_ROOT, DIGEST, MEMBER, MAX_KNOWLEDGE_PROFILE_BYTES)),
      ending(() => collectTypedViewerInputs(NOT_A_ROOT)),
    ]);
    expect(endings).toEqual(Array.from({ length: 6 }, () => "rejected ERR_INVALID_ARG_TYPE"));
  });
});
