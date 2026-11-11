/**
 * The top bar: project title with the whole-wiki verdict pill, the search box,
 * and the theme control. The pill and meta line need both bootstrap payloads;
 * a failed health fetch leaves lint "never run", which the verdict reports
 * rather than hiding.
 */
import type { ReactNode } from "react";
import type { HealthPayload, PagesEnvelope } from "./api";
import { SearchBox } from "./search";
import { THEMES, useTheme, type Theme } from "./theme";
import { formatUtcTimestamp, wikiVerdict } from "./wiki-model";

const THEME_LABELS: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

/** The meta line under the title: profile, load time, and a state warning when tracking is unavailable. */
function metaLine(wiki: PagesEnvelope): string {
  const parts = [`${wiki.profileId} project`, `Viewer loaded at ${formatUtcTimestamp(wiki.updatedAt)}`];
  if (wiki.stateStatus !== "ok") {
    parts.push("Update status unavailable: compilation tracking data is missing or unreadable");
  }
  return parts.join(" · ");
}

function ThemeControl(): ReactNode {
  const [theme, setTheme] = useTheme();
  return (
    <label className="theme-control">
      <span>Theme</span>
      <select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
        {THEMES.map((option) => <option key={option} value={option}>{THEME_LABELS[option]}</option>)}
      </select>
    </label>
  );
}

interface HeaderProps {
  wiki: PagesEnvelope;
  health: HealthPayload | null;
  initialQuery: string;
  onToggleNav: () => void;
  navOpen: boolean;
}

/** The persistent header. */
export function Header({ wiki, health, initialQuery, onToggleNav, navOpen }: HeaderProps): ReactNode {
  const verdict = wikiVerdict(wiki, health);
  return (
    <header className="topbar">
      <button type="button" className="nav-toggle" aria-expanded={navOpen} onClick={onToggleNav}>Menu</button>
      <div className="identity">
        <a className="project" href="#/">{wiki.project.title || "llmwiki"}</a>
        <span className={`verdict is-${verdict.tone}`} title={metaLine(wiki)}>{verdict.text}</span>
        <p className="meta">{metaLine(wiki)}</p>
      </div>
      <SearchBox key={initialQuery} initialQuery={initialQuery} />
      <ThemeControl />
    </header>
  );
}
