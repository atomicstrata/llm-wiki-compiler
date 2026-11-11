/**
 * The top bar: project title with the whole-wiki verdict pill and the search box. The pill and meta line need both bootstrap payloads;
 * a failed health fetch leaves lint "never run", which the verdict reports
 * rather than hiding.
 */
import type { ReactNode } from "react";
import type { HealthPayload, PagesEnvelope } from "./api";
import { SearchBox } from "./search";
import { Badge, type Tone } from "./components";
import { formatUtcTimestamp, wikiVerdict, type Verdict } from "./wiki-model";

const VERDICT_TONE: Record<Verdict["tone"], Tone> = { ok: "green", warn: "amber", unknown: "neutral" };

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
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-zinc-950/5 bg-white/90 px-4 backdrop-blur dark:border-white/10 dark:bg-zinc-950/90">
      <a href="#/" className="flex max-w-1/2 shrink-0 items-center gap-2.5" title={metaLine(wiki)}>
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-indigo-600 text-sm font-bold text-white" aria-hidden="true">
          {(wiki.project.title || "l").charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-zinc-950 dark:text-white">{wiki.project.title || "llmwiki"}</span>
          <span className="hidden text-xs text-zinc-500 sm:block dark:text-zinc-400">Local · read only</span>
        </span>
      </a>
      <span title={metaLine(wiki)} className="hidden sm:inline-flex"><Badge tone={VERDICT_TONE[verdict.tone]}>{verdict.text}</Badge></span>
      <SearchBox key={initialQuery} initialQuery={initialQuery} />
    </header>
  );
}
