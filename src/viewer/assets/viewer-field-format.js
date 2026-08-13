/**
 * llmwiki viewer — declared field formats to external hrefs.
 *
 * The ONLY place the viewer builds a URL out of page content, which is why it is
 * its own module and why every branch fails closed. A profile declares the
 * FORMAT (`url`, `doi`, `arxiv`); the VALUE comes from a wiki page, i.e. from
 * whatever an author or a connector wrote. The value is therefore treated as
 * untrusted: a `url` must parse and carry an http(s) scheme, and a `doi`/`arxiv`
 * id must match a conservative grammar before it is concatenated into a resolver
 * path. The resolver ORIGIN is a constant here and never author-controlled —
 * that is the reason the vocabulary is a closed enum rather than a URL template.
 *
 * Returning `null` means "render this as text". That is the answer whenever the
 * guard is not certain, because a value shown as text is merely unhelpful while
 * a value linked wrongly is a live `javascript:` or an off-site redirect.
 *
 * Load validation already rejects an unknown format, and this guards anyway:
 * `/api/pages` is a wire boundary, and code on the far side of one does not
 * assume a validator ran on the other.
 */

/** Schemes a `url` field may link to. Anything else renders as text. */
const LINKABLE_SCHEMES = new Set(["http:", "https:"]);

/**
 * A DOI: the `10.<registrant>/<suffix>` form.
 *
 * The suffix is deliberately PERMISSIVE — any run of non-whitespace. A DOI
 * suffix may contain almost anything, slashes included (`10.5061/dryad.abc/1`
 * is a real DOI), so an over-tight grammar silently degrades valid identifiers
 * to plain text. Safety does not come from the grammar here: it comes from
 * {@link resolvedUnder}, which rejects any value that leaves the fixed origin.
 */
const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;

/** An arXiv id: modern `2401.01234v2`, or legacy `math.GT/0309136`. */
const ARXIV_PATTERN = /^(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?)$/;

/**
 * Per-format resolvers, on a NULL-prototype object so an inherited `Object`
 * property (`__proto__`, `constructor`, `toString`) cannot be mistaken for a
 * declared format and invoked.
 */
const RESOLVERS = Object.assign(Object.create(null), {
  url: passThroughHttpUrl,
  doi: (value) => (DOI_PATTERN.test(value) ? resolvedUnder("https://doi.org/", value) : null),
  arxiv: (value) => (ARXIV_PATTERN.test(value) ? resolvedUnder("https://arxiv.org/abs/", value) : null),
});

/**
 * Resolve `value` against a FIXED resolver base and return the result only if it
 * stayed on that origin.
 *
 * This is the actual containment, rather than the identifier grammar: a value
 * that is absolute (`https://evil.test`), protocol-relative (`//evil.test`), or
 * anything else that re-bases lands on a different origin and is refused.
 * Traversal WITHIN the origin (`../x`) is harmless and allowed. Returning
 * `url.href` also normalises the percent-encoding, so the string that was
 * validated is the string that gets navigated.
 */
function resolvedUnder(base, value) {
  try {
    const url = new URL(value, base);
    return url.origin === new URL(base).origin ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The external href for a declared format and a page-supplied value, or `null`
 * when no link should be built.
 *
 * @param {string} format - The declared `FieldDef.format`.
 * @param {unknown} value - The raw frontmatter value.
 * @returns {string|null} An absolute http(s) URL, or null to render as text.
 */
export function formatHref(format, value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const resolve = RESOLVERS[format];
  return typeof resolve === "function" ? resolve(trimmed) : null;
}

/** A value that parses as an absolute http(s) URL, or null. */
function passThroughHttpUrl(value) {
  try {
    return LINKABLE_SCHEMES.has(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}
