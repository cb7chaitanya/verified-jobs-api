"use client";

import type { ReactNode } from "react";
import { fmtUsdc, networkName, short, type DemoEvent } from "@/lib/demo";
import { railColor, type RailId } from "@/lib/site";
import { ArrowUpRight, Check, X } from "../icons";
import { Card } from "../ui";

type Tone = "pending" | "ok" | "warn" | "bad" | "info";

interface Step {
  key: string;
  tone: Tone;
  title: string;
  /** Milliseconds this step took, when the server measured it. */
  ms?: number;
  /** Time since the run started. */
  t: number;
  body?: ReactNode;
}

const DOT: Record<Tone, string> = {
  pending: "border-line-strong bg-surface",
  ok: "border-ok bg-ok",
  warn: "border-warn bg-warn",
  bad: "border-bad bg-bad",
  info: "border-fg/60 bg-surface",
};

export function Timeline({ events, running, method, replay, recordedAt }: { events: DemoEvent[]; running: boolean; method: RailId; replay: boolean; recordedAt?: string }) {
  const steps = toSteps(events, method);
  const last = events.at(-1);
  const waiting = running && last && last.type !== "result" && last.type !== "error" ? nextWait(last, method) : null;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 className="text-sm font-medium">The exchange</h2>
        <span className="hidden text-xs text-faint sm:inline">{replay && recordedAt ? `Recorded ${new Date(recordedAt).toUTCString().slice(5, 22)} UTC` : "HTTP + x402, as the buyer agent sees it"}</span>
      </div>
      {steps.length === 0 && !running ? (
        <Empty />
      ) : (
        <ol className="relative px-5 py-5" aria-live="polite">
          {steps.map((s, i) => (
            <li key={s.key} className="rise relative flex gap-4 pb-6 last:pb-0">
              {(i < steps.length - 1 || waiting) && <span aria-hidden className="absolute top-5 bottom-0 left-[7px] w-px bg-line" />}
              <span aria-hidden className={`relative z-10 mt-1 flex size-[15px] shrink-0 items-center justify-center rounded-full border-2 ${DOT[s.tone]}`}>
                {s.tone === "ok" && <Check className="size-2.5 text-surface" strokeWidth={4} />}
                {s.tone === "bad" && <X className="size-2.5 text-surface" strokeWidth={4} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="text-sm font-medium">{s.title}</h3>
                  <span className="font-mono text-xs text-faint tabular-nums">
                    {s.ms !== undefined && <span className="text-muted">{s.ms} ms · </span>}+{(s.t / 1000).toFixed(2)} s
                  </span>
                </div>
                {s.body && <div className="mt-2 text-sm text-muted">{s.body}</div>}
              </div>
            </li>
          ))}
          {waiting && (
            <li className="relative flex gap-4">
              <span aria-hidden className="relative z-10 mt-1 flex size-[15px] shrink-0 items-center justify-center">
                <span className="size-3 animate-spin rounded-full border-2 border-line-strong border-t-fg" />
              </span>
              <p className="text-sm text-muted">{waiting}</p>
            </li>
          )}
        </ol>
      )}
    </Card>
  );
}

function Empty() {
  return (
    <div className="px-5 py-14 text-center">
      <div className="mx-auto mb-4 flex w-fit items-center gap-2 font-mono text-xs text-faint">
        <span className="rounded border border-line px-1.5 py-0.5">GET</span>→<span className="rounded border border-line px-1.5 py-0.5">402</span>→<span className="rounded border border-line px-1.5 py-0.5">pay</span>→<span className="rounded border border-line px-1.5 py-0.5">200</span>
      </div>
      <p className="text-sm text-muted">Run a check to watch each step of the exchange here.</p>
    </div>
  );
}

function nextWait(last: DemoEvent, method: RailId): string {
  switch (last.type) {
    case "start":
      return "Asking the API…";
    case "session-opening":
      return "Waiting for the session to confirm on Solana devnet…";
    case "session-opened":
      return "Asking the API…";
    case "402":
      return "Checking the offer against the agent's policy and signing…";
    case "pay":
      return method === "exact" ? "Sending the payment; the facilitator submits it and waits for confirmation…" : method === "gateway" ? "Gateway is verifying and settling the authorization…" : "The seller is checking the receipt off-chain…";
    case "settled":
    case "response":
      return "Reading the answer…";
    default:
      return "Working…";
  }
}

function TxLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-accent hover:underline">
      {label} <ArrowUpRight className="size-3" />
    </a>
  );
}

function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg border border-line bg-bg/60 px-3 py-2 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-faint">{k}</dt>
          <dd className="min-w-0 font-mono break-hash text-muted">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function toSteps(events: DemoEvent[], method: RailId): Step[] {
  const t0 = events[0]?.at ?? 0;
  const steps: Step[] = [];
  events.forEach((e, i) => {
    const t = e.at - t0;
    const key = `${i}-${e.type}`;
    switch (e.type) {
      case "start":
        steps.push({ key, tone: "info", t, title: "Agent asks for a verification", body: <span className="font-mono text-xs break-hash">GET /v1/verify?url={e.url}</span> });
        break;
      case "session-opening":
        steps.push({ key, tone: "pending", t, title: "No session with funds yet: opening one", body: <>Depositing {fmtUsdc(e.deposit)} into a <span className="font-mono">pay_session</span> vault. This happens once, not per call.</> });
        break;
      case "session-opened":
        steps.push({
          key,
          tone: "ok",
          t,
          ms: e.ms,
          title: "Session opened on Solana devnet",
          body: (
            <div className="space-y-2">
              <Kv rows={[["session", e.session], ["deposit", fmtUsdc(e.deposit)]]} />
              <TxLink href={e.explorer} label="open_session transaction" />
            </div>
          ),
        });
        break;
      case "402":
        steps.push({
          key,
          tone: "warn",
          t,
          ms: e.ms,
          title: "402 Payment Required",
          body: (
            <div className="space-y-2">
              <p>The API quotes a price for each way it accepts payment:</p>
              <ul className="space-y-1.5">
                {e.accepts.map((a) => {
                  const rail: RailId = a.scheme === "session" ? "session" : a.network.startsWith("eip155") ? "gateway" : "exact";
                  const mine = rail === method;
                  return (
                    <li key={a.scheme + a.network} className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-xs ${mine ? "border-fg/30 bg-raised" : "border-line"}`}>
                      <span className="flex items-center gap-1.5 font-mono text-fg">
                        <span aria-hidden className="size-1.5 rounded-full" style={{ background: railColor[rail] }} />
                        {a.scheme}
                      </span>
                      <span>{networkName(a.network)}</span>
                      <span className="font-mono">{fmtUsdc(a.amount)}</span>
                      <span className="ml-auto font-mono text-faint">to {short(a.payTo, 4, 4)}</span>
                      {mine && <span className="text-[10px] font-medium tracking-wide text-fg uppercase">chosen</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          ),
        });
        break;
      case "pay": {
        const p = e.payload ?? {};
        const detail: [string, ReactNode][] = [
          ["scheme", e.scheme],
          ["network", networkName(e.network)],
          ["amount", fmtUsdc(e.amount)],
          ["pay to", e.payTo],
        ];
        if (typeof p.cumulative === "string") detail.push(["running total", fmtUsdc(p.cumulative)]);
        if (typeof p.session === "string") detail.push(["session", p.session]);
        if (typeof p.signature === "string") detail.push(["receipt signature", short(p.signature, 10, 10)]);
        if (typeof p.transaction === "string") detail.push(["signed transfer", `${p.transaction.length} base64 chars, fee payer: the facilitator`]);
        if (p.authorization && typeof p.authorization === "object") detail.push(["authorization", "EIP-3009 transferWithAuthorization, signed off-chain"]);
        steps.push({
          key,
          tone: "info",
          t,
          title: method === "session" ? "Agent signs a receipt for the new running total" : method === "gateway" ? "Agent signs a Gateway authorization" : "Agent signs a USDC transfer",
          body: (
            <div className="space-y-2">
              <p>The payee and token matched the agent&apos;s pinned policy, and the price was within its limits. It retries with a PAYMENT-SIGNATURE header.</p>
              <Kv rows={detail} />
            </div>
          ),
        });
        break;
      }
      case "settled": {
        const cumulative = typeof e.extra?.cumulative === "string" ? e.extra.cumulative : null;
        steps.push({
          key,
          tone: e.success ? "ok" : "bad",
          t,
          ms: e.ms,
          title: e.success ? (method === "session" ? "Receipt accepted; answer served" : "Payment settled; answer served") : "Settlement failed; answer withheld",
          body: (
            <div className="space-y-2">
              {method === "session" && e.success && <p>Checked off-chain against the session&apos;s agent key and recorded atomically. No transaction for this call.</p>}
              {method === "gateway" && e.success && <p>Circle Gateway accepted the authorization; it settles in a batch later, so there&apos;s no per-call transaction.</p>}
              {method === "exact" && e.success && <p>One USDC transfer confirmed on Solana devnet.</p>}
              {(e.transaction || cumulative) && (
                <Kv rows={[...(e.transaction ? ([["reference", e.transaction]] as [string, ReactNode][]) : []), ...(cumulative ? ([["accepted total", fmtUsdc(cumulative)]] as [string, ReactNode][]) : [])]} />
              )}
              {e.explorer && <TxLink href={e.explorer} label="View on Solana Explorer" />}
            </div>
          ),
        });
        break;
      }
      case "response":
        steps.push({ key, tone: e.status < 400 ? "ok" : "bad", t, ms: e.ms, title: `HTTP ${e.status}` });
        break;
      case "result":
        if (e.refused) steps.push({ key, tone: "bad", t, title: "The agent refused to pay", body: e.refused });
        else if (!e.ok) steps.push({ key, tone: "bad", t, title: `No answer (HTTP ${e.status})`, body: e.error ?? "The call didn't complete; the agent wasn't charged for an answer it didn't get." });
        else steps.push({ key, tone: "ok", t, ms: e.totalMs, title: "Answer received", body: e.paid ? <>Paid {fmtUsdc(e.paid.amount)} on {networkName(e.paid.network)}. Total time {e.totalMs} ms.</> : undefined });
        break;
      case "error":
        steps.push({ key, tone: "bad", t, title: "The run failed", body: e.message });
        break;
    }
  });
  return steps;
}
