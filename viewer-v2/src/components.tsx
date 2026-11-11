/**
 * The building blocks every screen is assembled from: a screen frame, cards,
 * stats, row lists, tables, definition rows, badges, notices, disclosures,
 * code blocks, dialogs, form controls and empty states. Each component owns
 * its Tailwind classes, all from the default palette and scale, so screens
 * compose components instead of class strings and a design change lands in
 * one place.
 */
import type { ComponentProps, MouseEvent, ReactNode } from "react";

/** The raised white surface cards, stats and rail sections share. */
export const SURFACE = "rounded-xl bg-white shadow-sm ring-1 ring-zinc-950/5 dark:bg-zinc-900 dark:ring-white/10";

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
    <section className={`overflow-hidden ${SURFACE}`}>
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

/** A small pill label; `title` explains it on hover. */
export function Badge({ tone = "neutral", title, children }: { tone?: Tone; title?: string; children: ReactNode }): ReactNode {
  return <span title={title} className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${BADGE[tone]}`}>{children}</span>;
}

/** Text colour for a tone: headline figures and status lines. */
export const TONE_TEXT: Record<Tone, string> = {
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
    <div className={`p-4 ${SURFACE}`}>
      <div className="flex items-center justify-between gap-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
        <span>{label}</span>
        {badge}
      </div>
      <div className={`mt-2 text-3xl font-semibold tracking-tight tabular-nums ${TONE_TEXT[tone]}`}>{value}</div>
      {detail && <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{detail}</div>}
    </div>
  );
}

/** A list of rows with hairline dividers. */
export function RowList({ children }: { children: ReactNode }): ReactNode {
  return <ul role="list" className="divide-y divide-zinc-950/5 dark:divide-white/10">{children}</ul>;
}

/** A list row's link: hover and keyboard-focus highlights, and the `data-row` hook `j`/`k` move between. */
export const ROW_LINK =
  "px-4 py-2.5 text-sm outline-none hover:bg-zinc-50 focus-visible:bg-indigo-50 focus-visible:shadow-[inset_2px_0] focus-visible:shadow-indigo-600 dark:hover:bg-white/5 dark:focus-visible:bg-indigo-500/10 dark:focus-visible:shadow-indigo-400";

/** One clickable row: optional leading mark, a truncating title over an optional one-line description, then trailing badges and a quiet meta value. */
export function Row({ href, title, description, leading, trailing, meta }: {
  href: string;
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  meta?: ReactNode;
}): ReactNode {
  return (
    <li>
      <a href={href} data-row="" className={`flex items-center gap-3 ${ROW_LINK}`}>
        {leading}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-zinc-900 dark:text-zinc-100">{title}</span>
          {description && <span className="mt-0.5 block truncate text-zinc-500 dark:text-zinc-400" title={typeof description === "string" ? description : undefined}>{description}</span>}
        </span>
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
export function Td({ children }: { children: ReactNode }): ReactNode {
  return <td className="px-4 py-2.5 align-top text-zinc-700 dark:text-zinc-300">{children}</td>;
}

const NOTICE: Record<"amber" | "red", string> = {
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20",
  red: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20",
};

/** A tinted callout: amber for a caution, red for a failure. `alert` announces it at once; `code` tags a server warning. */
export function Notice({ tone = "amber", alert = false, code, children }: { tone?: "amber" | "red"; alert?: boolean; code?: string; children: ReactNode }): ReactNode {
  return <div role={alert ? "alert" : undefined} data-code={code} className={`rounded-lg px-4 py-3 text-sm ring-1 ring-inset ${NOTICE[tone]}`}>{children}</div>;
}

/** A native disclosure; `quiet` is the small grey kind for technical detail. `open` only sets the initial state. */
export function Disclosure({ summary, open, quiet = false, children }: { summary: ReactNode; open?: boolean; quiet?: boolean; children: ReactNode }): ReactNode {
  return (
    <details open={open} className={quiet ? "text-xs text-zinc-500 dark:text-zinc-400" : "text-sm"}>
      <summary className={quiet
        ? "cursor-pointer font-medium hover:text-zinc-700 dark:hover:text-zinc-200"
        : "cursor-pointer font-medium text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"}>{summary}</summary>
      <div className="mt-2 space-y-2">{children}</div>
    </details>
  );
}

/** Verbatim text such as disk content or identifiers, wrapped so long lines never widen the screen. */
export function CodeBlock({ children }: { children: ReactNode }): ReactNode {
  return (
    <pre className="overflow-x-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs break-words whitespace-pre-wrap text-zinc-800 ring-1 ring-zinc-950/5 ring-inset dark:bg-white/5 dark:text-zinc-200 dark:ring-white/10">
      {children}
    </pre>
  );
}

/** A centred modal `<dialog>` card over a dimmed backdrop; width comes from the caller. */
export const CENTRED_DIALOG =
  "mx-auto mt-[12vh] w-[calc(100%-2rem)] rounded-xl bg-white p-0 shadow-2xl ring-1 ring-zinc-950/10 outline-none backdrop:bg-zinc-950/40 backdrop:backdrop-blur-sm dark:bg-zinc-900 dark:ring-white/10";

/** A click on a modal dialog's own box, outside its content, is a click on the backdrop: close it. */
export function closeOnBackdrop(event: MouseEvent<HTMLDialogElement>): void {
  if (event.target === event.currentTarget) event.currentTarget.close();
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
export function Button({ children, ...props }: { children: ReactNode; onClick?: () => void; disabled?: boolean }): ReactNode {
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

/** An accent text link; any other anchor attribute (`target`, `download`) passes through. */
export function TextLink({ href, children, ...anchor }: ComponentProps<"a"> & { href: string }): ReactNode {
  return <a href={href} {...anchor} className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300">{children}</a>;
}

/** A search-style text field; `list` names a `<datalist>` of suggestions. */
export function TextField({ value, onChange, placeholder, label, list }: { value: string; onChange: (value: string) => void; placeholder: string; label: string; list?: string }): ReactNode {
  return (
    <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label} list={list}
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

/** A cited line range as a small link chip; `title` carries the full citation. */
export function RangeChip({ href, label, title }: { href: string; label: string; title?: string }): ReactNode {
  return (
    <a href={href} title={title} data-resolved="true"
      className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-600 hover:bg-indigo-50 hover:text-indigo-700 dark:bg-white/5 dark:text-zinc-400 dark:hover:bg-indigo-500/10 dark:hover:text-indigo-300">
      {label}
    </a>
  );
}

/** Inline code for commands and identifiers. */
export function Code({ children }: { children: ReactNode }): ReactNode {
  return <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs text-zinc-700 dark:bg-white/10 dark:text-zinc-300">{children}</code>;
}
