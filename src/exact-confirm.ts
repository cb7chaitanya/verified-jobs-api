import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { getBase58Decoder, getBase64Encoder, getTransactionDecoder, signature as asSignature } from "@solana/kit";
import type { Rpc } from "./session/chain";
import { log } from "./core/log";

/**
 * x402 `exact` on Solana: a facilitator can answer `settle` with `settlement_pending` (the transfer
 * was broadcast but it didn't see the confirmation in time). The x402 middleware treats that as a
 * failure and refuses the call, yet the transfer often lands a moment later, so the buyer pays and
 * gets nothing. Measured on devnet with the public facilitator: 40 of 100 calls.
 *
 * This wrapper closes that gap. On a pending settlement it watches the chain for the broadcast
 * transaction, and turns the result into a success only if that transaction:
 *  - confirmed without error,
 *  - carries the buyer's own signature from this payment (so no other transaction can stand in),
 *  - moved at least the required amount of the required mint to the seller,
 *  - and hasn't been accepted before.
 * Anything else keeps the original failure, so the buyer is still refused and not served for free.
 */

/** What a landed transaction shows: its error, its signatures, and each token account's change. */
export type LandedTx = { err: unknown; signatures: string[]; balances: { owner?: string; mint: string; delta: bigint }[] };

export interface TxSource {
  /** The confirmed transaction, or null if it isn't visible (yet). */
  get(sig: string): Promise<LandedTx | null>;
}

export function rpcTxSource(rpc: Rpc): TxSource {
  return {
    async get(sig) {
      const tx = await rpc.getTransaction(asSignature(sig), { commitment: "confirmed", // Facilitators may send version-1 transactions; kit's types only know 0 so far.
        maxSupportedTransactionVersion: 1 as 0, encoding: "json" }).send();
      if (!tx?.meta) return null;
      const pre = new Map((tx.meta.preTokenBalances ?? []).map((b) => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
      const balances = (tx.meta.postTokenBalances ?? []).map((b) => ({ owner: b.owner ?? undefined, mint: b.mint, delta: BigInt(b.uiTokenAmount.amount) - (pre.get(b.accountIndex) ?? 0n) }));
      return { err: tx.meta.err, signatures: tx.transaction.signatures.map(String), balances };
    },
  };
}

/** The signatures already present in the buyer's partially signed `exact` transaction. */
export function buyerSignatures(payload: PaymentPayload): string[] {
  const b64 = (payload.payload as { transaction?: unknown } | undefined)?.transaction;
  if (typeof b64 !== "string") return [];
  try {
    const tx = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(b64)));
    return Object.values(tx.signatures)
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map((s) => getBase58Decoder().decode(s));
  } catch {
    return [];
  }
}

const PENDING = "settlement_pending";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ConfirmingFacilitator implements FacilitatorClient {
  /** Pending settlements this wrapper confirmed on-chain and turned into successes. */
  recovered = 0;
  private accepted = new Set<string>();
  private pendingTx = new Map<string, string>();

  constructor(
    private inner: FacilitatorClient,
    private source: TxSource,
    private opts: { timeoutMs?: number; intervalMs?: number; maxRemembered?: number } = {},
  ) {}

  verify(p: PaymentPayload, r: PaymentRequirements) {
    return this.inner.verify(p, r);
  }

  getSupported() {
    return this.inner.getSupported();
  }

  async settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    const key = buyerSignatures(p).join(",");
    let res: SettleResponse;
    try {
      res = await this.inner.settle(p, r);
    } catch (e) {
      const err = e as Partial<SettleResponse> & Error;
      // A SettleError carries the facilitator's response; anything else is a transport problem.
      if (typeof err.transaction !== "string") throw e;
      res = { success: false, errorReason: err.errorReason, errorMessage: err.errorMessage, payer: err.payer, transaction: err.transaction, network: r.network };
    }
    if (res.success) {
      if (res.transaction) this.accepted.add(res.transaction);
      return res;
    }
    // A pending answer names the broadcast transaction. A later retry of the same payment may fail
    // differently (the transaction already landed), so remember it per payment.
    if (res.errorReason === PENDING && res.transaction && key) this.remember(key, res.transaction);
    const tx = key ? this.pendingTx.get(key) : undefined;
    if (!tx || !key) return res;
    const ok = await this.confirm(tx, key.split(","), r);
    if (!ok) return res;
    this.pendingTx.delete(key);
    this.accepted.add(tx);
    this.recovered++;
    log.info({ tx, reason: res.errorReason }, "exact settlement confirmed on-chain after a failed settle");
    return { success: true, transaction: tx, network: r.network, payer: res.payer };
  }

  private remember(key: string, tx: string) {
    this.pendingTx.set(key, tx);
    const max = this.opts.maxRemembered ?? 10_000;
    while (this.pendingTx.size > max) this.pendingTx.delete(this.pendingTx.keys().next().value!);
  }

  private async confirm(tx: string, buyerSigs: string[], r: PaymentRequirements): Promise<boolean> {
    if (this.accepted.has(tx)) return false;
    const deadline = Date.now() + (this.opts.timeoutMs ?? 30_000);
    for (;;) {
      let landed: LandedTx | null = null;
      try {
        landed = await this.source.get(tx);
      } catch (e) {
        log.warn({ tx, err: e instanceof Error ? e.message : String(e) }, "couldn't read transaction");
      }
      if (landed) {
        if (landed.err) return false;
        if (!buyerSigs.every((s) => landed.signatures.includes(s))) return false;
        const received = landed.balances.filter((b) => b.owner === r.payTo && b.mint === r.asset).reduce((sum, b) => sum + b.delta, 0n);
        return received >= BigInt(r.amount);
      }
      if (Date.now() >= deadline) return false;
      await sleep(this.opts.intervalMs ?? 1_500);
    }
  }
}
