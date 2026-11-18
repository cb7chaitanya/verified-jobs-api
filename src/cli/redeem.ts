/**
 * Seller-side redemption worker: turns accepted session receipts into USDC.
 *
 *   pnpm redeem            # every REDEEM_INTERVAL_SECONDS (default 300)
 *   pnpm redeem --once
 *
 * Env: SELLER_KEYPAIR (the seller's Solana keypair; it can only receive from session vaults),
 * LEDGER_PATH (same as the API server), SESSION_RPC_URL, REDEEM_MIN_USDC (default 0.10).
 * Runs separately from the API so the web server holds no key.
 */
import { connect, RpcSessionReader } from "../session/chain";
import { redeemDue } from "../session/ops";
import { Ledger } from "../ledger";
import { signerFrom, usdc } from "./keys";

const seller = await signerFrom(process.env.SELLER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`);
const chain = connect(process.env.SESSION_RPC_URL ?? "https://api.devnet.solana.com", process.env.SESSION_WS_URL);
const ledger = new Ledger(process.env.LEDGER_PATH ?? "./data/ledger.db");
const reader = new RpcSessionReader(chain.rpc, 0);
const minAmount = usdc(process.env.REDEEM_MIN_USDC ?? "0.10");

async function pass() {
  const results = await redeemDue(chain, ledger, reader, seller, { minAmount });
  for (const r of results) console.log(JSON.stringify({ ...r, amount: r.amount.toString() }));
  return results;
}

if (process.argv.includes("--once")) {
  await pass();
  process.exit(0);
}
const every = Number(process.env.REDEEM_INTERVAL_SECONDS ?? 300) * 1000;
for (;;) {
  await pass().catch((e) => console.error(e));
  await new Promise((r) => setTimeout(r, every));
}
