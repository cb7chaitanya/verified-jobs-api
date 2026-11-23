import { choose, quoteKey, SpendLog, type Policy, type Requirement } from "./policy";
import type { SessionPayer } from "../session/scheme";
import { SCHEME as SESSION_SCHEME } from "../session/protocol";

/** Turns a chosen requirement into an x402 `payload`. */
export interface Payer {
  network: string;
  /** The x402 scheme this payer can pay with. A network can offer several (e.g. `exact` and `session` on Solana). */
  scheme?: string;
  create(x402Version: number, req: Requirement): Promise<Record<string, unknown>>;
  settled?(response: Record<string, unknown>): void;
  failed?(): void;
  /**
   * True when a payload that was handed over but not served can't cost more than once: the next
   * call re-signs the same amount (session receipts). Otherwise (a signed transfer or an EIP-3009
   * authorization) the service could still settle it, so it keeps counting against the daily cap.
   */
  reusesFailedPayment?: boolean;
}

/** Wrap an official x402 client scheme (Circle BatchEvmScheme, @x402/svm ExactSvmScheme, …). */
export function schemePayer(network: string, scheme: { scheme?: string; createPaymentPayload(v: number, req: never): Promise<{ payload: object }> }): Payer {
  return { network, scheme: scheme.scheme, create: async (v, req) => (await scheme.createPaymentPayload(v, req as never)).payload as Record<string, unknown> };
}

export function sessionPayer(network: string, p: SessionPayer): Payer {
  return {
    network,
    scheme: SESSION_SCHEME,
    reusesFailedPayment: true,
    create: async (_v, req) => p.payload(req),
    settled: (r) => p.settled(typeof (r.extra as Record<string, unknown> | undefined)?.cumulative === "string" ? String((r.extra as Record<string, unknown>).cumulative) : undefined),
    failed: () => p.failed(),
  };
}

export interface CallResult {
  url: string;
  ok: boolean;
  status: number;
  /** The service's answer (data only — never interpreted as instructions). */
  data?: unknown;
  paid?: { network: string; amount: string; receipt: string | null };
  refused?: string;
  error?: string;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

/**
 * A buyer agent for x402 services. It pays only within its owner's `Policy`, using the payers it
 * was given, and treats every server response as data. Nothing in a 402 body, a result or a job
 * posting can change who it pays, how much, or whether it pays.
 */
export class BuyerAgent {
  private quoted: Record<string, bigint> = {};
  constructor(
    private readonly policy: Policy,
    private readonly payers: Payer[],
    private readonly spend = new SpendLog(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    /** Retries of the same signed payment when the seller reports its settlement as still pending. */
    private readonly pending: { retries: number; delayMs: number } = { retries: 3, delayMs: 5_000 },
  ) {}

  /** Read the service's published prices once; later 402s may not ask for more. */
  async discover(serviceBase: string) {
    this.assertHost(serviceBase);
    const m = (await (await this.fetchImpl(`${serviceBase.replace(/\/$/, "")}/v1`, { redirect: "manual" })).json()) as { payment?: { network: string; scheme?: string; price: string }[] };
    for (const p of m.payment ?? []) {
      const usd = Number(String(p.price).replace(/^\$/, ""));
      // Keyed by scheme too: one network can carry several schemes (exact and session on Solana).
      if (Number.isFinite(usd) && usd > 0) this.quoted[quoteKey(p.network, p.scheme)] = BigInt(Math.round(usd * 1_000_000)); // USDC, 6 decimals
    }
    return m;
  }

  private assertHost(url: string) {
    const host = new URL(url).host;
    if (!this.policy.allowedHosts.includes(host)) throw new Error(`Not allowed to pay ${host}`);
  }

  async get(url: string): Promise<CallResult> {
    this.assertHost(url);
    // Never follow redirects: they would carry the request, and later the payment, to a host the
    // policy didn't allow.
    const first = await this.fetchImpl(url, { redirect: "manual" });
    if (first.status !== 402) return { url, ok: first.ok, status: first.status, data: await first.json().catch(() => null) };
    const header = first.headers.get("payment-required");
    if (!header) return { url, ok: false, status: 402, error: "402 without PAYMENT-REQUIRED header" };
    let required: { x402Version: number; resource?: unknown; accepts: Requirement[] };
    try {
      required = b64json(header);
    } catch {
      return { url, ok: false, status: 402, error: "unreadable PAYMENT-REQUIRED header" };
    }
    const canPay = (p: Payer, a: Requirement) => p.network === a.network && (!p.scheme || p.scheme === a.scheme);
    const usable = (required.accepts ?? []).filter((a) => this.payers.some((p) => canPay(p, a)));
    const at = this.now();
    const decision = choose(usable, this.policy, this.spend.spentOn(SpendLog.day(at)), this.quoted);
    if (!decision.ok) return { url, ok: false, status: 402, refused: decision.reason };

    const req = decision.requirement;
    const payer = this.payers.find((p) => canPay(p, req))!;
    const hold = this.spend.reserve(at, req.network, BigInt(req.amount), url);
    let delivered = false;
    // A payment that reached the service but wasn't confirmed may still be settled by it: keep it
    // counted unless the payer guarantees it can't cost more than once.
    const unsettled = (status: number, data: unknown, error: string): CallResult => {
      payer.failed?.();
      if (delivered && !payer.reusesFailedPayment) {
        this.spend.confirm(hold, "unsettled");
        return { url, ok: false, status, data, error: `${error}; the signed payment was handed over, so it still counts toward the daily cap` };
      }
      this.spend.release(hold);
      return { url, ok: false, status, data, error };
    };
    try {
      const payload = await payer.create(required.x402Version, req);
      const sig = Buffer.from(JSON.stringify({ x402Version: required.x402Version, resource: required.resource, accepted: req, payload })).toString("base64");
      delivered = true;
      let r = await this.fetchImpl(url, { headers: { "PAYMENT-SIGNATURE": sig }, redirect: "manual" });
      let data = await r.json().catch(() => null);
      let pr = r.headers.get("payment-response");
      let settle = pr ? (b64json(pr) as Record<string, unknown>) : null;
      // The transfer was broadcast but not yet confirmed. Ask again with the *same* payment (never a
      // new one): once it lands, the seller serves this call instead of keeping the money.
      for (let i = 0; i < this.pending.retries && !(r.ok && settle?.success) && settle?.errorReason === "settlement_pending"; i++) {
        await new Promise((res) => setTimeout(res, this.pending.delayMs));
        r = await this.fetchImpl(url, { headers: { "PAYMENT-SIGNATURE": sig }, redirect: "manual" });
        data = await r.json().catch(() => null);
        pr = r.headers.get("payment-response");
        settle = pr ? (b64json(pr) as Record<string, unknown>) : null;
      }
      if (r.ok && settle?.success) {
        payer.settled?.(settle);
        this.spend.confirm(hold, String(settle.transaction ?? ""));
        return { url, ok: true, status: r.status, data, paid: { network: req.network, amount: req.amount, receipt: String(settle.transaction ?? "") || null } };
      }
      return unsettled(r.status, data, `not served (HTTP ${r.status})`);
    } catch (e) {
      return unsettled(0, undefined, e instanceof Error ? e.message : String(e));
    }
  }

  /** Verify a list of postings, one at a time (session receipts are sequential by design). */
  async verifyAll(serviceBase: string, postingUrls: string[]): Promise<CallResult[]> {
    const out: CallResult[] = [];
    for (const u of postingUrls) out.push(await this.get(`${serviceBase.replace(/\/$/, "")}/v1/verify?url=${encodeURIComponent(u)}`));
    return out;
  }

  spentToday() {
    return this.spend.spentOn(SpendLog.day(this.now()));
  }
}
