/**
 * Buyer-side session management.
 *
 *   pnpm session open  --seller <addr> --mint <addr> --deposit 1.00 --hours 24 [--out ./data/session.json]
 *   pnpm session status --file ./data/session.json
 *   pnpm session close  --file ./data/session.json      (after expiry; refunds what wasn't redeemed)
 *
 * Env: BUYER_KEYPAIR (Solana keypair file that funds the session), SESSION_RPC_URL.
 * `open` creates a separate agent key that signs receipts, so the wallet key never signs per call.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { address } from "@solana/kit";
import { connect, RpcSessionReader } from "../session/chain";
import { closeSession, openSession } from "../session/ops";
import { arg, newKeypairFile, signerFrom, usdc } from "./keys";

export interface SessionFile {
  session: string;
  buyer: string;
  seller: string;
  mint: string;
  deposit: string;
  expiresAt: number;
  agentKeyPath: string;
  rpcUrl: string;
  /** Highest receipt total the seller confirmed (kept up to date by the buyer agent). */
  committed: string;
}

const rpcUrl = process.env.SESSION_RPC_URL ?? "https://api.devnet.solana.com";
const chain = connect(rpcUrl, process.env.SESSION_WS_URL);
const cmd = process.argv[2];

if (cmd === "open") {
  const buyer = await signerFrom(process.env.BUYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`);
  const out = arg("out", "./data/session.json");
  mkdirSync(dirname(out), { recursive: true });
  const tmpKey = join(dirname(out), `agent-pending-${Date.now()}.json`);
  const agent = newKeypairFile(tmpKey);
  const deposit = usdc(arg("deposit", "1"));
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Math.round(Number(arg("hours", "24")) * 3600));
  const seller = address(arg("seller"));
  const mint = address(arg("mint"));
  const r = await openSession(chain, { buyer, seller, mint, signer: agent.address, deposit, expiresAt });
  const agentKeyPath = join(dirname(out), `agent-${r.session}.json`);
  renameSync(tmpKey, agentKeyPath);
  const file: SessionFile = { session: r.session, buyer: buyer.address, seller, mint, deposit: deposit.toString(), expiresAt: Number(expiresAt), agentKeyPath, rpcUrl, committed: "0" };
  writeFileSync(out, JSON.stringify(file, null, 2));
  console.log(JSON.stringify({ opened: r.session, tx: r.tx, agentSigner: agent.address, file: out }, null, 2));
} else if (cmd === "status" || cmd === "close") {
  const f = JSON.parse(readFileSync(arg("file", "./data/session.json"), "utf8")) as SessionFile;
  if (cmd === "status") {
    const s = await new RpcSessionReader(chain.rpc).get(address(f.session));
    console.log(JSON.stringify(s ? { ...s, nonce: String(s.nonce), deposit: String(s.deposit), redeemed: String(s.redeemed), committedLocally: f.committed } : { closed: true }, null, 2));
  } else {
    const buyer = await signerFrom(process.env.BUYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`);
    console.log(JSON.stringify({ closed: f.session, tx: await closeSession(chain, { caller: buyer, buyer: address(f.buyer), session: address(f.session), mint: address(f.mint) }) }, null, 2));
  }
} else {
  console.error("usage: session open|status|close (see the comment at the top of src/cli/session.ts)");
  process.exit(1);
}
process.exit(0);
