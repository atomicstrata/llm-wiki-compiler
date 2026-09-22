/**
 * @file Render and mixed-intent compiler fixtures, separated from base request
 * construction so both fixture modules remain independently readable.
 */
import type { CompilePackActionRequestV1 } from "../../src/operations-packs/compiler-types.js";
import type { RenderTemplateV1 } from "../../src/operations-packs/handlers/types.js";
import type { PackPhaseV2 } from "../../src/operations-packs/recipe-types.js";
import { RECIPE_ID, twoPhasePaperRecipe, twoPhasePaperRequest, multiSourcePaperRequest } from "./compile-base-fixture.js";

/** The ref every render-projection fixture's index template is declared under. */
const PAPER_INDEX_TEMPLATE_REF = "template.paper-index";

/** A pack-shipped markdown index template over the selected papers' topic field. */
function paperIndexTemplate(heading: string): RenderTemplateV1 {
  return {
    templateId: PAPER_INDEX_TEMPLATE_REF, version: "1.0.0",
    nodes: [
      { kind: "literal", text: heading },
      {
        kind: "each",
        body: [
          { kind: "literal", text: "- " },
          { kind: "field", field: "topic", escaping: "none" },
          { kind: "literal", text: "\n" },
        ],
      },
    ],
  };
}

/**
 * The projection action with its render phase binding BOTH sources: the frozen
 * action input and pick's output, under a template whose TOP level inserts the
 * frame's `topic` before the `each` loop. Pins the documented both-bound render
 * semantics: the frame is the action-input item's fields, AND the action-input
 * item is iterated by `each` alongside the predecessor's items.
 */
export function renderBothSourcesRequest(input: { topic: string; doi?: string }): CompilePackActionRequestV1 {
  const base = renderProjectionRequest(input);
  const recipe = base.pack.recipes[RECIPE_ID]!;
  const index = recipe.phases[1]!;
  index.inputBindings = [
    { bindingId: "seed", source: "action-input", ref: "topic" },
    { bindingId: "picked", source: "phase-output", ref: "pick.selected" },
  ];
  const framed: RenderTemplateV1 = {
    templateId: PAPER_INDEX_TEMPLATE_REF, version: "1.0.0",
    nodes: [
      { kind: "literal", text: "# " },
      { kind: "field", field: "topic", escaping: "none" },
      { kind: "literal", text: "\n" },
      { kind: "each", body: [{ kind: "literal", text: "- " }, { kind: "field", field: "topic", escaping: "none" }, { kind: "literal", text: "\n" }] },
    ],
  };
  return { ...base, pack: { ...base.pack, renderTemplates: { [PAPER_INDEX_TEMPLATE_REF]: framed } } };
}

/** The shared `index` render phase: the paper-index template over pick's output. */
function paperIndexRenderPhase(): PackPhaseV2 {
  return {
    phaseId: "index", kind: "render", dependencies: ["pick"], disposition: "required",
    inputBindings: [{ bindingId: "picked", source: "phase-output", ref: "pick.selected" }],
    outputSchema: [{ fieldId: "projection", valueKind: "evidence-ref" }],
    bounds: { maxItems: 4, maxOutputBytes: 65536 }, missingInputDisposition: "fail",
    body: {
      templateRef: PAPER_INDEX_TEMPLATE_REF, formatId: "markdown",
      escapingPolicyId: "per-node", inputEvidenceRefs: ["picked"],
    },
  };
}

/**
 * The framed projection over a MULTI-SOURCE input: the render phase binds the
 * ACTION INPUT alone, whose doi column decodes to `source-<i>` items — so NO
 * `action-input` item exists — while the template's TOP level inserts `topic`.
 * Pins the mode-independent frame rule: the render frame is the sealed input's
 * SCALAR fields via the decoder split, not the presence of an action-input item.
 */
export function multiSourceRenderRequest(input: { topic: string; doi: readonly string[] }): CompilePackActionRequestV1 {
  const framed = renderBothSourcesRequest({ topic: input.topic });
  const multi = multiSourcePaperRequest(input);
  const recipe = framed.pack.recipes[RECIPE_ID]!;
  const index = recipe.phases.find((phase) => phase.phaseId === "index")!;
  const propose = recipe.phases.find((phase) => phase.phaseId === "propose")!;
  index.dependencies = [];
  index.inputBindings = [{ bindingId: "seed", source: "action-input", ref: "topic" }];
  recipe.phases = [index, propose];
  return {
    ...framed,
    input: multi.input,
    pack: { ...framed.pack, recipes: { [RECIPE_ID]: recipe }, actions: multi.pack.actions },
  };
}

/**
 * A three-phase projection action: the eligibility `pick`, a `render` phase
 * walking the pack-shipped index template over pick's output, and an `intent`
 * phase proposing the projection page whose payload carries the RENDERED
 * markdown — read from the render phase's wrapped output item, so the mutation
 * provably reflects the template.
 */
export function renderProjectionRequest(
  input: { topic: string; doi?: string }, heading = "# Papers\n",
): CompilePackActionRequestV1 {
  const base = twoPhasePaperRequest(input);
  const recipe = twoPhasePaperRecipe();
  recipe.phases = [
    recipe.phases[0]!,
    paperIndexRenderPhase(),
    {
      phaseId: "propose", kind: "intent", dependencies: ["index"], disposition: "required",
      inputBindings: [{ bindingId: "projection-in", source: "phase-output", ref: "index.projection" }],
      outputSchema: [{ fieldId: "mutation", valueKind: "artifact-ref" }],
      bounds: { maxItems: 4, maxOutputBytes: 65536 }, missingInputDisposition: "fail",
      body: {
        intentTemplateRef: "intent.wiki-artifact",
        intents: [{
          mutationKind: "artifact-upsert", targetProfileClass: "wiki-page",
          fieldMappings: [
            { targetField: "content", source: "phase-input", ref: "output" },
            { targetField: "format", source: "phase-input", ref: "format-id" },
            { targetField: "author", source: "host-identity", identityKind: "principal" },
          ],
        }],
      },
    },
  ];
  return {
    ...base,
    pack: {
      ...base.pack,
      recipes: { [RECIPE_ID]: recipe },
      renderTemplates: { [PAPER_INDEX_TEMPLATE_REF]: paperIndexTemplate(heading) },
    },
  };
}

/**
 * The BOOTSTRAP-SHAPED mixed-intents action: two sources flow pick -> index ->
 * one terminal declaring THREE intent groups — a paper page per source item, a
 * `cites` relation per source (its relationType pinned as a pack STRING
 * constant), and ONE projection page gated by `whenPresent: "output"` to the
 * render item alone. The shape G4c's real bootstrap recipe takes.
 */
export function mixedBootstrapRequest(
  input: { topic: string; doi: readonly string[]; pid: readonly string[]; cites: readonly string[] },
): CompilePackActionRequestV1 {
  const base = multiSourcePaperRequest({ topic: input.topic, doi: input.doi });
  const action = base.pack.actions["demo.run"]!;
  const recipe = base.pack.recipes[RECIPE_ID]!;
  const pick = recipe.phases.find((phase) => phase.phaseId === "pick")!;
  recipe.phases = [
    pick,
    paperIndexRenderPhase(),
    {
      phaseId: "propose", kind: "intent", dependencies: ["index"], disposition: "required",
      inputBindings: [
        { bindingId: "selected-in", source: "phase-output", ref: "pick.selected" },
        { bindingId: "projection-in", source: "phase-output", ref: "index.projection" },
      ],
      outputSchema: [{ fieldId: "mutation", valueKind: "artifact-ref" }],
      bounds: { maxItems: 8, maxOutputBytes: 65536 }, missingInputDisposition: "fail",
      body: {
        intentTemplateRef: "intent.wiki-artifact",
        intents: [
          {
            mutationKind: "artifact-upsert", targetProfileClass: "wiki-page", whenPresent: "doi",
            fieldMappings: [
              { targetField: "title", source: "phase-input", ref: "topic" },
              { targetField: "doi", source: "phase-input", ref: "doi" },
              { targetField: "author", source: "host-identity", identityKind: "principal" },
            ],
          },
          {
            mutationKind: "relation-upsert", targetProfileClass: "cites-link", whenPresent: "cites",
            fieldMappings: [
              { targetField: "relation-type", source: "constant", value: "cites" },
              { targetField: "from", source: "phase-input", ref: "pid" },
              { targetField: "to", source: "phase-input", ref: "cites" },
            ],
          },
          {
            mutationKind: "artifact-upsert", targetProfileClass: "wiki-page", whenPresent: "output",
            fieldMappings: [
              { targetField: "content", source: "phase-input", ref: "output" },
              { targetField: "format", source: "phase-input", ref: "format-id" },
            ],
          },
        ],
      },
    },
  ];
  return {
    ...base,
    input: { topic: input.topic, doi: [...input.doi], pid: [...input.pid], cites: [...input.cites] },
    pack: {
      ...base.pack,
      actions: {
        "demo.run": {
          ...action,
          inputSchema: {
            ...action.inputSchema,
            pid: { kind: "string-list", required: true, overridable: true, sensitivityDisplay: "normal", maxItems: 8, maxItemBytes: 256 },
            cites: { kind: "string-list", required: true, overridable: true, sensitivityDisplay: "normal", maxItems: 8, maxItemBytes: 256 },
          },
        },
      },
      renderTemplates: { [PAPER_INDEX_TEMPLATE_REF]: paperIndexTemplate("# Papers\n") },
    },
  };
}
