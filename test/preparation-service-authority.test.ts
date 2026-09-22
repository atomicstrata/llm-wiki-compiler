/**
 * @file test/preparation-service-authority.test.ts
 * @description The service's own authority discipline, tested at the seam where
 * a HOST constructs it rather than through a facade.
 *
 * `createPreparationService` is NOT a public export — `src/index.ts` deliberately
 * withholds it, and the built `dist/index.d.ts` confirms that, so no npm consumer
 * can reach the constructor. (An earlier version of this header claimed the
 * opposite and used it as the rationale; the tests were right and the reason was
 * wrong.) The real reason to test here is that this is the seam a SECOND HOST
 * will construct — the MCP adapter, a status projection, any in-repo surface —
 * and each one supplies its own resolver. A control that only tests the SDK
 * facade tests the menu one host happens to offer, not the door every host
 * opens.
 *
 * Three doors, each with its own test:
 *
 *  - the FORGED SURFACE. `effectivePreparationGrants` unions the whole
 *    local-operator grant set into any `cli` principal, so a resolver claiming
 *    `surface: "cli"` on an `sdk` service would promote itself to the local
 *    operator in one field. The service's fixed surface must equal the captured
 *    principal's, and that is the comparison this pins.
 *  - the FORGED REQUEST. Request DTOs carry no actor, surface or grant, so
 *    presenting one must change nothing — asserted by passing them anyway.
 *  - the UNSAFE PRINCIPAL RECORD. Capture is fail-closed by construction
 *    (`capturePreparationPrincipal`), and the service must route through it
 *    rather than reading the resolver's object directly.
 */

import { describe, expect, it } from "vitest";
import { createPreparationService } from "../src/preparations/service.js";
import type {
  ListResultV1, PreparationPrincipal, PreparationServiceV1, PreparationSurface, StageRequestV1,
} from "../src/preparations/service.js";
import { emptyWorkspace, runStateOf } from "./preparation-cli-fixture.js";
import { stageableProject } from "./preparation-sdk-fixture.js";

/** A project with one `planned` run, and a service over it on a chosen surface. */
async function serviceOver(
  suffix: string, surface: PreparationSurface, principal: PreparationPrincipal,
): Promise<{ cwd: string; binding: { workspaceId: string; runId: string }; service: PreparationServiceV1 }> {
  const cwd = await emptyWorkspace(suffix);
  const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
  const { binding } = await stagePreparation(cwd);
  const service = createPreparationService({
    root: cwd, surface, principals: { principalFor: () => principal },
  });
  return { cwd, binding, service };
}

/** A stage request whose documents the service will accept. */
async function stageRequest(): Promise<StageRequestV1> {
  const { stageDocuments } = await import("./preparation-sdk-fixture.js");
  const { planDocument, seedDocument } = await stageDocuments();
  return {
    documents: {
      plan: () => Promise.resolve({ ok: true, text: planDocument }),
      seed: () => Promise.resolve({ ok: true, text: seedDocument }),
    },
    controlTransitionAllowance: 16,
  };
}

/** Read a project's runs through a second, grant-free service. */
async function listPreparationsIn(cwd: string): Promise<ListResultV1> {
  return createPreparationService({
    root: cwd, surface: "sdk",
    principals: { principalFor: () => ({ id: "reader", surface: "sdk", grants: [] }) },
  }).list();
}

/** Drive one run terminal through the service and assert it durably moved. */
async function expectFailed(
  service: PreparationServiceV1, cwd: string, binding: { workspaceId: string; runId: string },
): Promise<void> {
  expect(await service.fail({ runId: binding.runId }))
    .toEqual({ status: "failed", runId: binding.runId });
  expect(await runStateOf(cwd, binding)).toBe("failed");
}

describe("the service compares its fixed surface against the captured principal", () => {
  it("REFUSES a resolver claiming `cli` on an `sdk` service", async () => {
    // The principal carries NO explicit grants, so if the claimed `cli` surface
    // were believed it would still hold `preparation.run` — by transport. That
    // is what makes this a promotion rather than merely a mislabel.
    const { cwd, binding, service } = await serviceOver("forgedsurface", "sdk", {
      id: "impostor", surface: "cli", grants: [],
    });
    await expect(service.fail({ runId: binding.runId })).rejects.toMatchObject({
      name: "PrincipalAuthorityError", code: "invalid-principal",
    });
    expect(await runStateOf(cwd, binding)).toBe("planned");
  });

  it("ACCEPTS the same principal on the service whose surface it names", async () => {
    // The other direction, so the refusal above is about the MISMATCH and not
    // about `cli` principals being rejected everywhere.
    const { cwd, binding, service } = await serviceOver("matchedsurface", "cli", {
      id: "cli-operator", surface: "cli", grants: [],
    });
    await expectFailed(service, cwd, binding);
  });

  it("fails closed on a surface the transport vocabulary does not contain", async () => {
    const cwd = await emptyWorkspace("unknownsurface");
    expect(() => createPreparationService({
      root: cwd,
      surface: "totally-trusted" as unknown as PreparationSurface,
      principals: { principalFor: () => ({ id: "x", surface: "sdk", grants: [] }) },
    })).toThrow(/invalid-principal/u);
  });
});

describe("authority never travels in a request", () => {
  it("ignores grants, a surface and an actor forged into the request DTO", async () => {
    // The DTOs have no such fields, so this is what a JavaScript caller can
    // actually do: pass them anyway and see whether anything reads them.
    const { cwd, binding, service } = await serviceOver("forgedrequest", "sdk", {
      id: "sdk-test", surface: "sdk", grants: [],
    });
    const forged = {
      runId: binding.runId,
      grants: ["preparation.run"], surface: "cli", actor: { id: "cli-operator", surface: "cli" },
    };
    await expect(service.fail(forged as never)).rejects.toMatchObject({ code: "missing-grant" });
    expect(await runStateOf(cwd, binding)).toBe("planned");
  });
});

describe("the principal is captured BEFORE the first await", () => {
  it("does not see a grant added after the call began", async () => {
    // D-10-9, and until this test existed it had ZERO coverage: moving the
    // authority charge behind a single `await Promise.resolve()` left the whole
    // 7,532-test suite green. The service's own header calls this "the exact
    // defect class Task 9 hit four times", so an unfalsifiable version of it was
    // the worst possible state for the claim to be in.
    //
    // The resolver hands back a principal holding a LIVE reference to `grants`.
    // The escalation lands synchronously after the call returns — which is after
    // the async function's synchronous prologue and before any microtask. If the
    // capture happens in that prologue it copies an empty set and refuses; if it
    // is deferred by even one tick, the push wins.
    const cwd = await emptyWorkspace("captureprologue");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);
    const grants: string[] = [];
    const service = createPreparationService({
      root: cwd, surface: "sdk",
      principals: {
        principalFor: () => ({ id: "sdk-test", surface: "sdk", grants } as PreparationPrincipal),
      },
    });

    const pending = service.fail({ runId: binding.runId });
    grants.push("preparation.run");

    await expect(pending).rejects.toMatchObject({ code: "missing-grant" });
    expect(await runStateOf(cwd, binding)).toBe("planned");
  });

  it("does not see a grant added after a STAGE call began", async () => {
    // THE SIBLING. The `fail` version of this test above left the `stage` leg
    // unfalsifiable: deferring `authorize("stage")` behind one `await` survived
    // the entire suite, because the only escalation probe in the repo was on the
    // fail path. Each operation body is its own call site for `authorize(...)`,
    // so each needs its own probe — the shared checks inside `authorize` do not
    // cover WHERE it is invoked.
    const cwd = await stageableProject("captureprologuestage");
    const grants: string[] = [];
    const service = createPreparationService({
      root: cwd, surface: "sdk",
      principals: {
        principalFor: () => ({ id: "sdk-test", surface: "sdk", grants } as PreparationPrincipal),
      },
    });

    const pending = service.stage(await stageRequest());
    grants.push("preparation.run");

    await expect(pending).rejects.toMatchObject({ code: "missing-grant" });
    // And nothing was staged, observed through a second reader.
    expect((await listPreparationsIn(cwd)).runs).toEqual([]);
  });

  it("STAGES when that same grant is present from the start", async () => {
    // The positive direction for the stage leg, so its refusal is about WHEN the
    // grant arrived rather than about the request being rejected outright.
    const cwd = await stageableProject("captureprologuestageok");
    const service = createPreparationService({
      root: cwd, surface: "sdk",
      principals: {
        principalFor: () => ({
          id: "sdk-test", surface: "sdk", grants: ["preparation.run"],
        } as PreparationPrincipal),
      },
    });
    expect((await service.stage(await stageRequest())).status).toBe("staged");
  });

  it("charges the same escalated grant when it is present from the start", async () => {
    // The other direction, so the refusal above is about WHEN the grant arrived
    // and not about the resolver shape being rejected outright.
    const grants: string[] = ["preparation.run"];
    const { cwd, binding, service } = await serviceOver("captureprologueok", "sdk", {
      id: "sdk-test", surface: "sdk", grants,
    } as PreparationPrincipal);
    await expectFailed(service, cwd, binding);
  });
});

describe("the principal record is captured, not read", () => {
  it("REFUSES a principal whose fields are accessors rather than data", async () => {
    // `capturePreparationPrincipal` rejects getters, proxies and non-plain
    // prototypes before any authority decision. Routing through it is the whole
    // reason a resolver's return value cannot re-answer mid-operation.
    const cwd = await emptyWorkspace("accessorprincipal");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);
    const service = createPreparationService({
      root: cwd, surface: "sdk",
      principals: {
        principalFor: () => Object.defineProperties({}, {
          id: { get: () => "sdk-test", enumerable: true },
          surface: { get: () => "sdk", enumerable: true },
          grants: { get: () => ["preparation.run"], enumerable: true },
        }) as PreparationPrincipal,
      },
    });
    await expect(service.fail({ runId: binding.runId })).rejects.toMatchObject({
      code: "invalid-principal",
    });
    expect(await runStateOf(cwd, binding)).toBe("planned");
  });
});
