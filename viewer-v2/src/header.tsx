/**
 * The top bar: the project title, the whole-wiki verdict pill, and the button
 * that opens the command palette. The pill and the title's tooltip need both
 * bootstrap payloads; a failed health fetch leaves lint "never run", which the
 * verdict reports rather than hiding.
 */
import { Search } from "lucide-react";
import type { ReactNode } from "react";
import type { HealthPayload, PagesEnvelope } from "./api";
import { openPalette } from "./command-palette";
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
}

/** Looks like a search field; opens the palette, which does the searching. */
function SearchButton(): ReactNode {
  return (
    <button type="button" onClick={openPalette} aria-keyshortcuts="Meta+K Control+K /"
      className="ml-auto flex w-full max-w-sm min-w-0 items-center gap-2 rounded-md bg-zinc-950/5 py-1.5 pr-2 pl-3 text-left text-sm text-zinc-500 hover:bg-zinc-950/10 dark:bg-white/5 dark:text-zinc-400 dark:hover:bg-white/10">
      <Search className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">Search or jump to…</span>
      <kbd aria-hidden="true" className="hidden rounded border border-zinc-950/10 px-1 font-sans text-xs text-zinc-400 sm:block dark:border-white/10">⌘K</kbd>
    </button>
  );
}

/** The persistent header. */
export function Header({ wiki, health }: HeaderProps): ReactNode {
  const verdict = wikiVerdict(wiki, health);
  const meta = metaLine(wiki);
  const title = wiki.project.title || "llmwiki";
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-zinc-950/5 bg-white/90 px-4 backdrop-blur dark:border-white/10 dark:bg-zinc-950/90">
      <a href="#/" className="flex max-w-1/2 shrink-0 items-center gap-2.5" title={meta}>
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-indigo-600 text-sm font-bold text-white" aria-hidden="true">
          {title.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-zinc-950 dark:text-white">{title}</span>
          <span className="hidden text-xs text-zinc-500 sm:block dark:text-zinc-400">Read only</span>
        </span>
      </a>
      <span title={meta} className="hidden sm:inline-flex"><Badge tone={VERDICT_TONE[verdict.tone]}>{verdict.text}</Badge></span>
      <SearchButton />
    </header>
  );
}
