"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import recordingsJson from "@/data/recordings.json";
import { DemoError, getConfig, redeem, runVerify, type DemoConfig, type DemoEvent, type RedeemResult, type SessionStatus } from "@/lib/demo";
import { API_URL, RAILS, SAMPLES, railColor, type RailId } from "@/lib/site";
import { Alert, ArrowUpRight, Play } from "../icons";
import { Badge, Card, RailDot } from "../ui";
import { Meter } from "./meter";
import { ResultCard } from "./result";
import { Timeline } from "./timeline";

type Mode = { kind: "connecting" } | { kind: "live"; config: DemoConfig } | { kind: "replay"; reason: string };

interface Recording {
  url: string;
  recordedAt: string;
  events: DemoEvent[];
}
const RECORDINGS = recordingsJson as unknown as Partial<Record<RailId, Recording>>;

/** Recorded runs play back at real speed, except long waits, which are shortened (the labels keep the real times). */
const MAX_REPLAY_GAP_MS = 1600;

export function Playground() {
  const [mode, setMode] = useState<Mode>(API_URL ? { kind: "connecting" } : { kind: "replay", reason: "No live API is configured for this site." });
  const [url, setUrl] = useState(SAMPLES[2]!.url);
  const [method, setMethod] = useState<RailId>("session");
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [budget, setBudget] = useState<{ spentToday: string; dailyCap: string } | null>(null);
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const [redeemed, setRedeemed] = useState<RedeemResult | null>(null);
  const abort = useRef<AbortController | null>(null);
  const timers = useRef<number[]>([]);

  // Connect to the live API, or fall back to replaying recorded runs.
  useEffect(() => {
    if (!API_URL) return;
    const ac = new AbortController();
    const t = window.setTimeout(() => ac.abort(), 8000);
    getConfig(API_URL, ac.signal)
      .then((config) => {
        setMode({ kind: "live", config });
        setBudget(config.budget);
        setSession(config.session);
        const first = RAILS.find((r) => config.methods.some((m) => m.id === r.id));
        if (first) setMethod(first.id);
      })
      .catch(() => setMode({ kind: "replay", reason: "The live API isn't reachable right now." }))
      .finally(() => window.clearTimeout(t));
    return () => ac.abort();
  }, []);

  useEffect(
    () => () => {
      abort.current?.abort();
      timers.current.forEach((t) => window.clearTimeout(t));
    },
    [],
  );

  const enabled = useMemo(() => {
    if (mode.kind === "live") return new Set(mode.config.methods.map((m) => m.id));
    return new Set(Object.keys(RECORDINGS) as RailId[]);
  }, [mode]);

  const replay = mode.kind === "replay";
  const recording = replay ? RECORDINGS[method] : undefined;
  // In replay mode the URL is the one that was recorded for this method.
  const shownUrl = replay && recording ? recording.url : url;

  const onEvent = useCallback((e: DemoEvent) => {
    setEvents((xs) => [...xs, e]);
    if (e.type === "result") {
      setBudget(e.budget);
      if (e.session) setSession(e.session);
    }
    if (e.type === "session-opened") setSession({ session: e.session, spent: "0", deposit: e.deposit });
  }, []);

  const run = async () => {
    if (running) return;
    setEvents([]);
    setError(null);
    setRedeemed(null);
    setRunning(true);

    if (replay) {
      if (!recording) {
        setError("There's no recording for this payment method.");
        setRunning(false);
        return;
      }
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
      let delay = 0;
      recording.events.forEach((e, i) => {
        const prev = recording.events[i - 1];
        delay += prev ? Math.min(e.at - prev.at, MAX_REPLAY_GAP_MS) : 150;
        timers.current.push(
          window.setTimeout(() => {
            onEvent(e);
            if (i === recording.events.length - 1) setRunning(false);
          }, delay),
        );
      });
      return;
    }

    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    try {
      await runVerify(API_URL, url.trim(), method, onEvent, ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof DemoError ? e.message : "The live API couldn't be reached. Try again in a moment.");
    } finally {
      setRunning(false);
    }
  };

  const doRedeem = async () => {
    setRedeeming(true);
    setError(null);
    try {
      setRedeemed(await redeem(API_URL));
    } catch (e) {
      setError(e instanceof DemoError ? e.message : "The redeem failed. Try again in a moment.");
    } finally {
      setRedeeming(false);
    }
  };

  const result = events.findLast((e) => e.type === "result");
  const sessionRail = method === "session";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:items-start">
      {/* Controls */}
      <div className="space-y-4">
        <ModeBanner mode={mode} />
        <Card className="p-5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
            className="space-y-6"
          >
            <div>
              <label htmlFor="posting" className="mb-2 block text-sm font-medium">
                Job posting URL
              </label>
              <input
                id="posting"
                type="url"
                required
                inputMode="url"
                spellCheck={false}
                autoComplete="off"
                value={shownUrl}
                onChange={(e) => setUrl(e.target.value)}
                disabled={replay || running}
                placeholder="https://jobs.lever.co/…"
                className="h-10 w-full rounded-lg border border-line-strong bg-bg px-3 font-mono text-[13px] outline-none transition placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-70"
              />
              {replay ? (
                <p className="mt-2 text-xs text-faint">Replays use the posting that was checked when they were recorded.</p>
              ) : (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {SAMPLES.map((s) => (
                    <button
                      key={s.url}
                      type="button"
                      onClick={() => setUrl(s.url)}
                      disabled={running}
                      className={`rounded-full border px-2.5 py-1 text-xs transition ${url === s.url ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg"}`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <fieldset>
              <legend className="mb-2 text-sm font-medium">Pay with</legend>
              <div className="space-y-2">
                {RAILS.map((r) => {
                  const on = enabled.has(r.id);
                  const checked = method === r.id;
                  return (
                    <label
                      key={r.id}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${checked ? "border-fg/40 bg-raised" : "border-line hover:border-line-strong"} ${!on ? "cursor-not-allowed opacity-50" : ""}`}
                    >
                      <input type="radio" name="method" value={r.id} checked={checked} disabled={!on || running} onChange={() => setMethod(r.id)} className="sr-only" />
                      <span aria-hidden className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${checked ? "border-fg" : "border-line-strong"}`}>
                        {checked && <span className="size-2 rounded-full bg-fg" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <RailDot color={railColor[r.id]} />
                          <span className="font-mono text-sm font-medium">{r.name}</span>
                          <span className="ml-auto text-xs text-faint">{r.network}</span>
                        </span>
                        <span className="mt-1 block text-xs text-muted">{r.short} · {r.perCall}</span>
                        {!on && <span className="mt-1 block text-xs text-faint">Not enabled on this server</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div>
              <button
                type="submit"
                disabled={running || mode.kind === "connecting" || !enabled.has(method)}
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-fg text-sm font-medium text-bg transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {running ? (
                  <>
                    <span className="size-3.5 animate-spin rounded-full border-2 border-bg/30 border-t-bg" /> {replay ? "Replaying…" : "Paying and checking…"}
                  </>
                ) : (
                  <>
                    <Play /> {replay ? "Replay a recorded run" : "Pay $0.001 and check"}
                  </>
                )}
              </button>
              <p className="mt-2 text-center text-xs text-faint">{replay ? "Nothing is paid during a replay." : "Paid from the demo's testnet wallet. You need no wallet."}</p>
            </div>
          </form>
        </Card>

        {budget && (
          <Card className="p-5">
            <Meter label="Demo budget today" used={Number(budget.spentToday)} total={Number(budget.dailyCap)} />
          </Card>
        )}

        {sessionRail && session && (
          <Card className="space-y-4 p-5">
            <Meter label="Session deposit used" used={Number(session.spent)} total={Number(session.deposit)} color="var(--session)" />
            <p className="text-xs text-muted">
              Each call signed a new running total. The seller hasn&apos;t touched the chain yet; it redeems the latest receipt in one transaction.
            </p>
            {mode.kind === "live" && mode.config.canRedeem && (
              <button
                type="button"
                onClick={doRedeem}
                disabled={redeeming || running}
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-line-strong text-sm font-medium transition hover:bg-raised disabled:opacity-50"
              >
                {redeeming ? "Redeeming…" : "Redeem now, as the seller"}
              </button>
            )}
            {redeemed && <RedeemSummary r={redeemed} />}
          </Card>
        )}
      </div>

      {/* Exchange + answer */}
      <div className="min-w-0 space-y-4">
        {error && (
          <div role="alert" className="flex gap-3 rounded-xl border border-bad/30 bg-bad-soft p-4 text-sm text-bad">
            <Alert className="mt-0.5 shrink-0" />
            <p>{error}</p>
          </div>
        )}
        <Timeline events={events} running={running} method={method} replay={replay} recordedAt={recording?.recordedAt} />
        {result && result.type === "result" && <ResultCard result={result} />}
      </div>
    </div>
  );
}

function ModeBanner({ mode }: { mode: Mode }) {
  if (mode.kind === "connecting")
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">
        <span className="size-3 animate-spin rounded-full border-2 border-line-strong border-t-fg" /> Connecting to the live API…
      </div>
    );
  if (mode.kind === "live")
    return (
      <div className="flex items-center gap-2 rounded-xl border border-ok/25 bg-ok-soft px-4 py-3 text-sm text-ok">
        <span className="pulse-dot size-2 rounded-full bg-ok" />
        <span>
          <b className="font-medium">Live on testnet.</b> Runs pay the real API.
        </span>
      </div>
    );
  return (
    <div className="rounded-xl border border-warn/25 bg-warn-soft px-4 py-3 text-sm text-warn">
      <b className="font-medium">Replay mode.</b> {mode.reason} You&apos;ll see real recorded runs, with their real explorer links.
    </div>
  );
}

function RedeemSummary({ r }: { r: RedeemResult }) {
  if (!r.redeemed.length) return <p className="text-xs text-muted">Nothing was due: every receipt is already redeemed.</p>;
  return (
    <ul className="space-y-2">
      {r.redeemed.map((x) => (
        <li key={x.session + (x.tx ?? "")} className="flex items-center justify-between gap-2 text-xs">
          {x.error ? (
            <Badge tone="bad">{x.error}</Badge>
          ) : (
            <>
              <span className="text-muted">
                Redeemed <span className="font-mono text-fg">{(Number(x.amount) / 1e6).toFixed(3)} USDC</span> in {r.ms} ms
              </span>
              {x.explorer && (
                <a href={x.explorer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  tx <ArrowUpRight className="size-3" />
                </a>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
