/**
 * @file test/dev-backend/dev-grant.test.ts
 * @description The development grant helper, verified through the PLATFORM'S
 * own `resolveEffectiveProviderGrant` rather than by inspecting what it wrote.
 *
 * RESOLVING IS THE ONLY EVIDENCE THAT MATTERS. The grant store will accept any
 * well-formed record; what decides whether a provider can actually run is
 * whether the resolver re-derives the same pin and request digests and agrees.
 * So each case asks the resolver, and the drift cases perturb exactly one bound
 * field to show the binding is real rather than incidental.
 *
 * WHAT THE LAST CASE DOES AND DOES NOT MEASURE, stated because it was measured
 * rather than assumed: it pins the end-to-end intersection — a pack asking for
 * more wall time than the operator allowed gets the OPERATOR'S ceiling — and
 * that is a property of the platform's `minimumBounds` which this request merely
 * participates in. Rebuilding the request with the pack's scope as the host
 * floor and provider maximum leaves all four cases green, so this file does NOT
 * discriminate that choice. The digest derivation IS discriminated: deriving the
 * confirmation from any other scope reddens every case here.
 */

import { afterEach, describe, expect, it } from "vitest";
import { resolveEffectiveProviderGrant } from "../../src/capability-providers/authority/grants-resolve.js";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installDevProvider } from "../../src/capability-providers/host/install.js";
import {
  DEV_PROVIDER_BOUNDS, devEffectiveGrantRequest, devGrantScope, issueDevProviderGrant,
} from "../../src/capability-providers/host/grant.js";
import {
  devInstallMaterial, installResolutionFixture, removeResolutionFixture, type ResolutionFixture,
} from "../capability-providers/resolution-fixture.js";

let fixture: ResolutionFixture | undefined;
afterEach(async () => {
  if (fixture) await removeResolutionFixture(fixture);
  fixture = undefined;
});

/** A real project directory: the grant binds to its canonical path. */
async function projectDir(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "dev-grant-project-")));
}

/** Install a provider, grant it, and return everything the resolver needs. */
async function granted(grantId = "dev-grant-1") {
  fixture = await installResolutionFixture();
  const { sourceRoot, payload } = await devInstallMaterial(fixture, "dev-provider", "1.3.0");
  const installed = await installDevProvider(fixture.paths, {
    sourceRoot, payload, approveExecution: true,
  });
  const projectRoot = await projectDir();
  const issued = await issueDevProviderGrant(fixture.paths, {
    pin: installed.pin, projectRoot, grantId,
  });
  return { fixture, installed, issued, projectRoot };
}

/** The effective-grant request for one issued grant, with optional overrides. */
function requestFor(
  issued: Awaited<ReturnType<typeof granted>>["issued"],
  installed: Awaited<ReturnType<typeof granted>>["installed"],
  overrides: Record<string, unknown> = {},
) {
  return {
    ...devEffectiveGrantRequest(issued, {
      pin: installed.pin, workspaceId: "ws-1",
      preparationRunId: "prr_1", surface: "sdk",
      // The project the RUN is in. Here it matches the grant; the drift case
      // below supplies a different one, which is what the resolver refuses.
      projectRealpathDigest: issued.projectRealpathDigest,
      safetyFloorVersion: "1.0.0",
    }),
    ...overrides,
  };
}

describe("a development provider grant resolves", () => {
  it("resolves an effective grant for the provider it was issued for", async () => {
    const { fixture: f, installed, issued } = await granted();
    const effective = await resolveEffectiveProviderGrant(f.paths, requestFor(issued, installed));
    expect(effective.bounds.wallTimeMs).toBe(DEV_PROVIDER_BOUNDS.wallTimeMs);
  });

  it("REFUSES a grant spent in a different project", async () => {
    // The grant binds one project; another project's digest must not spend it.
    const { fixture: f, installed, issued } = await granted();
    const elsewhere = requestFor(issued, installed, {
      projectRealpathDigest: (await issueDevProviderGrant(f.paths, {
        pin: installed.pin, projectRoot: await projectDir(), grantId: "other-project",
      })).projectRealpathDigest,
    });
    await expect(resolveEffectiveProviderGrant(f.paths, elsewhere)).rejects.toThrow();
  });

  it("REFUSES a request naming a grant that was never issued", async () => {
    const { fixture: f, installed, issued } = await granted();
    await expect(resolveEffectiveProviderGrant(
      f.paths, requestFor(issued, installed, { operatorGrantId: "no-such-grant" }),
    )).rejects.toThrow();
  });

  it("caps the pack's request at the OPERATOR's ceiling, not the request's", async () => {
    // End-to-end: the operator's ceiling wins over a greedier pack request.
    // (Measured: this stays green if the request's own floor/maximum are the
    // pack's scope, because the operator grant caps it either way.)
    const { fixture: f, installed, issued } = await granted();
    const greedy = devGrantScope([], { ...DEV_PROVIDER_BOUNDS, wallTimeMs: 999_999 });
    const effective = await resolveEffectiveProviderGrant(f.paths, requestFor(issued, installed, {
      operationsPackRequest: greedy,
    }));
    expect(effective.bounds.wallTimeMs).toBe(DEV_PROVIDER_BOUNDS.wallTimeMs);
  });

  it("RE-ISSUING the same grant is a no-op, so a provider module can run twice", async () => {
    // A provider module runs on EVERY invocation. Issuing unconditionally used
    // to work once and then fail with "provider grant already exists", which
    // reads as corruption rather than as the second run it actually is.
    const { fixture: f, installed, issued, projectRoot } = await granted();
    const again = await issueDevProviderGrant(f.paths, {
      pin: installed.pin, projectRoot, grantId: issued.grantId,
    });
    expect(again.grantRequestDigest).toBe(issued.grantRequestDigest);
    const effective = await resolveEffectiveProviderGrant(f.paths, requestFor(again, installed));
    expect(effective.bounds.wallTimeMs).toBe(DEV_PROVIDER_BOUNDS.wallTimeMs);
  });

  it("REFUSES to reuse one grant id for a different project", async () => {
    // The complement that keeps the no-op honest: same id, different binding is
    // a genuine conflict, not a repeat.
    const { fixture: f, installed, issued } = await granted();
    await expect(issueDevProviderGrant(f.paths, {
      pin: installed.pin, projectRoot: await projectDir(), grantId: issued.grantId,
    })).rejects.toThrow(/different provider or project/);
  });

  it("survives CONCURRENT identical issuance, with no loser left failing", async () => {
    // A read-then-write version passes the sequential re-issue case and still
    // races: both callers observe absence, one writes, the other fails. Only
    // concurrency shows the difference, so the control has to be concurrent.
    // A FRESH id: if the grant already exists every caller returns early and
    // nothing races, which is exactly how the first version of this case passed
    // against the read-then-write code it was written to catch.
    const { fixture: f, installed, projectRoot } = await granted();
    const settled = await Promise.allSettled(Array.from({ length: 4 }, () =>
      issueDevProviderGrant(f.paths, {
        pin: installed.pin, projectRoot, grantId: "never-issued-before",
      })));
    const rejected = settled.filter((entry) => entry.status === "rejected");
    expect(rejected.map((entry) => String((entry as PromiseRejectedResult).reason))).toEqual([]);
  });
});
