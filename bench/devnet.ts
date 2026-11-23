/**
 * The same comparison as bench/local.ts, on real Solana devnet: x402 `exact` through the public
 * x402.org facilitator vs `pay_session` (deployed program), with real devnet USDC.
 *
 *   BUYER_KEYPAIR=… SELLER_KEYPAIR=… pnpm bench:devnet      # BENCH_CALLS=100 by default
 *
 * Needs: the pay_session program deployed on devnet; the buyer holding devnet USDC
 * (https://faucet.circle.com) and a little SOL for opening the session; the seller holding a
 * little SOL for its token account and the redeem. Job checks are stubbed, so only payment cost
 * is measured. At the end it checks the seller received exactly calls × price on each path.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { address, signature as asSignature } from "@solana/kit";
import { fetchToken, getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/express";
import { ExactSvmScheme as ExactServer } from "@x402/svm/exact/server";
import { ExactSvmScheme as ExactClient } from "@x402/svm/exact/client";
import { createApp } from "../src/app";
import { Ledger } from "../src/ledger";
import { BuyerAgent, schemePayer, sessionPayer } from "../src/buyer/agent";
import { SpendLog } from "../src/buyer/policy";
import { caip2, connect, RpcSessionReader } from "../src/session/chain";
import { SessionFacilitator } from "../src/session/facilitator";
import { SessionPayer, SessionServerScheme } from "../src/session/scheme";
import { ata, closeSession, openSession, redeemDue } from "../src/session/ops";
import { PROGRAM_ID, ReceiptSigner } from "../src/session/protocol";
import { newKeypairFile, signerFrom } from "../src/cli/keys";
import { ConfirmingFacilitator, rpcTxSource } from "../src/exact-confirm";
import type { Verification } from "../src/core/verify";

const CALLS = Number(process.env.BENCH_CALLS ?? 100);
/** Pause between calls so the public devnet RPC doesn't rate-limit the run. Not counted in latency. */
const PACE_MS = Number(process.env.BENCH_PACE_MS ?? 1000);
const PRICE = 1000n; // $0.001 in USDC atomic units
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const MINT = address(process.env.SESSION_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // devnet USDC
const FACILITATOR = process.env.SOLANA_FACILITATOR_URL ?? "https://x402.org/facilitator";
const DIR = process.env.BENCH_DIR ?? "./.bench";
const need = (k: string) => process.env[k] ?? (() => { throw new Error(`Set ${k}`); })();
mkdirSync(DIR, { recursive: true });

const chain = connect(RPC);
const network = await caip2(chain.rpc);
if (network !== "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1") throw new Error(`${RPC} isn't devnet (${network})`);
const program = await chain.rpc.getAccountInfo(PROGRAM_ID, { encoding: "base64" }).send();
if (!program.value?.executable) throw new Error(`pay_session (${PROGRAM_ID}) isn't deployed on devnet yet`);

const buyer = await signerFrom(need("BUYER_KEYPAIR"));
const seller = await signerFrom(need("SELLER_KEYPAIR"));
const buyerToken = await ata(buyer.address, MINT);
const sellerToken = await ata(seller.address, MINT);
const balance = async (t: typeof sellerToken) => {
  try {
    return (await fetchToken(chain.rpc, t)).data.amount;
  } catch {
    return 0n;
  }
};
const deposit = BigInt(CALLS) * PRICE + PRICE;
const buyerUsdc = await balance(buyerToken);
if (buyerUsdc < BigInt(CALLS) * PRICE + deposit) throw new Error(`Buyer ${buyer.address} holds ${Number(buyerUsdc) / 1e6} devnet USDC; needs ${Number(BigInt(CALLS) * PRICE + deposit) / 1e6}`);
// x402 exact pays into the seller's token account, so make sure it exists.
await chain.send(seller, [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: seller, owner: seller.address, mint: MINT })]);

const stub: Verification = { url: "https://jobs.lever.co/acme/1", status: "OPEN", checkedAt: new Date().toISOString(), evidence: { type: "ATS_DETAIL_ACTIVE", board: "LEVER", boardId: "acme", jobId: "1", endpoint: "stub", httpStatus: 200, ms: 0, detail: "stubbed for the benchmark" }, job: null, india: null };

async function serve(rs: x402ResourceServer, scheme: "exact" | "session", ledger: Ledger) {
  const app = createApp({ verify: async () => stub, payments: { server: rs, options: [{ scheme, network, payTo: seller.address, price: "$0.001", label: scheme }] }, ledger, cacheMs: 0 });
  const s = await new Promise<Server>((r) => {
    const x = app.listen(0, () => r(x));
  });
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Records what the public facilitator said for every verify and settle, so refusals can be explained. */
type Outcome = { step: "verify" | "settle"; ok: boolean; reason?: string; tx?: string };
class RecordingFacilitator extends HTTPFacilitatorClient {
  outcomes: Outcome[] = [];
  override async verify(...a: Parameters<HTTPFacilitatorClient["verify"]>) {
    try {
      const r = await super.verify(...a);
      this.outcomes.push({ step: "verify", ok: r.isValid, reason: r.invalidReason });
      return r;
    } catch (e) {
      this.outcomes.push({ step: "verify", ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      throw e;
    }
  }
  override async settle(...a: Parameters<HTTPFacilitatorClient["settle"]>) {
    try {
      const r = await super.settle(...a);
      this.outcomes.push({ step: "settle", ok: r.success, reason: r.errorReason, tx: r.transaction || undefined });
      return r;
    } catch (e) {
      this.outcomes.push({ step: "settle", ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      throw e;
    }
  }
}
const facilitator = new RecordingFacilitator({ url: FACILITATOR });
// BENCH_RAW_EXACT=1 measures the facilitator alone, without the on-chain confirmation fallback.
const RAW = process.env.BENCH_RAW_EXACT === "1";
const confirming = new ConfirmingFacilitator(facilitator, rpcTxSource(chain.rpc));

const exactLedger = new Ledger();
const exactApi = await serve(new x402ResourceServer(RAW ? facilitator : confirming).register(network, new ExactServer()), "exact", exactLedger);
const sessionLedger = new Ledger();
const sessionApi = await serve(new x402ResourceServer(new SessionFacilitator({ network, reader: new RpcSessionReader(chain.rpc), ledger: sessionLedger })).register(network, new SessionServerScheme({ mint: MINT })), "session", sessionLedger);

const policy = (host: string) => ({ allowedHosts: [host], networks: [network], payees: { [network]: seller.address }, assets: { [network]: MINT }, maxPerCall: 2_000n, dailyCap: 1_000_000_000n });
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
};

async function run(base: string, agent: BuyerAgent) {
  await agent.discover(base);
  const ms: number[] = [];
  const receipts: string[] = [];
  let ok = 0;
  for (let i = 0; i < CALLS; i++) {
    const t = performance.now();
    const r = await agent.get(`${base}/v1/verify?url=${encodeURIComponent(stub.url)}`);
    ms.push(performance.now() - t);
    if (r.ok) {
      ok++;
      if (r.paid?.receipt) receipts.push(r.paid.receipt);
    } else console.error("call failed:", r.refused ?? r.error, JSON.stringify(r.data)?.slice(0, 400));
    if (PACE_MS) await sleep(PACE_MS);
  }
  return { ok, ms, receipts };
}

async function fee(sig: string): Promise<bigint> {
  for (let i = 0; i < 40; i++) {
    try {
      const tx = await chain.rpc.getTransaction(asSignature(sig), { commitment: "confirmed", maxSupportedTransactionVersion: 1 as 0, encoding: "json" }).send();
      if (tx?.meta) return BigInt(tx.meta.fee);
    } catch (e) {
      if (!String(e).includes("429")) throw e;
    }
    await sleep(1000);
  }
  throw new Error(`no tx ${sig}`);
}

/** Wait until the seller's balance reaches `target` (devnet RPC reads can lag the confirmation). */
async function sellerBalanceAtLeast(target: bigint) {
  let b = 0n;
  for (let i = 0; i < 30; i++) {
    b = await balance(sellerToken);
    if (b >= target) return b;
    await sleep(1000);
  }
  // Late settlements can still be landing; give them a little longer before taking the final balance.
  await sleep(5000);
  b = await balance(sellerToken);
  return b;
}

// --- x402 exact (public facilitator pays the fees) ---
const start = await balance(sellerToken);
const exact = await run(exactApi.base, new BuyerAgent(policy(new URL(exactApi.base).host), [schemePayer(network, new ExactClient(buyer, { rpcUrl: RPC }))], new SpendLog()));
const afterExact = await sellerBalanceAtLeast(start + BigInt(exact.ok) * PRICE);
let exactFees = 0n;
const settled = facilitator.outcomes.filter((o) => o.step === "settle");
const landedTxs = [...new Set(settled.map((o) => o.tx).filter((t): t is string => !!t))];
const exactTxs = [...new Set([...exact.receipts, ...landedTxs])];
for (const s of exactTxs) {
  exactFees += await fee(s);
  await sleep(200);
}
const count = (xs: Outcome[]) => xs.reduce<Record<string, number>>((m, o) => ((m[o.ok ? "ok" : (o.reason ?? "unknown")] = (m[o.ok ? "ok" : (o.reason ?? "unknown")] ?? 0) + 1), m), {});
const exactCharged = (afterExact - start) / PRICE;

// --- pay_session ---
const agentKey = newKeypairFile(join(DIR, "devnet-agent.json"));
const t0 = performance.now();
const opened = await openSession(chain, { buyer, seller: seller.address, mint: MINT, signer: agentKey.address, deposit, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600) });
const openMs = performance.now() - t0;
const payer = new SessionPayer({ address: opened.session, seller: seller.address, mint: MINT, deposit, openedSlot: opened.openedSlot }, new ReceiptSigner(agentKey.secret));
const session = await run(sessionApi.base, new BuyerAgent(policy(new URL(sessionApi.base).host), [sessionPayer(network, payer)], new SpendLog()));
const t1 = performance.now();
const redeemed = await redeemDue(chain, sessionLedger, new RpcSessionReader(chain.rpc, 0), seller, { minAmount: 1n });
const redeemMs = performance.now() - t1;
const afterSession = await sellerBalanceAtLeast(afterExact + BigInt(session.ok) * PRICE);
const sessionTxs = [opened.tx, ...redeemed.filter((r) => r.tx).map((r) => r.tx!)];
let sessionFees = 0n;
for (const s of sessionTxs) sessionFees += await fee(s);
// Tidy up: the seller closes early, which refunds the unused deposit and the rent to the buyer.
const closeTx = await closeSession(chain, { caller: seller, buyer: buyer.address, session: opened.session, mint: MINT });

const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const result = {
  at: new Date().toISOString(),
  cluster: "Solana devnet",
  program: PROGRAM_ID,
  calls: CALLS,
  pricePerCall: "0.001 USDC",
  paceMs: PACE_MS,
  note: "Job checks are stubbed, so latency is payment overhead plus local HTTP to a local API, and devnet RPC/confirmation for exact. exact fees were paid by the public x402.org facilitator; session fees by the buyer (open) and the seller (redeem).",
  exact: {
    facilitator: FACILITATOR,
    served: exact.ok,
    latencyMs: stats(exact.ms),
    onchainTransactions: exactTxs.length,
    feesLamports: exactFees.toString(),
    sellerReceived: (afterExact - start).toString(),
    expected: (BigInt(exact.ok) * PRICE).toString(),
    chargedNotServed: Number(exactCharged) - exact.ok,
    confirmationFallback: RAW ? "off" : "on",
    recoveredOnChain: confirming.recovered,
    facilitatorVerify: count(facilitator.outcomes.filter((o) => o.step === "verify")),
    facilitatorSettle: count(settled),
    sampleTx: exact.receipts[0] ? explorer(exact.receipts[0]) : null,
  },
  session: {
    served: session.ok,
    latencyMs: stats(session.ms),
    openMs: Math.round(openMs),
    redeemMs: Math.round(redeemMs),
    onchainTransactions: sessionTxs.length,
    feesLamports: sessionFees.toString(),
    sellerReceived: (afterSession - afterExact).toString(),
    expected: (BigInt(session.ok) * PRICE).toString(),
    openTx: explorer(opened.tx),
    redeemTx: sessionTxs[1] ? explorer(sessionTxs[1]) : null,
    closeTx: explorer(closeTx),
    note: "Opening pays rent for the session and vault accounts; the close returned it with the unused deposit.",
  },
};
// Both paths must reconcile exactly: every call served, and the seller paid for exactly those calls.
// With BENCH_RAW_EXACT=1 the exact path is only reported, since unserved-but-paid calls are the finding.
const sessionOk = result.session.sellerReceived === result.session.expected && session.ok === CALLS;
const exactOk = result.exact.sellerReceived === result.exact.expected && exact.ok === CALLS;
const ok = sessionOk && (RAW || exactOk);
mkdirSync("bench/results", { recursive: true });
const out = `bench/results/devnet-${result.at.slice(0, 10)}${RAW ? "-raw" : ""}.json`;
writeFileSync(out, JSON.stringify({ ...result, balancesMatch: ok }, null, 2));
console.log(JSON.stringify({ ...result, balancesMatch: ok }, null, 2));
console.log(`\nwrote ${out}`);
exactApi.close();
sessionApi.close();
process.exit(ok ? 0 : 1);
