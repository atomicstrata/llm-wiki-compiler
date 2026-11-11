/**
 * The building blocks every screen is assembled from: a screen frame, cards,
 * stats, row lists, tables, definition rows, badges, form controls and empty
 * states. Each component owns its Tailwind classes, all from the default
 * palette and scale, so screens compose components instead of class strings
 * and a design change lands in one place.
 */
import type { ReactNode } from "react";

/** A screen's title, optional description and actions, then its content, at reading or dashboard width. */
export function Screen({ title, description, actions, wide = false, children }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={wide ? "mx-auto max-w-6xl" : "mx-auto max-w-3xl"}>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">{title}</h1>
          {description && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

/** A white surface with a hairline ring; an optional title bar with an action, and an optional footer. */
export function Card({ title, action, footer, flush = false, children }: {
  title?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-zinc-950/5 dark:bg-zinc-900 dark:ring-white/10">
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 border-b border-zinc-950/5 px-4 py-3 dark:border-white/10">
          <h2 className="text-sm font-semibold text-zinc-950 dark:text-white">{title}</h2>
          {action}
        </div>
      )}
      <div className={flush ? "" : "p-4"}>{children}</div>
      {footer && (
        <div className="flex items-center justify-between gap-3 border-t border-zinc-950/5 px-4 py-2.5 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
          {footer}
        </div>
      )}
    </section>
  );
}

/** A status colour shared by badges and figures. */
export type Tone = "neutral" | "green" | "amber" | "red" | "indigo";

const BADGE: Record<Tone, string> = {
  neutral: "bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-white/5 dark:text-zinc-400 dark:ring-white/10",
  green: "bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-500/10 dark:text-green-400 dark:ring-green-500/20",
  amber: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20",
  red: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-600/20 dark:bg-indigo-500/10 dark:text-indigo-400 dark:ring-indigo-500/20",
};

/** A small pill label. */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }): ReactNode {
  return <span className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${BADGE[tone]}`}>{children}</span>;
}

const FIGURE: Record<Tone, string> = {
  neutral: "text-zinc-950 dark:text-white",
  green: "text-green-600 dark:text-green-400",
  amber: "text-amber-600 dark:text-amber-400",
  red: "text-red-600 dark:text-red-400",
  indigo: "text-indigo-600 dark:text-indigo-400",
};

/** One headline number with its label and a detail line. */
export function Stat({ label, value, detail, tone = "neutral", badge }: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
  badge?: ReactNode;
}): ReactNode {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-zinc-950/5 dark:bg-zinc-900 dark:ring-white/10">
      <div className="flex items-center justify-between gap-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
        <span>{label}</span>
        {badge}
      </div>
      <div className={`mt-2 text-3xl font-semibold tracking-tight tabular-nums ${FIGURE[tone]}`}>{value}</div>
      {detail && <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{detail}</div>}
    </div>
  );
}

/** A list of rows with hairline dividers. */
export function RowList({ children }: { children: ReactNode }): ReactNode {
  return <ul role="list" className="divide-y divide-zinc-950/5 dark:divide-white/10">{children}</ul>;
}

/** One clickable row: optional leading mark, a truncating title, then trailing badges and a quiet meta value. */
export function Row({ href, title, leading, trailing, meta }: {
  href: string;
  title: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  meta?: ReactNode;
}): ReactNode {
  return (
    <li>
      <a href={href} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-zinc-50 dark:hover:bg-white/5">
        {leading}
        <span className="min-w-0 flex-1 truncate font-medium text-zinc-900 dark:text-zinc-100">{title}</span>
        {trailing}
        {meta !== undefined && <span className="w-12 shrink-0 text-right text-xs text-zinc-500 tabular-nums dark:text-zinc-400">{meta}</span>}
      </a>
    </li>
  );
}

/** Label and value pairs, one per line. */
export function DefinitionRows({ rows }: { rows: [string, ReactNode][] }): ReactNode {
  return (
    <dl className="divide-y divide-zinc-950/5 text-sm dark:divide-white/10">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
          <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
          <dd className="min-w-0 text-right font-medium break-words text-zinc-900 dark:text-zinc-100">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A plain data table: muted header, hairline rows; rows are built from `Td` cells. */
export function Table({ head, children }: { head: string[]; children: ReactNode }): ReactNode {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b border-zinc-950/5 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
          <tr>{head.map((label) => <th key={label} scope="col" className="px-4 py-2 font-medium">{label}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-zinc-950/5 dark:divide-white/10">{children}</tbody>
      </table>
    </div>
  );
}

/** One table cell. */
export function Td({ children, ...data }: { children: ReactNode; [attribute: `data-${string}`]: string | undefined }): ReactNode {
  return <td className="px-4 py-2.5 align-top text-zinc-700 dark:text-zinc-300" {...data}>{children}</td>;
}

/** A centred note for an empty list, with the command that fills it. */
export function EmptyState({ title, body, command }: { title: string; body: string; command?: string }): ReactNode {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 px-6 py-10 text-center dark:border-zinc-700">
      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">{body}</p>
      {command && <code className="mt-4 inline-block rounded-md bg-zinc-100 px-2 py-1 font-mono text-xs text-zinc-700 dark:bg-white/5 dark:text-zinc-300">{command}</code>}
    </div>
  );
}

/** A secondary button. */
export function Button({ children, ...props }: { children: ReactNode; onClick?: () => void; disabled?: boolean; type?: "button" | "submit" }): ReactNode {
  return (
    <button type="button" {...props}
      className="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 text-sm font-medium text-zinc-900 shadow-xs ring-1 ring-zinc-950/10 ring-inset hover:bg-zinc-50 disabled:opacity-50 dark:bg-white/5 dark:text-white dark:ring-white/10 dark:hover:bg-white/10">
      {children}
    </button>
  );
}

/** A link styled as a button; `primary` fills it with the accent. */
export function ButtonLink({ href, primary = false, children }: { href: string; primary?: boolean; children: ReactNode }): ReactNode {
  return (
    <a href={href}
      className={primary
        ? "inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400"
        : "inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-2 text-sm font-semibold text-zinc-900 shadow-xs ring-1 ring-zinc-950/10 ring-inset hover:bg-zinc-50 dark:bg-white/5 dark:text-white dark:ring-white/10 dark:hover:bg-white/10"}>
      {children}
    </a>
  );
}

/** An accent text link. */
export function TextLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  return <a href={href} className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300">{children}</a>;
}

/** A search-style text field. */
export function TextField({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder: string; label: string }): ReactNode {
  return (
    <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label}
      className="block w-full min-w-0 flex-1 rounded-md bg-white px-3 py-1.5 text-sm text-zinc-900 shadow-xs ring-1 ring-zinc-950/10 ring-inset placeholder:text-zinc-400 focus:ring-2 focus:ring-indigo-600 focus:outline-none dark:bg-white/5 dark:text-white dark:ring-white/10 dark:focus:ring-indigo-500" />
  );
}

/** A native select. */
export function SelectField({ value, onChange, label, children }: { value: string; onChange: (value: string) => void; label: string; children: ReactNode }): ReactNode {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}
      className="rounded-md bg-white py-1.5 pr-8 pl-3 text-sm text-zinc-900 shadow-xs ring-1 ring-zinc-950/10 ring-inset focus:ring-2 focus:ring-indigo-600 focus:outline-none dark:bg-white/5 dark:text-white dark:ring-white/10">
      {children}
    </select>
  );
}

/** Inline code for commands and identifiers. */
export function Code({ children }: { children: ReactNode }): ReactNode {
  return <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs text-zinc-700 dark:bg-white/10 dark:text-zinc-300">{children}</code>;
}
