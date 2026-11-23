/**
 * Circle Gateway Nanopayments on Arc Testnet: the same paid calls as bench/local.ts, through the
 * real Circle testnet Gateway, so the three payment paths can be compared.
 *
 *   EVM_PRIVATE_KEY=0x… EVM_PAY_TO=0x… pnpm tsx bench/gateway.ts [--deposit 1]
 *
 * Needs a TESTNET key holding Arc Testnet USDC (https://faucet.circle.com) and a small Gateway
 * deposit; `--deposit <USDC>` makes that one-time deposit first. Job checks are stubbed.
 * Settlement on-chain is done later by Gateway in batches, so this measures what the buyer and
 * seller see per call: authorization, verification and the seller's acceptance.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { FacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/express";
import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";
import { BatchEvmScheme, GatewayClient } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/app";
import { Ledger } from "../src/ledger";
import { BuyerAgent, schemePayer } from "../src/buyer/agent";
import { SpendLog } from "../src/buyer/policy";
import type { Verification } from "../src/core/verify";

const ARC = "eip155:5042002";
const CALLS = Number(process.env.BENCH_CALLS ?? 50);
const key = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const payTo = process.env.EVM_PAY_TO;
if (!key || !payTo) throw new Error("Set EVM_PRIVATE_KEY (testnet buyer) and EVM_PAY_TO (seller address)");

const gw = new GatewayClient({ chain: "arcTestnet", privateKey: key });
const depIdx = process.argv.indexOf("--deposit");
if (depIdx >= 0) console.log("deposit:", await gw.deposit(process.argv[depIdx + 1] ?? "1"));
const before = await gw.getBalances();
console.log(`Gateway balance: ${before.gateway.available} available (wallet ${before.wallet.formatted} USDC)`);

const stub: Verification = { url: "https://jobs.lever.co/acme/1", status: "OPEN", checkedAt: new Date().toISOString(), evidence: { type: "ATS_DETAIL_ACTIVE", board: "LEVER", boardId: "acme", jobId: "1", endpoint: "stub", httpStatus: 200, ms: 0, detail: "stubbed" }, job: null, india: null };
const rs = new x402ResourceServer([new BatchFacilitatorClient({ url: "https://gateway-api-testnet.circle.com" }) as unknown as FacilitatorClient]).register(ARC, new GatewayEvmScheme());
const app = createApp({ verify: async () => stub, payments: { server: rs, options: [{ scheme: "exact", network: ARC, payTo, price: "$0.001", label: "gateway" }] }, ledger: new Ledger(), cacheMs: 0 });
const server = await new Promise<Server>((r) => {
  const s = app.listen(0, () => r(s));
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const agent = new BuyerAgent({ allowedHosts: [new URL(base).host], networks: [ARC], payees: { [ARC]: payTo }, assets: { [ARC]: "0x3600000000000000000000000000000000000000" }, maxPerCall: 2_000n, dailyCap: 1_000_000_000n }, [schemePayer(ARC, new BatchEvmScheme(privateKeyToAccount(key)))], new SpendLog());
await agent.discover(base);
const ms: number[] = [];
let ok = 0;
for (let i = 0; i < CALLS; i++) {
  const t = performance.now();
  const r = await agent.get(`${base}/v1/verify?url=${encodeURIComponent(stub.url)}`);
  ms.push(performance.now() - t);
  if (r.ok) ok++;
  else console.error("call failed:", r.refused ?? r.error, JSON.stringify(r.data)?.slice(0, 300));
}
const s = [...ms].sort((a, b) => a - b);
const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]!);
const after = await gw.getBalances();
const result = {
  at: new Date().toISOString(),
  network: "Arc Testnet via Circle Gateway (testnet)",
  calls: CALLS,
  served: ok,
  latencyMs: { p50: q(0.5), p95: q(0.95) },
  buyerGatewayAvailableBefore: before.gateway.available.toString(),
  buyerGatewayAvailableAfter: after.gateway.available.toString(),
  note: "Per-call on-chain transactions: 0 (Gateway settles batches later). Buyer pays no gas per call.",
};
mkdirSync("bench/results", { recursive: true });
writeFileSync(`bench/results/arc-gateway-${result.at.slice(0, 10)}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
server.close();
process.exit(ok === CALLS ? 0 : 1);
