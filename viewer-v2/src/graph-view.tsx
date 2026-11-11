/**
 * The graph explorer at `#/graph`: the full-size drawing with drag, the
 * legend overlay, and a toolbar. **Find** takes a page title, with the
 * browser's own suggestions from a `<datalist>`, then centres that page and
 * keeps its neighbourhood emphasised until the box is cleared. **Colour**
 * switches between node kind and link community. **Fit** re-frames wherever
 * the layout and any dragging have left the nodes. The counts come from the
 * envelope the shell already holds, so the heading reads correctly before
 * the graph loads.
 */
import { useId, useMemo, useState, type ReactNode } from "react";
import type { PagesEnvelope } from "./api";
import { Button, Screen, SelectField, TextField } from "./components";
import { GraphCanvas, GraphLegend, type ColorBy } from "./graph-canvas";
import type { GraphControls } from "./graph-layout";
import { plural } from "./wiki-model";

/** The page id whose title is exactly `title`, ignoring case and outer spaces. */
export function pageIdForTitle(wiki: PagesEnvelope, title: string): string | null {
  const wanted = title.trim().toLowerCase();
  if (wanted.length === 0) return null;
  return wiki.pages.find((page) => page.title.toLowerCase() === wanted)?.id ?? null;
}

/** The find box: a page title with suggestions; reports the matching page, or null. */
function FindPage({ wiki, onFind }: { wiki: PagesEnvelope; onFind: (id: string | null) => void }): ReactNode {
  const [title, setTitle] = useState("");
  const listId = useId();
  const titles = useMemo(() => [...new Set(wiki.pages.map((page) => page.title).filter((name) => name.length > 0))].sort(), [wiki.pages]);
  const onChange = (value: string): void => {
    setTitle(value);
    onFind(pageIdForTitle(wiki, value));
  };
  return (
    <div className="w-56">
      <TextField value={title} onChange={onChange} placeholder="Find a page…" label="Find a page in the graph" list={listId} />
      <datalist id={listId}>{titles.map((name) => <option key={name} value={name} />)}</datalist>
    </div>
  );
}

/** The explorer screen. */
export function GraphView({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const [controls, setControls] = useState<GraphControls | null>(null);
  const [colorBy, setColorBy] = useState<ColorBy>("community");
  const [found, setFound] = useState<string | null>(null);
  const { nodeCount, edgeCount, danglingCount } = wiki.graph;
  const onFind = (id: string | null): void => {
    setFound(id);
    if (id !== null) controls?.focus(id);
  };
  const actions = (
    <>
      <FindPage wiki={wiki} onFind={onFind} />
      <SelectField value={colorBy} onChange={(value) => setColorBy(value as ColorBy)} label="Colour nodes by">
        <option value="community">Colour: clusters</option>
        <option value="kind">Colour: kind</option>
      </SelectField>
      <Button disabled={controls === null} onClick={() => controls?.fit()}>Fit</Button>
    </>
  );
  return (
    <Screen wide title="Graph explorer" actions={actions}
      description={<>{plural(nodeCount, "node")} · {plural(edgeCount, "edge")} · {plural(danglingCount, "dangling target")}</>}>
      <div className="relative overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-zinc-950/5 dark:bg-zinc-900 dark:ring-white/10">
        <GraphCanvas wiki={wiki} onSettled={setControls} colorBy={colorBy} highlightId={found} />
        <GraphLegend colorBy={colorBy} />
      </div>
    </Screen>
  );
}
