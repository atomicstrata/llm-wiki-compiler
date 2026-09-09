/**
 * llmwiki viewer — graph view module.
 *
 * Renders a D3 force-directed graph of wiki page links at the `#/graph`
 * route. Expects `globalThis.d3` to be set by the D3 IIFE bundle loaded
 * as a `<script>` tag in index.html before this module runs.
 *
 * Colour lives entirely in viewer-graph.css. D3 assigns semantic classes —
 * `graph-node graph-node--<kind>` on nodes, `graph-edge`/`graph-edge--relation`
 * on edges — rather than a hardcoded SVG fill/stroke presentation attribute,
 * because presentation attributes cannot read CSS custom properties: a graph
 * coloured that way would stay dark when the viewer switches to the light
 * theme. `nodeClass()` resolves the design system's four node semantics —
 * concept, entity, stale, dangling — in that priority order (a dangling
 * target has no backing page at all; a stale page outranks its kind because
 * "the source moved on" is the more urgent fact). `GraphNode` carries no
 * freshness field, so `staleIdsFromEnvelope()` joins it client-side from the
 * `/api/pages` envelope the caller already holds — both `#/graph` (viewer.js)
 * and the dashboard's compact panel (viewer-dashboard.js) pass it in.
 * `LEGEND_KINDS` is exported for the same reason: the dashboard panel
 * renders its own compact legend row (compact mode suppresses this file's
 * overlay legend — see `loadGraph`'s JSDoc) from the identical four-entry
 * list `nodeClass()` resolves against, rather than a second copy that
 * could silently drift out of sync.
 *
 * The canvas is deliberately label-free — no per-node `<text>` — because at
 * 128 nodes the labels overlapped into noise. Identification lives in the
 * hover tooltip (title, kind, connection count) and the legend (page
 * header). Each node group holds two circles: a halo (`.graph-halo`, drawn
 * first so it sits behind the node, invisible until hot) and the node
 * itself (`.graph-node`). Node radius and stroke width stay data-driven
 * `.attr()` calls because they come from degree and the active mode's
 * settings, not from the theme.
 *
 * Typed relation edges get the `graph-edge--relation` class and carry the
 * `relationType` as a tooltip title. Symmetric relation edges have no
 * arrowhead; directed and wikilink edges use the arrowhead marker.
 *
 * `loadGraph()` is the one entry point for two callers — the full `#/graph`
 * route and the dashboard's compact `[data-graph-panel]` — so the panel can
 * never drift into a second, decorative renderer. `options.compact` selects
 * full vs compact sizing (radius bounds, drag) and, for compact, derives its
 * link distance/charge from the live panel size and node count rather than
 * a fixed pair of numbers (see `resolveSettings`/`compactForces`) — the
 * fetch call and the force-simulation builder stay single-instance in both
 * modes regardless.
 */

import { emptyState } from "./viewer-dom.js";
import { plural } from "./viewer-format.js";

/**
 * Force and sizing parameters per mode. Compact serves the dashboard's
 * `[data-graph-panel]` — a small, fluid-width panel (roughly half the main
 * column, collapsing to full width under 900px) about 296px tall. Its
 * radius/drag stay fixed here; its linkDistance/charge are derived per
 * render from the panel's live size and node count instead (`compactForces`
 * below) — a fixed pair tuned for one viewport left an 8-node graph a tiny
 * knot in a much bigger panel at every other size (see the fidelity audit).
 */
const MODE_SETTINGS = {
  full:    { linkDistance: 80, charge: -200, minRadius: 4,   maxRadius: 10, drag: true },
  compact: { minRadius: 2.5, maxRadius: 6, drag: false },
};
const ARROWHEAD_MARKER_ID   = 'llmwiki-arrowhead';
const HIGH_DEGREE_THRESHOLD = 5;
/** Zoom scale bounds, shared by the interactive zoom behaviour and the "Fit" action below. */
const ZOOM_SCALE_EXTENT = [0.1, 4];

/**
 * Compact-force tuning constants (used by `compactForces`, below).
 * `COMPACT_REF_PER_NODE` is that function's `perNode` for the reference
 * case this pass measured and tuned against — the demo wiki's 8-node graph
 * in a ~443×304 panel (sqrt(443 * 296 / 8) ≈ 128). `COMPACT_LINK_DISTANCE_
 * FACTOR` and `COMPACT_CHARGE_FACTOR` are calibrated at exactly that point;
 * see `compactForces` for why that calibration holds regardless of
 * `COMPACT_FALLOFF_EXPONENT`. That exponent steepens how fast the derived
 * forces shrink for graphs bigger than the reference: exponent 1 (plain
 * linear-in-perNode scaling) still left an 80-node graph overflowing the
 * panel by up to ~195px; 2.65 was the smallest value that cleared it,
 * checked with Playwright against 8/37/80/290-node fixtures (see the
 * fidelity pass's probe2.mjs).
 */
const COMPACT_REF_PER_NODE = 128;
const COMPACT_FALLOFF_EXPONENT = 2.65;
const COMPACT_LINK_DISTANCE_FACTOR = 1.39;
const COMPACT_CHARGE_FACTOR = 4.69;

/**
 * Derive compact mode's linkDistance/charge from the panel's actual size
 * and node count, rather than the fixed pair of numbers this replaced (the
 * root cause of the "tiny knot" bug — see the fidelity audit). `perNode` is
 * the side of the square each node would own if the panel's area were split
 * evenly across them: a per-node spacing budget that shrinks as the panel
 * narrows or the graph grows, so the layout stays fluid instead of tuned to
 * one viewport.
 *
 * Scaling `linkDistance`/`charge` directly off `perNode` (exponent 1) is
 * not steep enough — a well-connected graph's on-screen footprint does not
 * shrink linearly with reduced per-node spacing — so `COMPACT_FALLOFF_
 * EXPONENT` steepens the falloff above the reference graph size. The
 * exponent cannot move the reference case itself: at
 * `perNode === COMPACT_REF_PER_NODE`, `(perNode / REF) ** (exponent - 1)`
 * is always 1, so `scaled === perNode` no matter which exponent is chosen.
 *
 * @param {number} width - Panel width in the simulation's own units (the
 *   container's `clientWidth` at mount).
 * @param {number} height - Panel height, same units.
 * @param {number} nodeCount - Node count of the graph being laid out.
 * @returns {{linkDistance: number, charge: number}}
 */
function compactForces(width, height, nodeCount) {
  const perNode = Math.sqrt((width * height) / Math.max(1, nodeCount));
  const scaled = perNode * (perNode / COMPACT_REF_PER_NODE) ** (COMPACT_FALLOFF_EXPONENT - 1);
  return {
    linkDistance: scaled * COMPACT_LINK_DISTANCE_FACTOR,
    charge: -scaled * COMPACT_CHARGE_FACTOR,
  };
}

/**
 * Resolve the force/sizing settings for one render. Full mode's numbers are
 * the fixed `MODE_SETTINGS.full` object, unchanged by this function
 * (`test/viewer-graph-compact.test.ts` pins its literal source text).
 * Compact mode keeps `MODE_SETTINGS.compact`'s radius/drag constants but
 * replaces its old fixed linkDistance/charge with `compactForces`'s
 * live-sized ones.
 *
 * @param {{compact?: boolean}} options - `loadGraph`'s own options.
 * @param {number} width - Container width (simulation units).
 * @param {number} height - Container height (simulation units).
 * @param {number} nodeCount - Node count of the graph being laid out.
 */
function resolveSettings(options, width, height, nodeCount) {
  if (!options.compact) return MODE_SETTINGS.full;
  return { ...MODE_SETTINGS.compact, ...compactForces(width, height, nodeCount) };
}

/**
 * Freshness states that colour a node amber. `GraphNode` carries no freshness
 * field, so the ids are joined from /api/pages — data the client already holds.
 */
const STALE_STATUSES = new Set(["stale", "orphaned"]);

/** True for a ghost node with no backing page — a broken wikilink or relation target. */
function isDanglingNode(d) {
  return d.isDangling === true || d.kind === "dangling";
}

/**
 * Resolve the semantic class for a node. Colour lives entirely in
 * viewer-graph.css so both themes are handled by the stylesheet — SVG
 * presentation attributes cannot read CSS custom properties.
 *
 * Order is deliberate: a dangling target has no page at all, and a stale page
 * outranks its kind because "the source moved on" is the more urgent fact.
 *
 * @param {object} d - The node datum.
 * @param {Set<string>} staleIds - Page ids whose freshness is stale or orphaned.
 */
function nodeClass(d, staleIds) {
  if (isDanglingNode(d)) return "graph-node graph-node--dangling";
  if (staleIds.has(d.id)) return "graph-node graph-node--stale";
  if (d.nodeKind === "entity") return "graph-node graph-node--entity";
  return "graph-node graph-node--concept";
}

/** The `pages` array of an /api/pages envelope, or `[]` when absent/malformed. */
function pagesFromEnvelope(envelope) {
  return Array.isArray(envelope?.pages) ? envelope.pages : [];
}

/** True when a page's computed freshness is stale or orphaned. */
function isStalePage(page) {
  return STALE_STATUSES.has(page.freshness?.freshnessStatus);
}

/**
 * Build the stale-id set from an /api/pages envelope. Returns an empty set
 * when the envelope is absent, so a failed page fetch degrades the graph to
 * kind-only colouring rather than breaking it.
 */
export function staleIdsFromEnvelope(envelope) {
  const ids = new Set();
  for (const page of pagesFromEnvelope(envelope)) {
    if (isStalePage(page)) ids.add(page.id);
  }
  return ids;
}

/** Map a node's degree to a circle radius using a linear scale. */
function radiusForDegree(degree, maxDegree, settings) {
  const { minRadius, maxRadius } = settings;
  if (maxDegree === 0) return minRadius;
  return minRadius + (degree / maxDegree) * (maxRadius - minRadius);
}

/** Build the tooltip DOM element and append it to the container. */
function buildTooltip(container) {
  const tip = document.createElement('div');
  tip.className = 'graph-tooltip';

  const title = document.createElement('div');
  title.className = 'tip-title';

  const meta = document.createElement('div');
  meta.className = 'tip-meta';

  const hint = document.createElement('div');
  hint.className = 'tip-hint';
  hint.textContent = 'Click to open page';

  tip.appendChild(title);
  tip.appendChild(meta);
  tip.appendChild(hint);
  container.appendChild(tip);
  return tip;
}

/** Position the tooltip near the cursor, keeping it within the SVG bounds. */
function positionTooltip(tooltip, event, svgEl) {
  const rect = svgEl.getBoundingClientRect();
  const size = tooltipSize(tooltip);
  const desired = {
    left: event.clientX - rect.left + 14,
    top:  event.clientY - rect.top  - 50,
  };
  const { left, top } = clampTooltipPosition(desired, size, rect);
  tooltip.style.left    = left + 'px';
  tooltip.style.top     = top  + 'px';
  tooltip.style.display = 'block';
}

/** Tooltip box dimensions with the same fallback defaults the previous inline `||` used. */
function tooltipSize(tooltip) {
  return {
    width:  tooltip.offsetWidth  || 220,
    height: tooltip.offsetHeight || 60,
  };
}

/** Clamp a tooltip's top-left so it stays within the SVG bounds with the existing margins. */
function clampTooltipPosition(pos, size, rect) {
  let { left, top } = pos;
  if (left + size.width  > rect.width)  left = rect.width  - size.width  - 8;
  if (top  < 0)                         top  = 4;
  if (top  + size.height > rect.height) top  = rect.height - size.height - 8;
  return { left, top };
}

/** Create the SVG element, a zoom-aware inner group, and the tooltip. */
function initGraph(container) {
  const d3     = globalThis.d3;
  const width  = container.clientWidth  || 800;
  const height = container.clientHeight || 600;

  const svg = d3.select(container)
    .append('svg')
    .attr('width',   '100%')
    .attr('height',  '100%')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .style('cursor', 'grab');

  const g = svg.append('g');

  const zoom = d3.zoom()
    .scaleExtent(ZOOM_SCALE_EXTENT)
    .on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoom);

  const tooltip = buildTooltip(container);
  return { svg, g, zoom, width, height, tooltip };
}

/** Update edge and node SVG positions after each simulation tick. */
function onTick(edgeSel, nodeSel) {
  edgeSel
    .attr('x1', d => d.source.x)
    .attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x)
    .attr('y2', d => d.target.y);
  nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
}

/**
 * Dim everything, mark the hovered node and its edges hot. Each node group
 * holds two circles (halo + node), so both are targeted by class rather than
 * by tag — a bare `.select('circle')` would hit whichever circle comes
 * first in document order (the halo), not the node.
 */
function applyHighlight(hoveredId, edgeSel, nodeSel) {
  edgeSel.classed('is-dimmed', true).classed('is-hot', false);
  nodeSel.select('.graph-node').classed('is-dimmed', true).classed('is-hot', false);
  nodeSel.select('.graph-halo').classed('is-hot', false);

  edgeSel
    .filter(d => d.source.id === hoveredId || d.target.id === hoveredId)
    .classed('is-dimmed', false)
    .classed('is-hot', true);

  const hovered = nodeSel.filter(d => d.id === hoveredId);
  hovered.select('.graph-node').classed('is-dimmed', false).classed('is-hot', true);
  hovered.select('.graph-halo').classed('is-hot', true);
}

/** Clear every highlight class, including the halo. */
function resetHighlight(edgeSel, nodeSel) {
  edgeSel.classed('is-dimmed', false).classed('is-hot', false);
  nodeSel.select('.graph-node').classed('is-dimmed', false).classed('is-hot', false);
  nodeSel.select('.graph-halo').classed('is-hot', false);
}

/** Attach drag behaviour to node groups so users can reposition nodes. */
function attachDrag(nodeSel, sim) {
  nodeSel.call(globalThis.d3.drag()
    .on('start', (event, d) => {
      if (!event.active) sim.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on('drag', (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
    })
    .on('end', (event, d) => {
      if (!event.active) sim.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    })
  );
}

/** Build the tooltip meta-line text for a node datum. */
function nodeMetaText(d) {
  if (d.isDangling) return 'missing page · ' + plural(d.degree, 'reference');
  const kindLabel = d.nodeKind === 'entity' ? 'entity · ' + d.entityType : d.kind;
  return kindLabel + ' · ' + plural(d.degree, 'connection');
}

/** Wire hover and click interactions onto node groups. */
function attachHover(nodeSel, edgeSel, tooltip, svg) {
  nodeSel
    .on('mouseenter', function(event, d) {
      applyHighlight(d.id, edgeSel, nodeSel);
      tooltip.querySelector('.tip-title').textContent = d.title;
      tooltip.querySelector('.tip-meta').textContent = nodeMetaText(d);
      positionTooltip(tooltip, event, svg.node());
    })
    .on('mousemove', function(event) {
      positionTooltip(tooltip, event, svg.node());
    })
    .on('mouseleave', function() {
      resetHighlight(edgeSel, nodeSel);
      tooltip.style.display = 'none';
    })
    .on('click', function(_event, d) {
      if (d.isDangling) return;
      const hash = nodeRouteHash(d);
      if (hash !== null) location.hash = hash;
    });
}

/**
 * The `#/<directory>/<slug>` hash a node routes to, or null when it has no id.
 *
 * Built from `id`, NOT from `directory`, because that field means two different
 * things depending on where the node came from: a default page reports its
 * ROUTE segment (`concepts`), while a typed entity page reports its ON-DISK
 * directory (`wiki/articles`, see `EntityPageNode.directory` in
 * src/viewer/graph.ts). Encoding the latter turned the slash into `%2F`, so a
 * click on any typed node navigated to `#/wiki%2Farticles/<slug>` and the page
 * route answered 400 — the directory segment is matched against the profile's
 * declared entity types, and `wiki%2Farticles` is not one of them.
 *
 * `id` is already `<routeDirectory>/<slug>` for BOTH kinds
 * (`concepts/change-detection`, `articles/arena-deal-spiked`), so it is the one
 * field that needs no per-kind branch. Split on the FIRST separator only: a
 * dangling target's slug can itself contain one.
 *
 * @param {{id?: string}} node - A graph node datum.
 * @returns {string|null}
 */
function nodeRouteHash(node) {
  const id = typeof node.id === 'string' ? node.id : '';
  const cut = id.indexOf('/');
  if (cut <= 0 || cut === id.length - 1) return null;
  const directory = id.slice(0, cut);
  const slug = id.slice(cut + 1);
  return '#/' + encodeURIComponent(directory) + '/' + encodeURIComponent(slug);
}

/**
 * Append the circle for each node group. Labels are absent in both modes,
 * per the design system's label-free canvas.
 *
 * @param {object} nodeSel - D3 selection of node groups.
 * @param {{maxDegree: number, staleIds: Set<string>, settings: object}} ctx - Render context.
 */
function appendNodeVisuals(nodeSel, ctx) {
  // Halo ring, drawn first so it sits behind the node. Invisible until the
  // node is hot — the design system's "focus · halo ring" semantic.
  nodeSel.append('circle')
    .attr('class', 'graph-halo')
    .attr('r',     d => radiusForDegree(d.degree, ctx.maxDegree, ctx.settings) + 9);

  nodeSel.append('circle')
    .attr('class',            d => nodeClass(d, ctx.staleIds))
    .attr('r',                d => radiusForDegree(d.degree, ctx.maxDegree, ctx.settings))
    .attr('stroke-dasharray', d => d.isDangling ? '3,2' : null)
    .attr('stroke-width',     d => d.degree > HIGH_DEGREE_THRESHOLD ? 2.5 : d.degree > 0 ? 2 : 1);
}

/** Append the arrowhead marker definition; its fill comes from the stylesheet. */
function appendArrowheadDef(svg) {
  svg.append('defs').append('marker')
    .attr('id',           ARROWHEAD_MARKER_ID)
    .attr('viewBox',      '0 -4 8 8')
    .attr('refX',         8)
    .attr('refY',         0)
    .attr('markerWidth',  6)
    .attr('markerHeight', 6)
    .attr('orient',       'auto')
    .append('path')
    .attr('class', 'graph-arrowhead')
    .attr('d',     'M0,-4L8,0L0,4');
}

/**
 * Apply structural edge styling. Colour comes from viewer-graph.css via the
 * class; only the arrowhead decision and the relation tooltip are data-driven.
 * Symmetric relations get no arrowhead; directed and wikilink edges do.
 *
 * @param {object} edgeSel - The D3 line selection bound to edge data.
 * @returns {object} The same selection (for chaining).
 */
function styleEdges(edgeSel) {
  return edgeSel
    .attr('class',      d => d.edgeKind === 'relation' ? 'graph-edge graph-edge--relation' : 'graph-edge')
    .attr('title',      d => d.edgeKind === 'relation' ? d.relationType : null)
    .attr('marker-end', d => d.direction === 'symmetric' ? null : `url(#${ARROWHEAD_MARKER_ID})`);
}

/**
 * Build and run the D3 simulation; append edges, nodes, and interactions.
 *
 * @param {{svg: object, g: object, width: number, height: number, tooltip: HTMLElement}} view -
 *   The object `initGraph()` returns — collapsed into one argument rather than
 *   five positional ones.
 * @param {{nodes: object[], edges: object[]}} data - The `/api/graph` payload.
 * @param {{compact?: boolean, staleIds?: Set<string>}} options - `compact` selects
 *   full vs compact settings (see `resolveSettings`); `staleIds` feeds
 *   `nodeClass()` via the render context.
 */
function renderGraph(view, data, options) {
  const d3 = globalThis.d3;
  const settings = resolveSettings(options, view.width, view.height, data.nodes.length);
  const maxDegree = Math.max(0, ...data.nodes.map(n => n.degree));
  const ctx = { maxDegree, staleIds: options.staleIds ?? new Set(), settings };

  appendArrowheadDef(view.svg);

  const sim = d3.forceSimulation(data.nodes)
    .force('link',   d3.forceLink(data.edges).id(d => d.id).distance(settings.linkDistance))
    .force('charge', d3.forceManyBody().strength(settings.charge))
    .force('center', d3.forceCenter(view.width / 2, view.height / 2));

  const edgeSel = styleEdges(view.g.append('g').selectAll('line').data(data.edges).join('line'));

  const nodeSel = view.g.append('g')
    .selectAll('g')
    .data(data.nodes)
    .join('g')
    .style('cursor', d => d.isDangling ? 'default' : 'pointer');

  appendNodeVisuals(nodeSel, ctx);
  if (settings.drag) attachDrag(nodeSel, sim);
  attachHover(nodeSel, edgeSel, view.tooltip, view.svg);

  // Stop the simulation when the SVG leaves the document (route change).
  sim.on('tick', () => {
    if (!view.svg.node().isConnected) { sim.stop(); return; }
    onTick(edgeSel, nodeSel);
  });

  return { sim, edgeSel, nodeSel };
}

/** Duration (ms) of the "Fit" zoom transition; skipped under prefers-reduced-motion. */
const FIT_TRANSITION_MS = 750;
/** Breathing room (px) kept between the fitted node bounding box and the panel edge. */
const FIT_PADDING_PX = 32;
/** Smallest bounding-box span treated as non-zero, so a one-node graph cannot divide by zero. */
const FIT_MIN_EXTENT = 1;

/** True when the OS/browser requests reduced motion; the fit action skips its transition then. */
function prefersReducedMotion() {
  return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Compute the axis-aligned bounding box of each node's current simulation
 * position. Reads live `.x`/`.y` (not a cached layout captured at render
 * time) so "Fit" reflects wherever the simulation and any drag have
 * actually settled the nodes by the time the user clicks it. Non-finite
 * coordinates are filtered out first — `Math.min`/`Math.max` of zero
 * arguments fall back to their `Infinity`/`-Infinity` identities, the same
 * "nothing found" values a caller would seed a manual scan with.
 *
 * @param {object[]} nodes - Node data bound to the rendered node selection.
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
 */
function nodeBoundingBox(nodes) {
  const xs = nodes.map((d) => d.x).filter(Number.isFinite);
  const ys = nodes.map((d) => d.y).filter(Number.isFinite);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

/**
 * Build the zoom transform that centres and scales a node bounding box to
 * fill `width`×`height` with `FIT_PADDING_PX` of breathing room — the
 * standard "translate to the viewport centre, scale, then translate back by
 * the box's own centre" construction, capped at the maximum magnification.
 *
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} box - From `nodeBoundingBox`.
 * @param {number} width - Panel width (simulation units).
 * @param {number} height - Panel height (simulation units).
 */
function fitTransform(box, width, height) {
  const boxWidth  = Math.max(box.maxX - box.minX, FIT_MIN_EXTENT);
  const boxHeight = Math.max(box.maxY - box.minY, FIT_MIN_EXTENT);
  const scale = Math.min(
    Math.min((width - FIT_PADDING_PX * 2) / boxWidth, (height - FIT_PADDING_PX * 2) / boxHeight),
    ZOOM_SCALE_EXTENT[1],
  );
  const centerX = (box.minX + box.maxX) / 2;
  const centerY = (box.minY + box.maxY) / 2;
  return globalThis.d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(scale)
    .translate(-centerX, -centerY);
}

/**
 * Build the "Fit" control's action for one render. Recomputes the node
 * bounding box from LIVE simulation positions on every call — not a
 * snapshot taken when the graph first rendered — so it reflects panning or
 * dragging that happened before the click. Applies the transform through
 * the zoom behaviour itself (`zoom.transform`, the same one mouse/wheel/drag
 * gestures drive) rather than writing the `<g>` transform attribute
 * directly, so d3-zoom's own internal transform stays in sync — otherwise
 * the next user pan would jump to wherever the zoom behaviour last thought
 * it was.
 *
 * @param {{svg: object, zoom: object, width: number, height: number}} view - From `initGraph`.
 * @param {object} nodeSel - The rendered node selection (from `renderGraph`).
 * @returns {() => void} The `fit()` action.
 */
function makeFitAction(view, nodeSel) {
  return function fit({ animate = true } = {}) {
    const transform = fitTransform(nodeBoundingBox(nodeSel.data()), view.width, view.height);
    view.zoom.scaleExtent([Math.min(ZOOM_SCALE_EXTENT[0], transform.k), ZOOM_SCALE_EXTENT[1]]);
    const target = !animate || prefersReducedMotion()
      ? view.svg
      : view.svg.transition().duration(FIT_TRANSITION_MS);
    target.call(view.zoom.transform, transform);
  };
}

/**
 * Legend entries: label plus the node class whose swatch it shows. Exported
 * so the dashboard's compact panel (viewer-dashboard.js) can render its own
 * inline legend row from the same four semantics `nodeClass()` resolves
 * against, rather than hardcoding a second copy that could drift out of
 * sync with this one.
 */
export const LEGEND_KINDS = [
  { label: 'concept',  kind: 'concept' },
  { label: 'entity',   kind: 'entity' },
  { label: 'stale',    kind: 'stale' },
  { label: 'dangling', kind: 'dangling' },
];

/** Build one legend row with a class-styled swatch. */
function buildLegendItem(label, kindClass) {
  const item = document.createElement('div');
  item.className = 'graph-legend-item';
  const dot = document.createElement('div');
  dot.className = `graph-legend-dot graph-legend-dot--${kindClass}`;
  item.appendChild(dot);
  item.appendChild(document.createTextNode(label));
  return item;
}

/** Build the legend item for the relation edge kind (dashed swatch + label). */
function buildRelationLegendItem() {
  return buildLegendItem('relation', 'relation');
}

/** Append the "Edge kind" heading + the relation-edge legend item to the legend. */
function appendEdgeKindSection(legend) {
  const edgeHeading = document.createElement('div');
  edgeHeading.className = 'graph-legend-heading';
  edgeHeading.textContent = 'Edge kind';
  legend.appendChild(edgeHeading);

  legend.appendChild(buildRelationLegendItem());
}

/** Build and append the kind/size legend overlay to the container. */
function buildLegend(container) {
  const legend = document.createElement('div');
  legend.className = 'graph-legend';

  const kindHeading = document.createElement('div');
  kindHeading.className = 'graph-legend-heading';
  kindHeading.textContent = 'Node kind';
  legend.appendChild(kindHeading);

  for (const { label, kind } of LEGEND_KINDS) {
    legend.appendChild(buildLegendItem(label, kind));
  }

  appendEdgeKindSection(legend);

  const sizeHeading = document.createElement('div');
  sizeHeading.className = 'graph-legend-heading';
  sizeHeading.textContent = 'Node size';
  legend.appendChild(sizeHeading);

  const sizeNote = document.createElement('div');
  sizeNote.className = 'graph-legend-item';
  sizeNote.textContent = 'larger = more connections';
  legend.appendChild(sizeNote);

  container.appendChild(legend);
}

/** True once `/api/graph` returned at least one node to draw. */
function hasRenderableNodes(data) {
  return Boolean(data?.nodes?.length);
}

/** Show the design system empty state when the wiki has no pages yet. */
function renderEmptyState(container) {
  container.appendChild(
    emptyState(
      "Nothing to graph yet",
      "The graph draws links between compiled pages. Compile at least two pages that reference each other to see structure here.",
      "$ llmwiki compile",
    ),
  );
}

/**
 * Entry point for both the `#/graph` route (viewer.js) and the dashboard's
 * compact panel (viewer-dashboard.js). Fetches `/api/graph`, builds the SVG,
 * and settles the initial force layout before fitting it to the viewport —
 * the same fetch call and simulation
 * builder run in both modes; only the resolved settings differ (see
 * `resolveSettings`).
 *
 * @param {HTMLElement} container - Element to render into.
 * @param {{compact?: boolean, staleIds?: Set<string>}} [options] - Compact mode
 *   drops the legend and drag and tightens the forces for a small panel.
 *   `staleIds` comes from `staleIdsFromEnvelope()` over the already-fetched
 *   `/api/pages` envelope; a caller that omits it gets kind-only colouring
 *   (no stale nodes highlighted).
 * Initial framing follows yielding layout batches; explicit Fit clicks retain their transition.
 * User zoom/pan is not subsequently overridden by a deferred automatic fit.
 * @returns {Promise<{fit: () => void}|null>} A control handle exposing
 *   `fit()` (see `makeFitAction`), or `null` when nothing was rendered — no
 *   data, an empty graph, a failed fetch, or cancellation on navigation. Callers use the `null` case to
 *   know a "Fit" affordance has nothing to act on (see viewer-dashboard.js's
 *   `mountGraphPanel`).
 */
export async function loadGraph(container, options = {}) {
  const data = await fetchGraphData(container);
  if (!data) return null;
  if (!hasRenderableNodes(data)) {
    renderEmptyState(container);
    return null;
  }
  return renderSettledGraph(container, data, options);
}

/** Frame a populated graph only after its initial layout has settled. */
async function renderSettledGraph(container, data, options) {
  const view = initGraph(container);
  view.svg.style('visibility', 'hidden');
  const { sim, edgeSel, nodeSel } = renderGraph(view, data, options);
  // Settle before framing: fitting the initial seed positions would let the
  // force layout drift outside the viewport again after the first paint.
  sim.stop();
  if (!await settleLayout(view, sim, container)) return null;
  onTick(edgeSel, nodeSel);
  if (!options.compact) buildLegend(container);
  const fit = makeFitAction(view, nodeSel);
  fit({ animate: false });
  view.svg.style('visibility', null);
  return { fit };
}

/** Maximum layout work per batch; yielding keeps navigation responsive. */
const LAYOUT_BATCH_MS = 8;

/** Run one bounded batch, allowing a single force tick to finish atomically. */
function stepLayout(sim) {
  const start = performance.now();
  do { sim.tick(); }
  while (sim.alpha() > sim.alphaMin() && performance.now() - start < LAYOUT_BATCH_MS);
}

/** Settle off-screen without blocking navigation or overriding a user's first gesture. */
async function settleLayout(view, sim, container) {
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Arranging graph…';
  container.prepend(status);
  try {
    while (sim.alpha() > sim.alphaMin()) {
      if (!view.svg.node().isConnected) return false;
      stepLayout(sim);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return view.svg.node().isConnected;
  } finally {
    status.remove();
  }
}

/** Fetch /api/graph and parse JSON; render an inline error banner and return null on failure. */
async function fetchGraphData(container) {
  try {
    const res = await fetch('/api/graph', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (err) {
    showGraphLoadError(container, err);
    return null;
  }
}

/** Append the "Could not load graph" warning banner with the error message. */
function showGraphLoadError(container, err) {
  const p = document.createElement('p');
  p.className = 'warning-banner';
  p.textContent = 'Could not load graph: ' + err.message;
  container.appendChild(p);
}
