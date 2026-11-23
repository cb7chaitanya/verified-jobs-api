import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Address, KeyPairSigner } from "@solana/kit";
import { getBase64Encoder } from "@solana/kit";
import { closeSessionInstruction, decodeSession, ed25519Instruction, openSessionInstruction, PROGRAM_ID, receiptMessage, redeemInstruction, sessionAddress, vaultAddress } from "./protocol";
import type { connect, RpcSessionReader } from "./chain";
import type { Ledger } from "../ledger";
import { log } from "../core/log";

type Chain = ReturnType<typeof connect>;

export async function ata(owner: Address, mint: Address): Promise<Address> {
  const [a] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return a;
}

/** Buyer: lock `deposit` for `seller`, payable by receipts signed with `signer` (an agent key) until `expiresAt`. */
export async function openSession(chain: Chain, a: { buyer: KeyPairSigner; seller: Address; mint: Address; signer: Address; deposit: bigint; expiresAt: bigint; nonce?: bigint }) {
  const nonce = a.nonce ?? BigInt(Date.now());
  const session = await sessionAddress(a.buyer.address, a.seller, nonce);
  const vault = await vaultAddress(session);
  const buyerToken = await ata(a.buyer.address, a.mint);
  const tx = await chain.send(a.buyer, [openSessionInstruction({ buyer: a.buyer.address, seller: a.seller, mint: a.mint, buyerToken, session, vault }, { nonce, deposit: a.deposit, expiresAt: a.expiresAt, signer: a.signer })]);
  // Receipts are bound to the slot the session was opened in, so read it back from the account.
  const { value } = await chain.rpc.getAccountInfo(session, { encoding: "base64", commitment: "confirmed" }).send();
  const state = value ? decodeSession(session, new Uint8Array(getBase64Encoder().encode(value.data[0]))) : null;
  if (!state) throw new Error(`Opened session ${session} but couldn't read it back`);
  return { session, vault, nonce, tx, openedSlot: state.openedSlot };
}

export async function closeSession(chain: Chain, a: { caller: KeyPairSigner; buyer: Address; session: Address; mint: Address }) {
  const vault = await vaultAddress(a.session);
  const buyerToken = await ata(a.buyer, a.mint);
  return chain.send(a.caller, [closeSessionInstruction({ caller: a.caller.address, buyer: a.buyer, session: a.session, mint: a.mint, vault, buyerToken })]);
}

/**
 * Seller: redeem every session whose accepted receipts exceed what's been paid out on-chain,
 * once the amount owed reaches `minAmount` or the session is about to expire. One transaction
 * per session pays for all calls since the last redemption.
 */
export async function redeemDue(chain: Chain, ledger: Ledger, reader: RpcSessionReader, seller: KeyPairSigner, opts: { minAmount?: bigint; expiringWithinSeconds?: number; now?: () => number } = {}) {
  const results: { session: string; amount: bigint; tx?: string; error?: string }[] = [];
  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  for (const r of ledger.unredeemed()) {
    const session = r.session as Address;
    reader.forget(session);
    const state = await reader.get(session);
    if (!state || state.openedSlot !== r.openedSlot) {
      // Closed, or re-opened as a new lifetime: these receipts can never be redeemed. Stop re-reading them.
      ledger.retire(session, r.openedSlot);
      results.push({ session, amount: 0n, error: state ? "session was re-opened; old receipts retired" : "session account not found (closed?)" });
      continue;
    }
    if (state.redeemed >= r.accepted) {
      ledger.markRedeemed(session, r.openedSlot, state.redeemed);
      continue;
    }
    const owed = r.accepted - state.redeemed;
    const expiring = state.expiresAt - nowSec <= (opts.expiringWithinSeconds ?? 900);
    if (owed < (opts.minAmount ?? 1n) && !expiring) continue;
    try {
      const sellerToken = await ata(seller.address, state.mint);
      const createAta = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: seller, owner: seller.address, mint: state.mint });
      const msg = receiptMessage(PROGRAM_ID, session, state.openedSlot, r.accepted);
      // The ed25519 check must sit immediately before redeem.
      const tx = await chain.send(seller, [createAta, ed25519Instruction(state.signer, r.signature, msg), redeemInstruction({ seller: seller.address, session, mint: state.mint, vault: await vaultAddress(session), sellerToken }, r.accepted)]);
      ledger.markRedeemed(session, r.openedSlot, r.accepted);
      results.push({ session, amount: owed, tx });
    } catch (e) {
      log.warn({ session, err: e instanceof Error ? e.message : String(e) }, "redeem failed");
      results.push({ session, amount: owed, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
