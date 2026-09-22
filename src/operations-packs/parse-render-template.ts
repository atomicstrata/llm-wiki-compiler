/**
 * @file src/operations-packs/parse-render-template.ts
 * @description Bounded closed-grammar parser for one pack-declared
 * {@link RenderTemplateV1} (design section 16.5). The node union is rebuilt arm
 * by arm — literal, field, each, when-present — with unknown kinds, unknown
 * keys, over-cap node counts, and over-deep nesting all refused, so no
 * expression, path, include, helper, or shell arm is representable in a parsed
 * template.
 *
 * LITERAL TEXT IS THE TEMPLATE'S DECLARED CONTENT, deliberately unlike the
 * pack-authored string constants the rule-parameter and intent-constant
 * grammars refuse. Those constants would flow into draft PAYLOADS as data a
 * caller never supplied; a render literal is the template's own presentation
 * text, emitted verbatim into an output that only ever becomes evidence, and
 * the section-16.5 grammar models it as an inert closed segment beside ESCAPED
 * evidence insertions. It is bounded and control-character-free (newline and
 * tab excepted — a text template without line breaks could not render an
 * index) rather than forbidden.
 */

import { Buffer } from "node:buffer";
import { array, exact, record } from "../operation-bundles/manifest-values.js";
import {
  FORBIDDEN_PACK_TEXT_CONTROL,
  MAX_RENDER_LITERAL_BYTES, MAX_RENDER_NODE_DEPTH, MAX_RENDER_TEMPLATE_NODES,
} from "./constants.js";
import type { PackRenderNodeV1, RenderTemplateV1 } from "./handlers/types.js";
import { assertRefId, assertPackVersion, assertSlug } from "./ids.js";
import { PackParseError } from "./problems.js";



/** The per-template parse budget: total nodes across all nesting levels. */
interface NodeBudgetV1 { remaining: number }

/** One bounded literal segment: non-empty, byte-capped, printable + \n\t only. */
function literalText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_RENDER_LITERAL_BYTES
    || FORBIDDEN_PACK_TEXT_CONTROL.test(value)) {
    throw new PackParseError(`${label} must be a bounded literal without control characters`);
  }
  return value;
}

/** Parse one closed node; unknown kinds and unknown keys fail closed. */
function parseNode(value: unknown, label: string, depth: number, budget: NodeBudgetV1): PackRenderNodeV1 {
  if (depth > MAX_RENDER_NODE_DEPTH) throw new PackParseError(`${label} exceeds the render nesting depth cap`);
  if ((budget.remaining -= 1) < 0) throw new PackParseError("render template exceeds its node cap");
  const node = record(value, label);
  if (node.kind === "literal") {
    exact(node, ["kind", "text"]);
    return { kind: "literal", text: literalText(node.text, `${label}.text`) };
  }
  if (node.kind === "field") {
    exact(node, ["kind", "field", "escaping"]);
    return { kind: "field", field: assertSlug(node.field), escaping: assertSlug(node.escaping) };
  }
  if (node.kind === "each" || node.kind === "when-present") {
    return parseBodyNode(node, label, depth, budget);
  }
  throw new PackParseError(`${label} kind is not a registered render node kind`);
}

/** Parse the two body-carrying arms, which recurse one level deeper. */
function parseBodyNode(
  node: Readonly<Record<string, unknown>>, label: string, depth: number, budget: NodeBudgetV1,
): PackRenderNodeV1 {
  const body = array(node.body, `${label}.body`, MAX_RENDER_TEMPLATE_NODES)
    .map((item, index) => parseNode(item, `${label}.body[${index}]`, depth + 1, budget));
  if (body.length === 0) throw new PackParseError(`${label}.body must carry at least one node`);
  if (node.kind === "each") {
    exact(node, ["kind", "body"]);
    return { kind: "each", body };
  }
  exact(node, ["kind", "field", "body"]);
  return { kind: "when-present", field: assertSlug(node.field), body };
}

/** Rebuild one closed render template; every field is validated or refused. */
export function parseRenderTemplate(value: unknown, label: string): RenderTemplateV1 {
  const node = record(value, label);
  exact(node, ["templateId", "version", "nodes"]);
  const budget: NodeBudgetV1 = { remaining: MAX_RENDER_TEMPLATE_NODES };
  const nodes = array(node.nodes, `${label}.nodes`, MAX_RENDER_TEMPLATE_NODES)
    .map((item, index) => parseNode(item, `${label}.nodes[${index}]`, 0, budget));
  if (nodes.length === 0) throw new PackParseError(`${label}.nodes must carry at least one node`);
  return {
    templateId: assertRefId(node.templateId),
    version: assertPackVersion(node.version),
    nodes,
  };
}
