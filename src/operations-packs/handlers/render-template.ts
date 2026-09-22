/**
 * @file src/operations-packs/handlers/render-template.ts
 * @description The render-template host-handler family (design section 16.5): a
 * PURE walk of a CLOSED declarative {@link RenderTemplateV1} over typed evidence
 * into bounded output evidence. The grammar permits only literal UTF-8 segments,
 * scalar field insertion through a registered escaping policy, bounded iteration
 * over the evidence items, and closed conditional-presence checks. It FORBIDS
 * executable expressions, helpers, filesystem paths, network access, provider
 * calls, unbounded recursion, dynamic includes, and shell content: the node union
 * has no arm that can carry any of them, an unknown node kind or unregistered
 * escaping/format id fails closed, and every evidence value is escaped on insertion
 * so no executable interpolation — nor any second-order interpolation — survives.
 *
 * RESOLVED FROM PROSE (section 16.5). Literals are host-authored template text and
 * emitted verbatim; only EVIDENCE field values (the untrusted data) are escaped.
 * The launch escaping policies are `none`, `html`, and `json-string`; the launch
 * format ids are `text`, `markdown`, and `json-lines` and label the output only.
 */

import { Buffer } from "node:buffer";
import { enforceOutputBytes } from "./evidence.js";
import { PackHostHandlerError } from "./types.js";
import type {
  PackEvidenceScalarV1, PackRenderInputV1, PackRenderNodeV1, PackRenderResultV1,
} from "./types.js";

const REGISTERED_FORMATS: ReadonlySet<string> = new Set(["text", "markdown", "json-lines"]);

/**
 * The registered BODY-level escaping policy ids (section 16.5). Exactly one
 * exists, and its name says what actually executes: each `field` NODE carries
 * its own registered escaping, applied on insertion. The body-level id is
 * validated-and-pinned at parse so a pack cannot declare a policy this handler
 * does not implement and silently receive per-node behavior instead.
 */
export const REGISTERED_ESCAPING_POLICY_IDS: ReadonlySet<string> = new Set(["per-node"]);

/** The closed registered escaping policies; an unregistered id fails closed. */
const ESCAPERS: Readonly<Record<string, (value: PackEvidenceScalarV1) => string>> = {
  none: (value) => String(value),
  html: (value) => String(value).replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char),
  "json-string": (value) => JSON.stringify(String(value)),
};

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** The bounded per-render context: the iterable items and their hard ceiling. */
interface RenderContextV1 {
  readonly items: readonly Readonly<Record<string, PackEvidenceScalarV1>>[];
  readonly maximumItems: number;
}

/** Escape one evidence value through a registered policy or fail closed. */
function escape(policyId: string, value: PackEvidenceScalarV1 | undefined): string {
  const escaper = ESCAPERS[policyId];
  if (escaper === undefined) throw new PackHostHandlerError(`escaping policy is not registered: ${policyId}`);
  return value === undefined ? "" : escaper(value);
}

/** Render one closed node against the current frame; an unknown kind fails closed. */
function renderNode(node: PackRenderNodeV1, frame: Readonly<Record<string, PackEvidenceScalarV1>>, ctx: RenderContextV1): string {
  if (node.kind === "literal") return node.text;
  if (node.kind === "field") return escape(node.escaping, frame[node.field]);
  if (node.kind === "when-present") {
    const value = frame[node.field];
    return value === undefined || value === "" ? "" : renderNodes(node.body, frame, ctx);
  }
  if (node.kind === "each") return renderEach(node.body, ctx);
  throw new PackHostHandlerError(`render template node kind is not supported: ${(node as { kind: string }).kind}`);
}

/** Iterate the bounded evidence items, rendering the loop body per item (16.5). */
function renderEach(body: readonly PackRenderNodeV1[], ctx: RenderContextV1): string {
  if (ctx.items.length > ctx.maximumItems) throw new PackHostHandlerError(`render iteration exceeds the ${ctx.maximumItems}-item ceiling`);
  return ctx.items.map((frame) => renderNodes(body, frame, ctx)).join("");
}

/** Concatenate the rendering of a bounded node sequence. */
function renderNodes(nodes: readonly PackRenderNodeV1[], frame: Readonly<Record<string, PackEvidenceScalarV1>>, ctx: RenderContextV1): string {
  return nodes.map((node) => renderNode(node, frame, ctx)).join("");
}

/** Fail closed unless the declared output format id is registered (section 16.5). */
function assertFormat(formatId: string): void {
  if (!REGISTERED_FORMATS.has(formatId)) throw new PackHostHandlerError(`output format is not registered: ${formatId}`);
}

/**
 * Render bounded output evidence from a closed template and typed evidence
 * (section 16.5). Pure and deterministic: identical input yields identical output
 * bytes. It never writes, calls no provider, and cannot execute an interpolated
 * value — evidence values are escaped, and the grammar has no executable arm.
 */
export function renderTemplate(input: PackRenderInputV1): PackRenderResultV1 {
  assertFormat(input.body.formatId);
  const ctx: RenderContextV1 = { items: input.items.map((item) => item.fields), maximumItems: input.bounds.maximumItems };
  const output = renderNodes(input.template.nodes, input.frame, ctx);
  const byteCount = Buffer.byteLength(output, "utf8");
  if (byteCount > input.bounds.maximumOutputBytes) throw new PackHostHandlerError(`rendered output exceeds the ${input.bounds.maximumOutputBytes}-byte ceiling`);
  const result: PackRenderResultV1 = { templateRef: input.body.templateRef, formatId: input.body.formatId, output, byteCount, deficits: [] };
  enforceOutputBytes(result, input.bounds.maximumOutputBytes);
  return result;
}
