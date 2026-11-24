import type { ReactNode } from "react";
import { railColor, type RailId } from "@/lib/site";

/**
 * The x402 exchange the hero shows: request, 402 with offers, the paid retry, the answer.
 * Lines rise in one after another (CSS only; still for reduced-motion visitors).
 */
const Rail = ({ id, children }: { id: RailId; children: ReactNode }) => (
  <span className="inline-flex items-center gap-1.5 text-fg">
    <span aria-hidden className="inline-block size-1.5 rounded-full" style={{ background: railColor[id] }} />
    {children}
  </span>
);
const K = ({ children }: { children: ReactNode }) => <span className="text-code-key">&quot;{children}&quot;</span>;
const S = ({ children }: { children: ReactNode }) => <span className="text-ok">&quot;{children}&quot;</span>;

const LINES: { dir: "out" | "in" | "body"; content: ReactNode; gap?: boolean }[] = [
  { dir: "out", content: <><b className="text-code-kw">GET</b> /v1/verify?url=jobs.lever.co/meesho/7d9af9b5…</> },
  { dir: "in", content: <><b className="text-warn">402</b> Payment Required</> },
  { dir: "body", content: <>accepts: <Rail id="session">pay_session</Rail> · <Rail id="gateway">gateway</Rail> · <Rail id="exact">exact</Rail> · 1000 µUSDC</> },
  { dir: "out", gap: true, content: <><b className="text-code-kw">GET</b> /v1/verify … <span className="text-faint">+ PAYMENT-SIGNATURE</span></> },
  { dir: "body", content: <>receipt: session Hbk3…efMZ · running total <span className="text-fg">0.043</span> USDC</> },
  { dir: "in", gap: true, content: <><b className="text-ok">200</b> OK · paid 0.001 USDC · <span className="text-fg">8 ms</span></> },
  { dir: "body", content: <>{"{"} <K>status</K>: <S>OPEN</S>, <K>evidence</K>: <S>ATS_DETAIL_ACTIVE</S> {"}"}</> },
  { dir: "body", content: <>{"{"} <K>india</K>: <S>ELIGIBLE</S>, <K>tier</K>: <S>INDIA_CITY</S> {"}"}</> },
];

export function HeroExchange() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-line-strong" />
        <span className="size-2.5 rounded-full bg-line-strong" />
        <span className="size-2.5 rounded-full bg-line-strong" />
        <span className="ml-2 font-mono text-xs text-faint">buyer-agent → verified-jobs-api</span>
      </div>
      <div className="space-y-1.5 p-4 font-mono text-[12.5px] leading-relaxed sm:p-5 sm:text-[13px]">
        {LINES.map((l, i) => (
          <div key={i} className={`rise flex gap-3 ${l.gap ? "pt-2" : ""}`} style={{ animationDelay: `${250 + i * 380}ms` }}>
            <span className={`w-4 shrink-0 select-none ${l.dir === "out" ? "text-code-kw" : l.dir === "in" ? "text-ok" : "text-transparent"}`}>{l.dir === "out" ? "→" : l.dir === "in" ? "←" : "·"}</span>
            <span className={`min-w-0 break-hash ${l.dir === "body" ? "text-muted" : "text-fg"}`}>{l.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
