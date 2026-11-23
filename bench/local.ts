/**
 * End-to-end benchmark on a local Solana validator: x402 `exact` (one transfer per call)
 * vs `pay_session` (one signed receipt per call, redeemed in one transaction).
 *
 *   pnpm solana:build && pnpm bench:local          # BENCH_CALLS=100 by default
 *
 * Starts solana-test-validator with the pay_session program, creates a test USDC mint, runs the
 * real API (job checks stubbed so only payment cost is measured) and the real buyer agent, then
 * checks the seller received exactly calls × price on each path. Writes bench/results/*.json.
 * Circle Gateway on Arc Testnet needs testnet funds, so it's measured separately: bench/gateway.ts.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import {
  AccountRole,
  generateKeyPairSigner,
  getAddressEncoder,
  lamports,
  signature as asSignature,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getInitializeMint2Instruction, getMintSize, getMintToInstruction, TOKEN_PROGRAM_ADDRESS, fetchToken } from "@solana-program/token";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/express";
import { ExactSvmScheme as ExactServer } from "@x402/svm/exact/server";
import { ExactSvmScheme as ExactClient } from "@x402/svm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { createApp } from "../src/app";
import { Ledger } from "../src/ledger";
import { BuyerAgent, schemePayer, sessionPayer } from "../src/buyer/agent";
import { SpendLog } from "../src/buyer/policy";
import { caip2, connect, RpcSessionReader } from "../src/session/chain";
import { SessionFacilitator } from "../src/session/facilitator";
import { SessionPayer, SessionServerScheme } from "../src/session/scheme";
import { ata, openSession, redeemDue } from "../src/session/ops";
import { PROGRAM_ID, ReceiptSigner, SCHEME, SYSTEM_PROGRAM } from "../src/session/protocol";
import { newKeypairFile } from "../src/cli/keys";
import type { Verification } from "../src/core/verify";

const CALLS = Number(process.env.BENCH_CALLS ?? 100);
const PRICE = 1000n; // $0.001 in USDC atomic units
const DIR = process.env.BENCH_DIR ?? "./.bench";
const SO = process.env.PROGRAM_SO ?? "./solana/target/deploy/pay_session.so";
const RPC = "http://127.0.0.1:8899";
mkdirSync(DIR, { recursive: true });

// --- validator ---
const validator = spawn("solana-test-validator", ["--reset", "--quiet", "--ledger", join(DIR, "ledger"), "--bpf-program", PROGRAM_ID, SO], { stdio: "ignore" });
process.on("exit", () => validator.kill());
const chain = connect(RPC);
for (let i = 0; ; i++) {
  try {
    if ((await chain.rpc.getHealth().send()) === "ok") break;
  } catch {}
  if (i > 60) throw new Error("validator didn't start");
  await new Promise((r) => setTimeout(r, 1000));
}
const network = await caip2(chain.rpc);
// @x402/svm only accepts the mainnet/devnet/testnet ids, but uses a custom RPC URL when given one, so the
// exact path labels this local validator with the devnet id while every RPC call goes to 127.0.0.1.
const exactNetwork = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;

async function airdrop(to: Address, sol: number) {
  await chain.rpc.requestAirdrop(to, lamports(BigInt(sol * 1e9))).send();
  for (let i = 0; i < 60; i++) {
    if ((await chain.rpc.getBalance(to).send()).value > 0n) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("airdrop didn't land");
}

function createAccountIx(payer: KeyPairSigner, account: KeyPairSigner, rent: bigint, space: number, owner: Address): Instruction {
  const data = new Uint8Array(4 + 8 + 8 + 32);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 0, true);
  dv.setBigUint64(4, rent, true);
  dv.setBigUint64(12, BigInt(space), true);
  data.set(getAddressEncoder().encode(owner), 20);
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: account.address, role: AccountRole.WRITABLE_SIGNER, signer: account },
    ] as unknown as Instruction["accounts"], // kit picks up embedded signers when signing
    data,
  };
}

// --- accounts and a test USDC mint ---
const [buyer, seller, feePayer, mintKp] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
await Promise.all([airdrop(buyer.address, 10), airdrop(seller.address, 2), airdrop(feePayer.address, 5)]);
const rent = await chain.rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send();
await chain.send(buyer, [createAccountIx(buyer, mintKp, rent, getMintSize(), TOKEN_PROGRAM_ADDRESS), getInitializeMint2Instruction({ mint: mintKp.address, decimals: 6, mintAuthority: buyer.address })]);
const mint = mintKp.address;
const buyerToken = await ata(buyer.address, mint);
const sellerToken = await ata(seller.address, mint);
await chain.send(buyer, [
  await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: buyer, owner: buyer.address, mint }),
  await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: buyer, owner: seller.address, mint }),
  getMintToInstruction({ mint, token: buyerToken, mintAuthority: buyer, amount: 100_000_000n }),
]);
const sellerBalance = async () => (await fetchToken(chain.rpc, sellerToken)).data.amount;

// --- API servers (one per payment method), job checks stubbed ---
const stub: Verification = { url: "https://jobs.lever.co/acme/1", status: "OPEN", checkedAt: new Date().toISOString(), evidence: { type: "ATS_DETAIL_ACTIVE", board: "LEVER", boardId: "acme", jobId: "1", endpoint: "stub", httpStatus: 200, ms: 0, detail: "stubbed for the benchmark" }, job: null, india: null };

async function serve(rs: x402ResourceServer, scheme: "exact" | "session", ledger: Ledger, net: `${string}:${string}`) {
  const app = createApp({ verify: async () => stub, payments: { server: rs, options: [{ scheme, network: net, payTo: seller.address, price: "$0.001", label: scheme }] }, ledger, cacheMs: 0 });
  const s = await new Promise<Server>((r) => {
    const x = app.listen(0, () => r(x));
  });
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
}

// The local validator (Agave 2.3) only decodes v0 transactions, so advertise v0 only.
const facilitator = registerExactSvmScheme(new x402Facilitator(), { signer: toFacilitatorSvmSigner(feePayer, { defaultRpcUrl: RPC }), networks: exactNetwork, transactionVersions: [0] });
const exactFacilitator: FacilitatorClient = { getSupported: async () => facilitator.getSupported() as never, verify: async (p, r) => { const v = await facilitator.verify(p, r); if (!v.isValid && process.env.BENCH_DEBUG) console.error("exact verify:", JSON.stringify(v).slice(0, 1500)); return v; }, settle: (p, r) => facilitator.settle(p, r) };
const exactServerScheme = new ExactServer().registerMoneyParser(async (amount) => ({ amount: String(Math.round(Number(amount) * 1e6)), asset: mint, extra: {} }));
const exactLedger = new Ledger();
const exactApi = await serve(new x402ResourceServer(exactFacilitator).register(exactNetwork, exactServerScheme), "exact", exactLedger, exactNetwork);

const sessionLedger = new Ledger();
const reader = new RpcSessionReader(chain.rpc);
const sessionApi = await serve(new x402ResourceServer(new SessionFacilitator({ network, reader, ledger: sessionLedger })).register(network, new SessionServerScheme({ mint })), "session", sessionLedger, network);

const policy = (host: string, net: string) => ({ allowedHosts: [host], networks: [net], payees: { [net]: seller.address }, maxPerCall: 2_000n, dailyCap: 1_000_000_000n });
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
};

async function run(base: string, agent: BuyerAgent) {
  await agent.discover(base);
  const ms: number[] = [];
  let ok = 0;
  const receipts: string[] = [];
  for (let i = 0; i < CALLS; i++) {
    const t = performance.now();
    const r = await agent.get(`${base}/v1/verify?url=${encodeURIComponent(stub.url)}`);
    ms.push(performance.now() - t);
    if (r.ok) {
      ok++;
      if (r.paid?.receipt) receipts.push(r.paid.receipt);
    } else console.error("call failed:", r.refused ?? r.error, JSON.stringify(r.data)?.slice(0, 400));
  }
  return { ok, ms, receipts };
}

async function fee(sig: string): Promise<bigint> {
  for (let i = 0; i < 20; i++) {
    const tx = await chain.rpc.getTransaction(asSignature(sig), { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
    if (tx?.meta) return BigInt(tx.meta.fee);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no tx ${sig}`);
}

// --- x402 exact ---
const before = await sellerBalance();
const exactAgent = new BuyerAgent(policy(new URL(exactApi.base).host, exactNetwork), [schemePayer(exactNetwork, new ExactClient(buyer, { rpcUrl: RPC }))], new SpendLog());
const exact = await run(exactApi.base, exactAgent);
const afterExact = await sellerBalance();
let exactFees = 0n;
for (const s of exact.receipts) exactFees += await fee(s);

// --- pay_session ---
const agentKey = newKeypairFile(join(DIR, "agent.json"));
const t0 = performance.now();
const opened = await openSession(chain, { buyer, seller: seller.address, mint, signer: agentKey.address, deposit: BigInt(CALLS) * PRICE + PRICE, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600) });
const openMs = performance.now() - t0;
const payer = new SessionPayer({ address: opened.session, seller: seller.address, mint, deposit: BigInt(CALLS) * PRICE + PRICE, openedSlot: opened.openedSlot }, new ReceiptSigner(agentKey.secret));
const sessionAgent = new BuyerAgent(policy(new URL(sessionApi.base).host, network), [sessionPayer(network, payer)], new SpendLog());
const session = await run(sessionApi.base, sessionAgent);
const t1 = performance.now();
const redeemed = await redeemDue(chain, sessionLedger, new RpcSessionReader(chain.rpc, 0), seller, { minAmount: 1n });
const redeemMs = performance.now() - t1;
const afterSession = await sellerBalance();
const sessionTxs = [opened.tx, ...redeemed.filter((r) => r.tx).map((r) => r.tx!)];
let sessionFees = 0n;
for (const s of sessionTxs) sessionFees += await fee(s);

const result = {
  at: new Date().toISOString(),
  cluster: "solana-test-validator (local)",
  calls: CALLS,
  pricePerCall: "0.001 USDC",
  note: "Job checks are stubbed, so latency is payment overhead plus local HTTP. Fees are what the local validator charged (5,000 lamports per signature, no priority fee). The exact path labels the local validator with the devnet CAIP-2 id because @x402/svm accepts only known cluster ids; all its RPC calls go to the local validator.",
  exact: {
    served: exact.ok,
    latencyMs: stats(exact.ms),
    onchainTransactions: exact.receipts.length,
    feesLamports: exactFees.toString(),
    sellerReceived: (afterExact - before).toString(),
    expected: (BigInt(exact.ok) * PRICE).toString(),
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
    note: "Opening also pays rent for the session and vault accounts, refunded to the buyer on close.",
  },
};
const ok = result.exact.sellerReceived === result.exact.expected && result.session.sellerReceived === result.session.expected && exact.ok === CALLS && session.ok === CALLS;
mkdirSync("bench/results", { recursive: true });
const out = `bench/results/localnet-${result.at.slice(0, 10)}.json`;
writeFileSync(out, JSON.stringify({ ...result, balancesMatch: ok }, null, 2));
console.log(JSON.stringify({ ...result, balancesMatch: ok }, null, 2));
console.log(`\nwrote ${out}`);
exactApi.close();
sessionApi.close();
validator.kill();
process.exit(ok ? 0 : 1);
