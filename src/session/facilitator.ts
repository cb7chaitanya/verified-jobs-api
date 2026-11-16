import { z } from "zod";
import type { FacilitatorClient } from "@x402/core/server";
import type { Address } from "@solana/kit";
import { address } from "@solana/kit";
import { PROGRAM_ID, receiptMessage, SCHEME, verifyEd25519, type SessionState } from "./protocol";
import type { Ledger } from "../ledger";

type Payload = Parameters<FacilitatorClient["verify"]>[0];
type Requirements = Parameters<FacilitatorClient["verify"]>[1];
type Network = Requirements["network"];

/** Reads a session account from the chain (or a fake in tests). */
export interface SessionReader {
  get(session: Address): Promise<SessionState | null>;
}

const PayloadSchema = z.object({
  session: z.string().min(32).max(44),
  cumulative: z.string().regex(/^\d{1,20}$/),
  signature: z.string().max(200),
});

export interface SessionFacilitatorOptions {
  network: Network;
  reader: SessionReader;
  ledger: Ledger;
  /** Refuse receipts when the session ends sooner than this, so there's time to redeem. */
  minRemainingSeconds?: number;
  now?: () => number;
}

/**
 * Verifies and accepts `session` receipts locally: no network round-trip per call.
 * Acceptance is a compare-and-set in the ledger, so two requests racing on the same
 * receipt can't both be served, and a restart can't reopen an old receipt.
 */
export class SessionFacilitator implements FacilitatorClient {
  constructor(private readonly o: SessionFacilitatorOptions) {}

  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: SCHEME, network: this.o.network, extra: { programId: PROGRAM_ID } }], extensions: [], signers: {} };
  }

  private async check(payload: Payload, req: Requirements) {
    const fail = (invalidReason: string, invalidMessage: string) => ({ ok: false as const, invalidReason, invalidMessage });
    if (req.scheme !== SCHEME || req.network !== this.o.network) return fail("unsupported_scheme", "Not a session payment for this network");
    const p = PayloadSchema.safeParse(payload.payload);
    if (!p.success) return fail("invalid_payload", "Expected { session, cumulative, signature }");
    let session: Address;
    try {
      session = address(p.data.session);
    } catch {
      return fail("invalid_payload", "session is not a valid address");
    }
    const state = await this.o.reader.get(session);
    if (!state) return fail("session_not_found", "No open payment session at that address");
    if (state.seller !== req.payTo) return fail("wrong_payee", "Session pays a different seller");
    if (state.mint !== req.asset) return fail("wrong_asset", "Session holds a different token");
    const nowSec = Math.floor((this.o.now ?? Date.now)() / 1000);
    if (state.expiresAt - nowSec < (this.o.minRemainingSeconds ?? 600)) return fail("session_expiring", "Session ends too soon to accept new receipts; open a new one");

    const cumulative = BigInt(p.data.cumulative);
    const prior = this.o.ledger.accepted(session);
    const base = prior && prior.accepted > state.redeemed ? prior.accepted : state.redeemed;
    if (cumulative - base < BigInt(req.amount)) return fail("insufficient_increment", `Receipt must cover at least ${req.amount} beyond the ${base} already accepted`);
    if (cumulative > state.deposit) return fail("insufficient_funds", "Receipt exceeds the session's deposit; top up");
    const signature = new Uint8Array(Buffer.from(p.data.signature, "base64"));
    if (!verifyEd25519(state.signer, receiptMessage(PROGRAM_ID, session, cumulative), signature)) return fail("invalid_signature", "Receipt isn't signed by the session's signer");
    return { ok: true as const, state, session, cumulative, signature, expected: prior ? prior.accepted : null };
  }

  async verify(payload: Payload, req: Requirements) {
    const c = await this.check(payload, req);
    return c.ok ? { isValid: true, payer: c.state.buyer } : { isValid: false, invalidReason: c.invalidReason, invalidMessage: c.invalidMessage };
  }

  async settle(payload: Payload, req: Requirements) {
    const network = this.o.network;
    const c = await this.check(payload, req); // re-check: state may have moved since verify
    if (!c.ok) return { success: false, errorReason: c.invalidReason, errorMessage: c.invalidMessage, transaction: "", network };
    if (!this.o.ledger.advance(c.session, c.expected, c.cumulative, c.signature)) {
      return { success: false, errorReason: "conflict", errorMessage: "Another request used this receipt first", transaction: "", network, payer: c.state.buyer };
    }
    const id = `session:${c.session}:${c.cumulative}`;
    this.o.ledger.recordPayment({ id, scheme: SCHEME, network, payer: c.state.buyer, signer: c.state.signer, payTo: req.payTo, amount: req.amount, resource: payload.resource?.url ?? null });
    return { success: true, transaction: id, network, payer: c.state.buyer, amount: req.amount, extra: { session: c.session, cumulative: c.cumulative.toString() } };
  }
}
