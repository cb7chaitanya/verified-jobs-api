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
        updated_at INTEGER NOT NULL,
        opened_slot TEXT                   -- lifetime of the session address these receipts belong to
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
    // Additive migration for ledgers created before receipts were bound to a session lifetime.
    const cols = this.db.prepare("PRAGMA table_info(session_receipts)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "opened_slot")) this.db.exec("ALTER TABLE session_receipts ADD COLUMN opened_slot TEXT");
  }

  /** The latest receipt accepted for this lifetime of the session (rows from an earlier lifetime don't count). */
  accepted(session: string, openedSlot: bigint): { accepted: bigint; redeemed: bigint } | null {
    const r = this.db.prepare("SELECT accepted, redeemed FROM session_receipts WHERE session = ? AND opened_slot = ?").get(session, openedSlot.toString()) as { accepted: string; redeemed: string } | undefined;
    return r ? { accepted: BigInt(r.accepted), redeemed: BigInt(r.redeemed) } : null;
  }

  /**
   * Compare-and-set: move a session lifetime from `expected` (null = never seen) to `next`. False if
   * someone got there first. A row left by an earlier lifetime of the same address is replaced.
   */
  advance(session: string, openedSlot: bigint, expected: bigint | null, next: bigint, signature: Uint8Array, now = Date.now()): boolean {
    const slot = openedSlot.toString();
    if (expected === null) {
      const r = this.db
        .prepare(
          "INSERT INTO session_receipts (session, accepted, signature, updated_at, opened_slot) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(session) DO UPDATE SET accepted = excluded.accepted, signature = excluded.signature, redeemed = '0', updated_at = excluded.updated_at, opened_slot = excluded.opened_slot " +
            "WHERE session_receipts.opened_slot IS NOT excluded.opened_slot",
        )
        .run(session, next.toString(), signature, now, slot);
      return r.changes === 1;
    }
    const r = this.db.prepare("UPDATE session_receipts SET accepted = ?, signature = ?, updated_at = ? WHERE session = ? AND opened_slot = ? AND accepted = ?").run(next.toString(), signature, now, session, slot, expected.toString());
    return r.changes === 1;
  }

  /** Session lifetimes holding receipts not yet redeemed on-chain. */
  unredeemed(): { session: string; openedSlot: bigint | null; accepted: bigint; redeemed: bigint; signature: Uint8Array }[] {
    return (this.db.prepare("SELECT session, opened_slot, accepted, redeemed, signature FROM session_receipts").all() as { session: string; opened_slot: string | null; accepted: string; redeemed: string; signature: Uint8Array }[])
      .map((r) => ({ session: r.session, openedSlot: r.opened_slot === null ? null : BigInt(r.opened_slot), accepted: BigInt(r.accepted), redeemed: BigInt(r.redeemed), signature: new Uint8Array(r.signature) }))
      .filter((r) => r.accepted > r.redeemed);
  }

  /** Record what the chain shows as redeemed for this lifetime; never moves backwards. */
  markRedeemed(session: string, openedSlot: bigint | null, upTo: bigint) {
    const slot = openedSlot === null ? null : openedSlot.toString();
    const r = this.db.prepare("SELECT redeemed FROM session_receipts WHERE session = ? AND opened_slot IS ?").get(session, slot) as { redeemed: string } | undefined;
    if (r && upTo > BigInt(r.redeemed)) this.db.prepare("UPDATE session_receipts SET redeemed = ? WHERE session = ? AND opened_slot IS ? AND redeemed = ?").run(upTo.toString(), session, slot, r.redeemed);
  }

  /** Stop tracking a lifetime that no longer exists on-chain (closed, or replaced by a re-open). */
  retire(session: string, openedSlot: bigint | null) {
    this.db.prepare("UPDATE session_receipts SET redeemed = accepted WHERE session = ? AND opened_slot IS ?").run(session, openedSlot === null ? null : openedSlot.toString());
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
