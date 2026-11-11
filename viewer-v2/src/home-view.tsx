/** The landing view: the wiki's own index page when it has one. */
import type { ReactNode } from "react";
import { fetchIndex } from "./api";
import { AsyncView } from "./async-view";
import { useAsync } from "./use-async";
import { WikiHtml } from "./wiki-html";

/** Show `wiki/index.md`, or a short prompt when the wiki has no index. */
export function HomeView({ hasIndex }: { hasIndex: boolean }): ReactNode {
  const state = useAsync(() => (hasIndex ? fetchIndex() : Promise.resolve({ html: "" })), String(hasIndex));
  return (
    <AsyncView state={state}>
      {({ html }) => (html ? <WikiHtml html={html} /> : <p className="status">Pick a page from the list.</p>)}
    </AsyncView>
  );
}
