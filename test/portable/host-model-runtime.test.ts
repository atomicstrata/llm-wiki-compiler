/**
 * @file test/portable/host-model-runtime.test.ts
 * @description Focused PURE regression tests of the local host's model seam
 * (`requireHostModel`, CP185): a configured model must fail CLOSED before its
 * override can answer any model call.
 *
 * The shared provider lookup answers a scope whose override has no provider
 * with the provider built from the environment. So an untyped caller's
 * malformed factory result (no provider, a provider missing a method, a blank
 * provider name or model id) must be refused here, by name, instead of
 * reaching an environment-backed provider or stamping an identity nobody
 * configured. A valid override is returned unchanged: same object, same
 * identity, methods inherited from a prototype accepted, the optional
 * `embedBatch` accepted when callable.
 *
 * STATUS: UNRUN when written (CP185). Every provider here is an in-memory fake
 * whose methods count calls and throw if invoked; no provider module, real
 * SDK, compiler, proposal path, network, listener, subprocess or environment
 * is used. Provider shapes are derived from the runtime module's own types.
 */

import { describe, expect, it } from "bun:test";
import { PortableHostError } from "../../src/portable/errors.js";
import { requireHostModel, type HostModel, type ProjectRuntime } from "../../src/portable/project/runtime.js";

/** The override a host model returns, and its provider, as the runtime module types them. */
type Override = ReturnType<HostModel>;
type Provider = Override["provider"];

/** Calls made to any fake provider method: validation must never make one. */
const invoked: string[] = [];

/** A method that records and refuses any call. */
function forbidden(name: string): () => never {
  return () => {
    invoked.push(name);
    throw new Error(`provider method ${name} must not be called during validation`);
  };
}

/** A complete in-memory provider whose methods are own properties. */
function fakeProvider(extra: Record<string, unknown> = {}): Provider {
  return { complete: forbidden("complete"), stream: forbidden("stream"), toolCall: forbidden("toolCall"), embed: forbidden("embed"), ...extra } as Provider;
}

/** A complete override with a fake provider. */
function override(extra: Partial<Record<keyof Override, unknown>> = {}): Override {
  return { provider: fakeProvider(), providerName: "fixture", modelId: "fixture-model-1", ...extra } as Override;
}

/** A runtime carrying only `model`: requireHostModel reads nothing else. */
function runtimeWith(model: unknown): ProjectRuntime {
  return { control: null, store: null, principal: null, model } as unknown as ProjectRuntime;
}

/** The model a runtime would run under, given the factory's result. */
function requireResult(result: unknown): Override {
  return requireHostModel(runtimeWith(() => result));
}

describe("host model seam: no callable model", () => {
  it("refuses a null model by name", () => {
    expect(() => requireHostModel(runtimeWith(null))).toThrow(PortableHostError);
    expect(() => requireHostModel(runtimeWith(null))).toThrow("no model is configured");
  });

  it("refuses an undefined or non-callable model", () => {
    for (const model of [undefined, {}, "anthropic", 7, [() => override()]]) {
      expect(() => requireHostModel(runtimeWith(model))).toThrow(PortableHostError);
    }
  });
});

describe("host model seam: malformed factory result", () => {
  it("refuses a result that is not an override object", () => {
    for (const result of [null, undefined, [], "override", 1, true]) {
      expect(() => requireResult(result)).toThrow("returned no provider override");
    }
  });

  it("refuses a missing, null, array or function provider", () => {
    for (const provider of [undefined, null, [], () => "text"]) {
      expect(() => requireResult(override({ provider }))).toThrow("missing a required method");
    }
  });

  it("refuses a provider missing any one required method, or with it not callable", () => {
    for (const name of ["complete", "stream", "toolCall", "embed"]) {
      expect(() => requireResult(override({ provider: fakeProvider({ [name]: undefined }) }))).toThrow(PortableHostError);
      expect(() => requireResult(override({ provider: fakeProvider({ [name]: "not a function" }) }))).toThrow(PortableHostError);
    }
  });

  it("refuses an embedBatch that is supplied but not callable", () => {
    for (const embedBatch of [null, "batch", {}]) {
      expect(() => requireResult(override({ provider: fakeProvider({ embedBatch }) }))).toThrow("missing a required method");
    }
  });

  it("refuses a missing, blank or non-string provider name or model id", () => {
    for (const bad of [undefined, null, "", "   ", "\n\t", 42]) {
      expect(() => requireResult(override({ providerName: bad }))).toThrow("must be non-blank");
      expect(() => requireResult(override({ modelId: bad }))).toThrow("must be non-blank");
    }
  });
});

/** A provider whose methods live on its class prototype, not on the instance. */
class PrototypeProvider {
  complete(): never { return forbidden("complete")(); }
  stream(): never { return forbidden("stream")(); }
  toolCall(): never { return forbidden("toolCall")(); }
  embed(): never { return forbidden("embed")(); }
}

describe("host model seam: valid override", () => {
  it("returns the exact override object, identity unchanged and not normalized", () => {
    const valid = override({ providerName: " fixture ", modelId: "Fixture-Model-1 " });
    const returned = requireResult(valid);
    expect(returned).toBe(valid);
    expect([returned.providerName, returned.modelId]).toEqual([" fixture ", "Fixture-Model-1 "]);
  });

  it("accepts methods inherited from a prototype", () => {
    const valid = override({ provider: new PrototypeProvider() });
    expect(requireResult(valid)).toBe(valid);
  });

  it("accepts a callable embedBatch", () => {
    const valid = override({ provider: fakeProvider({ embedBatch: forbidden("embedBatch") }) });
    expect(requireResult(valid)).toBe(valid);
  });
});

describe("host model seam: factory calls and provider calls", () => {
  it("calls the factory exactly once per request", () => {
    let calls = 0;
    const valid = override();
    requireHostModel(runtimeWith(() => { calls += 1; return valid; }));
    expect(calls).toBe(1);
  });

  it("propagates the factory's own error unchanged, after one call", () => {
    let calls = 0;
    const failure = new Error("model configuration unavailable");
    let caught: unknown = null;
    try {
      requireHostModel(runtimeWith(() => { calls += 1; throw failure; }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(calls).toBe(1);
  });

  it("never invokes a provider method, whether the override is accepted or refused", () => {
    invoked.length = 0;
    requireResult(override());
    requireResult(override({ provider: new PrototypeProvider() }));
    expect(() => requireResult(override({ modelId: "" }))).toThrow(PortableHostError);
    expect(invoked).toEqual([]);
  });
});
