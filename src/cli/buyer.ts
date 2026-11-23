/**
 * Buyer agent: verify job postings through a paid x402 service, within a spending policy.
 *
 *   pnpm buyer --service http://localhost:3000 --policy ./policy.json <posting URL> [<posting URL> …]
 *   pnpm buyer --service … --policy … --file postings.txt
 *
 * Payers are enabled by what you provide (testnet only):
 *   EVM_PRIVATE_KEY   Circle Gateway Nanopayments on Arc Testnet (deposit first: `pnpm gateway deposit 1`)
 *   SOLANA_KEYPAIR    x402 exact on Solana devnet (SOLANA_RPC_URL optional)
 *   SESSION_FILE      a pay_session opened with `pnpm session open`
 * Spending is logged to SPEND_DB (default ./data/spend.db) and counts toward the daily cap.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createKeyPairSignerFromBytes, address } from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { BuyerAgent, schemePayer, sessionPayer, type Payer } from "../buyer/agent";
import { SpendLog, USDC, type Policy } from "../buyer/policy";
import { SessionPayer } from "../session/scheme";
import { ReceiptSigner } from "../session/protocol";
import { caip2, connect } from "../session/chain";
import { arg, readKeypair, usdc } from "./keys";
import type { SessionFile } from "./session";

const ARC_TESTNET = "eip155:5042002";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

interface PolicyFile {
  allowedHosts: string[];
  networks: string[];
  payees: Record<string, string>;
  /** Token to pay in per network; defaults to USDC on the networks in buyer/policy.ts. */
  assets?: Record<string, string>;
  maxPerCallUsdc: string;
  dailyCapUsdc: string;
}

const pf = JSON.parse(readFileSync(arg("policy", "./policy.json"), "utf8")) as PolicyFile;
const assets = Object.fromEntries(pf.networks.map((n) => [n, pf.assets?.[n] ?? USDC[n]]));
for (const [n, a] of Object.entries(assets)) if (!a) throw new Error(`policy.assets has no token for ${n}; name the mint or contract to pay in`);
const policy: Policy = { allowedHosts: pf.allowedHosts, networks: pf.networks, payees: pf.payees, assets: assets as Record<string, string>, maxPerCall: usdc(pf.maxPerCallUsdc), dailyCap: usdc(pf.dailyCapUsdc) };

const payers: Payer[] = [];
if (process.env.EVM_PRIVATE_KEY) payers.push(schemePayer(ARC_TESTNET, new BatchEvmScheme(privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`))));
if (process.env.SOLANA_KEYPAIR) {
  const signer = await createKeyPairSignerFromBytes(readKeypair(process.env.SOLANA_KEYPAIR));
  payers.push(schemePayer(process.env.SOLANA_NETWORK ?? SOLANA_DEVNET, new ExactSvmScheme(signer, { rpcUrl: process.env.SOLANA_RPC_URL })));
}
if (process.env.SESSION_FILE) {
  const path = process.env.SESSION_FILE;
  const f = JSON.parse(readFileSync(path, "utf8")) as SessionFile;
  const network = await caip2(connect(f.rpcUrl).rpc);
  const p = new SessionPayer({ address: address(f.session), seller: address(f.seller), mint: address(f.mint), deposit: BigInt(f.deposit), openedSlot: BigInt(f.openedSlot) }, new ReceiptSigner(readKeypair(f.agentKeyPath)), BigInt(f.committed), (committed) =>
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), committed: committed.toString() }, null, 2)),
  );
  payers.push(sessionPayer(network, p));
}
if (!payers.length) throw new Error("No payer configured: set EVM_PRIVATE_KEY, SOLANA_KEYPAIR and/or SESSION_FILE");

const service = arg("service", "http://localhost:3000");
const file = process.argv.includes("--file") ? arg("file") : null;
const postings = file
  ? readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  : process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));

const agent = new BuyerAgent(policy, payers, new SpendLog(process.env.SPEND_DB ?? "./data/spend.db"));
await agent.discover(service);
const results = await agent.verifyAll(service, postings);
for (const r of results) {
  const d = r.data as { status?: string; job?: { title?: string; location?: string }; india?: { eligibility?: string } } | null;
  const line = r.ok ? `${d?.status}  india=${d?.india?.eligibility ?? "-"}  ${d?.job?.title ?? ""} (${d?.job?.location ?? "?"})  paid ${r.paid?.amount} on ${r.paid?.network}` : `NOT DONE  ${r.refused ? `refused: ${r.refused}` : r.error}`;
  console.log(`${line}\n  ${decodeURIComponent(r.url.split("url=")[1] ?? r.url)}`);
}
console.log(`spent today: ${Number(agent.spentToday()) / 1e6} USDC (cap ${pf.dailyCapUsdc})`);
