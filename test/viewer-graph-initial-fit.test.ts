/** Initial graph framing exercises the shipped D3 bundle and real SVG output. */
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";

const windows: JSDOM[] = [];
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); });

/** Mount real graph code; only viewport geometry and network input are supplied. */
async function graph(count: number, compact: boolean, duringLoad?: (container: Element) => void) {
  const dom = new JSDOM('<div id="graph"></div>', { runScripts: "outside-only", pretendToBeVisual: true });
  windows.push(dom);
  const win = dom.window;
  const container = win.document.querySelector("div")!;
  Object.defineProperties(container, { clientWidth: { value: 440 }, clientHeight: { value: 296 } });
  // JSDOM lacks the SVG animated viewBox API used by d3-zoom's default extent.
  Object.defineProperty(win.SVGElement.prototype, "viewBox", {
    get() { return { baseVal: { x: 0, y: 0, width: 440, height: 296 } }; },
  });
  win.eval(await readFile("src/viewer/assets/d3.min.js", "utf8"));
  for (const name of ["viewer-dom", "viewer-format", "viewer-graph"]) {
    const source = await readFile(`src/viewer/assets/${name}.js`, "utf8");
    win.eval(source.replace(/^import .*;$/gm, "").replace(/\bexport /g, ""));
  }
  win.fetch = async () => new Response(JSON.stringify({
    nodes: Array.from({ length: count }, (_, i) => ({ id: `concepts/n${i}`, title: `N${i}`, degree: 0, kind: "concept" })),
    edges: [],
  }));
  if (duringLoad) win.setTimeout(() => duringLoad(container), 0);
  const handle = await win.eval(`loadGraph(document.querySelector('#graph'), { compact: ${compact} })`);
  return { dom, container, handle };
}

it.each([[24, false], [24, true], [500, false], [500, true]] as const)("fits %s nodes on initial load (compact=%s)", async (count, compact) => {
  const { dom, container } = await graph(count, compact);
  const svg = container.querySelector("svg")!;
  const transform = dom.window.eval("d3.zoomTransform(document.querySelector('svg'))");
  expect(svg.querySelector("g")?.getAttribute("transform")).toBeTruthy();
  expect(svg.style.visibility).toBe("");
  expect(container.querySelector('[role="status"]')).toBeNull();
  for (const circle of container.querySelectorAll(".graph-node")) {
    const node = (circle as unknown as { __data__: { x: number; y: number } }).__data__;
    expect(circle.parentElement!.getAttribute("transform")).toBe(`translate(${node.x},${node.y})`);
    const [x, y] = transform.apply([node.x, node.y]);
    const radius = Number(circle.getAttribute("r")) * transform.k;
    expect(x - radius).toBeGreaterThanOrEqual(0);
    expect(x + radius).toBeLessThanOrEqual(440);
    expect(y - radius).toBeGreaterThanOrEqual(0);
    expect(y + radius).toBeLessThanOrEqual(296);
  }
});

it("yields during layout and cancels when the graph is removed", async () => {
  let yielded = false;
  let stoppedX = 0;
  let point: { x: number } | undefined;
  const { handle } = await graph(500, true, (container) => {
    yielded = true;
    expect(container.querySelector("svg")!.style.visibility).toBe("hidden");
    expect(container.querySelector('[role="status"]')!.textContent).toBe("Arranging graph…");
    point = (container.querySelector(".graph-node") as unknown as { __data__: { x: number } }).__data__;
    stoppedX = point.x;
    container.remove();
  });
  expect(yielded).toBe(true);
  expect(handle).toBeNull();
  expect(point!.x).toBe(stoppedX);
});

it("keeps wheel zoom continuous below the usual minimum scale", async () => {
  const { dom, container } = await graph(500, false);
  const win = dom.window;
  const scale = () => win.eval("d3.zoomTransform(document.querySelector('svg')).k");
  const initial = scale();
  expect(initial).toBeLessThan(0.1);
  container.querySelector("svg")!.dispatchEvent(new win.WheelEvent("wheel", {
    deltaY: -10, clientX: 220, clientY: 148, bubbles: true, cancelable: true,
  }));
  expect(scale()).toBeGreaterThan(initial);
  expect(scale()).toBeLessThan(initial * 1.1);
});

it("keeps a one-node graph finite and leaves an empty graph without controls", async () => {
  const single = await graph(1, true);
  const transform = single.container.querySelector("svg > g")?.getAttribute("transform");
  expect(transform).toBeTruthy();
  expect(transform).not.toMatch(/NaN|Infinity/);
  const empty = await graph(0, true);
  expect(empty.handle).toBeNull();
  expect(empty.container.querySelector("svg")).toBeNull();
});

it("keeps manual zoom and Fit usable after the initial framing", async () => {
  const { dom, handle } = await graph(24, true);
  const win = dom.window;
  win.eval("d3.select('svg').call(d3.zoom().transform, d3.zoomIdentity.translate(50, 60).scale(0.5))");
  expect(win.eval("d3.zoomTransform(document.querySelector('svg')).k")).toBe(0.5);
  win.matchMedia = (() => ({ matches: true })) as typeof win.matchMedia;
  handle.fit();
  expect(win.eval("d3.zoomTransform(document.querySelector('svg')).k")).not.toBe(0.5);
  expect(win.document.querySelector("svg > g")?.getAttribute("transform")).not.toMatch(/NaN|Infinity/);
});
