/**
 * Client for the API's testnet demo routes (src/demo/demo.ts in the API):
 *   GET  /demo/config  → which payment methods are on, the daily budget, the demo session
 *   POST /demo/verify  → NDJSON stream of the exchange, one event per line
 *   POST /demo/redeem  → the seller redeems the demo session's receipts in one transaction
 */
import type { RailId } from "./site";

export interface Offer {
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
}

export interface Verification {
  url: string;
  status: "OPEN" | "CLOSED" | "UNKNOWN";
  checkedAt: string;
  cached?: boolean;
  evidence: { type: string; board: string; boardId: string; jobId: string; endpoint: string; httpStatus: number | null; ms: number | null; detail: string };
  job: null | { title: string; company: string | null; location: string | null; workplace: string; postedAt: string | null; applyUrl: string | null; isSoftwareRole: boolean };
  india: null | { eligibility: "ELIGIBLE" | "NEEDS_REVIEW" | "INELIGIBLE"; tier: string; reasons: string[] };
}

export type DemoEvent =
  | { type: "start"; at: number; method: RailId; url: string }
  | { type: "session-opening"; at: number; deposit: string }
  | { type: "session-opened"; at: number; session: string; tx: string; explorer: string; ms: number; deposit: string }
  | { type: "402"; at: number; ms: number; accepts: Offer[] }
  | { type: "pay"; at: number; scheme: string; network: string; amount: string; payTo: string; payload?: Record<string, unknown> }
  | { type: "settled"; at: number; ms: number; status: number; success: boolean; transaction: string | null; explorer: string | null; extra?: Record<string, unknown> | null }
  | { type: "response"; at: number; ms: number; status: number }
  | {
      type: "result";
      at: number;
      ok: boolean;
      status: number;
      data: Verification | Record<string, unknown> | null;
      paid: { network: string; amount: string; receipt: string | null } | null;
      refused: string | null;
      error: string | null;
      totalMs: number;
      budget: Budget;
      session: SessionStatus | null;
    }
  | { type: "error"; at: number; message: string };

export interface Budget {
  spentToday: string;
  dailyCap: string;
}
export interface SessionStatus {
  session: string;
  spent: string;
  deposit: string;
}

export interface DemoConfig {
  price: string;
  methods: { id: RailId; network: string; payTo: string }[];
  canRedeem: boolean;
  session: SessionStatus | null;
  budget: Budget;
}

export interface RedeemResult {
  ms: number;
  redeemed: { session: string; amount: string; tx: string | null; explorer: string | null; error: string | null }[];
}

export class DemoError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const NETWORKS: Record<string, string> = {
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "Solana devnet",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana mainnet",
  "eip155:5042002": "Arc Testnet",
};
export const networkName = (caip2: string) => NETWORKS[caip2] ?? caip2;
export const fmtUsdc = (atomic: string | number) => `${(Number(atomic) / 1e6).toFixed(Number(atomic) % 1000 === 0 ? 3 : 6)} USDC`;
export const short = (s: string, head = 4, tail = 4) => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);

async function failure(r: Response): Promise<DemoError> {
  let message = `The demo answered ${r.status}`;
  try {
    const body = (await r.json()) as { message?: string; error?: string };
    message = body.message ?? (r.status === 403 ? "This site isn't allowed to use the demo API." : body.error ?? message);
  } catch {
    /* not JSON */
  }
  return new DemoError(message, r.status);
}

export async function getConfig(api: string, signal?: AbortSignal): Promise<DemoConfig> {
  const r = await fetch(`${api}/demo/config`, { signal, cache: "no-store" });
  if (!r.ok) throw await failure(r);
  return (await r.json()) as DemoConfig;
}

/** Runs one paid check and calls `onEvent` for each line of the stream as it arrives. */
export async function runVerify(api: string, url: string, method: RailId, onEvent: (e: DemoEvent) => void, signal?: AbortSignal) {
  const r = await fetch(`${api}/demo/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, method }), signal });
  if (!r.ok || !r.body) throw await failure(r);
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as DemoEvent);
    }
    if (done) break;
  }
  if (buf.trim()) onEvent(JSON.parse(buf) as DemoEvent);
}

export async function redeem(api: string): Promise<RedeemResult> {
  const r = await fetch(`${api}/demo/redeem`, { method: "POST" });
  if (!r.ok) throw await failure(r);
  return (await r.json()) as RedeemResult;
}

export const isVerification = (d: unknown): d is Verification => !!d && typeof d === "object" && "status" in d && "evidence" in d;
