/** The compiled `wiki/index.md`, or a short note when the wiki has none. */
import type { ReactNode } from "react";
import { fetchIndex } from "./api";
import { AsyncView } from "./async-view";
import { useAsync } from "./use-async";
import { WikiHtml } from "./wiki-html";

/** Show `wiki/index.md` when it exists. */
export function IndexView({ hasIndex }: { hasIndex: boolean }): ReactNode {
  const state = useAsync(() => (hasIndex ? fetchIndex() : Promise.resolve({ html: "" })), String(hasIndex));
  return (
    <AsyncView state={state}>
      {({ html }) => (
        <div>
          {html ? <WikiHtml html={html} /> : <p>wiki/index.md is not available. Run `llmwiki compile`.</p>}
        </div>
      )}
    </AsyncView>
  );
}
