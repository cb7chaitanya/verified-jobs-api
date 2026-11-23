/**
 * Testnet demo: a web page where you paste a job posting, pick a payment method, and watch a real
 * buyer agent pay this API and get the answer. The agent pays from testnet keys held by this
 * server, so visitors need no wallet.
 *
 * Off unless DEMO=1. It spends the server's testnet funds, so it is capped per day, rate-limited,
 * runs one call at a time and only answers same-origin requests. Never point it at mainnet keys.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import type { Address, KeyPairSigner } from "@solana/kit";
import { BuyerAgent, type Payer } from "../buyer/agent";
import { SpendLog, type Policy } from "../buyer/policy";
import { log } from "../core/log";
import type { Ledger } from "../ledger";
import type { connect } from "../session/chain";
import { RpcSessionReader } from "../session/chain";
import { openSession, redeemDue } from "../session/ops";
import { ReceiptSigner } from "../session/protocol";
import { SessionPayer } from "../session/scheme";
import { newKeypairFile } from "../cli/keys";

export type MethodId = "gateway" | "exact" | "session";
type Chain = ReturnType<typeof connect>;

export interface DemoMethod {
  id: MethodId;
  network: string;
  payTo: string;
  /** Token the agent will pay in (pinned in its policy). */
  asset: string;
  /** Explorer link for a settlement reference, when there is one to show. */
  explorer?: (tx: string) => string | null;
  /** The payer for one run. May open on-chain state first and report it through `emit`. */
  payer(emit: (e: DemoEvent) => void, price: bigint): Promise<Payer>;
}

export type DemoEvent = Record<string, unknown> & { type: string };

export const SAMPLES = [
  { label: "Groww · Internal Audit", board: "Greenhouse", url: "https://job-boards.eu.greenhouse.io/groww/jobs/4970739101" },
  { label: "Meesho · Risk & Decision Science", board: "Lever", url: "https://jobs.lever.co/meesho/7d9af9b5-c1c7-48ec-bbb5-9b25e49f6596" },
  { label: "Notion · Forward Deployed Engineer, India", board: "Ashby", url: "https://jobs.ashbyhq.com/notion/79c18580-c927-456c-9d5f-72efbc6c43cb" },
  { label: "Notion · Forward Deployed Engineer, AMER", board: "Ashby", url: "https://jobs.ashbyhq.com/notion/10437426-14c8-4c45-8075-67959ce80393" },
];

export const solanaExplorer = (tx: string) => `https://explorer.solana.com/tx/${tx}?cluster=devnet`;

/** A prepaid session for the demo agent: opened on first use, reopened when the deposit runs out. */
export class DemoSession {
  private payer: SessionPayer | null = null;
  constructor(
    private chain: Chain,
    private buyer: KeyPairSigner,
    private seller: Address,
    private mint: Address,
    private deposit: bigint,
    private dir: string,
  ) {}

  async get(emit: (e: DemoEvent) => void, price: bigint): Promise<SessionPayer> {
    if (this.payer && this.payer.spent + price <= this.payer.session.deposit) return this.payer;
    emit({ type: "session-opening", deposit: this.deposit.toString() });
    const key = newKeypairFile(join(this.dir, `demo-session-signer-${Date.now()}.json`));
    const t = performance.now();
    const opened = await openSession(this.chain, { buyer: this.buyer, seller: this.seller, mint: this.mint, signer: key.address, deposit: this.deposit, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 24 * 3600) });
    this.payer = new SessionPayer({ address: opened.session, seller: this.seller, mint: this.mint, deposit: this.deposit, openedSlot: opened.openedSlot }, new ReceiptSigner(key.secret));
    emit({ type: "session-opened", session: opened.session, tx: opened.tx, explorer: solanaExplorer(opened.tx), ms: Math.round(performance.now() - t), deposit: this.deposit.toString() });
    return this.payer;
  }

  status() {
    return this.payer ? { session: this.payer.session.address, spent: this.payer.spent.toString(), deposit: this.payer.session.deposit.toString() } : null;
  }
}

export interface DemoOptions {
  /** Base URL the agent uses to reach this server (normally http://127.0.0.1:<port>). */
  selfBase: string;
  price: bigint;
  methods: DemoMethod[];
  dailyCap: bigint;
  /** Session redeem, if the seller key is available. */
  redeem?: { chain: Chain; ledger: Ledger; seller: KeyPairSigner };
  session?: DemoSession;
  resultsDir?: string;
  /** Max paid runs per window, across all visitors. */
  rate?: { max: number; windowMs: number };
  fetchImpl?: typeof fetch;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as Record<string, unknown>;
const PAGE = join(dirname(fileURLToPath(import.meta.url)), "page.html");

/** The newest result file for a benchmark kind, parsed; null if none. */
function latest(dir: string, prefix: string, exclude?: RegExp) {
  try {
    const f = readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && n.endsWith(".json") && !exclude?.test(n))
      .sort()
      .at(-1);
    return f ? { file: f, ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as object) } : null;
  } catch {
    return null;
  }
}

export function benchmarks(dir: string) {
  return {
    localnet: latest(dir, "localnet-"),
    devnet: latest(dir, "devnet-", /-raw\.json$/),
    devnetRaw: latest(dir, "devnet-", /^(?!.*-raw\.json$)/),
    gateway: latest(dir, "arc-gateway-"),
  };
}

export function mountDemo(app: Express, o: DemoOptions) {
  const page = readFileSync(PAGE, "utf8");
  const spend = new SpendLog();
  const host = new URL(o.selfBase).host;
  const rate = o.rate ?? { max: 30, windowMs: 10 * 60_000 };
  const runs: number[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const results = o.resultsDir ?? join(process.cwd(), "bench/results");
  const doFetch = o.fetchImpl ?? fetch;

  /** Same-origin only: a browser on another site can't spend the demo's funds. */
  const sameOrigin = (req: Request) => {
    const origin = req.get("origin");
    if (!origin) return true;
    try {
      return new URL(origin).host === req.get("host");
    } catch {
      return false;
    }
  };

  app.get("/", (_req, res) => {
    res.set("Cache-Control", "no-store").type("html").send(page);
  });

  app.get("/demo/config", (_req, res) => {
    const today = spend.spentOn(SpendLog.day(Date.now()));
    res.json({
      price: o.price.toString(),
      methods: o.methods.map((m) => ({ id: m.id, network: m.network, payTo: m.payTo })),
      samples: SAMPLES,
      canRedeem: !!o.redeem && !!o.session,
      session: o.session?.status() ?? null,
      budget: { spentToday: today.toString(), dailyCap: o.dailyCap.toString() },
      benchmarks: benchmarks(results),
    });
  });

  app.post("/demo/verify", express.json({ limit: "4kb" }), (req: Request, res: Response) => {
    if (!sameOrigin(req)) return void res.status(403).json({ error: "FORBIDDEN" });
    const { url, method } = (req.body ?? {}) as { url?: unknown; method?: unknown };
    const m = o.methods.find((x) => x.id === method);
    if (typeof url !== "string" || !url || url.length > 2048) return void res.status(400).json({ error: "INVALID_URL", message: "Paste a job posting URL" });
    if (!m) return void res.status(400).json({ error: "UNKNOWN_METHOD", message: "That payment method isn't enabled here" });
    const now = Date.now();
    while (runs.length && now - runs[0]! > rate.windowMs) runs.shift();
    if (runs.length >= rate.max) return void res.status(429).json({ error: "RATE_LIMITED", message: "The demo is busy; try again in a few minutes" });
    runs.push(now);

    res.status(200).type("application/x-ndjson").set("Cache-Control", "no-store");
    const emit = (e: DemoEvent) => {
      if (!res.writableEnded) res.write(JSON.stringify({ ...e, at: Date.now() }) + "\n");
    };
    const job = queue.then(() => run(m, url, emit)).catch((e) => emit({ type: "error", message: e instanceof Error ? e.message : String(e) }));
    queue = job;
    void job.finally(() => res.end());
  });

  app.post("/demo/redeem", (req: Request, res: Response) => {
    if (!sameOrigin(req)) return void res.status(403).json({ error: "FORBIDDEN" });
    if (!o.redeem) return void res.status(404).json({ error: "NOT_ENABLED" });
    const r = o.redeem;
    const job = queue.then(async () => {
      const t = performance.now();
      const out = await redeemDue(r.chain, r.ledger, new RpcSessionReader(r.chain.rpc, 0), r.seller, { minAmount: 1n });
      return { ms: Math.round(performance.now() - t), redeemed: out.map((x) => ({ session: x.session, amount: x.amount.toString(), tx: x.tx ?? null, explorer: x.tx ? solanaExplorer(x.tx) : null, error: x.error ?? null })) };
    });
    queue = job.catch(() => {});
    job.then(
      (body) => res.json(body),
      (e) => {
        log.error({ err: e instanceof Error ? e.message : String(e) }, "demo redeem failed");
        res.status(502).json({ error: "REDEEM_FAILED", message: e instanceof Error ? e.message : String(e) });
      },
    );
  });

  async function run(m: DemoMethod, url: string, emit: (e: DemoEvent) => void) {
    const started = performance.now();
    emit({ type: "start", method: m.id, url });
    const payer = await m.payer(emit, o.price);

    // Watch the agent's HTTP calls to show each step of the x402 exchange. The agent itself is unchanged.
    const watched: typeof fetch = async (input, init) => {
      const target = String(input);
      const sig = (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];
      if (sig) {
        const p = b64json(sig);
        const acc = (p.accepted ?? {}) as Record<string, unknown>;
        emit({ type: "pay", scheme: acc.scheme, network: acc.network, amount: acc.amount, payTo: acc.payTo, payload: p.payload });
      }
      const t = performance.now();
      const r = await doFetch(input, init);
      const ms = Math.round(performance.now() - t);
      if (target.endsWith("/v1")) return r;
      if (!sig && r.status === 402) {
        const h = r.headers.get("payment-required");
        const accepts = h ? ((b64json(h).accepts as Record<string, unknown>[]) ?? []).map((a) => ({ scheme: a.scheme, network: a.network, amount: a.amount, payTo: a.payTo })) : [];
        emit({ type: "402", ms, accepts });
      } else if (sig) {
        const pr = r.headers.get("payment-response");
        const settle = pr ? b64json(pr) : null;
        const tx = typeof settle?.transaction === "string" ? settle.transaction : null;
        emit({ type: "settled", ms, status: r.status, success: !!settle?.success, transaction: tx, explorer: tx ? (m.explorer?.(tx) ?? null) : null, extra: settle?.extra ?? null });
      } else {
        emit({ type: "response", ms, status: r.status });
      }
      return r;
    };

    const policy: Policy = { allowedHosts: [host], networks: [m.network], payees: { [m.network]: m.payTo }, assets: { [m.network]: m.asset }, maxPerCall: o.price, dailyCap: o.dailyCap };
    const agent = new BuyerAgent(policy, [payer], spend, watched);
    await agent.discover(o.selfBase);
    const r = await agent.get(`${o.selfBase}/v1/verify?url=${encodeURIComponent(url)}`);
    emit({
      type: "result",
      ok: r.ok,
      status: r.status,
      data: r.data ?? null,
      paid: r.paid ?? null,
      refused: r.refused ?? null,
      error: r.error ?? null,
      totalMs: Math.round(performance.now() - started),
      budget: { spentToday: spend.spentOn(SpendLog.day(Date.now())).toString(), dailyCap: o.dailyCap.toString() },
      session: m.id === "session" ? (o.session?.status() ?? null) : null,
    });
  }
}
