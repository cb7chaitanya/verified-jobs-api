import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One payment option from a 402 response (x402 PaymentRequirements). */
export interface Requirement {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/**
 * Spending rules. Everything that decides where money goes is fixed here, by the agent's owner,
 * never read from a server response or a job posting.
 */
export interface Policy {
  /** Hosts the agent may pay. */
  allowedHosts: string[];
  /** Networks the agent can pay on, most preferred first. */
  networks: string[];
  /** Pinned payee per network: a 402 asking to pay anyone else is refused. */
  payees: Record<string, string>;
  /**
   * Pinned token per network (mint or contract address). Limits are in that token's atomic units,
   * so a 402 asking for any other token is refused rather than letting it be paid in something
   * worth more per unit.
   */
  assets: Record<string, string>;
  /** Largest single payment, in atomic units (USDC: 1 = $0.000001). */
  maxPerCall: bigint;
  /** Total per UTC day, in atomic units, across all networks. */
  dailyCap: bigint;
}

export type Decision = { ok: true; requirement: Requirement } | { ok: false; reason: string };

/** USDC on the networks this repo targets, for policies that don't name their own token. */
export const USDC: Record<string, string> = {
  "eip155:5042002": "0x3600000000000000000000000000000000000000", // Arc Testnet
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Solana devnet
};

/** EVM addresses compare case-insensitively (checksums); everything else exactly. */
const sameAsset = (a: string, b: string) => (a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Pick the first acceptable option, or explain why none is. `quoted` is the price per network from
 * the service's published manifest; if the 402 asks for more, it's refused as a changed quote.
 */
export function choose(accepts: Requirement[], policy: Policy, spentToday: bigint, quoted: Record<string, bigint> = {}): Decision {
  const reasons: string[] = [];
  for (const network of policy.networks) {
    for (const r of accepts.filter((a) => a.network === network)) {
      let amount: bigint;
      try {
        amount = BigInt(r.amount);
      } catch {
        reasons.push(`${network}: unreadable amount`);
        continue;
      }
      const pinnedAsset = policy.assets[network];
      if (r.payTo !== policy.payees[network]) reasons.push(`${network}: asks to pay ${r.payTo}, not the pinned payee`);
      else if (!pinnedAsset || typeof r.asset !== "string" || !sameAsset(r.asset, pinnedAsset)) reasons.push(`${network}: asks for ${r.asset}, not the pinned asset`);
      else if (amount <= 0n) reasons.push(`${network}: non-positive amount`);
      else if (amount > policy.maxPerCall) reasons.push(`${network}: ${amount} exceeds the per-call limit of ${policy.maxPerCall}`);
      else if (quoted[network] !== undefined && amount > quoted[network]) reasons.push(`${network}: price changed from the published ${quoted[network]} to ${amount}`);
      else if (spentToday + amount > policy.dailyCap) reasons.push(`${network}: would exceed the daily cap (${spentToday} + ${amount} > ${policy.dailyCap})`);
      else return { ok: true, requirement: r };
    }
  }
  if (!reasons.length) reasons.push(`offered networks not allowed by policy: ${[...new Set(accepts.map((a) => a.network))].join(", ") || "none"}`);
  return { ok: false, reason: reasons.join("; ") };
}

/** Durable record of what the agent has paid, for the daily cap and for its owner. */
export class SpendLog {
  private db: DatabaseSync;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS spend (at INTEGER NOT NULL, day TEXT NOT NULL, network TEXT NOT NULL, amount TEXT NOT NULL, url TEXT NOT NULL, receipt TEXT)");
  }
  static day(ms: number) {
    return new Date(ms).toISOString().slice(0, 10);
  }
  spentOn(day: string): bigint {
    return (this.db.prepare("SELECT amount FROM spend WHERE day = ?").all(day) as { amount: string }[]).reduce((n, r) => n + BigInt(r.amount), 0n);
  }
  /** Reserve before paying, so concurrent calls can't jointly overshoot the cap. Returns an id to release on failure. */
  reserve(at: number, network: string, amount: bigint, url: string): number | bigint {
    return this.db.prepare("INSERT INTO spend (at, day, network, amount, url) VALUES (?, ?, ?, ?, ?)").run(at, SpendLog.day(at), network, amount.toString(), url).lastInsertRowid;
  }
  confirm(id: number | bigint, receipt: string | null) {
    this.db.prepare("UPDATE spend SET receipt = ? WHERE rowid = ?").run(receipt, id);
  }
  release(id: number | bigint) {
    this.db.prepare("DELETE FROM spend WHERE rowid = ?").run(id);
  }
  entries() {
    return this.db.prepare("SELECT at, network, amount, url, receipt FROM spend ORDER BY at").all() as { at: number; network: string; amount: string; url: string; receipt: string | null }[];
  }
}
