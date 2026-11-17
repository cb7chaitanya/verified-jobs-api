import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { createApp } from "../src/app";
import { UpstreamError, type Verification } from "../src/core/verify";

const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
// Well-formed public addresses used only as labels; this repo holds no keys for them.
const PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const FEE_PAYER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";

/** Stands in for the payment facilitator: counts verify/settle calls and never touches a chain. */
class FakeFacilitator implements FacilitatorClient {
  verifies = 0;
  settles = 0;
  valid = true;
  settleOk = true;
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET, extra: { feePayer: FEE_PAYER } }], extensions: [], signers: {} };
  }
  async verify() {
    this.verifies++;
    return this.valid ? { isValid: true, payer: "buyer" } : { isValid: false, invalidReason: "invalid_signature", payer: "buyer" };
  }
  async settle() {
    this.settles++;
    return this.settleOk
      ? { success: true, transaction: "5fake-signature", network: SOLANA_DEVNET, payer: "buyer" }
      : { success: false, errorReason: "insufficient_funds", transaction: "", network: SOLANA_DEVNET, payer: "buyer" };
  }
}

const OPEN: Verification = {
  url: "https://job-boards.greenhouse.io/acme/jobs/42",
  status: "OPEN",
  checkedAt: "2026-11-19T00:00:00.000Z",
  evidence: { type: "ATS_DETAIL_ACTIVE", board: "GREENHOUSE", boardId: "acme", jobId: "42", endpoint: "https://boards-api.greenhouse.io/v1/boards/acme/jobs/42", httpStatus: 200, ms: 12, detail: "live" },
  job: { title: "Backend Engineer", company: "Acme", location: "Bengaluru", workplace: "ONSITE", postedAt: null, applyUrl: null, isSoftwareRole: true },
  india: { eligibility: "ELIGIBLE", tier: "INDIA_CITY", reasons: ["Location lists India (Bengaluru)"] },
};

let server: Server | undefined;
afterEach(() => server?.close());

async function start(verify: (url: string) => Promise<Verification>) {
  const fac = new FakeFacilitator();
  const rs = new x402ResourceServer(fac).register(SOLANA_DEVNET, new ExactSvmScheme());
  const calls: string[] = [];
  const app = createApp({
    verify: async (u) => {
      calls.push(u);
      return verify(u);
    },
    payments: { server: rs, options: [{ scheme: "exact", network: SOLANA_DEVNET, payTo: PAY_TO, price: "$0.001", label: "test" }] },
  });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { fac, calls, base };
}

const target = encodeURIComponent(OPEN.url);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

/** Build a payment for whatever the 402 asked for. The fake facilitator decides whether it's "valid". */
async function payFor(base: string) {
  const first = await fetch(`${base}/v1/verify?url=${target}`);
  const required = unb64(first.headers.get("payment-required")!);
  return { first, required, header: b64({ x402Version: required.x402Version, resource: required.resource, accepted: required.accepts[0], payload: { transaction: "signed-by-buyer" } }) };
}

describe("payments", () => {
  it("free: health, the price list, and bad input (rejected before any payment is asked for)", async () => {
    const { base, fac } = await start(async () => OPEN);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const info = await (await fetch(`${base}/v1`)).json();
    expect(info.payment).toEqual([{ label: "test", scheme: "exact", network: SOLANA_DEVNET, price: "$0.001", payTo: PAY_TO }]);
    const bad = await fetch(`${base}/v1/verify?url=${encodeURIComponent("https://example.com/job/1")}`);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("INVALID_URL");
    expect(fac.verifies + fac.settles).toBe(0);
  });

  it("no payment → 402 with USDC payment instructions; the job board is never contacted", async () => {
    const { base, calls } = await start(async () => OPEN);
    const { first, required } = await payFor(base);
    expect(first.status).toBe(402);
    expect(required.accepts[0]).toMatchObject({ scheme: "exact", network: SOLANA_DEVNET, payTo: PAY_TO, amount: "1000" }); // $0.001 = 1000 micro-USDC
    expect(required.accepts[0].extra.feePayer).toBe(FEE_PAYER);
    expect(calls).toEqual([]);
  });

  it("valid payment → 200 with the verification, settled exactly once, receipt in PAYMENT-RESPONSE", async () => {
    const { base, fac, calls } = await start(async () => OPEN);
    const { header } = await payFor(base);
    const paid = await fetch(`${base}/v1/verify?url=${target}`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ status: "OPEN", india: { eligibility: "ELIGIBLE" }, cached: false });
    expect(unb64(paid.headers.get("payment-response")!)).toMatchObject({ success: true, transaction: "5fake-signature" });
    expect([fac.verifies, fac.settles, calls.length]).toEqual([1, 1, 1]);
  });

  it("job board down → 502 and the buyer is NOT charged", async () => {
    const { base, fac } = await start(async () => {
      throw new UpstreamError("Couldn't check the board: HTTP 503", 502);
    });
    const { header } = await payFor(base);
    const r = await fetch(`${base}/v1/verify?url=${target}`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe("UPSTREAM_UNAVAILABLE");
    expect(fac.verifies).toBe(1);
    expect(fac.settles).toBe(0);
  });

  it("invalid payment → 402 and no work is done", async () => {
    const { base, fac, calls } = await start(async () => OPEN);
    fac.valid = false;
    const { header } = await payFor(base);
    const r = await fetch(`${base}/v1/verify?url=${target}`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(r.status).toBe(402);
    expect(fac.settles).toBe(0);
    expect(calls).toEqual([]);
  });

  it("settlement fails → 402 and the paid result is withheld", async () => {
    const { base, fac } = await start(async () => OPEN);
    fac.settleOk = false;
    const { header } = await payFor(base);
    const r = await fetch(`${base}/v1/verify?url=${target}`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(r.status).toBe(402);
    expect(JSON.stringify(await r.json())).not.toContain("ATS_DETAIL_ACTIVE");
  });
});
