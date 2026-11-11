/** The compiled `wiki/index.md`, or a short note when the wiki has none. */
import type { ReactNode } from "react";
import { fetchIndex } from "./api";
import { AsyncView } from "./async-view";
import { EmptyState, Screen } from "./components";
import { useAsync } from "./use-async";
import { WikiHtml } from "./wiki-html";

/** The index once it has loaded. */
function LoadedIndex(): ReactNode {
  const state = useAsync(fetchIndex, "index");
  return <AsyncView state={state}>{({ html }) => <div className="mx-auto max-w-3xl"><WikiHtml html={html} /></div>}</AsyncView>;
}

/** Show `wiki/index.md` when it exists, and say how to make it when it does not. */
export function IndexView({ hasIndex }: { hasIndex: boolean }): ReactNode {
  if (hasIndex) return <LoadedIndex />;
  return (
    <Screen title="Index">
      <EmptyState title="No compiled index" body="wiki/index.md is not available yet." command="$ llmwiki compile" />
    </Screen>
  );
}
