import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "./icons";

export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-6xl px-4 sm:px-6 ${className}`}>{children}</div>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="mb-3 font-mono text-xs font-medium tracking-wider text-accent uppercase">{children}</p>;
}

export function SectionHeading({ eyebrow, title, lead, id }: { eyebrow?: string; title: ReactNode; lead?: ReactNode; id?: string }) {
  return (
    <div className="mb-10 max-w-2xl" id={id}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{title}</h2>
      {lead && <p className="mt-3 text-pretty text-muted">{lead}</p>}
    </div>
  );
}

export function PageHeader({ eyebrow, title, lead, children }: { eyebrow: string; title: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <div className="border-b border-line">
      <Container className="py-12 sm:py-16">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
        {lead && <p className="mt-4 max-w-2xl text-pretty text-muted sm:text-lg">{lead}</p>}
        {children}
      </Container>
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-surface shadow-card ${className}`}>{children}</div>;
}

type Tone = "neutral" | "ok" | "warn" | "bad" | "accent";
const TONES: Record<Tone, string> = {
  neutral: "border-line bg-raised text-muted",
  ok: "border-transparent bg-ok-soft text-ok",
  warn: "border-transparent bg-warn-soft text-warn",
  bad: "border-transparent bg-bad-soft text-bad",
  accent: "border-transparent bg-accent-soft text-accent",
};

export function Badge({ children, tone = "neutral", className = "" }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]} ${className}`}>{children}</span>;
}

export function ButtonLink({ href, children, variant = "primary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" }) {
  const cls =
    variant === "primary"
      ? "bg-fg text-bg hover:opacity-85"
      : "border border-line-strong bg-surface text-fg hover:bg-raised";
  const inner = (
    <>
      {children}
      {variant === "primary" && <ArrowRight className="transition-transform group-hover:translate-x-0.5" />}
    </>
  );
  const className = `group inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium transition ${cls}`;
  return href.startsWith("/") ? (
    <Link href={href} className={className}>
      {inner}
    </Link>
  ) : (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {inner}
    </a>
  );
}

export function RailDot({ color, className = "" }: { color: string; className?: string }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${className}`} style={{ background: color }} />;
}

/** A plain table with the site's styling; wraps in a horizontal scroller on narrow screens. */
export function Table({ head, rows, className = "" }: { head: ReactNode[]; rows: ReactNode[][]; className?: string }) {
  return (
    <div className={`overflow-x-auto rounded-xl border border-line ${className}`}>
      <table className="w-full min-w-[520px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line bg-raised/60">
            {head.map((h, i) => (
              <th key={i} scope="col" className="px-4 py-2.5 text-xs font-medium tracking-wide text-faint uppercase">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {r.map((c, j) => (
                <td key={j} className="px-4 py-3 align-top">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <code className={`rounded bg-raised px-1.5 py-0.5 font-mono text-[0.85em] ${className}`}>{children}</code>;
}

export function ExtLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`text-fg underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-accent ${className}`}>
      {children}
    </a>
  );
}
