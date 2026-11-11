/**
 * The top bar: project title with the whole-wiki verdict pill and the search box. The pill and meta line need both bootstrap payloads;
 * a failed health fetch leaves lint "never run", which the verdict reports
 * rather than hiding.
 */
import type { ReactNode } from "react";
import type { HealthPayload, PagesEnvelope } from "./api";
import { SearchBox } from "./search";
import { formatUtcTimestamp, wikiVerdict } from "./wiki-model";

/** The meta line under the title: profile, load time, and a state warning when tracking is unavailable. */
function metaLine(wiki: PagesEnvelope): string {
  const parts = [`${wiki.profileId} project`, `Viewer loaded at ${formatUtcTimestamp(wiki.updatedAt)}`];
  if (wiki.stateStatus !== "ok") {
    parts.push("Update status unavailable: compilation tracking data is missing or unreadable");
  }
  return parts.join(" · ");
}

interface HeaderProps {
  wiki: PagesEnvelope;
  health: HealthPayload | null;
  initialQuery: string;
}

/** The persistent header. */
export function Header({ wiki, health, initialQuery }: HeaderProps): ReactNode {
  const verdict = wikiVerdict(wiki, health);
  return (
    <header className="flex flex-wrap items-center gap-4 border-b p-4">
      <div>
        <a href="#/">{wiki.project.title || "llmwiki"}</a>{" "}
        <span title={metaLine(wiki)}>{verdict.text}</span>
        <p>{metaLine(wiki)}</p>
      </div>
      <SearchBox key={initialQuery} initialQuery={initialQuery} />
    </header>
  );
}
