/**
 * llmwiki viewer — a typed entity page's DECLARED fields.
 *
 * The support rail's own list is nine fixed keys — `kind`, `sources`,
 * `confidence`, `provenanceState`, `contradictedBy`, `tags`, `aliases`,
 * `createdAt`, `updatedAt` — which is the DEFAULT profile's vocabulary. A
 * paper's authors, year, DOI and stage are none of them, so a typed page used to
 * show its body beside a rail describing a contract it was never under.
 *
 * This renders what the page's own type declares, dispatching on the declared
 * `FieldDef.type` and NEVER on a field NAME. That is the design constraint, not
 * a stylistic preference: a renderer that knew what `doi` meant would work for
 * one profile and quietly do nothing for the next, and `src/` may not name a
 * domain vocabulary at all (test/no-research-branch-in-core.test.ts).
 *
 * Three value states are reachable and no more. A record violating its declared
 * field contract never becomes a viewer page — `collectTypedViewerInputs` filters
 * it and it surfaces as a `field-violation` problem instead — so a rendered
 * field is either PRESENT, ABSENT-and-optional (the row is omitted, matching the
 * rail's existing rule that a sparse page shows a short list rather than a wall
 * of "(none)"), or an ARTIFACT REFERENCE this view does not resolve. There is no
 * fourth branch because nothing can enter it.
 */

import { el } from "./viewer-dom.js";
import { formatHref } from "./viewer-field-format.js";

/** Rendered in place of a raw boolean; a bare `false` reads as a rendering fault. */
const BOOLEAN_LABELS = { true: "Yes", false: "No" };

/** Said of an artifact reference this view names but has not verified. */
const UNRESOLVED_NOTE = "not verified in this view";

/**
 * Value renderers keyed by DECLARED field type. A type absent from this table
 * falls back to text, so a field type added to the profile schema renders
 * plainly instead of vanishing.
 *
 * NULL-prototype, because the key is read off the wire: on a plain object
 * literal a declared type of `__proto__` would resolve to `Object.prototype` and
 * throw when called, and `constructor` would resolve to `Object` and be invoked.
 * Neither is reachable from a well-formed envelope; neither should be able to
 * break a page render either.
 */
const FIELD_RENDERERS = Object.assign(Object.create(null), {
  "string[]": renderList,
  "artifactRef[]": renderArtifactRefList,
  boolean: renderBoolean,
  enum: renderState,
  artifactRef: renderArtifactRef,
});

/**
 * The declared-field list for one typed page, or `null` when there is nothing to
 * render — the type declares no fields, or the record carries none of them.
 *
 * @param {{name: string, type: string}[]} fieldDefs - The type's declared fields, in declaration order.
 * @param {Record<string, unknown>} frontmatter - The page's raw frontmatter.
 * @returns {HTMLElement|null} A `<dl>`, or null.
 */
export function buildEntityFields(fieldDefs, frontmatter) {
  const present = presentFields(fieldDefs, frontmatter);
  if (present.length === 0) return null;
  const list = el("dl", "entity-fields");
  list.setAttribute("data-entity-fields", "");
  for (const def of present) {
    // The DECLARED key verbatim, never a prettified name: it is what the author
    // typed in frontmatter, and inventing a display name the profile never
    // declared is exactly the substitution this surface exists to avoid.
    list.appendChild(el("dt", "entity-field-label", def.name));
    list.appendChild(renderValue(def, ownValue(frontmatter, def.name)));
  }
  return list;
}

/**
 * The names this page renders as declared fields — used by the rail to stand its
 * own fixed row down for a key the profile declares, so nothing is stated twice.
 *
 * @param {{name: string, type: string}[]} fieldDefs - The type's declared fields.
 * @param {Record<string, unknown>} frontmatter - The page's raw frontmatter.
 * @returns {Set<string>} The declared names actually rendered.
 */
export function renderedFieldNames(fieldDefs, frontmatter) {
  return new Set(presentFields(fieldDefs, frontmatter).map((def) => def.name));
}

/** The declared fields the record actually carries a usable value for. */
function presentFields(fieldDefs, frontmatter) {
  const defs = Array.isArray(fieldDefs) ? fieldDefs : [];
  return defs.filter((def) => isPresent(ownValue(frontmatter, def?.name)));
}

/**
 * One declared field's value off a record, or `undefined` when the record does
 * not carry it.
 *
 * `Object.hasOwn` rather than a bare index, because both sides arrive from
 * outside: `frontmatter` is JSON off the wire, so it carries `Object.prototype`,
 * and `def.name` is a field name the PROFILE declares, which the schema does not
 * constrain (`fields` has no `propertyNames`). A type declaring `constructor`
 * would otherwise resolve `Object.prototype.constructor` on every page of that
 * type and render `function Object() { [native code] }` as the field's value —
 * a value the record does not carry, displayed as though it does, which is the
 * one thing this surface exists not to do. `toString` and `valueOf` do the same.
 *
 * `FIELD_RENDERERS` above already takes the null-prototype form of this
 * precaution for the declared TYPE; this is the same precaution for the
 * declared NAME, which is the half the profile schema leaves open.
 *
 * @param {Record<string, unknown>} record - The page's raw frontmatter.
 * @param {string} name - The declared field name.
 * @returns {unknown} The own value, or `undefined`.
 */
function ownValue(record, name) {
  if (record === null || typeof record !== "object") return undefined;
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

/**
 * Emptiness tests by value shape. A shape absent from this table is present by
 * virtue of existing — a number, a boolean, an object all carry information.
 */
const EMPTINESS_TESTS = [
  { matches: (value) => typeof value === "string", isEmpty: (value) => value.trim().length === 0 },
  { matches: Array.isArray, isEmpty: (value) => value.length === 0 },
];

/** Present means: not absent, not a blank string, not an empty list. */
function isPresent(value) {
  if (value === undefined || value === null) return false;
  const test = EMPTINESS_TESTS.find((entry) => entry.matches(value));
  return test === undefined || !test.isEmpty(value);
}

/** Render one field's value into its `<dd>`, dispatching on the declared type. */
function renderValue(def, value) {
  const cell = el("dd", "entity-field-value");
  const render = FIELD_RENDERERS[def.type];
  (typeof render === "function" ? render : renderText)(cell, value, def.format);
  return cell;
}

/**
 * Fallback and the scalar case: the value as its own text, never reformatted —
 * or as an external link when the field declares a format that resolves.
 */
function renderText(cell, value, format) {
  cell.appendChild(buildScalar(value, format));
}

/**
 * One scalar value: an anchor when its declared format resolves to a safe href,
 * otherwise a text node.
 *
 * `formatHref` returns null for anything it is not certain about — an unknown
 * format, a non-http scheme, an id that could steer its resolver path — so the
 * fallback here is the value AS TEXT rather than a link built anyway. `noopener
 * noreferrer` because the target is page-supplied, and `_blank` because the
 * viewer is a local snapshot a reader should not lose their place in.
 */
function buildScalar(value, format) {
  const text = String(value);
  const href = formatHref(format, text);
  if (href === null) return document.createTextNode(text);
  const link = el("a", "entity-field-link", text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

/** A boolean as a word. */
function renderBoolean(cell, value) {
  cell.textContent = BOOLEAN_LABELS[String(value)] ?? String(value);
}

/** An enum value as a state chip: it is one of a closed set, not free text. */
function renderState(cell, value) {
  cell.appendChild(el("span", "entity-field-state", String(value)));
}

/**
 * A `<ul>` over `value`'s entries, each `<li>` filled by `buildEntry`.
 *
 * A non-array value is wrapped rather than rejected: a page declaring a list
 * type but carrying one bare value renders as a one-item list, which is what the
 * record means, instead of vanishing.
 */
function buildItemList(value, buildEntry) {
  const items = Array.isArray(value) ? value : [value];
  const list = el("ul", "entity-field-list");
  for (const item of items) {
    const entry = el("li", "entity-field-item");
    entry.appendChild(buildEntry(item));
    list.appendChild(entry);
  }
  return list;
}

/** An array as a list; joining into one string would hide where an entry ends. */
function renderList(cell, value, format) {
  cell.appendChild(buildItemList(value, (item) => buildScalar(item, format)));
}

/**
 * An artifact reference, NAMED but not resolved.
 *
 * Resolving one needs a request-time read of the artifact store and a
 * pinned-hash verification, which this surface does not do. So the ref is shown
 * as the record spells it and marked unresolved — presenting it plainly would
 * imply its bytes had been checked, which is the one thing this cannot claim.
 */
function renderArtifactRef(cell, value) {
  cell.appendChild(el("span", "entity-field-ref", String(value)));
  cell.appendChild(el("span", "entity-field-unresolved", UNRESOLVED_NOTE));
}

/**
 * A LIST of artifact references — each one named and marked unresolved.
 *
 * Deliberately not `renderList`: that renders entries as ordinary scalars, which
 * would show an `artifactRef[]` indistinguishably from verified values and undo
 * the whole point of {@link renderArtifactRef}. The unresolved note sits once
 * under the list rather than on every row, since it describes all of them.
 */
function renderArtifactRefList(cell, value) {
  cell.appendChild(buildItemList(value, (item) => el("span", "entity-field-ref", String(item))));
  cell.appendChild(el("span", "entity-field-unresolved", UNRESOLVED_NOTE));
}
