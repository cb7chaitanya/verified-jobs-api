import { describe, expect, it } from "vitest";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { FacilitatorClient } from "@x402/core/server";
import { SettleError, type PaymentPayload, type PaymentRequirements, type SettleResponse } from "@x402/core/types";
import { buyerSignatures, ConfirmingFacilitator, type LandedTx, type TxSource } from "../src/exact-confirm";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SELLER = "EecxWpaA3DvMmT8TqyXAtGj93wzpfhWckyBkrJmEUeVJ";
const req: PaymentRequirements = { scheme: "exact", network: NETWORK, asset: MINT, amount: "1000", payTo: SELLER, maxTimeoutSeconds: 60, extra: {} };

/** A buyer-signed transaction with the fee payer's signature still missing, like an x402 `exact` payload. */
async function payment() {
  const buyer = await generateKeyPairSigner();
  const feePayer = (await generateKeyPairSigner()).address;
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstruction({ programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [{ address: buyer.address, role: AccountRole.READONLY_SIGNER, signer: buyer }], data: new Uint8Array([1]) }, m),
  );
  const tx = await partiallySignTransactionMessageWithSigners(msg);
  const payload = { x402Version: 2, accepted: req, payload: { transaction: getBase64EncodedWireTransaction(tx) } } as unknown as PaymentPayload;
  return { payload, buyerSig: getBase58Decoder().decode(tx.signatures[buyer.address]!) };
}

const inner = (...answers: (SettleResponse | Error)[]): FacilitatorClient & { calls: number } => ({
  calls: 0,
  async verify() {
    return { isValid: true };
  },
  async settle() {
    const a = answers[Math.min(this.calls++, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    return a;
  },
  async getSupported() {
    return { kinds: [], extensions: [], signers: {} };
  },
});
const source = (txs: Record<string, LandedTx>): TxSource => ({ get: async (sig) => txs[sig] ?? null });
const pending = (tx: string): SettleResponse => ({ success: false, errorReason: "settlement_pending", transaction: tx, network: NETWORK });
const landed = (buyerSig: string, over: Partial<LandedTx> = {}): LandedTx => ({ err: null, signatures: ["FEEPAYERSIG", buyerSig], balances: [{ owner: SELLER, mint: MINT, delta: 1000n }], ...over });
const fast = { timeoutMs: 30, intervalMs: 5 };

describe("ConfirmingFacilitator", () => {
  it("reads the buyer's signature out of an exact payload", async () => {
    const { payload, buyerSig } = await payment();
    expect(buyerSignatures(payload)).toEqual([buyerSig]);
  });

  it("passes a successful settlement through untouched", async () => {
    const { payload } = await payment();
    const ok: SettleResponse = { success: true, transaction: "T1", network: NETWORK };
    const f = new ConfirmingFacilitator(inner(ok), source({}), fast);
    expect(await f.settle(payload, req)).toEqual(ok);
    expect(f.recovered).toBe(0);
  });

  it("serves a pending settlement once its transaction lands and pays the seller", async () => {
    const { payload, buyerSig } = await payment();
    const f = new ConfirmingFacilitator(inner(pending("T1")), source({ T1: landed(buyerSig) }), fast);
    expect(await f.settle(payload, req)).toMatchObject({ success: true, transaction: "T1" });
    expect(f.recovered).toBe(1);
  });

  it("also recovers when the facilitator throws a pending SettleError", async () => {
    const { payload, buyerSig } = await payment();
    const f = new ConfirmingFacilitator(inner(new SettleError(500, pending("T1"))), source({ T1: landed(buyerSig) }), fast);
    expect(await f.settle(payload, req)).toMatchObject({ success: true, transaction: "T1" });
  });

  it("recovers on the retry when the first answer was pending and the retry fails differently", async () => {
    const { payload, buyerSig } = await payment();
    const chain: Record<string, LandedTx> = {};
    const f = new ConfirmingFacilitator(inner(pending("T1"), { success: false, errorReason: "invalid_exact_svm_transaction_simulation_failed", transaction: "", network: NETWORK }), source(chain), fast);
    expect((await f.settle(payload, req)).success).toBe(false); // not landed yet
    chain.T1 = landed(buyerSig);
    expect(await f.settle(payload, req)).toMatchObject({ success: true, transaction: "T1" });
  });

  it("keeps the failure if the transaction never shows up", async () => {
    const { payload } = await payment();
    const f = new ConfirmingFacilitator(inner(pending("T1")), source({}), fast);
    expect(await f.settle(payload, req)).toMatchObject({ success: false, errorReason: "settlement_pending" });
  });

  it("refuses a landed transaction that failed on-chain", async () => {
    const { payload, buyerSig } = await payment();
    const f = new ConfirmingFacilitator(inner(pending("T1")), source({ T1: landed(buyerSig, { err: { InstructionError: [0, "Custom"] } }) }), fast);
    expect((await f.settle(payload, req)).success).toBe(false);
  });

  it("refuses a transaction without this buyer's signature", async () => {
    const { payload } = await payment();
    const other = await payment();
    const f = new ConfirmingFacilitator(inner(pending("T1")), source({ T1: landed(other.buyerSig) }), fast);
    expect((await f.settle(payload, req)).success).toBe(false);
  });

  it("refuses a transaction that paid someone else, the wrong mint or too little", async () => {
    for (const balances of [[{ owner: "Someone", mint: MINT, delta: 1000n }], [{ owner: SELLER, mint: "OtherMint", delta: 1000n }], [{ owner: SELLER, mint: MINT, delta: 999n }]]) {
      const { payload, buyerSig } = await payment();
      const f = new ConfirmingFacilitator(inner(pending("T1")), source({ T1: landed(buyerSig, { balances }) }), fast);
      expect((await f.settle(payload, req)).success).toBe(false);
    }
  });

  it("never accepts the same transaction twice", async () => {
    const { payload, buyerSig } = await payment();
    const f = new ConfirmingFacilitator(inner(pending("T1")), source({ T1: landed(buyerSig) }), fast);
    expect((await f.settle(payload, req)).success).toBe(true);
    expect((await f.settle(payload, req)).success).toBe(false);
    expect(f.recovered).toBe(1);
  });

  it("concurrent requests reusing one payment: exactly one is served", async () => {
    const { payload, buyerSig } = await payment();
    // First settle is pending; repeats of the same payload are duplicates. The tx lands after a few polls.
    let reads = 0;
    const slow: TxSource = { get: async () => (++reads > 2 ? landed(buyerSig) : null) };
    const f = new ConfirmingFacilitator(inner(pending("T1"), { success: false, errorReason: "duplicate_settlement", transaction: "", network: NETWORK }), slow, { timeoutMs: 500, intervalMs: 5 });
    const first = f.settle(payload, req);
    await new Promise((r) => setTimeout(r, 1)); // T1 is remembered and being confirmed
    const results = await Promise.all([first, f.settle(payload, req), f.settle(payload, req)]);
    expect(results.filter((x) => x.success)).toHaveLength(1);
  });

  it("refuses a facilitator success for a transaction that already paid for a call", async () => {
    const { payload, buyerSig } = await payment();
    const ok: SettleResponse = { success: true, transaction: "T1", network: NETWORK };
    const f = new ConfirmingFacilitator(inner(pending("T1"), ok), source({ T1: landed(buyerSig) }), fast);
    expect((await f.settle(payload, req)).success).toBe(true); // recovered on-chain
    expect(await f.settle(payload, req)).toMatchObject({ success: false, errorReason: "duplicate_settlement" }); // the facilitator later reconciles T1 too
  });

  it("checks the durable payment ledger, so a restart doesn't reopen a used transaction", async () => {
    const { payload, buyerSig } = await payment();
    const used = new Set(["T1"]);
    const f = new ConfirmingFacilitator(inner(pending("T1")), source({ T1: landed(buyerSig) }), { ...fast, used: (tx) => used.has(tx) });
    expect((await f.settle(payload, req)).success).toBe(false);
    const g = new ConfirmingFacilitator(inner({ success: true, transaction: "T1", network: NETWORK }), source({}), { ...fast, used: (tx) => used.has(tx) });
    expect(await g.settle(payload, req)).toMatchObject({ success: false, errorReason: "duplicate_settlement" });
  });

  it("lets a retried payment through verify while its pending transaction is tracked, and serves it once it lands", async () => {
    const { payload, buyerSig } = await payment();
    const chain: Record<string, LandedTx> = {};
    const refusing: FacilitatorClient & { calls: number } = { ...inner(pending("T1"), { success: false, errorReason: "duplicate_settlement", transaction: "", network: NETWORK }), async verify() {
      return { isValid: false, invalidReason: "transaction_simulation_failed" };
    } };
    const f = new ConfirmingFacilitator(refusing, source(chain), fast);
    expect(await f.verify(payload, req)).toMatchObject({ isValid: false }); // nothing tracked yet
    expect((await f.settle(payload, req)).success).toBe(false); // pending, not landed within the window
    expect(await f.verify(payload, req)).toMatchObject({ isValid: true }); // the retry gets through verify
    chain.T1 = landed(buyerSig);
    expect(await f.settle(payload, req)).toMatchObject({ success: true, transaction: "T1" });
    expect(await f.verify(payload, req)).toMatchObject({ isValid: false }); // used: no more passes
  });

  it("rethrows errors that aren't settlement responses", async () => {
    const { payload } = await payment();
    const f = new ConfirmingFacilitator(inner(new Error("network down")), source({}), fast);
    await expect(f.settle(payload, req)).rejects.toThrow("network down");
  });
});
