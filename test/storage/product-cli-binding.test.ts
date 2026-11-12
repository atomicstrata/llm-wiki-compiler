/**
 * @file test/storage/product-cli-binding.test.ts
 * @description The `product init` and `product status` controllers as ONE body
 * each over their project steps (`productInitCommandWith`,
 * `productStatusCommandWith`), with no project. This file uses the bodies, which
 * exist only after the controllers were given their steps, so it has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Memory steps answer install, activation, resolution and the
 * scaffold, and the contract, the skip record, the provider paths and the review,
 * and log each call; the JSON envelope is captured from stdout. Every decision is
 * pinned with the steps it reached: the installed digest activated under the CLI
 * principal, the changed-identity refusal before any scaffold, the scaffold set
 * from the re-resolved profile, the contract refusal, the skip decisions, and the
 * zero-dimension short cut that never resolves provider paths. The compositions
 * are shown reaching the resolution, contract and skip bodies, and each root form
 * the incumbents with its root.
 *
 * NOT SHOWN HERE: install, activation, scaffolding, the contract and the review
 * themselves; their suites and `product-command-reporting.test.ts` show those.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as paths from "../../src/capability-providers/packages/paths.js";
import { CLI_ACTIVATION_PRINCIPAL } from "../../src/commands/product/host.js";
import { productInitCommand, productInitCommandWith, productInitStepsOver, type ProductInitSteps } from "../../src/commands/product/init.js";
import { productStatusCommand, productStatusCommandWith, productStatusStepsOver, type ProductStatusSteps } from "../../src/commands/product/status.js";
import * as actionResolve from "../../src/products/action-resolve.js";
import * as activate from "../../src/products/binding/activate.js";
import * as bindingResolve from "../../src/products/binding/resolve.js";
import * as install from "../../src/products/packages/install.js";
import * as readiness from "../../src/products/readiness.js";
import * as skips from "../../src/products/readiness-skips.js";
import * as scaffold from "../../src/utils/confined-scaffold.js";

const DIGEST = `sha256:${"a".repeat(64)}` as never;
const OTHER = `sha256:${"b".repeat(64)}` as never;
const PROFILE = { entities: { papers: { directory: "wiki/papers" }, notes: { directory: "wiki/notes" } } };

let stdout: string[];
beforeEach(() => {
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });

/** The one JSON envelope written to stdout. */
const envelope = () => JSON.parse(stdout.join(""));

/** Memory init steps whose re-resolve finds `activeDigest` active; each call logged. */
function initSteps(log: string[], activeDigest: string = DIGEST): ProductInitSteps {
  return {
    install: async (sourceDir) => { log.push(`install ${sourceDir}`); return { packageDigest: DIGEST } as never; },
    activate: async (digest, principal) => {
      log.push(`activate ${digest === DIGEST} ${principal === CLI_ACTIVATION_PRINCIPAL}`);
      return { status: "activated", productId: "p", productVersion: "1.0.0", packageDigest: DIGEST } as never;
    },
    resolveActive: async () => { log.push("resolve"); return { mode: "product", binding: { packageDigest: activeDigest }, loaded: { profile: PROFILE } } as never; },
    scaffold: async (relDirs) => { log.push(`scaffold ${[...relDirs].join(",")}`); return { created: [...relDirs], existing: [] }; },
  };
}

describe("product init over its steps", () => {
  it("N1 activates the installed digest under the CLI principal, re-resolves, then scaffolds that profile's entity directories", async () => {
    const log: string[] = [];
    expect(await productInitCommandWith(initSteps(log), "/pkg", { json: true })).toBe(0);
    expect([log, envelope()]).toEqual([["install /pkg", "activate true true", "resolve", "scaffold wiki/papers,wiki/notes"], {
      status: "initialized", productId: "p", productVersion: "1.0.0", packageDigest: DIGEST, scaffold: { created: ["wiki/papers", "wiki/notes"], existing: [] },
    }]);
  });

  it("N2 refuses when another product became active after activation, before any scaffold", async () => {
    const log: string[] = [];
    expect(await productInitCommandWith(initSteps(log, OTHER), "/pkg", { json: true })).toBe(1);
    expect([log, envelope()]).toEqual([["install /pkg", "activate true true", "resolve"], {
      status: "refused", reason: `active product changed during init (activated ${DIGEST}, now ${OTHER})`,
    }]);
  });
});

const DIMENSIONS = [{ dimensionId: "model-ready" }];

/** Memory status steps declaring `dimensions`; `record` answers both skip leaves. Each call logged. */
function statusSteps(log: string[], dimensions: object[] = DIMENSIONS, record: Set<string> | null = new Set()): ProductStatusSteps {
  return {
    resolveContract: async () => {
      log.push("contract");
      return { status: "ok", packId: "pack", contract: { productReadinessDimensions: dimensions }, providerRequirements: ["req"] } as never;
    },
    readSkips: async () => { log.push("skips"); return record; },
    recordSkip: async (id, skipped) => { log.push(`record ${id} ${skipped}`); return record; },
    providerPaths: async () => { log.push("paths"); return { tag: "paths" } as never; },
    review: async (given, dims, skipped, reqs) => {
      log.push(`review ${(given as never as { tag: string }).tag} ${dims.length} ${skipped === record} ${reqs?.length}`);
      return { items: [], declaresNoOptionalCapabilities: false };
    },
  };
}

describe("product status over its steps", () => {
  it("S1 refuses an unresolved contract before the skip record; a product with no dimensions never resolves provider paths", async () => {
    const log: string[] = [];
    const refused = { ...statusSteps(log), resolveContract: async () => { log.push("contract"); return { status: "refused", reason: "no product" } as never; } };
    expect(await productStatusCommandWith(refused, { json: true })).toBe(1);
    expect(await productStatusCommandWith(statusSteps(log, []), { json: true })).toBe(0);
    expect(log).toEqual(["contract", "contract", "skips"]);
  });

  it("S2 refuses a skip of an undeclared capability or over an unreadable record; records a declared skip or unskip", async () => {
    const log: string[] = [];
    expect(await productStatusCommandWith(statusSteps(log), { skip: "nope", json: true })).toBe(1);
    expect(await productStatusCommandWith(statusSteps(log, DIMENSIONS, null), { skip: "model-ready", json: true })).toBe(1);
    expect(await productStatusCommandWith(statusSteps(log), { unskip: "model-ready", json: true })).toBe(0);
    expect(log).toEqual(["contract", "contract", "record model-ready true", "contract", "record model-ready false", "paths", "review paths 1 true 1"]);
  });

  it("S3 reviews declared dimensions with the provider paths, the recorded skips and the requirements", async () => {
    const log: string[] = [];
    expect(await productStatusCommandWith(statusSteps(log), { json: true })).toBe(0);
    expect([log, envelope()]).toEqual([["contract", "skips", "paths", "review paths 1 true 1"], { status: "reviewed", packId: "pack", items: [], declaresNoOptionalCapabilities: false }]);
  });
});

describe("the compositions and the root forms", () => {
  it("B1 the compositions reach the resolution, contract and skip-record bodies over their seams", async () => {
    const resolved = vi.spyOn(bindingResolve, "resolveActiveProductFrom").mockResolvedValue({ mode: "legacy" });
    const contract = vi.spyOn(actionResolve, "resolveActiveWorkspaceContractWith").mockResolvedValue(await statusSteps([]).resolveContract());
    const read = vi.spyOn(skips, "readRecordedSkipsFrom").mockResolvedValue(new Set());
    const memory = statusSteps([]);
    await productInitCommandWith(productInitStepsOver({ tag: "active" } as never, initSteps([])), "/pkg", { json: true });
    await productStatusCommandWith(productStatusStepsOver({ action: { tag: "action" }, skips: { tag: "skips" } } as never, memory), { json: true });
    expect([resolved.mock.calls, contract.mock.calls, read.mock.calls]).toEqual([[[{ tag: "active" }]], [[{ tag: "action" }]], [[{ tag: "skips" }]]]);
  });

  it("B2 each root form reaches the incumbents with its root", async () => {
    const installed = vi.spyOn(install, "installLocalProductPackage").mockResolvedValue({ packageDigest: DIGEST } as never);
    const activated = vi.spyOn(activate, "activateProductLocked").mockResolvedValue({ productId: "p", productVersion: "1", packageDigest: DIGEST } as never);
    vi.spyOn(bindingResolve, "resolveActiveProduct").mockResolvedValue({ mode: "product", binding: { packageDigest: DIGEST }, loaded: { profile: PROFILE } } as never);
    const scaffolded = vi.spyOn(scaffold, "scaffoldConfinedDirectories").mockResolvedValue({ created: [], existing: [] });
    vi.spyOn(actionResolve, "resolveActiveWorkspaceContract").mockResolvedValue(await statusSteps([]).resolveContract());
    const read = vi.spyOn(skips, "readRecordedSkips").mockResolvedValue(new Set());
    vi.spyOn(paths, "resolveAuthorizedProviderPaths").mockResolvedValue({} as never);
    const review = vi.spyOn(readiness, "reviewProductReadiness").mockResolvedValue({ items: [], declaresNoOptionalCapabilities: false } as never);
    expect([await productInitCommand("/project", "/pkg", { json: true }), await productStatusCommand("/project", { json: true })]).toEqual([0, 0]);
    expect([installed.mock.calls, activated.mock.calls[0]?.slice(0, 2), scaffolded.mock.calls[0]?.[0], read.mock.calls, review.mock.calls[0]?.[4]]).toEqual([
      [["/project", "/pkg"]], ["/project", DIGEST], "/project", [["/project"]], "/project",
    ]);
  });
});
