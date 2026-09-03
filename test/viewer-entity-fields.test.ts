/**
 * @file test/viewer-entity-fields.test.ts
 * @description A typed entity page renders the fields its PROFILE declares.
 *
 * Before this, a typed page's own data was invisible. The support rail renders a
 * FIXED nine-field list — `kind`, `sources`, `confidence`, `provenanceState`,
 * `contradictedBy`, `tags`, `aliases`, `createdAt`, `updatedAt` — which is the
 * DEFAULT profile's vocabulary. A paper's authors, year, DOI and stage are none
 * of those, so the page showed its body and a rail describing a contract it was
 * never under.
 *
 * The renderer dispatches on the declared `FieldDef.type` and NEVER on a field
 * name. That is the whole design constraint: a renderer that knew what `doi` or
 * `hypothesis` meant would work for one profile and quietly do nothing for the
 * next, and `src/` is barred from naming a domain vocabulary at all
 * (test/no-research-branch-in-core.test.ts). Every case below is therefore
 * written against a made-up profile, not against a shipped one.
 *
 * Three value states are reachable and no more. A record violating its declared
 * field contract never becomes a viewer page — `collectTypedViewerInputs` filters
 * it and it surfaces as a `field-violation` problem — so a rendered field is
 * either present, absent-and-optional (omitted), or an artifact reference this
 * slice does not resolve.
 */

import { describe, expect, it } from "vitest";
import {
  flushMicrotasks,
  jsonResponse,
  mountViewerDom,
  type FetchResponder,
} from "./fixtures/viewer-jsdom.js";

/** A type declaring one field of every renderable shape, in a made-up vocabulary. */
const FIELDS = [
  { name: "headline", type: "string" },
  { name: "wordCount", type: "integer" },
  { name: "rating", type: "number" },
  { name: "syndicated", type: "boolean" },
  { name: "filedOn", type: "date" },
  { name: "topics", type: "string[]" },
  { name: "stage", type: "enum", enum: ["draft", "filed"] },
  { name: "proofs", type: "artifactRef" },
];

/** Options for {@link mountPage}: what the profile declares, and what the page carries. */
interface PageCase {
  /** Declared fields of `articles`; omitted entirely for a default-profile envelope. */
  fields?: Record<string, unknown>[];
  /** The page's raw frontmatter. */
  frontmatter: Record<string, unknown>;
  /** The page's directory. A typed page also reports it as `entityType`. */
  directory?: string;
  /** The key this type titles pages by, if any. */
  titleField?: string;
}

/**
 * Serve a bootstrap envelope and one page, then mount and route to that page.
 *
 * One builder for every case here — declared fields, no declarations, a default
 * page, an overlapping key — because four near-identical responders drifted the
 * moment one of them needed a different field type.
 */
async function mountPage({ fields, frontmatter, directory = "articles", titleField }: PageCase): Promise<Document> {
  const typed = directory !== "concepts";
  const responder: FetchResponder = (url) => {
    if (url.endsWith("/api/pages")) {
      return jsonResponse({
        project: { title: "demo", rootName: "demo" },
        counts: {},
        pages: [],
        recentPages: [],
        index: { available: false },
        ...(fields
          ? {
              profilePipeline: {
                entityTypes: [
                  {
                    type: "articles",
                    directory: "wiki/articles",
                    pageCount: 1,
                    fields,
                    ...(titleField ? { titleField } : {}),
                  },
                ],
              },
            }
          : {}),
      });
    }
    if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
    if (url.includes("/api/page/")) {
      return jsonResponse({
        pageDirectory: directory,
        ...(typed ? { entityType: directory } : {}),
        slug: "alpha",
        title: "Alpha",
        html: "<p>Body.</p>",
        warnings: [],
        frontmatter,
      });
    }
    return null;
  };
  const { dom } = await mountViewerDom(responder);
  dom.window.location.hash = `#/${directory}/alpha`;
  await flushMicrotasks();
  return dom.window.document;
}

/** Mount a page declaring {@link FIELDS} and return its declared-fields block. */
async function fieldsFor(frontmatter: Record<string, unknown>): Promise<HTMLElement | null> {
  const doc = await mountPage({ fields: FIELDS, frontmatter });
  return doc.querySelector("[data-entity-fields]");
}

/** The `<dt>`/`<dd>` text pairs of a declared-fields block, in render order. */
function rows(block: HTMLElement | null): [string, string][] {
  const terms = Array.from(block?.querySelectorAll("dt") ?? []).map((n) => n.textContent ?? "");
  const values = Array.from(block?.querySelectorAll("dd") ?? []).map((n) => n.textContent ?? "");
  return terms.map((term, index) => [term, values[index]]);
}

const FULL_RECORD = {
  headline: "Alpha",
  wordCount: 900,
  rating: 4.5,
  syndicated: false,
  filedOn: "2026-08-01",
  topics: ["politics", "local"],
  stage: "filed",
};

describe("a typed page renders the fields its profile declares", () => {
  it("renders every declared field the record carries, in declaration order", async () => {
    const block = await fieldsFor(FULL_RECORD);
    expect(rows(block).map(([label]) => label)).toEqual([
      "headline",
      "wordCount",
      "rating",
      "syndicated",
      "filedOn",
      "topics",
      "stage",
    ]);
  });

  it("labels each row with the declared key verbatim, not a prettified name", async () => {
    const block = await fieldsFor({ wordCount: 900 });
    expect(rows(block).map(([label]) => label)).toEqual(["wordCount"]);
  });

  it("renders scalars as their own text", async () => {
    const byLabel = Object.fromEntries(rows(await fieldsFor(FULL_RECORD)));
    expect(byLabel.headline).toBe("Alpha");
    expect(byLabel.wordCount).toBe("900");
    expect(byLabel.rating).toBe("4.5");
    expect(byLabel.filedOn).toBe("2026-08-01");
  });

  // A bare `false` in a metadata list reads as a rendering fault rather than as
  // the value the page declares.
  it("renders a boolean as a word, including when it is false", async () => {
    expect(Object.fromEntries(rows(await fieldsFor({ syndicated: false }))).syndicated).toBe("No");
    expect(Object.fromEntries(rows(await fieldsFor({ syndicated: true }))).syndicated).toBe("Yes");
  });

  it("renders an array as a list, so an entry boundary stays visible", async () => {
    const block = await fieldsFor({ topics: ["politics", "local"] });
    expect(Array.from(block?.querySelectorAll("li") ?? []).map((n) => n.textContent)).toEqual([
      "politics",
      "local",
    ]);
  });

  it("renders an enum value as a state chip rather than bare text", async () => {
    const block = await fieldsFor({ stage: "filed" });
    expect(block?.querySelector(".entity-field-state")?.textContent).toBe("filed");
  });
});

describe("the three reachable value states", () => {
  it("omits a declared field the record does not carry", async () => {
    const block = await fieldsFor({ headline: "Alpha" });
    expect(rows(block).map(([label]) => label)).toEqual(["headline"]);
  });

  it("omits a declared field holding an empty string or empty list", async () => {
    const block = await fieldsFor({ headline: "Alpha", topics: [], filedOn: "   " });
    expect(rows(block).map(([label]) => label)).toEqual(["headline"]);
  });

  it("names an artifact reference but marks it unresolved, never verified", async () => {
    const block = await fieldsFor({ proofs: "photo:alpha@abc123" });
    expect(block?.querySelector(".entity-field-ref")?.textContent).toBe("photo:alpha@abc123");
    expect(block?.querySelector(".entity-field-unresolved")?.textContent).toContain("not verified");
  });

  it("renders no block at all when the record carries none of its declared fields", async () => {
    expect(await fieldsFor({})).toBeNull();
  });

  // The type is read off the wire, so an inherited `Object` property must not
  // resolve to a renderer: `__proto__` would throw when called and `constructor`
  // would invoke `Object`. Neither is reachable from a well-formed envelope, and
  // neither may break the page render.
  it("falls back to text for a declared type naming an inherited Object property", async () => {
    for (const type of ["__proto__", "constructor", "toString"]) {
      const doc = await mountPage({
        fields: [{ name: "odd", type }],
        frontmatter: { odd: "a value" },
      });
      const block = doc.querySelector("[data-entity-fields]");
      expect(block?.textContent, type).toContain("a value");
    }
  });

  // The same hazard on the other half of a declaration. The profile schema
  // constrains a field's TYPE to a closed enum but puts no `propertyNames` on
  // `fields`, so the NAME is the open half: a type may declare `constructor`,
  // and frontmatter arrives as JSON off the wire, carrying `Object.prototype`.
  // A bare `frontmatter[def.name]` therefore resolves an inherited member and
  // renders a value the record does not carry — the one thing this surface
  // exists not to do. Same class as the `titleField` lookup fixed in #187.
  it("omits a declared field naming an inherited Object property when the record lacks it", async () => {
    for (const name of ["constructor", "toString", "valueOf"]) {
      const doc = await mountPage({
        fields: [{ name, type: "string" }],
        frontmatter: { headline: "Ada" },
      });
      const block = doc.querySelector("[data-entity-fields]");
      expect(block?.textContent ?? "", name).not.toContain("native code");
      expect(block?.textContent ?? "", name).not.toContain("function");
    }
  });

  it("still renders such a field when the record genuinely carries it", async () => {
    const doc = await mountPage({
      fields: [{ name: "constructor", type: "string" }],
      frontmatter: { constructor: "hand-built" },
    });

    expect(rows(doc.querySelector("[data-entity-fields]"))).toEqual([["constructor", "hand-built"]]);
  });
});

describe("the block is confined to typed pages", () => {
  it("renders nothing for a default concept page, which declares no fields", async () => {
    const doc = await mountPage({
      directory: "concepts",
      frontmatter: { tags: ["a"], sources: ["s.md"] },
    });
    expect(doc.querySelector("[data-entity-fields]")).toBeNull();
  });

  it("still renders the default rail's own fields on that page", async () => {
    const doc = await mountPage({ directory: "concepts", frontmatter: { tags: ["a", "b"] } });
    const rail = doc.querySelector("[data-support-rail]");
    expect(rail?.textContent).toContain("Tags");
    expect(rail?.textContent).toContain("a, b");
  });
});

/**
 * The fixed rail list and the declared list can name the same key: a profile is
 * free to declare `tags` or `updatedAt`. Nothing a page displays today may
 * disappear, and nothing may be stated twice — so a declared name wins and the
 * fixed row for it stands down, while an UNDECLARED extra the page happens to
 * carry keeps rendering exactly as before.
 */
describe("a declared field and the fixed rail list never state the same key twice", () => {
  /** Mount a page whose type declares `tags` as a real field, and return the rail. */
  async function overlapRail(frontmatter: Record<string, unknown>): Promise<HTMLElement> {
    const doc = await mountPage({ fields: [{ name: "tags", type: "string[]" }], frontmatter });
    return doc.querySelector("[data-support-rail]") as HTMLElement;
  }

  it("states a declared name once, in the declared block", async () => {
    const rail = await overlapRail({ tags: ["politics"] });
    expect(rail.querySelectorAll("[data-entity-fields] dt")).toHaveLength(1);
    expect(rail.textContent?.match(/politics/g)).toHaveLength(1);
  });

  it("drops the fixed row for a name the profile declares", async () => {
    const rail = await overlapRail({ tags: ["politics"] });
    expect(rail.textContent).not.toContain("Tags");
  });

  it("still renders an undeclared extra the page carries", async () => {
    const rail = await overlapRail({ tags: ["politics"], aliases: ["alpha-story"] });
    expect(rail.textContent).toContain("Aliases");
    expect(rail.textContent).toContain("alpha-story");
  });
});

/**
 * A declared `format` turns a value into an external link. The guard lives in
 * `viewer-field-format.js` and is unit-tested there; these pin that the renderer
 * consults it, carries the safety attributes, and falls back to TEXT — never to
 * a link built anyway — when the guard declines.
 */
describe("a declared format renders as a safe external link", () => {
  /** Mount a page whose `locator` field declares `format`, typed for its value. */
  async function blockFor(format: string | undefined, locator: unknown): Promise<HTMLElement> {
    const type = Array.isArray(locator) ? "string[]" : "string";
    const field = format === undefined ? { name: "locator", type } : { name: "locator", type, format };
    const doc = await mountPage({ fields: [field], frontmatter: { locator } });
    return doc.querySelector("[data-entity-fields]") as HTMLElement;
  }

  it("links a doi through its resolver, showing the id the page declares", async () => {
    const anchor = (await blockFor("doi", "10.1000/xyz123")).querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://doi.org/10.1000/xyz123");
    expect(anchor?.textContent).toBe("10.1000/xyz123");
  });

  it("carries noopener noreferrer, since the value comes from page content", async () => {
    const anchor = (await blockFor("url", "https://example.org/a")).querySelector("a");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor?.getAttribute("target")).toBe("_blank");
  });

  it("renders a refused value as text, never as a link built anyway", async () => {
    const block = await blockFor("url", "javascript:alert(1)");
    expect(block.querySelector("a")).toBeNull();
    expect(block.textContent).toContain("javascript:alert(1)");
  });

  it("renders an unformatted field as text", async () => {
    const block = await blockFor(undefined, "https://example.org/a");
    expect(block.querySelector("a")).toBeNull();
  });

  it("links each entry of a formatted list independently", async () => {
    const block = await blockFor("url", ["https://a.test/", "not-a-url"]);
    const anchors = Array.from(block.querySelectorAll("a"));
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["https://a.test/"]);
    expect(block.textContent).toContain("not-a-url");
  });
});

/**
 * Findings from review, each pinned so the fix cannot quietly regress.
 */
describe("the declared block survives a cold deep link", () => {
  /**
   * `main()` renders the route twice — once immediately, once after `/api/pages`
   * settles — and `unsettledOrPageRoute` lets a page route resolve without the
   * envelope. Each pass issues its own `/api/page` fetch, with no ordering
   * guarantee, so this drives the awkward order: the FIRST page response is held
   * until after the second has already painted.
   *
   * HONEST SCOPE: this does not discriminate the current implementation. The
   * declared fields are resolved after the page fetch resolves, so a pass that
   * could read a stale envelope is also a pass that paints before the
   * settle-triggered one — the two conditions are mutually exclusive and the
   * later paint always carries the fields. What it pins is the OUTCOME a cold
   * deep link must reach whatever the ordering, which is what would break if the
   * resolution were ever moved ahead of the fetch.
   */
  it("ends with the declared fields when the first page response lands last", async () => {
    let releaseEnvelope: () => void = () => {};
    let releaseFirstPage: () => void = () => {};
    const envelopeGate = new Promise<void>((resolve) => (releaseEnvelope = resolve));
    const firstPageGate = new Promise<void>((resolve) => (releaseFirstPage = resolve));
    let pageCalls = 0;

    const envelope = {
      project: {},
      counts: {},
      pages: [],
      recentPages: [],
      index: {},
      profilePipeline: {
        entityTypes: [
          {
            type: "articles",
            directory: "wiki/articles",
            pageCount: 1,
            fields: [{ name: "headline", type: "string" }],
          },
        ],
      },
    };
    const page = {
      pageDirectory: "articles",
      entityType: "articles",
      slug: "alpha",
      title: "Alpha",
      html: "<p>Body.</p>",
      warnings: [],
      frontmatter: { headline: "Alpha" },
    };

    const responder: FetchResponder = (url) => {
      if (url.endsWith("/api/pages")) {
        return envelopeGate.then(() => jsonResponse(envelope)) as unknown as Response;
      }
      if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
      if (url.includes("/api/page/")) {
        pageCalls += 1;
        return pageCalls === 1
          ? (firstPageGate.then(() => jsonResponse(page)) as unknown as Response)
          : jsonResponse(page);
      }
      return null;
    };

    const { dom, flush } = await mountViewerDom(responder, "#/articles/alpha");
    releaseEnvelope();
    await flush();
    releaseFirstPage();
    await flush();
    await flush();
    const block = dom.window.document.querySelector("[data-entity-fields]");
    expect(block?.textContent).toContain("headline");
  });
});

describe("an artifactRef list is marked unresolved like a single ref", () => {
  // `renderList` would have rendered the entries as ordinary scalars, showing an
  // `artifactRef[]` indistinguishably from a verified value — the exact claim
  // `renderArtifactRef` exists to avoid making.
  it("names each ref and says once that none were verified", async () => {
    const doc = await mountPage({
      fields: [{ name: "results", type: "artifactRef[]" }],
      frontmatter: { results: ["result:a@aaa", "result:b@bbb"] },
    });
    const block = doc.querySelector("[data-entity-fields]") as HTMLElement;
    expect(Array.from(block.querySelectorAll(".entity-field-ref")).map((n) => n.textContent)).toEqual(
      ["result:a@aaa", "result:b@bbb"],
    );
    expect(block.querySelectorAll(".entity-field-unresolved")).toHaveLength(1);
  });
});

describe("the heading and the rail never state the title twice", () => {
  /** Mount a page whose type titles by `headline`, and return the rail. */
  async function titledRail(): Promise<HTMLElement> {
    const doc = await mountPage({
      fields: [
        { name: "headline", type: "string" },
        { name: "byline", type: "string" },
      ],
      frontmatter: { headline: "Alpha", byline: "R. Reporter" },
      titleField: "headline",
    });
    return doc.querySelector("[data-support-rail]") as HTMLElement;
  }

  it("omits the row for the field the heading already shows", async () => {
    const rail = await titledRail();
    expect(rail.textContent).not.toContain("headline");
  });

  it("still renders every other declared field", async () => {
    const rail = await titledRail();
    expect(rail.textContent).toContain("byline");
    expect(rail.textContent).toContain("R. Reporter");
  });
});
