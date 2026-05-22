/**
 * llmwiki viewer — graph view module.
 *
 * Renders a D3 force-directed graph of wiki page links at the `#/graph`
 * route. Expects `globalThis.d3` to be set by the D3 IIFE bundle loaded
 * as a `<script>` tag in index.html before this module runs.
 *
 * Nodes are coloured by frontmatter `kind` and sized by total degree
 * (in-degree + out-degree). Hovering a node saturates it and highlights
 * all connected edges (both directions). Clicking navigates to the page.
 */

const MIN_RADIUS = 4;
const MAX_RADIUS = 10;

const KIND_COLORS = {
  concept:    { rest: '#1c3e67', restStroke: '#1565c0', fill: '#1565c0', stroke: '#4fc3f7', hot: '#1e88e5', strokeHot: '#82d9ff' },
  entity:     { rest: '#143f44', restStroke: '#00695c', fill: '#00695c', stroke: '#80cbc4', hot: '#00897b', strokeHot: '#b2dfdb' },
  comparison: { rest: '#653724', restStroke: '#e65100', fill: '#e65100', stroke: '#ffb74d', hot: '#f4511e', strokeHot: '#ffcc80' },
  overview:   { rest: '#1e3c2f', restStroke: '#1b5e20', fill: '#1b5e20', stroke: '#81c784', hot: '#2e7d32', strokeHot: '#a5d6a7' },
};

const ORPHAN_COLOR   = { fill: '#212121', stroke: '#424242', hot: '#37474f', strokeHot: '#607d8b' };
const DANGLING_COLOR = { fill: '#0f172a', stroke: '#475569', hot: '#1e293b', strokeHot: '#94a3b8' };
const DEFAULT_EDGE_STROKE  = '#374151';
const HOT_EDGE_STROKE      = '#60a5fa';
const HIGH_DEGREE_THRESHOLD = 5;
const RESTING_FILL   = '#374151';
const RESTING_STROKE = '#4b5563';

/** Return the hover color config for a node (kind + degree determine the palette). */
function colorForNode(kind, degree) {
  if (kind === 'dangling') return DANGLING_COLOR;
  if (degree === 0) return ORPHAN_COLOR;
  return KIND_COLORS[kind] || KIND_COLORS.concept;
}

/** Return the resting (non-hovered) fill and stroke for a node, tinted by kind. */
function restColorsForNode(kind) {
  if (kind === 'dangling') return { fill: RESTING_FILL, stroke: RESTING_STROKE };
  const c = KIND_COLORS[kind] || KIND_COLORS.concept;
  return { fill: c.rest, stroke: c.restStroke };
}

/** Map a node's degree to a circle radius using a linear scale. */
function radiusForDegree(degree, maxDegree) {
  if (maxDegree === 0) return MIN_RADIUS;
  return MIN_RADIUS + (degree / maxDegree) * (MAX_RADIUS - MIN_RADIUS);
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
    .scaleExtent([0.1, 4])
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


/** Dim all nodes/edges, saturate the hovered node, highlight its edges only. */
function applyHighlight(hoveredId, edgeSel, nodeSel, maxDegree) {
  edgeSel
    .attr('stroke', '#1a2233')
    .attr('stroke-opacity', 0.25)
    .attr('stroke-width', 1.2);

  nodeSel.select('circle').style('filter', 'brightness(0.3)');

  const hotEdges = edgeSel.filter(
    d => d.source.id === hoveredId || d.target.id === hoveredId
  );
  hotEdges.attr('stroke', HOT_EDGE_STROKE).attr('stroke-opacity', 1).attr('stroke-width', 2);

  const hoveredSel = nodeSel.filter(d => d.id === hoveredId);
  hoveredSel.select('circle')
    .attr('fill',   d => colorForNode(d.kind, d.degree).hot)
    .attr('stroke', d => colorForNode(d.kind, d.degree).strokeHot)
    .style('filter', 'brightness(1.5) saturate(2) drop-shadow(0 0 6px #60a5fa)');
  hoveredSel.select('text')
    .attr('y', d => radiusForDegree(d.degree, maxDegree) + 8);
}

/** Restore all edges and nodes to their default visual state. */
function resetHighlight(edgeSel, nodeSel, maxDegree) {
  edgeSel
    .attr('stroke', DEFAULT_EDGE_STROKE)
    .attr('stroke-opacity', 0.7)
    .attr('stroke-width', 1.2);

  nodeSel.select('circle')
    .style('filter', null)
    .attr('fill',   d => restColorsForNode(d.kind).fill)
    .attr('stroke', d => restColorsForNode(d.kind).stroke);
  nodeSel.select('text').attr('y', d => radiusForDegree(d.degree, maxDegree) + 3);
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

/** Wire hover and click interactions onto node groups. */
function attachHover(nodeSel, edgeSel, tooltip, svg, maxDegree) {
  nodeSel
    .on('mouseenter', function(event, d) {
      applyHighlight(d.id, edgeSel, nodeSel, maxDegree);
      tooltip.querySelector('.tip-title').textContent = d.title;
      tooltip.querySelector('.tip-meta').textContent = d.isDangling
        ? 'missing page · ' + d.degree + ' reference' + (d.degree !== 1 ? 's' : '')
        : d.kind + ' · ' + d.degree + ' connection' + (d.degree !== 1 ? 's' : '');
      positionTooltip(tooltip, event, svg.node());
    })
    .on('mousemove', function(event) {
      positionTooltip(tooltip, event, svg.node());
    })
    .on('mouseleave', function() {
      resetHighlight(edgeSel, nodeSel, maxDegree);
      tooltip.style.display = 'none';
    })
    .on('click', function(_event, d) {
      if (d.isDangling) return;
      location.hash = '#/' + encodeURIComponent(d.directory) + '/' + encodeURIComponent(d.slug);
    });
}

/** Append circle and label children to each node group. */
function appendNodeVisuals(nodeSel, maxDegree) {
  nodeSel.append('circle')
    .attr('r',                d => radiusForDegree(d.degree, maxDegree))
    .attr('fill',             d => restColorsForNode(d.kind).fill)
    .attr('stroke',           d => restColorsForNode(d.kind).stroke)
    .attr('stroke-dasharray', d => d.isDangling ? '3,2' : null)
    .attr('stroke-width',     d => d.degree > HIGH_DEGREE_THRESHOLD ? 2.5 : d.degree > 0 ? 2 : 1);

  nodeSel.append('text')
    .text(d => d.title)
    .attr('class', 'node-label')
    .attr('text-anchor', 'middle')
    .attr('y',            d => radiusForDegree(d.degree, maxDegree) + 3)
    .attr('dy',           '0.75em')
    .attr('font-size',    d => Math.max(5, radiusForDegree(d.degree, maxDegree) * 0.4))
    .attr('font-family',  'monospace')
    .attr('pointer-events', 'none');
}

/** Build and run the D3 simulation; append edges, nodes, labels, and interactions. */
function renderGraph(svg, g, data, tooltip, width, height) {
  const d3 = globalThis.d3;
  const maxDegree = Math.max(0, ...data.nodes.map(n => n.degree));

  const sim = d3.forceSimulation(data.nodes)
    .force('link',   d3.forceLink(data.edges).id(d => d.id).distance(80))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(width / 2, height / 2));

  const edgeSel = g.append('g')
    .selectAll('line')
    .data(data.edges)
    .join('line')
    .attr('stroke', DEFAULT_EDGE_STROKE)
    .attr('stroke-width', 1.2)
    .attr('stroke-opacity', 0.7);

  const nodeSel = g.append('g')
    .selectAll('g')
    .data(data.nodes)
    .join('g')
    .style('cursor', d => d.isDangling ? 'default' : 'pointer');

  appendNodeVisuals(nodeSel, maxDegree);
  attachDrag(nodeSel, sim);
  attachHover(nodeSel, edgeSel, tooltip, svg, maxDegree);

  // Stop the simulation when the SVG is removed from the document (e.g. navigating away from #/graph).
  sim.on('tick', () => {
    if (!svg.node().isConnected) { sim.stop(); return; }
    onTick(edgeSel, nodeSel);
  });

  return { sim, edgeSel, nodeSel };
}

/** Build and append the kind/size legend overlay to the container. */
function buildLegend(container) {
  const legend = document.createElement('div');
  legend.className = 'graph-legend';

  const kindHeading = document.createElement('div');
  kindHeading.className = 'graph-legend-heading';
  kindHeading.textContent = 'Node kind';
  legend.appendChild(kindHeading);

  const LEGEND_KINDS = [
    { label: 'concept',    dashed: false, ...KIND_COLORS.concept },
    { label: 'entity',     dashed: false, ...KIND_COLORS.entity },
    { label: 'comparison', dashed: false, ...KIND_COLORS.comparison },
    { label: 'overview',   dashed: false, ...KIND_COLORS.overview },
    { label: 'orphan',     dashed: false, ...ORPHAN_COLOR },
    { label: 'missing',    dashed: true,  ...DANGLING_COLOR },
  ];

  for (const { label, dashed, fill, stroke } of LEGEND_KINDS) {
    const item = document.createElement('div');
    item.className = 'graph-legend-item';

    const dot = document.createElement('div');
    dot.className = 'graph-legend-dot';
    dot.style.background = fill;
    dot.style.border = `1px ${dashed ? 'dashed' : 'solid'} ${stroke}`;

    const text = document.createTextNode(label);
    item.appendChild(dot);
    item.appendChild(text);
    legend.appendChild(item);
  }

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

/** Show a placeholder message when the wiki has no pages yet. */
function renderEmptyState(container) {
  const p = document.createElement('p');
  p.className = 'placeholder';
  p.textContent = 'No pages yet — run `llmwiki compile`.';
  container.appendChild(p);
}

/**
 * Entry point called by viewer.js when the `#/graph` route is active.
 * Fetches `/api/graph`, builds the SVG, and starts the force simulation.
 *
 * @param {HTMLElement} container - The `.graph-pane` element to render into.
 */
export async function loadGraph(container) {
  const data = await fetchGraphData(container);
  if (!data) return;
  if (!data.nodes || data.nodes.length === 0) {
    renderEmptyState(container);
    return;
  }
  const { svg, g, width, height, tooltip } = initGraph(container);
  renderGraph(svg, g, data, tooltip, width, height);
  buildLegend(container);
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
