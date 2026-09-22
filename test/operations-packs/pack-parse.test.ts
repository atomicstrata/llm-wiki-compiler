/**
 * @file test/operations-packs/pack-parse.test.ts
 * @description The operations-pack loader accepts a full valid single-root pack
 * and preserves the full spec shapes (design sections 10, 14, 15, 19): the
 * execution union (both the preparation and configuration arms), all thirteen
 * closed input kinds, fractional `number` bounds, per-surface caps, the FULL
 * recipe grammar (input/output/bounds contracts and closed context/render/intent
 * phase bodies), an agent alias with its transport surface, and empty deferred
 * collections.
 */

import { describe, expect, it } from "vitest";
import { parseOperationsPack } from "../../src/operations-packs/parse.js";
import { allInputKinds, buildPack, serialize } from "./pack-fixture.js";

const text = serialize(buildPack());

describe("operations pack parse", () => {
  it("accepts a full valid single-root pack", () => {
    const pack = parseOperationsPack(text);
    expect(pack.schemaVersion).toBe(2);
    expect(pack.packId).toBe("com.example.demo");
    expect(Object.keys(pack.actions)).toEqual(["demo.run"]);
    expect(Object.keys(pack.recipes)).toEqual(["demo.prepare"]);
    expect(pack.aliases?.[0]?.token).toBe("run");
  });

  it("preserves the full execution union and input kinds", () => {
    const action = parseOperationsPack(text).actions["demo.run"]!;
    expect(action.execution.kind).toBe("preparation");
    expect(action.inputSchema.topic?.kind).toBe("string");
    expect(action.inputSchema.model?.kind).toBe("provider-role");
    expect(action.requestedSurfaceCaps.cli).toBe("staged-write");
  });

  it("preserves recipe atomicity, phase kind, and provider fallback", () => {
    const pack = parseOperationsPack(text);
    expect(pack.recipes["demo.prepare"]?.atomicityClass).toBe("local-bundle-only");
    expect(pack.recipes["demo.prepare"]?.phases[0]?.kind).toBe("context");
    expect(pack.providerRequirements[0]?.fallbackPolicy.kind).toBe("explicit-ordered");
  });

  it("accepts an agent alias that declares its transport surface", () => {
    const withAgent = JSON.parse(text);
    withAgent.aliases.push({ aliasId: "chat-agent", surface: "agent", transportSurface: "cli", token: "chat", actionId: "demo.run" });
    const pack = parseOperationsPack(JSON.stringify(withAgent));
    expect(pack.aliases?.find((alias) => alias.aliasId === "chat-agent")?.transportSurface).toBe("cli");
  });

  it("accepts empty deferred collections", () => {
    const withEmpties = JSON.parse(text);
    withEmpties.settingSchema = {};
    withEmpties.contextRecipes = {};
    withEmpties.experienceResources = [];
    expect(() => parseOperationsPack(JSON.stringify(withEmpties))).not.toThrow();
  });

  it("parses the pack-declared render templates through the closed node grammar", () => {
    const template = parseOperationsPack(text).renderTemplates?.["render.wiki-page"];
    expect(template?.templateId).toBe("render.wiki-page");
    expect(template?.nodes[0]).toEqual({ kind: "literal", text: "# " });
    expect(template?.nodes[1]).toEqual({ kind: "field", field: "topic", escaping: "none" });
  });

  it("refuses a render template node of an unregistered kind", () => {
    const tampered = JSON.parse(text);
    tampered.renderTemplates["render.wiki-page"].nodes.push({ kind: "include", path: "/etc/passwd" });
    expect(() => parseOperationsPack(JSON.stringify(tampered))).toThrow(/not a registered render node kind/);
  });

  it("refuses render-template grammar breaches: C1 control, byte ceiling, node cap, depth cap, extra key", () => {
    const breach = (mutate: (template: Record<string, unknown>) => void, pattern: RegExp) => {
      const tampered = JSON.parse(text);
      mutate(tampered.renderTemplates["render.wiki-page"]);
      expect(() => parseOperationsPack(JSON.stringify(tampered))).toThrow(pattern);
    };
    breach((t) => { (t.nodes as unknown[]).push({ kind: "literal", text: "bad\u0085text" }); }, /bounded literal without control characters/);
    breach((t) => { (t.nodes as unknown[]).push({ kind: "literal", text: "x".repeat(8_193) }); }, /bounded literal without control characters/);
    breach((t) => { t.nodes = Array.from({ length: 513 }, () => ({ kind: "literal", text: "a" })); }, /item cap/);
    breach((t) => {
      // Two branches of 300 nested literals: every ARRAY is under its cap, so
      // only the cross-nesting node BUDGET can refuse the 602-node total.
      const branch = () => ({ kind: "each", body: Array.from({ length: 300 }, () => ({ kind: "literal", text: "a" })) });
      t.nodes = [branch(), branch()];
    }, /node cap/);
    breach((t) => {
      let body: unknown[] = [{ kind: "literal", text: "a" }];
      for (let depth = 0; depth < 9; depth += 1) body = [{ kind: "each", body }];
      t.nodes = body;
    }, /nesting depth cap/);
    breach((t) => { (t.nodes as unknown[]).push({ kind: "literal", text: "a", extra: 1 }); }, /unknown/i);
  });

  it("refuses a render body naming an unregistered escaping policy", () => {
    // The body-level policy id is pinned to the handler's registered set; a pack
    // declaring a policy the handler does not implement must refuse, never
    // silently receive per-node escaping instead.
    const tampered = JSON.parse(text);
    tampered.recipes["demo.prepare"].phases[1].body.escapingPolicyId = "strict-html";
    expect(() => parseOperationsPack(JSON.stringify(tampered))).toThrow(/not a registered escaping policy/);
  });

  it("parses the group-list intent form and refuses its breaches closed", () => {
    // Groups parse with whenPresent; an unknown group key, an empty group list,
    // and a control-carrying or oversized string constant each refuse.
    const grouped = JSON.parse(text);
    const body = grouped.recipes["demo.prepare"].phases.find((p: { kind: string }) => p.kind === "intent").body;
    body.intents = [{
      mutationKind: "relation-upsert", targetProfileClass: "cites-link", whenPresent: "cites",
      fieldMappings: [{ targetField: "relation-type", source: "constant", value: "cites" }],
    }];
    delete body.mutationKind; delete body.targetProfileClass; delete body.fieldMappings;
    const parsed = parseOperationsPack(JSON.stringify(grouped));
    const intent = parsed.recipes["demo.prepare"]!.phases.find((p) => p.kind === "intent")!;
    expect(intent.kind === "intent" && intent.body.intents[0]).toEqual({
      mutationKind: "relation-upsert", targetProfileClass: "cites-link", whenPresent: "cites",
      fieldMappings: [{ targetField: "relation-type", source: "constant", value: "cites" }],
    });

    const breach = (mutate: (b: Record<string, unknown>) => void, message: RegExp) => {
      const copy = JSON.parse(JSON.stringify(grouped));
      mutate(copy.recipes["demo.prepare"].phases.find((p: { kind: string }) => p.kind === "intent").body);
      expect(() => parseOperationsPack(JSON.stringify(copy))).toThrow(message);
    };
    breach((b) => { (b.intents as Record<string, unknown>[])[0]!.surprise = 1; }, /unknown|unexpected/i);
    breach((b) => { b.intents = []; }, /at least one group/);
    // listFields is CLOSED to where it has semantics: a non-page group's hint,
    // and one naming the reserved body field, must refuse rather than be
    // silently ignored by the page formatter they never reach.
    breach((b) => { (b.intents as Record<string, unknown>[])[0]!.listFields = ["from"]; }, /only meaningful on artifact-upsert/);
    breach((b) => {
      b.intents = [{
        mutationKind: "artifact-upsert", targetProfileClass: "wiki-page", listFields: ["content"],
        fieldMappings: [{ targetField: "content", source: "phase-input", ref: "topic" }],
      }];
    }, /reserved page body field/);
    // The THIRTEENTH group breaches the closed 12-group cap (raised from 8 for
    // the §4.4 topology: five page classes plus four relation types) — the cap
    // itself, not a shape rule, must be what refuses (every group is well-formed).
    breach((b) => {
      b.intents = Array.from({ length: 13 }, (_, index) => ({
        mutationKind: "artifact-upsert", targetProfileClass: `class-${index}`,
        fieldMappings: [{ targetField: "title", source: "phase-input", ref: "topic" }],
      }));
    }, /item cap/);
    breach((b) => { ((b.intents as Record<string, Record<string, unknown>[]>[])[0]!.fieldMappings)[0]!.value = "bad\u0007bell"; }, /control/);
    breach((b) => { ((b.intents as Record<string, Record<string, unknown>[]>[])[0]!.fieldMappings)[0]!.value = "x".repeat(5000); }, /bounded string/);
  });

  it("preserves all thirteen closed input-field kinds", () => {
    const obj = JSON.parse(text);
    obj.actions["demo.run"].inputSchema = allInputKinds();
    const schema = parseOperationsPack(JSON.stringify(obj)).actions["demo.run"]!.inputSchema;
    const kinds = Object.values(schema).map((field) => field.kind);
    expect(new Set(kinds).size).toBe(13);
  });

  it("accepts a number input field with fractional bounds", () => {
    const obj = JSON.parse(text);
    obj.actions["demo.run"].inputSchema.ratio = {
      kind: "number", required: true, overridable: true, sensitivityDisplay: "normal", minimum: 0.5, maximum: 1.5,
    };
    const field = parseOperationsPack(JSON.stringify(obj)).actions["demo.run"]!.inputSchema.ratio!;
    expect(field).toMatchObject({ kind: "number", minimum: 0.5, maximum: 1.5 });
  });

  it("parses a configuration-arm action at the parse layer", () => {
    const obj = JSON.parse(text);
    obj.actions["demo.run"].execution = { kind: "configuration", flowRef: "demo.flow" };
    const action = parseOperationsPack(JSON.stringify(obj)).actions["demo.run"]!;
    expect(action.execution).toEqual({ kind: "configuration", flowRef: "demo.flow" });
  });

  it("parses the full recipe contracts and closed phase bodies", () => {
    const recipe = parseOperationsPack(text).recipes["demo.prepare"]!;
    expect(recipe.inputContract.fields[0]?.fieldId).toBe("topic");
    expect(recipe.outputContract.formatIds).toEqual(["markdown"]);
    expect(recipe.bounds.maxPhaseInvocations).toBe(8);
    const render = recipe.phases.find((phase) => phase.kind === "render");
    expect(render?.kind === "render" && render.body.templateRef).toBe("render.wiki-page");
    const intent = recipe.phases.find((phase) => phase.kind === "intent");
    expect(intent?.kind === "intent" && intent.body.intents[0]?.mutationKind).toBe("artifact-upsert");
  });
});
