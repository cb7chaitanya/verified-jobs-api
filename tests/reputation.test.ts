import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddressDecoder } from "@solana/kit";
import type { FacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { Ledger } from "../src/ledger";
import { registrationFile, reputation, submitReview, type Identity } from "../src/reputation";
import { ReceiptSigner } from "../src/session/protocol";
import { createApp } from "../src/app";
import type { Verification } from "../src/core/verify";

const ID: Identity = { name: "Verified Jobs API", description: "d", baseUrl: "https://api.example", registrations: [{ agentRegistry: "solana:devnet:Registry1111", agentId: "7" }] };
const SELLER_EVM = "0x1111111111111111111111111111111111111111";
const evm = privateKeyToAccount(generatePrivateKey());
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

function feedback(over: Record<string, unknown> = {}, proof: Record<string, unknown> = {}) {
  return {
    agentRegistry: "solana:devnet:Registry1111",
    agentId: "7",
    clientAddress: evm.address,
    createdAt: "2026-11-19T12:00:00Z",
    value: 95,
    valueDecimals: 0,
    tag1: "accuracy",
    proofOfPayment: { fromAddress: evm.address, toAddress: SELLER_EVM, chainId: "eip155:5042002", txHash: "0xpaid1", ...proof },
    ...over,
  };
}

function seeded() {
  const ledger = new Ledger();
  ledger.recordPayment({ id: "0xpaid1", scheme: "exact", network: "eip155:5042002", payer: evm.address, payTo: SELLER_EVM, amount: "1000" });
  ledger.recordPayment({ id: "0xpaid2", scheme: "exact", network: "eip155:5042002", payer: evm.address, payTo: SELLER_EVM, amount: "9000" });
  return ledger;
}

describe("identity", () => {
  it("serves an ERC-8004 registration file", () => {
    const r = registrationFile(ID);
    expect(r).toMatchObject({ type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", x402Support: true, active: true, supportedTrust: ["reputation"], registrations: ID.registrations });
    expect(r.services[0]).toEqual({ name: "web", endpoint: "https://api.example/v1" });
  });
});

describe("payment-backed reviews", () => {
  it("accepts a review signed by the address that paid, once per payment, and weights by amount paid", async () => {
    const ledger = seeded();
    const body = enc(feedback());
    expect(await submitReview(ledger, ID, body, await evm.signMessage({ message: { raw: body } }))).toMatchObject({ score: 95 });
    await expect(submitReview(ledger, ID, body, await evm.signMessage({ message: { raw: body } }))).rejects.toMatchObject({ code: "DUPLICATE" });

    const body2 = enc(feedback({ value: 400, valueDecimals: 1 }, { txHash: "0xpaid2" })); // 40.0
    await submitReview(ledger, ID, body2, await evm.signMessage({ message: { raw: body2 } }));
    expect(reputation(ledger)).toMatchObject({ reviews: 2, distinctReviewers: 1, averageScore: 67.5, paymentWeightedScore: 45.5 }); // (95*1000 + 40*9000) / 10000
  });

  it("refuses reviews without a real payment, from someone else, or with a bad signature", async () => {
    const ledger = seeded();
    const sign = (b: Uint8Array) => evm.signMessage({ message: { raw: b } });
    const noPay = enc(feedback({}, { txHash: "0xnever" }));
    await expect(submitReview(ledger, ID, noPay, await sign(noPay))).rejects.toMatchObject({ code: "NO_SUCH_PAYMENT" });

    const other = privateKeyToAccount(generatePrivateKey());
    const impostor = enc(feedback({ clientAddress: other.address }));
    await expect(submitReview(ledger, ID, impostor, await other.signMessage({ message: { raw: impostor } }))).rejects.toMatchObject({ code: "NOT_PAYER" });

    const body = enc(feedback());
    const tampered = enc(feedback({ value: 5 }));
    await expect(submitReview(ledger, ID, tampered, await sign(body))).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    await expect(submitReview(ledger, ID, body, undefined)).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    const wrongAgent = enc(feedback({ agentId: "8" }));
    await expect(submitReview(ledger, ID, wrongAgent, await sign(wrongAgent))).rejects.toMatchObject({ code: "INVALID" });
    const outOfRange = enc(feedback({ value: 101 }));
    await expect(submitReview(ledger, ID, outOfRange, await sign(outOfRange))).rejects.toMatchObject({ code: "INVALID" });
    expect(reputation(ledger).reviews).toBe(0);
  });

  it("a Solana session payment can be reviewed by its agent key (ed25519)", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const secret = new Uint8Array(Buffer.concat([privateKey.export({ format: "der", type: "pkcs8" }).subarray(16), publicKey.export({ format: "der", type: "spki" }).subarray(12)]));
    const agent = new ReceiptSigner(secret);
    const buyer = getAddressDecoder().decode(new Uint8Array(32).fill(7));
    const ledger = new Ledger();
    ledger.recordPayment({ id: "session:S:1000", scheme: "session", network: "solana:x", payer: buyer, signer: agent.address, payTo: "SellerSol", amount: "1000" });
    const body = enc({ ...feedback({ clientAddress: agent.address }, { fromAddress: buyer, toAddress: "SellerSol", chainId: "solana:x", txHash: "session:S:1000" }) });
    const sig = Buffer.from(agent.sign(body)).toString("base64");
    expect(await submitReview(ledger, ID, body, sig)).toMatchObject({ score: 95 });
  });
});

describe("over HTTP", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("a paid call is recorded, then its payer can review it at /v1/feedback; /v1/reputation reflects it", async () => {
    const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
    const PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const fac: FacilitatorClient = {
      getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5" } }], extensions: [], signers: {} }),
      verify: async () => ({ isValid: true, payer: evm.address }),
      settle: async () => ({ success: true, transaction: "5onchainTx", network: SOL, payer: evm.address }),
    };
    const ledger = new Ledger();
    const verification: Verification = { url: "https://jobs.lever.co/acme/1", status: "OPEN", checkedAt: "x", evidence: { type: "ATS_DETAIL_ACTIVE", board: "LEVER", boardId: "acme", jobId: "1", endpoint: "e", httpStatus: 200, ms: 1, detail: "d" }, job: null, india: null };
    const app = createApp({
      verify: async () => verification,
      payments: { server: new x402ResourceServer(fac).register(SOL, new ExactSvmScheme()), options: [{ scheme: "exact", network: SOL, payTo: PAY_TO, price: "$0.001", label: "t" }] },
      ledger,
      identity: { registrations: [] },
    });
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, () => r(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = `${base}/v1/verify?url=${encodeURIComponent(verification.url)}`;
    const req = JSON.parse(Buffer.from((await fetch(url)).headers.get("payment-required")!, "base64").toString());
    const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: req.resource, accepted: req.accepts[0], payload: {} })).toString("base64");
    expect((await fetch(url, { headers: { "PAYMENT-SIGNATURE": header } })).status).toBe(200);
    expect(ledger.payment("5onchainTx")).toMatchObject({ payer: evm.address, payTo: PAY_TO, amount: "1000" });

    const body = JSON.stringify(feedback({ agentRegistry: "any", agentId: "1" }, { toAddress: PAY_TO, txHash: "5onchainTx" }));
    const post = (sig: string) => fetch(`${base}/v1/feedback`, { method: "POST", headers: { "content-type": "application/json", "x-feedback-signature": sig }, body });
    const sig = await evm.signMessage({ message: { raw: new TextEncoder().encode(body) } });
    expect((await post(sig)).status).toBe(201);
    expect((await post(sig)).status).toBe(409);
    expect(await (await fetch(`${base}/v1/reputation`)).json()).toMatchObject({ reviews: 1, averageScore: 95 });
    expect(await (await fetch(`${base}/.well-known/agent-registration.json`)).json()).toMatchObject({ x402Support: true });
  });
});
