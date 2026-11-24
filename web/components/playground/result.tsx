"use client";

import { isVerification, type DemoEvent, type Verification } from "@/lib/demo";
import { Code } from "../code";
import { ArrowUpRight } from "../icons";
import { Badge, Card } from "../ui";

type Result = Extract<DemoEvent, { type: "result" }>;

const ELIGIBILITY = {
  ELIGIBLE: { tone: "ok", label: "Can apply from India" },
  NEEDS_REVIEW: { tone: "warn", label: "Needs review" },
  INELIGIBLE: { tone: "bad", label: "Not open to India" },
} as const;

export function ResultCard({ result }: { result: Result }) {
  const v = isVerification(result.data) ? result.data : null;
  if (!v) return null;
  return (
    <Card className="rise overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line p-5">
        <div className="min-w-0">
          <p className="text-xs text-faint capitalize">{v.job?.company ?? v.evidence.boardId}</p>
          <h2 className="mt-0.5 text-lg font-semibold tracking-tight">{v.job?.title ?? "Job posting"}</h2>
          <p className="mt-1 text-sm text-muted">
            {[v.job?.location, v.job?.workplace && v.job.workplace !== "UNKNOWN" ? v.job.workplace.toLowerCase() : null].filter(Boolean).join(" · ") || "Location not stated"}
          </p>
        </div>
        <Status status={v.status} />
      </div>

      <div className="grid gap-px bg-line sm:grid-cols-2">
        <section className="bg-surface p-5">
          <h3 className="mb-3 text-xs font-medium tracking-wide text-faint uppercase">India eligibility</h3>
          {v.india ? (
            <>
              <Badge tone={ELIGIBILITY[v.india.eligibility].tone}>{ELIGIBILITY[v.india.eligibility].label}</Badge>
              <ul className="mt-3 space-y-1.5 text-sm text-muted">
                {v.india.reasons.map((r) => (
                  <li key={r} className="flex gap-2">
                    <span aria-hidden className="text-faint">–</span>
                    {r}
                  </li>
                ))}
              </ul>
              <p className="mt-3 font-mono text-[11px] text-faint">tier: {v.india.tier}</p>
            </>
          ) : (
            <p className="text-sm text-muted">Not assessed for a closed posting.</p>
          )}
        </section>
        <section className="bg-surface p-5">
          <h3 className="mb-3 text-xs font-medium tracking-wide text-faint uppercase">Evidence</h3>
          <Evidence v={v} />
        </section>
      </div>

      <details className="group border-t border-line">
        <summary className="cursor-pointer list-none px-5 py-3 text-sm text-muted select-none hover:text-fg">
          <span className="inline-block transition-transform group-open:rotate-90">›</span> Raw JSON response
        </summary>
        <div className="px-5 pb-5">
          <Code code={JSON.stringify(v, null, 2)} lang="json" />
        </div>
      </details>
    </Card>
  );
}

function Status({ status }: { status: Verification["status"] }) {
  const tone = status === "OPEN" ? "ok" : status === "CLOSED" ? "bad" : "neutral";
  return (
    <Badge tone={tone} className="px-3 py-1 text-sm">
      <span aria-hidden className={`size-1.5 rounded-full ${status === "OPEN" ? "bg-ok" : status === "CLOSED" ? "bg-bad" : "bg-faint"}`} />
      {status === "OPEN" ? "Open" : status === "CLOSED" ? "Closed" : "Unknown"}
    </Badge>
  );
}

function Evidence({ v }: { v: Verification }) {
  const e = v.evidence;
  return (
    <dl className="space-y-2 text-sm">
      <Row k="Signal" v={<span className="font-mono text-xs">{e.type}</span>} />
      <Row k="Board" v={`${e.board.charAt(0)}${e.board.slice(1).toLowerCase()} · ${e.boardId}`} />
      <Row k="Board answered" v={<span className="font-mono text-xs">{e.httpStatus ?? "–"}{e.ms != null ? ` in ${e.ms} ms` : ""}</span>} />
      <Row k="Checked" v={<span className="text-xs">{new Date(v.checkedAt).toUTCString().slice(5, 25)} UTC{v.cached ? " (cached)" : ""}</span>} />
      {v.job?.applyUrl && (
        <Row
          k="Apply"
          v={
            <a href={v.job.applyUrl} target="_blank" rel="noreferrer nofollow" className="inline-flex items-center gap-1 text-accent hover:underline">
              Application page <ArrowUpRight className="size-3" />
            </a>
          }
        />
      )}
      {e.detail && <p className="pt-1 text-xs text-faint">{e.detail}</p>}
    </dl>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-faint">{k}</dt>
      <dd className="min-w-0 text-right text-muted">{v}</dd>
    </div>
  );
}
