import { createHash } from "node:crypto";
import { z } from "zod";
import { verifyMessage } from "viem";
import { address as solAddress, getBase58Encoder } from "@solana/kit";
import type { Ledger } from "./ledger";
import { verifyEd25519 } from "./session/protocol";

/**
 * Identity and payment-backed reputation, in ERC-8004 ("Trustless Agents") formats:
 * - an agent registration file describing this service, its endpoints and x402 support;
 * - feedback files accepted only with a proofOfPayment that matches a payment this service
 *   actually settled, signed by the address that paid. One review per payment, so reviews
 *   cost real money to fake and can be weighted by what the reviewer paid.
 */

export interface Identity {
  name: string;
  description: string;
  baseUrl: string;
  /** Filled in once registered on an identity registry (e.g. { agentRegistry: "solana:<cluster>:<program>", agentId: "42" }). */
  registrations: { agentRegistry: string; agentId: string }[];
}

export function registrationFile(id: Identity) {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: id.name,
    description: id.description,
    image: `${id.baseUrl}/icon.svg`,
    services: [{ name: "web", endpoint: `${id.baseUrl}/v1` }],
    x402Support: true,
    active: true,
    registrations: id.registrations,
    supportedTrust: ["reputation"],
  };
}

const Feedback = z.object({
  agentRegistry: z.string().max(200),
  agentId: z.union([z.string().max(100), z.number().int().nonnegative()]).transform(String),
  clientAddress: z.string().max(100),
  createdAt: z.string().datetime({ offset: true }),
  value: z.number().int(),
  valueDecimals: z.number().int().min(0).max(18),
  tag1: z.string().max(64).optional(),
  tag2: z.string().max(64).optional(),
  endpoint: z.string().max(300).optional(),
  proofOfPayment: z.object({ fromAddress: z.string().max(100), toAddress: z.string().max(100), chainId: z.string().max(100), txHash: z.string().max(200) }),
});
export type FeedbackFile = z.infer<typeof Feedback>;

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID" | "NO_SUCH_PAYMENT" | "NOT_PAYER" | "BAD_SIGNATURE" | "DUPLICATE",
  ) {
    super(message);
  }
}

const isEvm = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const same = (a: string, b: string) => (isEvm(a) && isEvm(b) ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The signature covers the exact bytes submitted: EIP-191 personal_sign (0x hex) for EVM payers, ed25519 (base58 or base64) for Solana. */
async function signatureValid(signer: string, body: Uint8Array, signature: string): Promise<boolean> {
  try {
    if (isEvm(signer)) return await verifyMessage({ address: signer as `0x${string}`, message: { raw: body }, signature: signature as `0x${string}` });
    const sig = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature) ? new Uint8Array(getBase58Encoder().encode(signature)) : new Uint8Array(Buffer.from(signature, "base64"));
    return verifyEd25519(solAddress(signer), body, sig);
  } catch {
    return false;
  }
}

export async function submitReview(ledger: Ledger, id: Identity, raw: Uint8Array, signature: string | undefined): Promise<{ hash: string; score: number }> {
  let parsed: FeedbackFile;
  try {
    parsed = Feedback.parse(JSON.parse(Buffer.from(raw).toString("utf8")));
  } catch {
    throw new ReviewError("Body must be an ERC-8004 feedback file with proofOfPayment", "INVALID");
  }
  const reg = id.registrations[0];
  if (reg && (parsed.agentRegistry !== reg.agentRegistry || parsed.agentId !== reg.agentId)) throw new ReviewError("Feedback is for a different agent", "INVALID");
  const score = parsed.value / 10 ** parsed.valueDecimals;
  if (!(score >= 0 && score <= 100)) throw new ReviewError("Score must be between 0 and 100", "INVALID");

  const payment = ledger.payment(parsed.proofOfPayment.txHash);
  if (!payment) throw new ReviewError("No settled payment to this service matches proofOfPayment.txHash", "NO_SUCH_PAYMENT");
  if (!same(parsed.proofOfPayment.toAddress, payment.payTo)) throw new ReviewError("proofOfPayment.toAddress isn't this service's payee", "NO_SUCH_PAYMENT");
  const speaksForPayer = [payment.payer, payment.signer].filter((x): x is string => !!x).some((a) => same(a, parsed.clientAddress));
  if (!speaksForPayer) throw new ReviewError("clientAddress didn't make that payment", "NOT_PAYER");
  if (!signature || !(await signatureValid(parsed.clientAddress, raw, signature))) throw new ReviewError("X-Feedback-Signature must be clientAddress's signature over the request body", "BAD_SIGNATURE");

  const hash = createHash("sha256").update(raw).digest("hex");
  if (!ledger.addReview({ paymentId: payment.id, client: parsed.clientAddress, value: Math.round(score), body: Buffer.from(raw).toString("utf8"), hash })) throw new ReviewError("That payment already has a review", "DUPLICATE");
  return { hash, score };
}

/** Plain and payment-weighted averages; each review is backed by one settled payment. */
export function reputation(ledger: Ledger) {
  const rows = ledger.reviews();
  const clients = new Set(rows.map((r) => r.client.toLowerCase()));
  const paid = rows.reduce((n, r) => n + Number(r.amount), 0);
  const avg = rows.length ? rows.reduce((n, r) => n + r.value, 0) / rows.length : null;
  const weighted = paid ? rows.reduce((n, r) => n + r.value * Number(r.amount), 0) / paid : null;
  return {
    reviews: rows.length,
    distinctReviewers: clients.size,
    averageScore: avg === null ? null : Math.round(avg * 10) / 10,
    paymentWeightedScore: weighted === null ? null : Math.round(weighted * 10) / 10,
    recent: rows.slice(0, 20).map((r) => ({ score: r.value, reviewer: r.client, paymentId: r.paymentId, feedbackHash: r.hash, at: new Date(r.createdAt).toISOString() })),
  };
}
