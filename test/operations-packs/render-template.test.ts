/**
 * @file test/operations-packs/render-template.test.ts
 * @description render-template (design section 16.5) walks a CLOSED template into
 * bounded output evidence deterministically, and proves the forbidden capabilities
 * are unrepresentable: evidence values are escaped so no executable interpolation
 * (and no second-order `${}`/`{{}}` interpolation) survives, an unsupported node
 * kind / unregistered escaping / unregistered format fails closed, and the byte and
 * iteration ceilings fail closed.
 */

import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../src/operations-packs/handlers/render-template.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { PackHostHandlerError } from "../../src/operations-packs/handlers/types.js";
import type { RenderPhaseBodyV2 } from "../../src/operations-packs/recipe-types.js";
import type { PackEvidenceItemV1, PackRenderInputV1, RenderTemplateV1 } from "../../src/operations-packs/handlers/types.js";

function body(over: Partial<RenderPhaseBodyV2> = {}): RenderPhaseBodyV2 {
  return { templateRef: "tmpl.report", formatId: "text", escapingPolicyId: "per-node", inputEvidenceRefs: ["evd"], ...over };
}
function item(itemId: string, fields: PackEvidenceItemV1["fields"]): PackEvidenceItemV1 { return { itemId, fields }; }
function render(template: RenderTemplateV1, frame: PackEvidenceItemV1["fields"], items: PackEvidenceItemV1[] = [], maximumOutputBytes = 262_144, maximumItems = 100): PackRenderInputV1 {
  return { body: body(), template, frame, items, bounds: { maximumItems, maximumOutputBytes } };
}

describe("render-template", () => {
  it("renders literals, fields, and bounded iteration deterministically", () => {
    const template: RenderTemplateV1 = { templateId: "t", version: "1.0.0", nodes: [
      { kind: "literal", text: "Title: " }, { kind: "field", field: "title", escaping: "none" },
      { kind: "literal", text: "\nItems:" }, { kind: "each", body: [{ kind: "literal", text: " " }, { kind: "field", field: "name", escaping: "none" }] },
    ] };
    const input = render(template, { title: "Report" }, [item("1", { name: "alpha" }), item("2", { name: "beta" })]);
    const first = renderTemplate(input);
    expect(first.output).toBe("Title: Report\nItems: alpha beta");
    expect(canonicalBytes(first)).toEqual(canonicalBytes(renderTemplate(input)));
  });

  it("escapes evidence values so no executable interpolation survives", () => {
    const template: RenderTemplateV1 = { templateId: "t", version: "1.0.0", nodes: [{ kind: "field", field: "body", escaping: "html" }] };
    const output = renderTemplate(render(template, { body: "<script>alert(1)</script>${x}{{y}}" })).output;
    expect(output).not.toContain("<script>");
    expect(output).toContain("&lt;script&gt;");
    expect(output).toContain("${x}");
    expect(output).toContain("{{y}}");
  });

  it("fails closed on an unsupported template node kind", () => {
    const template = { templateId: "t", version: "1.0.0", nodes: [{ kind: "expression", code: "eval(x)" }] } as unknown as RenderTemplateV1;
    expect(() => renderTemplate(render(template, {}))).toThrow(PackHostHandlerError);
  });

  it("fails closed on an unregistered escaping policy or output format", () => {
    const template: RenderTemplateV1 = { templateId: "t", version: "1.0.0", nodes: [{ kind: "field", field: "x", escaping: "exec" }] };
    expect(() => renderTemplate(render(template, { x: "v" }))).toThrow(PackHostHandlerError);
    const empty: RenderTemplateV1 = { templateId: "t", version: "1.0.0", nodes: [] };
    expect(() => renderTemplate({ ...render(empty, {}), body: body({ formatId: "binary" }) })).toThrow(PackHostHandlerError);
  });

  it("fails closed when the rendered output exceeds the byte ceiling", () => {
    const template: RenderTemplateV1 = { templateId: "t", version: "1.0.0", nodes: [{ kind: "field", field: "big", escaping: "none" }] };
    expect(() => renderTemplate(render(template, { big: "x".repeat(50) }, [], 10))).toThrow(PackHostHandlerError);
  });

  it("fails closed when iteration exceeds the item ceiling", () => {
    const template: RenderTemplateV1 = { templateId: "t", version: "1.0.0", nodes: [{ kind: "each", body: [{ kind: "field", field: "name", escaping: "none" }] }] };
    expect(() => renderTemplate(render(template, {}, [item("1", { name: "a" }), item("2", { name: "b" })], 262_144, 1))).toThrow(PackHostHandlerError);
  });
});
