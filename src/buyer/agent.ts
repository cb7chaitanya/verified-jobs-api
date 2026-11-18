import { choose, SpendLog, type Policy, type Requirement } from "./policy";
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
}

/** Wrap an official x402 client scheme (Circle BatchEvmScheme, @x402/svm ExactSvmScheme, …). */
export function schemePayer(network: string, scheme: { scheme?: string; createPaymentPayload(v: number, req: never): Promise<{ payload: object }> }): Payer {
  return { network, scheme: scheme.scheme, create: async (v, req) => (await scheme.createPaymentPayload(v, req as never)).payload as Record<string, unknown> };
}

export function sessionPayer(network: string, p: SessionPayer): Payer {
  return {
    network,
    scheme: SESSION_SCHEME,
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
  ) {}

  /** Read the service's published prices once; later 402s may not ask for more. */
  async discover(serviceBase: string) {
    this.assertHost(serviceBase);
    const m = (await (await this.fetchImpl(`${serviceBase.replace(/\/$/, "")}/v1`)).json()) as { payment?: { network: string; price: string }[] };
    for (const p of m.payment ?? []) {
      const usd = Number(String(p.price).replace(/^\$/, ""));
      if (Number.isFinite(usd) && usd > 0) this.quoted[p.network] = BigInt(Math.round(usd * 1_000_000)); // USDC, 6 decimals
    }
    return m;
  }

  private assertHost(url: string) {
    const host = new URL(url).host;
    if (!this.policy.allowedHosts.includes(host)) throw new Error(`Not allowed to pay ${host}`);
  }

  async get(url: string): Promise<CallResult> {
    this.assertHost(url);
    const first = await this.fetchImpl(url);
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
    try {
      const payload = await payer.create(required.x402Version, req);
      const sig = Buffer.from(JSON.stringify({ x402Version: required.x402Version, resource: required.resource, accepted: req, payload })).toString("base64");
      const r = await this.fetchImpl(url, { headers: { "PAYMENT-SIGNATURE": sig } });
      const data = await r.json().catch(() => null);
      const pr = r.headers.get("payment-response");
      const settle = pr ? (b64json(pr) as Record<string, unknown>) : null;
      if (r.ok && settle?.success) {
        payer.settled?.(settle);
        this.spend.confirm(hold, String(settle.transaction ?? ""));
        return { url, ok: true, status: r.status, data, paid: { network: req.network, amount: req.amount, receipt: String(settle.transaction ?? "") || null } };
      }
      // Not served or not settled: nothing was charged, so release the reservation.
      payer.failed?.();
      this.spend.release(hold);
      return { url, ok: false, status: r.status, data, error: `not served (HTTP ${r.status})` };
    } catch (e) {
      payer.failed?.();
      this.spend.release(hold);
      return { url, ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
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
