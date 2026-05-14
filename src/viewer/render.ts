/**
 * Server-side markdown → sanitized HTML renderer for the viewer.
 *
 * Pipeline:
 *   1. `markdown-it` with raw HTML disabled parses the body.
 *   2. Two custom inline rules (`wikilink-rule`, `citation-rule`) are
 *      registered AFTER the built-in `link` rule so a wikilink or
 *      citation embedded in markdown link text (`[outer [[alpha]] text](url)`)
 *      gets folded into the outer link's text rather than emitting a
 *      nested anchor. Inside that recursive parse the `linkLevel`
 *      guard (and the silent-mode decline) keep the custom rules from
 *      firing, so `[[…]]` and `^[…]` markers in link text, code spans,
 *      fenced code blocks, and escaped sequences all render as literal
 *      text. See `markdown-it-helpers.ts::shouldDeferInlineRule`.
 *   3. `sanitize-html` enforces the spec's tag/attribute/protocol
 *      allowlist. The same policy applies to every rendered surface
 *      (`/api/page/...` and `/api/index`).
 *
 * Returns HTML only. The structured `citations: ClaimCitation[]` field
 * on every page payload comes from `ViewerPage.citations` (produced by
 * Slice 1's `extractClaimCitations`), never from the renderer — so the
 * page record and the rendered HTML cannot drift on what the page cites.
 */

import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import type { IOptions } from "sanitize-html";
import { registerWikilink } from "./wikilink-rule.js";
import { registerCitation } from "./citation-rule.js";
import type { ViewerSnapshot } from "./types.js";

/** Per-render configuration the server passes in. */
interface RenderOptions {
  /**
   * True when the viewer is bound to loopback (`127.0.0.1` or `::1`).
   * Controls whether citation chips include `data-absolute-path` and
   * editor-link payloads — both omitted on LAN binds per spec
   * §Support Rail.
   */
  isLoopback: boolean;
}

/**
 * Render a page body to sanitized HTML. The renderer is constructed per
 * call so the wikilink and citation rules can capture the current
 * snapshot in their closures without leaking across requests.
 */
export function renderPageHtml(
  body: string,
  snapshot: ViewerSnapshot,
  options: RenderOptions,
): { html: string } {
  const md = buildMarkdownIt(snapshot, options);
  const rendered = md.render(body);
  const html = sanitizeHtml(rendered, buildSanitizerPolicy(options));
  return { html };
}

/** Construct a fresh markdown-it instance with the viewer's inline rules wired in. */
function buildMarkdownIt(snapshot: ViewerSnapshot, options: RenderOptions): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: false,
  });
  registerWikilink(md, { pages: snapshot.pages });
  registerCitation(md, {
    root: snapshot.root,
    sourceFiles: new Set(snapshot.sourceFilenames),
    isLoopback: options.isLoopback,
  });
  return md;
}

/**
 * Build the sanitize-html policy. The spec's allowlist is encoded here
 * exactly once; every test that asserts a policy decision points at this
 * one source of truth so future changes show up in a single diff.
 *
 * Exported so the defense-in-depth security tests can exercise
 * `sanitizeHtml` directly against raw HTML the markdown parser would
 * normally escape — the sanitizer is the last line if a future change
 * ever flips the parser's `html` flag or admits an HTML-emitting plugin.
 */
export function buildSanitizerPolicy(options: RenderOptions): IOptions {
  const allowedSchemes = ["http", "https", "mailto"];
  const allowedSchemesAppliedToAttributes = ["href", "src", "cite"];
  return {
    allowedTags: [
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "br", "hr",
      "ul", "ol", "li",
      "blockquote",
      "strong", "em", "b", "i", "s", "u",
      "code", "pre",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td",
      "a", "img", "span", "div",
    ],
    disallowedTagsMode: "discard",
    allowedAttributes: {
      a: ["href", "title", "class", "id", "data-*", "aria-*"],
      img: ["src", "alt", "title", "class", "id"],
      span: ["class", "id", "data-*", "aria-*"],
      div: ["class", "id", "data-*", "aria-*"],
      th: ["scope", "colspan", "rowspan", "class", "id"],
      td: ["colspan", "rowspan", "class", "id"],
      table: ["class", "id"],
      code: ["class"],
      "*": ["class", "id"],
    },
    allowedSchemes,
    allowedSchemesByTag: {
      a: buildAnchorSchemes(),
      img: ["http", "https", "data"],
    },
    allowedSchemesAppliedToAttributes,
    allowProtocolRelative: false,
    // `allowedAttributes` above whitelists `class` everywhere via `*`,
    // so no further class-name allowlist is needed; leaving
    // `allowedClasses` unset lets every class value through.
    allowedStyles: {},
    allowedIframeHostnames: [],
    transformTags: {
      a: filterAnchorHref(),
      img: filterImgSrc,
      span: filterSpanForLanBind(options),
    },
    // sanitize-html's URL filter does not enforce hash-only links by
    // default; the anchor transform above whitelists `#/…` explicitly.
  };
}

/**
 * On non-loopback binds, strip `data-absolute-path` and
 * `data-editor-href` from any `<span>` regardless of who produced them.
 * The citation rule already gates these at the producer; this transform
 * is defense-in-depth so a future markdown-it plugin or hand-crafted
 * raw HTML can't smuggle the user's filesystem layout onto a LAN
 * surface. On loopback binds the attributes pass through untouched
 * (citation chips need them to render the editor link).
 */
function filterSpanForLanBind(options: RenderOptions) {
  return function transformSpan(tagName: string, attribs: Record<string, string>): {
    tagName: string;
    attribs: Record<string, string>;
  } {
    if (options.isLoopback) return { tagName, attribs };
    if (!("data-absolute-path" in attribs) && !("data-editor-href" in attribs)) {
      return { tagName, attribs };
    }
    const stripped: Record<string, string> = {};
    for (const [key, value] of Object.entries(attribs)) {
      if (key === "data-absolute-path" || key === "data-editor-href") continue;
      stripped[key] = value;
    }
    return { tagName, attribs: stripped };
  };
}

/**
 * Anchor protocols allowed in the rendered output. Intentionally does
 * NOT include `vscode://` even on loopback: citation chips emit the
 * editor link on a `<span data-editor-href>`, not on an `<a href>`, so
 * markdown-authored anchors like `[click](vscode://file//etc/passwd)`
 * get their href stripped and cannot trick the user into opening
 * arbitrary local files in their editor.
 */
function buildAnchorSchemes(): string[] {
  return ["http", "https", "mailto"];
}

/**
 * Filter anchor `href` values. Allows http/https/mailto, the viewer's
 * `#/…` hash links, and bare-fragment anchors. Anything else
 * (including any `vscode://` URI — see `buildAnchorSchemes`) loses the
 * `href` attribute entirely.
 */
function filterAnchorHref() {
  return function transformAnchor(tagName: string, attribs: Record<string, string>): {
    tagName: string;
    attribs: Record<string, string>;
  } {
    const href = attribs.href;
    if (typeof href !== "string" || href.length === 0) return { tagName, attribs };
    if (isAllowedAnchorHref(href)) return { tagName, attribs };
    const stripped = { ...attribs };
    delete stripped.href;
    return { tagName, attribs: stripped };
  };
}

/** Filter `img` src to image-typed `data:` URIs and http(s) only. */
function filterImgSrc(tagName: string, attribs: Record<string, string>): {
  tagName: string;
  attribs: Record<string, string>;
} {
  const src = attribs.src;
  if (typeof src !== "string" || src.length === 0) return { tagName, attribs };
  if (isAllowedImgSrc(src)) return { tagName, attribs };
  const stripped = { ...attribs };
  delete stripped.src;
  return { tagName, attribs: stripped };
}

/**
 * Allow `http://`, `https://`, `mailto:`, and bare-fragment `#…`/`#/…`.
 * On loopback binds, additionally allow `vscode://file/<path>` (the
 * spec's "safe local editor link" carve-out for citation chips). The
 * carve-out is intentionally narrow — arbitrary `vscode://` URIs can
 * invoke commands (e.g. `vscode://vscode.git/...`), so a tighter prefix
 * keeps a hostile markdown source from smuggling command invocations
 * through user-authored anchors.
 */
function isAllowedAnchorHref(href: string): boolean {
  if (href.startsWith("#")) return true;
  if (href.startsWith("http://") || href.startsWith("https://")) return true;
  if (href.startsWith("mailto:")) return true;
  return false;
}

/** Allow http(s) and `data:image/...` only. */
function isAllowedImgSrc(src: string): boolean {
  if (src.startsWith("http://") || src.startsWith("https://")) return true;
  if (src.startsWith("data:image/")) return true;
  return false;
}
