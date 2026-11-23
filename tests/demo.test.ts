import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { createApp } from "../src/app";
import type { Verification } from "../src/core/verify";
import { mountDemo, type DemoMethod } from "../src/demo/demo";
import { Ledger } from "../src/ledger";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
const PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const POSTING = "https://job-boards.greenhouse.io/acme/jobs/42";

class FakeFacilitator implements FacilitatorClient {
  settles = 0;
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5" } }], extensions: [], signers: {} };
  }
  async verify() {
    return { isValid: true, payer: "buyer" };
  }
  async settle() {
    this.settles++;
    return { success: true, transaction: "5fakeSig", network: SOL, payer: "buyer" };
  }
}

const OPEN: Verification = {
  url: POSTING,
  status: "OPEN",
  checkedAt: "2026-11-23T00:00:00.000Z",
  evidence: { type: "ATS_DETAIL_ACTIVE", board: "GREENHOUSE", boardId: "acme", jobId: "42", endpoint: "stub", httpStatus: 200, ms: 1, detail: "live" },
  job: { title: "Backend Engineer", company: "Acme", location: "Bengaluru", workplace: "ONSITE", postedAt: null, applyUrl: null, isSoftwareRole: true },
  india: { eligibility: "ELIGIBLE", tier: "INDIA_CITY", reasons: ["Location lists India (Bengaluru)"] },
};

let server: Server | undefined;
afterEach(() => server?.close());

async function start(o: { dailyCap?: bigint; rate?: { max: number; windowMs: number }; publicOrigin?: string; allowedOrigins?: string[]; failing?: boolean; redeem?: boolean } = {}) {
  const fac = new FakeFacilitator();
  const rs = new x402ResourceServer(fac).register(SOL, new ExactSvmScheme());
  const app = createApp({ verify: async () => OPEN, payments: { server: rs, options: [{ scheme: "exact", network: SOL, payTo: PAY_TO, price: "$0.001", label: "test" }] }, cacheMs: 0 });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const results = mkdtempSync(join(tmpdir(), "demo-bench-"));
  writeFileSync(join(results, "devnet-2026-11-23.json"), JSON.stringify({ calls: 100, exact: { served: 100 } }));
  writeFileSync(join(results, "devnet-2026-11-23-raw.json"), JSON.stringify({ calls: 100, exact: { served: 60 } }));
  const exact: DemoMethod = { id: "exact", network: SOL, payTo: PAY_TO, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", explorer: (tx) => `https://explorer.solana.com/tx/${tx}?cluster=devnet`, payer: async () => {
      if (o.failing) throw new Error("connect ECONNREFUSED https://user:secret@rpc.internal:8899");
      return { network: SOL, scheme: "exact", create: async () => ({ transaction: "c2lnbmVk" }) };
    } };
  // One receipt due on a session the (fake, slow) chain no longer has: each redeem pass makes one RPC read.
  let rpcReads = 0;
  const ledger = new Ledger();
  ledger.advance("11111111111111111111111111111112", 1n, null, 1000n, new Uint8Array(64));
  const rpc = { getAccountInfo: () => ({ send: () => (rpcReads++, new Promise((r) => setTimeout(() => r({ value: null }), 50))) }) };
  const redeem = o.redeem ? { chain: { rpc } as never, ledger, seller: {} as never } : undefined;
  mountDemo(app, { selfBase: base, price: 1000n, methods: [exact], dailyCap: o.dailyCap ?? 1_000_000n, resultsDir: results, rate: o.rate, publicOrigin: o.publicOrigin, allowedOrigins: o.allowedOrigins, redeem });
  return { fac, base, reads: () => rpcReads };
}

const run = async (base: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}/demo/verify`, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, events: r.headers.get("content-type")?.includes("ndjson") ? text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [], text };
};

describe("demo page", () => {
  it("serves the page and its configuration, with the latest benchmark results", async () => {
    const { base } = await start();
    const page = await fetch(base + "/");
    expect(page.headers.get("content-type")).toMatch(/html/);
    expect(await page.text()).toContain("Testnet demo");
    const cfg = (await (await fetch(base + "/demo/config")).json()) as Record<string, any>;
    expect(cfg.methods.map((m: { id: string }) => m.id)).toEqual(["exact"]);
    expect(cfg.samples.length).toBeGreaterThan(0);
    expect(cfg.benchmarks.devnet.exact.served).toBe(100);
    expect(cfg.benchmarks.devnetRaw.exact.served).toBe(60);
  });

  it("streams the whole x402 exchange: 402, payment, settlement, answer", async () => {
    const { base, fac } = await start();
    const { status, events } = await run(base, { url: POSTING, method: "exact" });
    expect(status).toBe(200);
    expect(events.map((e) => e.type)).toEqual(["start", "402", "pay", "settled", "result"]);
    expect(events[1]).toMatchObject({ accepts: [{ scheme: "exact", network: SOL, amount: "1000", payTo: PAY_TO }] });
    expect(events[3]).toMatchObject({ success: true, transaction: "5fakeSig", explorer: "https://explorer.solana.com/tx/5fakeSig?cluster=devnet" });
    expect(events[4]).toMatchObject({ ok: true, data: { status: "OPEN" }, paid: { amount: "1000" }, budget: { spentToday: "1000" } });
    expect(fac.settles).toBe(1);
  });

  it("stops at the demo's daily cap without paying", async () => {
    const { base, fac } = await start({ dailyCap: 500n });
    const { events } = await run(base, { url: POSTING, method: "exact" });
    expect(events.at(-1)).toMatchObject({ type: "result", ok: false, refused: expect.stringMatching(/daily cap/) });
    expect(events.some((e) => e.type === "pay")).toBe(false);
    expect(fac.settles).toBe(0);
  });

  it("refuses other sites, unknown methods and bad input", async () => {
    const { base, fac } = await start();
    expect((await run(base, { url: POSTING, method: "exact" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await run(base, { url: POSTING, method: "card" })).status).toBe(400);
    expect((await run(base, { url: 42, method: "exact" })).status).toBe(400);
    expect(fac.settles).toBe(0);
  });

  it("rate-limits paid runs across visitors", async () => {
    const { base } = await start({ rate: { max: 1, windowMs: 60_000 } });
    expect((await run(base, { url: POSTING, method: "exact" })).status).toBe(200);
    expect((await run(base, { url: POSTING, method: "exact" })).status).toBe(429);
  });

  it("requires the page's own Origin on POSTs, matching PUBLIC_URL when configured", async () => {
    const { base, fac } = await start({ publicOrigin: "https://demo.example" });
    expect((await fetch(`${base}/demo/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await run(base, { url: POSTING, method: "exact" })).status).toBe(403); // Host matches, PUBLIC_URL doesn't
    expect((await run(base, { url: POSTING, method: "exact" }, { origin: "https://demo.example" })).status).toBe(200);
    expect(fac.settles).toBe(1);
  });

  it("can't be framed by another site", async () => {
    const { base } = await start();
    const r = await fetch(base + "/");
    expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("shows visitors a generic error, never internal details", async () => {
    const { base } = await start({ failing: true });
    const { events, text } = await run(base, { url: POSTING, method: "exact" });
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/demo payment failed/) });
    expect(text).not.toMatch(/secret|ECONNREFUSED|rpc\.internal/);
  });

  it("redeem shares the rate limit and joins an in-flight redeem instead of queueing more", async () => {
    const { base, reads } = await start({ redeem: true, rate: { max: 1, windowMs: 60_000 } });
    const post = () => fetch(`${base}/demo/redeem`, { method: "POST", headers: { origin: base } });
    const burst = await Promise.all([post(), post(), post(), post(), post()]);
    expect(burst.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]); // one job, everyone joined it
    expect(reads()).toBe(1);
    expect((await post()).status).toBe(429); // the window is used up
    expect((await run(base, { url: POSTING, method: "exact" })).status).toBe(429); // shared with paid runs
  });

  it("lets the configured web app drive it over CORS, and nobody else", async () => {
    const web = "https://verified-jobs.example";
    const { base, fac } = await start({ publicOrigin: "https://api.example", allowedOrigins: [web] });
    const pre = await fetch(`${base}/demo/verify`, { method: "OPTIONS", headers: { origin: web, "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(web);
    const cfg = await fetch(`${base}/demo/config`, { headers: { origin: web } });
    expect(cfg.headers.get("access-control-allow-origin")).toBe(web);
    expect((await run(base, { url: POSTING, method: "exact" }, { origin: web })).status).toBe(200);
    // Another site gets no CORS grant and its POSTs are refused.
    const evil = "https://evil.example";
    expect((await fetch(`${base}/demo/verify`, { method: "OPTIONS", headers: { origin: evil } })).status).toBe(403);
    expect((await fetch(`${base}/demo/config`, { headers: { origin: evil } })).headers.get("access-control-allow-origin")).toBeNull();
    expect((await run(base, { url: POSTING, method: "exact" }, { origin: evil })).status).toBe(403);
    expect(fac.settles).toBe(1);
  });
});
