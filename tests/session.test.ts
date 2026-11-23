import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { getAddressDecoder, type Address } from "@solana/kit";
import { x402ResourceServer } from "@x402/express";
import { Ledger } from "../src/ledger";
import { SessionFacilitator, type SessionReader } from "../src/session/facilitator";
import { PROGRAM_ID, receiptMessage, ReceiptSigner, SCHEME, verifyEd25519, type SessionState } from "../src/session/protocol";
import { SessionPayer, SessionServerScheme } from "../src/session/scheme";
import { createApp } from "../src/app";
import { UpstreamError, type Verification } from "../src/core/verify";

const NETWORK = "solana:localnet-test" as const;
const NOW = Date.UTC(2026, 10, 19, 12);

/** A fresh ed25519 key as a 64-byte Solana secret key. */
function keypair(): { secret: Uint8Array; address: Address } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { secret: new Uint8Array(Buffer.concat([seed, pub])), address: getAddressDecoder().decode(new Uint8Array(pub)) };
}

const buyer = keypair();
const seller = keypair();
const agent = keypair();
const mint = keypair().address;
const sessionAddr = keypair().address;
const signer = new ReceiptSigner(agent.secret);
const SLOT = 4242n;

function state(over: Partial<SessionState> = {}): SessionState {
  return { address: sessionAddr, buyer: buyer.address, seller: seller.address, mint, signer: agent.address, nonce: 1n, deposit: 5_000n, redeemed: 0n, expiresAt: NOW / 1000 + 3600, openedSlot: SLOT, ...over };
}
class FakeReader implements SessionReader {
  constructor(public s: SessionState | null = state()) {}
  async get(a: Address) {
    return this.s && a === this.s.address ? this.s : null;
  }
}

const req = { scheme: SCHEME, network: NETWORK, asset: mint, amount: "1000", payTo: seller.address, maxTimeoutSeconds: 120, extra: { programId: PROGRAM_ID } };
const receipt = (cumulative: bigint, by = signer, session = sessionAddr, slot = SLOT) => ({
  x402Version: 2,
  accepted: req,
  payload: { session, cumulative: cumulative.toString(), signature: Buffer.from(by.sign(receiptMessage(PROGRAM_ID, session, slot, cumulative))).toString("base64") },
});

function setup(reader = new FakeReader(), ledger = new Ledger()) {
  return { reader, ledger, fac: new SessionFacilitator({ network: NETWORK, reader, ledger, now: () => NOW }) };
}

describe("receipt format", () => {
  it("is domain || program || session || opened slot || cumulative (u64 LE), 96 bytes, like the Rust program", () => {
    const m = receiptMessage(PROGRAM_ID, sessionAddr, 0x0a0bn, 0x0102n);
    expect(m.length).toBe(96);
    expect(Buffer.from(m.subarray(0, 16)).toString("latin1")).toBe("x402-session-v2\0");
    expect([...m.subarray(80, 82)]).toEqual([0x0b, 0x0a]);
    expect([...m.subarray(88, 90)]).toEqual([0x02, 0x01]);
    expect([...m.subarray(80)]).toEqual([0x0b, 0x0a, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0]);
  });
});

describe("session facilitator", () => {
  it("accepts a correctly signed receipt once and records the payment", async () => {
    const { fac, ledger } = setup();
    expect(await fac.verify(receipt(1000n), req)).toMatchObject({ isValid: true, payer: buyer.address });
    expect(await fac.settle(receipt(1000n), req)).toMatchObject({ success: true, transaction: `session:${sessionAddr}:${SLOT}:1000` });
    expect(ledger.accepted(sessionAddr, SLOT)).toEqual({ accepted: 1000n, redeemed: 0n });
    expect(ledger.payment(`session:${sessionAddr}:${SLOT}:1000`)).toMatchObject({ payer: buyer.address, signer: agent.address, amount: "1000" });
    // The same receipt again pays for nothing new.
    expect(await fac.verify(receipt(1000n), req)).toMatchObject({ isValid: false, invalidReason: "insufficient_increment" });
    expect(await fac.verify(receipt(1500n), req)).toMatchObject({ isValid: false, invalidReason: "insufficient_increment" });
    expect(await fac.verify(receipt(2000n), req)).toMatchObject({ isValid: true });
  });

  it("refuses receipts signed by another key, beyond the deposit, for another session, or too close to expiry", async () => {
    expect(await setup().fac.verify(receipt(1000n, new ReceiptSigner(buyer.secret)), req)).toMatchObject({ invalidReason: "invalid_signature" });
    expect(await setup().fac.verify(receipt(6000n), req)).toMatchObject({ invalidReason: "insufficient_funds" });
    expect(await setup().fac.verify(receipt(1000n, signer, keypair().address), req)).toMatchObject({ invalidReason: "session_not_found" });
    expect(await setup(new FakeReader(state({ expiresAt: NOW / 1000 + 300 }))).fac.verify(receipt(1000n), req)).toMatchObject({ invalidReason: "session_expiring" });
    expect(await setup(new FakeReader(state({ seller: buyer.address }))).fac.verify(receipt(1000n), req)).toMatchObject({ invalidReason: "wrong_payee" });
    expect(await setup().fac.verify({ ...receipt(1000n), payload: { session: sessionAddr, cumulative: "-1", signature: "" } }, req)).toMatchObject({ invalidReason: "invalid_payload" });
  });

  it("two requests racing on the same receipt: exactly one is served", async () => {
    const { fac } = setup();
    const [a, b] = [receipt(1000n), receipt(1000n)];
    expect((await fac.verify(a, req)).isValid && (await fac.verify(b, req)).isValid).toBe(true);
    const results = await Promise.all([fac.settle(a, req), fac.settle(b, req)]);
    expect(results.map((r) => r.success).sort()).toEqual([false, true]);
    expect(results.find((r) => !r.success)).toMatchObject({ errorReason: expect.stringMatching(/conflict|insufficient_increment/) });
  });

  it("a restart can't reopen an old receipt (the ledger is durable)", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "vja-")), "ledger.db");
    const first = setup(new FakeReader(), new Ledger(path));
    expect((await first.fac.settle(receipt(1000n), req)).success).toBe(true);
    first.ledger.db.close();
    const restarted = setup(new FakeReader(), new Ledger(path));
    expect(await restarted.fac.verify(receipt(1000n), req)).toMatchObject({ isValid: false, invalidReason: "insufficient_increment" });
  });

  it("never accepts less than what's already redeemed on-chain (e.g. by another server)", async () => {
    const { fac } = setup(new FakeReader(state({ redeemed: 3000n })));
    expect(await fac.verify(receipt(3000n), req)).toMatchObject({ invalidReason: "insufficient_increment" });
    expect(await fac.verify(receipt(4000n), req)).toMatchObject({ isValid: true });
  });

  it("a session address re-opened as a new lifetime refuses the old lifetime's receipts and starts fresh", async () => {
    const reader = new FakeReader();
    const { fac, ledger } = setup(reader);
    expect((await fac.settle(receipt(3000n), req)).success).toBe(true);
    // Closed and re-opened at the same address in a later slot.
    reader.s = state({ openedSlot: SLOT + 10n });
    expect(await fac.verify(receipt(4000n), req)).toMatchObject({ isValid: false, invalidReason: "invalid_signature" });
    // The new lifetime isn't blocked by the old ledger row: its first receipt is accepted from zero.
    expect(await fac.settle(receipt(1000n, signer, sessionAddr, SLOT + 10n), req)).toMatchObject({ success: true, transaction: `session:${sessionAddr}:${SLOT + 10n}:1000` });
    expect(ledger.accepted(sessionAddr, SLOT + 10n)).toEqual({ accepted: 1000n, redeemed: 0n });
    expect(ledger.accepted(sessionAddr, SLOT)).toBeNull();
  });

  it("migrates a ledger created before receipts were bound to a lifetime", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vja-")), "old.db");
    const old = new Ledger(path);
    old.db.exec("DROP TABLE session_receipts; CREATE TABLE session_receipts (session TEXT PRIMARY KEY, accepted TEXT NOT NULL, signature BLOB NOT NULL, redeemed TEXT NOT NULL DEFAULT '0', updated_at INTEGER NOT NULL)");
    old.db.exec(`INSERT INTO session_receipts VALUES ('${sessionAddr}', '5000', x'00', '0', 1)`);
    old.db.close();
    const ledger = new Ledger(path);
    expect(ledger.unredeemed()).toMatchObject([{ session: sessionAddr, openedSlot: null, accepted: 5000n }]);
    ledger.retire(sessionAddr, null);
    expect(ledger.unredeemed()).toEqual([]);
    expect(ledger.advance(sessionAddr, SLOT, null, 1000n, new Uint8Array(64))).toBe(true);
  });
});

describe("buyer side", () => {
  const session = { address: sessionAddr, seller: seller.address, mint, deposit: 3000n, openedSlot: SLOT };
  it("advances its running total only when the seller confirms, so a failed call costs nothing extra", () => {
    const saved: bigint[] = [];
    const p = new SessionPayer(session, signer, 0n, (v) => saved.push(v));
    expect(p.payload(req).cumulative).toBe("1000");
    p.failed();
    expect(p.payload(req).cumulative).toBe("1000"); // same total again
    p.settled("1000");
    expect(p.payload(req).cumulative).toBe("2000");
    p.settled(undefined);
    expect([p.spent, saved]).toEqual([2000n, [1000n, 2000n]]);
  });
  it("never adopts a running total the seller reports: only what it signed (a dishonest service can't inflate the next receipt)", () => {
    const payer = new SessionPayer({ ...session, deposit: 50_000n }, signer);
    expect(payer.payload(req).cumulative).toBe("1000");
    expect(payer.settled("49000")).toBe(false); // claims the buyer owes 49 000
    expect(payer.spent).toBe(1000n);
    const next = payer.payload(req);
    expect(next.cumulative).toBe("2000");
    expect(verifyEd25519(agent.address, receiptMessage(PROGRAM_ID, sessionAddr, SLOT, 2000n), new Uint8Array(Buffer.from(next.signature, "base64")))).toBe(true);
    expect(payer.settled("2000")).toBe(true);
    expect(payer.settled("9999")).toBe(false); // nothing pending: ignored
    expect(payer.spent).toBe(2000n);
  });

  it("refuses to sign for a different seller, token or program, or past the deposit", () => {
    const p = new SessionPayer(session, signer, 2500n);
    expect(() => p.payload({ ...req, payTo: buyer.address })).toThrow(/different seller/);
    expect(() => p.payload({ ...req, asset: buyer.address })).toThrow(/different token/);
    expect(() => p.payload({ ...req, extra: { programId: buyer.address } })).toThrow(/program/);
    expect(() => p.payload(req)).toThrow(/exhausted/);
  });
});

describe("session payments over HTTP", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());
  const OPEN: Verification = {
    url: "https://jobs.lever.co/acme/1",
    status: "OPEN",
    checkedAt: "2026-11-19T00:00:00.000Z",
    evidence: { type: "ATS_DETAIL_ACTIVE", board: "LEVER", boardId: "acme", jobId: "1", endpoint: "https://api.lever.co/v0/postings/acme/1", httpStatus: 200, ms: 5, detail: "live" },
    job: null,
    india: null,
  };

  it("pays per call with signed totals; a failed check isn't charged and the next call reuses the total", async () => {
    const { fac, ledger } = setup();
    let fail = false;
    const rs = new x402ResourceServer(fac).register(NETWORK, new SessionServerScheme({ mint }));
    const app = createApp({
      verify: async () => {
        if (fail) throw new UpstreamError("board down", 502);
        return OPEN;
      },
      payments: { server: rs, options: [{ scheme: SCHEME as "exact", network: NETWORK, payTo: seller.address, price: "$0.001", label: "session" }] },
      cacheMs: 0,
    });
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, () => r(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/verify?url=${encodeURIComponent(OPEN.url)}`;
    const payer = new SessionPayer({ address: sessionAddr, seller: seller.address, mint, deposit: 5000n, openedSlot: SLOT }, signer);
    const call = async () => {
      const first = await fetch(base);
      const required = JSON.parse(Buffer.from(first.headers.get("payment-required")!, "base64").toString());
      const accepted = required.accepts[0];
      const header = Buffer.from(JSON.stringify({ x402Version: required.x402Version, resource: required.resource, accepted, payload: payer.payload(accepted) })).toString("base64");
      const r = await fetch(base, { headers: { "PAYMENT-SIGNATURE": header } });
      if (r.ok) payer.settled(JSON.parse(Buffer.from(r.headers.get("payment-response")!, "base64").toString()).extra?.cumulative);
      else payer.failed();
      return r.status;
    };
    expect(await call()).toBe(200);
    expect(await call()).toBe(200);
    expect(ledger.accepted(sessionAddr, SLOT)?.accepted).toBe(2000n);
    fail = true;
    expect(await call()).toBe(502);
    expect(ledger.accepted(sessionAddr, SLOT)?.accepted).toBe(2000n); // not charged
    fail = false;
    expect(await call()).toBe(200);
    expect(ledger.accepted(sessionAddr, SLOT)?.accepted).toBe(3000n); // exactly one more call's worth
  });
});
