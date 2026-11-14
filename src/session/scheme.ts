import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import type { x402ResourceServer } from "@x402/express";
import type { Address } from "@solana/kit";
import { PROGRAM_ID, receiptMessage, ReceiptSigner, SCHEME } from "./protocol";

type ServerScheme = Parameters<x402ResourceServer["register"]>[1];
type Requirements = Parameters<ServerScheme["enhancePaymentRequirements"]>[0];

/**
 * Seller side of the `session` scheme: prices in USDC of the given mint and tells buyers
 * which program their session must belong to.
 */
export class SessionServerScheme implements ServerScheme {
  readonly scheme = SCHEME;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = { default: { supported: ["authorization"], default: "authorization" } } as ServerScheme["paymentFlows"];
  constructor(private readonly o: { mint: Address; decimals?: number; minRemainingSeconds?: number }) {}

  async parsePrice(price: Parameters<ServerScheme["parsePrice"]>[0]) {
    if (typeof price === "object" && price !== null && "amount" in price) return { amount: price.amount, asset: price.asset ?? this.o.mint, extra: price.extra ?? {} };
    const { amount } = parseMoney(price);
    return { amount: convertToTokenAmount(amount, this.o.decimals ?? 6), asset: this.o.mint, extra: {} };
  }

  async enhancePaymentRequirements(req: Requirements) {
    return { ...req, extra: { ...req.extra, programId: PROGRAM_ID, minRemainingSeconds: this.o.minRemainingSeconds ?? 600 } };
  }
}

/** What a buyer knows about its own open session. */
export interface BuyerSession {
  address: Address;
  seller: Address;
  mint: Address;
  deposit: bigint;
}

/**
 * Buyer side: signs the next running total for each call. `committed` only advances when the
 * seller confirms it accepted the receipt; after a failed call the same total is signed again,
 * so a failure never costs more than one call's price.
 */
export class SessionPayer {
  private committed: bigint;
  private pending: bigint | null = null;
  constructor(
    readonly session: BuyerSession,
    private readonly signer: ReceiptSigner,
    start: bigint = 0n,
    private readonly persist: (committed: bigint) => void = () => {},
  ) {
    this.committed = start;
  }

  get spent() {
    return this.committed;
  }

  payload(req: { scheme: string; payTo: string; asset: string; amount: string; extra: Record<string, unknown> }) {
    if (req.scheme !== SCHEME) throw new Error("Not a session payment");
    if (req.extra.programId !== PROGRAM_ID) throw new Error("Session program doesn't match");
    if (req.payTo !== this.session.seller) throw new Error("Payment requested for a different seller than this session pays");
    if (req.asset !== this.session.mint) throw new Error("Payment requested in a different token than this session holds");
    const next = this.committed + BigInt(req.amount);
    if (next > this.session.deposit) throw new Error("Session deposit exhausted; top up or open a new session");
    this.pending = next;
    const signature = this.signer.sign(receiptMessage(PROGRAM_ID, this.session.address, next));
    return { session: this.session.address, cumulative: next.toString(), signature: Buffer.from(signature).toString("base64") };
  }

  /** Call with the seller's settlement response once the paid request succeeded. */
  settled(accepted: string | undefined) {
    const v = accepted ? BigInt(accepted) : this.pending;
    if (v !== null && v > this.committed) {
      this.committed = v;
      this.persist(v);
    }
    this.pending = null;
  }

  failed() {
    this.pending = null;
  }
}
