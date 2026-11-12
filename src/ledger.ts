import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The seller's durable state (SQLite): the latest receipt accepted for each payment session,
 * every settled payment (for receipts and payment-backed reviews), and reviews.
 * Durable on purpose: if the server restarts, an old session receipt must still be refused.
 */
export class Ledger {
  readonly db: DatabaseSync;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS session_receipts (
        session    TEXT PRIMARY KEY,
        accepted   TEXT NOT NULL,          -- highest cumulative amount accepted (atomic units, decimal)
        signature  BLOB NOT NULL,          -- buyer's signature over that amount
        redeemed   TEXT NOT NULL DEFAULT '0',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payments (
        id         TEXT PRIMARY KEY,       -- on-chain tx / settlement id / session receipt id
        scheme     TEXT NOT NULL,
        network    TEXT NOT NULL,
        payer      TEXT NOT NULL,
        signer     TEXT,                   -- key allowed to speak for the payer (session agent key)
        pay_to     TEXT NOT NULL,
        amount     TEXT NOT NULL,
        resource   TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        payment_id TEXT PRIMARY KEY REFERENCES payments(id),
        client     TEXT NOT NULL,
        value      INTEGER NOT NULL,
        body       TEXT NOT NULL,          -- the ERC-8004 feedback file as submitted
        hash       TEXT NOT NULL,          -- sha256 of body, for an on-chain feedbackHash
        created_at INTEGER NOT NULL
      );
    `);
  }

  accepted(session: string): { accepted: bigint; redeemed: bigint } | null {
    const r = this.db.prepare("SELECT accepted, redeemed FROM session_receipts WHERE session = ?").get(session) as { accepted: string; redeemed: string } | undefined;
    return r ? { accepted: BigInt(r.accepted), redeemed: BigInt(r.redeemed) } : null;
  }

  /** Compare-and-set: move a session from `expected` (null = never seen) to `next`. False if someone got there first. */
  advance(session: string, expected: bigint | null, next: bigint, signature: Uint8Array, now = Date.now()): boolean {
    if (expected === null) {
      const r = this.db.prepare("INSERT INTO session_receipts (session, accepted, signature, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session) DO NOTHING").run(session, next.toString(), signature, now);
      return r.changes === 1;
    }
    const r = this.db.prepare("UPDATE session_receipts SET accepted = ?, signature = ?, updated_at = ? WHERE session = ? AND accepted = ?").run(next.toString(), signature, now, session, expected.toString());
    return r.changes === 1;
  }

  /** Sessions holding receipts not yet redeemed on-chain. */
  unredeemed(): { session: string; accepted: bigint; redeemed: bigint; signature: Uint8Array }[] {
    return (this.db.prepare("SELECT session, accepted, redeemed, signature FROM session_receipts").all() as { session: string; accepted: string; redeemed: string; signature: Uint8Array }[])
      .map((r) => ({ session: r.session, accepted: BigInt(r.accepted), redeemed: BigInt(r.redeemed), signature: new Uint8Array(r.signature) }))
      .filter((r) => r.accepted > r.redeemed);
  }

  /** Record what the chain shows as redeemed; never moves backwards. */
  markRedeemed(session: string, upTo: bigint) {
    const cur = this.accepted(session);
    if (cur && upTo > cur.redeemed) this.db.prepare("UPDATE session_receipts SET redeemed = ? WHERE session = ? AND redeemed = ?").run(upTo.toString(), session, cur.redeemed.toString());
  }

  recordPayment(p: { id: string; scheme: string; network: string; payer: string; signer?: string | null; payTo: string; amount: string; resource?: string | null }, now = Date.now()) {
    this.db.prepare("INSERT INTO payments (id, scheme, network, payer, signer, pay_to, amount, resource, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING").run(p.id, p.scheme, p.network, p.payer, p.signer ?? null, p.payTo, p.amount, p.resource ?? null, now);
  }

  payment(id: string) {
    return this.db.prepare("SELECT id, scheme, network, payer, signer, pay_to AS payTo, amount, created_at AS createdAt FROM payments WHERE id = ?").get(id) as
      | { id: string; scheme: string; network: string; payer: string; signer: string | null; payTo: string; amount: string; createdAt: number }
      | undefined;
  }

  addReview(r: { paymentId: string; client: string; value: number; body: string; hash: string }, now = Date.now()): boolean {
    return this.db.prepare("INSERT INTO reviews (payment_id, client, value, body, hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(payment_id) DO NOTHING").run(r.paymentId, r.client, r.value, r.body, r.hash, now).changes === 1;
  }

  reviews() {
    return this.db
      .prepare("SELECT r.payment_id AS paymentId, r.client, r.value, r.hash, r.created_at AS createdAt, p.amount, p.network FROM reviews r JOIN payments p ON p.id = r.payment_id ORDER BY r.created_at DESC")
      .all() as { paymentId: string; client: string; value: number; hash: string; createdAt: number; amount: string; network: string }[];
  }
}
